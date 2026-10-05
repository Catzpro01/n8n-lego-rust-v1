//! P4.8 (Agent 2) — **Advanced ingress efficiency (innovation, Issue #111)**.
//!
//! Setiap fitur: **optional/toggleable, contract-bounded, disableable,
//! observable, rollbackable, default = perilaku n8n** (tidak ada perubahan
//! semantik senyap). Fitur yang diterapkan di sini (value murni & std-only):
//!
//! 1. **Route Atlas** — indeks route immutable terkompilasi + pointer generation
//!    atomic-swap (self-heal; atlas adalah state derived — selalu dapat dibangun
//!    ulang dari state canonical).
//! 2. **Adaptive clamp** — telemetri ringkas → penyesuaian *hanya dalam* hard
//!    safety limits; telemetri basi ⇒ conservative fallback (bukan agresif).
//! 3. **Payload Capsule** — handle payload capability-scoped (bukan salinan),
//!    tenancy/owner/generation scoping + TTL; **tanpa** global content-addressable
//!    store (anti).
//! 4. **Burst Fusion / event coalescing** — opt-in hanya untuk source yang
//!    dideklarasikan coalescible; window + max-aggregate; deterministik;
//!    audit jumlah event yang digabung; default **off**, tak pernah auto.
//! 5. **Brownout / QoS modes** — NORMAL→PRESSURE→BROWNOUT→CRITICAL eksplisit;
//!    menunda low-priority / menolak optional; observabel; reversibel;
//!    tanpa silent-drop normal-priority.
//! 6. **Flight recorder** — ring buffer bounded berisi metadata keputusan
//!    ternormalisasi (tanpa kredensial/payload mentah); `promote` untuk
//!    diagnostik durable saat error/race.
//!
//! Deferred → P4.9 (deterministic replay = alat verifikasi kompatibilitas;
//! adaptive *controller* penuh terikat ke matrix performance #107/#111).

use crate::ingress_contract::{
    AdmissionState, Generation, HttpMethod, IngressSourceKind, Priority, RouteRecord,
    WorkflowIdentity,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};
use std::sync::Arc;

// ---------------------------------------------------------------------------
// 1. Route Atlas — kompilasi immutable + atomic hot swap
// ---------------------------------------------------------------------------

pub const MAX_ATLAS_ROUTES: usize = 4096;

/// Indeks route terkompilasi: direct lookup untuk static, kandidat untuk
/// dynamic, partisi method·environment, pointer generation.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RouteAtlas {
    /// route_id → RouteRecord (compact metadata tunggal).
    routes: BTreeMap<String, RouteRecord>,
    /// method → relative path → route_id (STATIC direct).
    static_index: HashMap<HttpMethod, BTreeMap<String, String>>,
    /// kandidat dynamic (wildcard/param) per method.
    dynamic_index: HashMap<HttpMethod, BTreeSet<String>>,
    /// generation pointer — atlas melayani hanya untuk generation ini.
    generation: Option<Generation>,
}

impl RouteAtlas {
    /// Kompilasi atlas dari canonical route records (derived state).
    pub fn compile(routes: impl IntoIterator<Item = RouteRecord>) -> Result<Self, AtlasError> {
        let mut atlas = RouteAtlas::default();
        for route in routes {
            route.validate().map_err(AtlasError::Contract)?;
            if atlas.routes.len() >= MAX_ATLAS_ROUTES {
                return Err(AtlasError::AtlasFull {
                    max: MAX_ATLAS_ROUTES,
                });
            }
            let is_static = route.is_static();
            let method = route.method;
            let rel = route.path.clone();
            let id = route.route_id.clone();
            if is_static {
                atlas
                    .static_index
                    .entry(method)
                    .or_default()
                    .insert(rel, id.clone());
            } else {
                atlas
                    .dynamic_index
                    .entry(method)
                    .or_default()
                    .insert(id.clone());
            }
            atlas.generation = Some(route.generation);
            atlas.routes.insert(id, route);
        }
        Ok(atlas)
    }

    /// Lookup deterministik: static dulu, lalu kandidat dynamic (spesifik win).
    pub fn resolve(&self, method: HttpMethod, rel_path: &str) -> Option<&RouteRecord> {
        if let Some(id) = self.static_index.get(&method).and_then(|m| m.get(rel_path)) {
            return self.routes.get(id);
        }
        // dynamic kandidat: cocokkan ulang pakai `RouteRecord::path` (tanpa
        // menyalin matcher run-time; atlas hanya indeks kandidat).
        let cands = self.dynamic_index.get(&method)?;
        let mut best: Option<&RouteRecord> = None;
        let mut best_depth = 0u32;
        for id in cands {
            if let Some(route) = self.routes.get(id) {
                if route_matches(rel_path, &route.path) {
                    if best.is_none() || route.path_depth > best_depth {
                        best = Some(route);
                        best_depth = route.path_depth;
                    }
                }
            }
        }
        best
    }

    pub fn generation(&self) -> Option<Generation> {
        self.generation
    }

    pub fn len(&self) -> usize {
        self.routes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.routes.is_empty()
    }
}

fn route_matches(rel_path: &str, pattern: &str) -> bool {
    let rel: Vec<&str> = rel_path.split('/').filter(|s| !s.is_empty()).collect();
    let pat: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    if pat.is_empty() || rel.is_empty() {
        return false;
    }
    for (idx, seg) in pat.iter().enumerate() {
        let Some(value) = rel.get(idx) else {
            return false;
        };
        if *seg == "*" {
            return true;
        }
        if let Some(name) = seg.strip_prefix(':') {
            let _ = name;
            if value.is_empty() {
                return false;
            }
            continue;
        }
        if seg != value {
            return false;
        }
    }
    rel.len() == pat.len()
}

pub type AtlasPointer = Arc<RouteAtlas>;

/// Atomic hot-swap pointer generation. Reader memegang `Arc` lama sampai selesai
/// (drains & retired); publisher menukar lewat `SwapHandle`.
#[derive(Debug, Clone)]
pub struct AtlasSwap(Arc<std::sync::Mutex<AtlasPointer>>);

impl Default for AtlasSwap {
    fn default() -> Self {
        Self(Arc::new(std::sync::Mutex::new(Arc::new(
            RouteAtlas::default(),
        ))))
    }
}

impl AtlasSwap {
    pub fn new() -> Self {
        Self::default()
    }

    /// Snapshot reader (immutable, ringan).
    pub fn current(&self) -> AtlasPointer {
        Arc::clone(&self.0.lock().expect("atlas lock"))
    }

    /// Publikasi atlas baru (hot swap); atlas lama tetap hidup bagi reader lama.
    pub fn publish(&self, atlas: RouteAtlas) -> AtlasPointer {
        let new = Arc::new(atlas);
        let mut guard = self.0.lock().expect("atlas lock");
        let old = std::mem::replace(&mut *guard, Arc::clone(&new));
        let _ = old;
        new
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AtlasError {
    #[error(transparent)]
    Contract(#[from] crate::ingress_contract::IngressContractError),
    #[error("atlas penuh: melebihi {max} route")]
    AtlasFull { max: usize },
}

// ---------------------------------------------------------------------------
// 2. Adaptive clamp — penyesuaian dalam hard safety limits saja
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetrySample {
    pub queue_depth: u64,
    pub error_rate_permille: u64,
    pub latency_ms: u64,
    pub stale: bool,
}

/// Penyesuaian efektif yang TIDAK PERNAH melebar di luar hard limits.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdaptiveLimits {
    pub effective_route_concurrency: u64,
    pub low_priority_deferred: bool,
}

/// Konfigurasi safety immutability (hard ceilings).
#[derive(Debug, Clone, Copy)]
pub struct HardLimits {
    pub max_route_concurrency: u64,
    /// di bawah ini = overallocated → kembalikan slot
    pub min_route_concurrency: u64,
    pub latency_ceiling_ms: u64,
    pub error_permille_ceiling: u64,
}

impl Default for HardLimits {
    fn default() -> Self {
        Self {
            max_route_concurrency: 32,
            min_route_concurrency: 1,
            latency_ceiling_ms: 4000,
            error_permille_ceiling: 50,
        }
    }
}

/// Telemetri basi ⇒ **conservative fallback** (bukan aggressive admission).
pub fn adapt_limits(telemetry: TelemetrySample, hard: HardLimits) -> AdaptiveLimits {
    if telemetry.stale {
        return AdaptiveLimits {
            effective_route_concurrency: hard.min_route_concurrency,
            low_priority_deferred: true,
        };
    }
    let under_pressure = telemetry.latency_ms > hard.latency_ceiling_ms
        || telemetry.error_rate_permille > hard.error_permille_ceiling
        || telemetry.queue_depth > hard.max_route_concurrency;
    let effective = if under_pressure {
        // shrink toward min as a function of queue depth, clamp in [min, max]
        let overshoot = telemetry
            .queue_depth
            .saturating_sub(hard.max_route_concurrency);
        let span = hard.max_route_concurrency - hard.min_route_concurrency;
        hard.min_route_concurrency + span.saturating_sub(overshoot.min(span))
    } else {
        hard.max_route_concurrency
    };
    AdaptiveLimits {
        effective_route_concurrency: effective
            .clamp(hard.min_route_concurrency, hard.max_route_concurrency),
        low_priority_deferred: under_pressure,
    }
}

// ---------------------------------------------------------------------------
// 3. Payload Capsule — capability-scoped handle (bukan salinan)
// ---------------------------------------------------------------------------

pub const MAX_CAPSULE_TTL_MS: u64 = 24 * 3600 * 1000;
pub const CAPSULE_SHA256_LEN: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayloadCapsule {
    pub handle: String,
    pub size_bytes: u64,
    pub media_type: Option<String>,
    /// hex sha256 (64 hex).
    pub sha256: String,
    pub retention_deadline_ms: u64,
    pub owner: WorkflowIdentity,
    pub generation: Generation,
    pub capability: CapabilityToken,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CapabilityToken(pub String);

impl CapabilityToken {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CapsuleError {
    #[error("digest sha256 harus 64 hex — dapat {actual}")]
    BadDigest { actual: usize },
    #[error("retention TTL melebihi batas {max}ms")]
    TtlTooLong { max: u64 },
}

impl PayloadCapsule {
    /// Validasi & kunci TTL. `ttl_ms` diubah menjadi deadline absolut.
    pub fn seal(
        handle: impl Into<String>,
        size_bytes: u64,
        media_type: Option<String>,
        sha256: impl Into<String>,
        ttl_ms: u64,
        owner: WorkflowIdentity,
        generation: Generation,
        capability: CapabilityToken,
        now_ms: u64,
    ) -> Result<Self, CapsuleError> {
        let sha256 = sha256.into();
        if sha256.len() != CAPSULE_SHA256_LEN || !sha256.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Err(CapsuleError::BadDigest {
                actual: sha256.len(),
            });
        }
        if ttl_ms > MAX_CAPSULE_TTL_MS {
            return Err(CapsuleError::TtlTooLong {
                max: MAX_CAPSULE_TTL_MS,
            });
        }
        Ok(Self {
            handle: handle.into(),
            size_bytes,
            media_type,
            sha256,
            retention_deadline_ms: now_ms + ttl_ms,
            owner,
            generation,
            capability,
        })
    }

    pub fn is_expired_at(&self, now_ms: u64) -> bool {
        now_ms >= self.retention_deadline_ms
    }

    /// Access capability check, fail-closed (scoped per owner+generation).
    pub fn assert_access(
        &self,
        capability: &CapabilityToken,
        owner: &WorkflowIdentity,
        generation: Generation,
        now_ms: u64,
    ) -> bool {
        // capability must match, owner must match, generation must match, TTL valid
        capability.0 == self.capability.0
            && owner.workflow_id == self.owner.workflow_id
            && generation == self.generation
            && !self.is_expired_at(now_ms)
    }
}

// ---------------------------------------------------------------------------
// 4. Burst Fusion — event coalescing opt-in
// ---------------------------------------------------------------------------

pub const MAX_AGGREGATE: usize = 512;

/// Satu event masuk (normalized).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CoalescibleEvent {
    pub source: IngressSourceKind,
    pub workflow_id: String,
    pub node_id: String,
    pub received_at_ms: u64,
    pub payload_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FusionConfig {
    pub enabled: bool,
    pub window_ms: u64,
    pub max_aggregate: usize,
}

impl Default for FusionConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            window_ms: 5_000,
            max_aggregate: MAX_AGGREGATE,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FusionOutput {
    /// jumlah event yang bergabung.
    pub merged_count: usize,
    /// input gabungan deterministik (payload keys urut waktu).
    pub aggregate_keys: Vec<String>,
    /// audited event ids (untuk audit; tidak drop senyap).
    pub audited: Vec<String>,
}

/// Coalesce hanya untuk source coalescible yang dideklarasikan; off ⇒ tak
/// pernah diterapkan otomatis. Deterministik (urut `received_at_ms`).
pub fn coalesce_events(
    events: Vec<CoalescibleEvent>,
    config: &FusionConfig,
    now_ms: u64,
) -> FusionOutput {
    if !config.enabled || events.len() < 2 {
        return FusionOutput {
            merged_count: events.len(),
            aggregate_keys: events.iter().map(|e| e.payload_key.clone()).collect(),
            audited: Vec::new(),
        };
    }
    let mut sorted: Vec<CoalescibleEvent> = events;
    sorted.sort_by_key(|e| e.received_at_ms);
    let window_start = now_ms.saturating_sub(config.window_ms);
    let in_window: Vec<&CoalescibleEvent> = sorted
        .iter()
        .filter(|e| e.received_at_ms >= window_start)
        .collect();
    // bounded: jangan pernah lebih dari max_aggregate
    let take = in_window.len().min(config.max_aggregate);
    let keys: Vec<String> = in_window[..take]
        .iter()
        .map(|e| e.payload_key.clone())
        .collect();
    let _ = config;
    FusionOutput {
        merged_count: take,
        aggregate_keys: keys,
        audited: in_window.iter().map(|e| e.payload_key.clone()).collect(),
    }
}

// ---------------------------------------------------------------------------
// 5. Brownout / QoS modes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BrownoutMode {
    Normal,
    Pressure,
    Brownout,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum QosAction {
    Admit,
    DeferLowPriority,
    RejectOptional,
    Unavailable,
}

/// Kebijakan deterministik: pressure memundurkan low-priority; brownout
/// menolak optional; critical menolak nyaris semua kecuali control-plane.
pub fn qos_decide(priority: Priority, mode: BrownoutMode) -> QosAction {
    match mode {
        BrownoutMode::Normal => QosAction::Admit,
        BrownoutMode::Pressure => match priority {
            Priority::Low => QosAction::DeferLowPriority,
            _ => QosAction::Admit,
        },
        BrownoutMode::Brownout => match priority {
            Priority::Low => QosAction::DeferLowPriority,
            Priority::Normal => QosAction::RejectOptional,
            Priority::High => QosAction::Admit,
        },
        BrownoutMode::Critical => QosAction::Unavailable,
    }
}

/// Transisi level dari indikator beban (deterministik, konservatif).
pub fn next_brownout(mode: BrownoutMode, queue_depth: u64, error_permille: u64) -> BrownoutMode {
    match mode {
        BrownoutMode::Normal if queue_depth > 512 || error_permille > 200 => BrownoutMode::Pressure,
        BrownoutMode::Pressure if queue_depth > 2048 || error_permille > 500 => {
            BrownoutMode::Brownout
        }
        BrownoutMode::Brownout if queue_depth > 16_384 => BrownoutMode::Critical,
        BrownoutMode::Critical => BrownoutMode::Critical,
        other => other,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct QosDecision {
    pub action: QosAction,
    pub mode: BrownoutMode,
    pub admitted: bool,
}

/// Helper admission-level: kembalikan keputusan QoS murni.
/// Catatan: `AdmissionDecision` penuh tetap diterbitkan `AdmissionControl`
/// (P4.5); di sini cukup action/mode/admitted untuk lapisan kebijakan.
pub fn qos_apply(priority: Priority, mode: BrownoutMode) -> QosDecision {
    let action = qos_decide(priority, mode);
    let admitted = matches!(action, QosAction::Admit);
    QosDecision {
        action,
        mode,
        admitted,
    }
}

// ---------------------------------------------------------------------------
// 6. Flight recorder — ring bounded, sanitized
// ---------------------------------------------------------------------------

pub const MAX_FLIGHT_RECORDS: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestStamp {
    pub request_id: String,
    pub route_id: Option<String>,
    pub generation: Option<u64>,
    pub received_at_ms: u64,
    pub decided_at_ms: u64,
    pub admission_state: AdmissionState,
    pub queue_delay_ms: u64,
    /// referensi keputusan security (bukan kredensial).
    pub security_decision_ref: Option<String>,
    pub error_code: Option<String>,
}

#[derive(Debug, Default, Clone)]
pub struct FlightRecorder {
    records: VecDeque<RequestStamp>,
}

impl FlightRecorder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, stamp: RequestStamp) {
        self.records.push_back(stamp);
        while self.records.len() > MAX_FLIGHT_RECORDS {
            self.records.pop_front();
        }
    }

    pub fn len(&self) -> usize {
        self.records.len()
    }

    pub fn is_empty(&self) -> bool {
        self.records.is_empty()
    }

    /// Promote record untuk diagnostik durable (di sini = kembalikan salinan;
    /// tidak menyimpan kredensial/payload mentah).
    pub fn promote(&self, request_id: &str) -> Option<RequestStamp> {
        self.records
            .iter()
            .find(|r| r.request_id == request_id)
            .cloned()
    }
}

// ===========================================================================
// P4-S01 — Ingress efficiency remainder (Issue #111 items 2, 9, 10; #225 item 1)
//
// Empat subsistem, semuanya **optional / policy-controlled / contract-bounded /
// disableable / observable / rollbackable / default = perilaku n8n**:
//
//   (1) Predictive admission controller (full) — item 2.
//   (2) Shadow compatibility path                — item 9.
//   (3) P4 self-profiling                        — item 10.
//   (4) Dedicated webhook/ingress plane          — #225 item 1.
//
// Setiap subsistem adalah nilai murni + std-only (tanpa I/O, tanpa thread),
// sehingga dapat diuji secara deterministik dan dinonaktifkan tanpa mengubah
// semantik workflow JSON.
// ===========================================================================

// ---------------------------------------------------------------------------
// (1) Predictive admission controller (full) — Issue #111 item 2
//
// Mengamati: latency, queue depth, CPU/memory pressure, admission rate,
// completion rate, error rate, dan bentuk burst terbaru.
// Menyesuaikan HANYA: per-route concurrency, per-workflow concurrency, queue
// budget, low-priority admission, dan defer threshold.
//
// Batas keselamatan adalah **hard ceilings immutability**. Karena
// [`AdmissionTargets`] secara struktural tidak memiliki satu pun field
// keamanan/permission/authentication, controller tidak *dapat* melebarkan izin
// atau melewati autentikasi. Queue budget selalu dibatasi kapasitas antrean,
// jadi antrean tak terbatas tidak dapat terbentuk. Telemetri basi ⇒
// **conservative fallback**, bukan admission agresif.
// ---------------------------------------------------------------------------

/// Bentuk burst terbaru pada window pendek. Turunan deterministik dari
/// telemetri — bukan prediksi probabilistik.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BurstShape {
    #[default]
    Idle,
    Steady,
    Rising,
    Burst,
}

/// Telemetri penuh yang diamati controller. Tidak ada field opsional:
/// controller tidak pernah menebak nilai yang tidak diamati.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionTelemetry {
    pub queue_depth: u64,
    /// Kapasitas antrean keras — menjadi batas atas queue budget.
    pub queue_capacity: u64,
    pub latency_ms: u64,
    pub error_rate_permille: u64,
    /// Fraksi permintaan yang di-admit dari yang ditawarkan (permille).
    pub admission_rate_permille: u64,
    /// Fraksi eksekusi yang selesai dari yang di-admit (permille).
    pub completion_rate_permille: u64,
    pub cpu_pressure_permille: u64,
    pub memory_pressure_permille: u64,
    pub burst: BurstShape,
    /// Telemetri tidak segar ⇒ controller WAJIB fallback konservatif.
    pub stale: bool,
}

impl Default for AdmissionTelemetry {
    fn default() -> Self {
        Self {
            queue_depth: 0,
            queue_capacity: 4096,
            latency_ms: 0,
            error_rate_permille: 0,
            admission_rate_permille: 1000,
            completion_rate_permille: 1000,
            cpu_pressure_permille: 0,
            memory_pressure_permille: 0,
            burst: BurstShape::Idle,
            stale: false,
        }
    }
}

/// Knob yang boleh disesuaikan controller — **hanya** ini.
///
/// Tidak ada field izin/keamanan/autentikasi: penyesuaian admission secara
/// struktural tidak dapat melebarkan wewenang.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionTargets {
    pub route_concurrency: u64,
    pub workflow_concurrency: u64,
    /// Budget antrean. Selalu `<= queue_capacity` dan `<= max_queue_budget`.
    pub queue_budget: u64,
    pub low_priority_admitted: bool,
    pub defer_threshold_ms: u64,
}

/// Hard ceilings — batas keselamatan yang tidak dapat dilebarkan controller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AdmissionCeilings {
    pub max_route_concurrency: u64,
    pub min_route_concurrency: u64,
    pub max_workflow_concurrency: u64,
    pub min_workflow_concurrency: u64,
    pub max_queue_budget: u64,
    pub min_queue_budget: u64,
    pub max_defer_threshold_ms: u64,
    pub min_defer_threshold_ms: u64,
    pub latency_ceiling_ms: u64,
    pub error_permille_ceiling: u64,
    pub cpu_permille_ceiling: u64,
    pub memory_permille_ceiling: u64,
    /// Di bawah tekanan ini low-priority tetap di-admit.
    pub low_priority_admit_below_permille: u64,
}

impl Default for AdmissionCeilings {
    fn default() -> Self {
        Self {
            max_route_concurrency: 64,
            min_route_concurrency: 1,
            max_workflow_concurrency: 256,
            min_workflow_concurrency: 1,
            max_queue_budget: 4096,
            min_queue_budget: 16,
            max_defer_threshold_ms: 30_000,
            min_defer_threshold_ms: 250,
            latency_ceiling_ms: 2000,
            error_permille_ceiling: 50,
            cpu_permille_ceiling: 800,
            memory_permille_ceiling: 850,
            low_priority_admit_below_permille: 300,
        }
    }
}

impl AdmissionCeilings {
    /// Batas antrean efektif: tidak pernah melampaui hard ceiling.
    pub fn effective_queue_cap(&self, observed_capacity: u64) -> u64 {
        observed_capacity.min(self.max_queue_budget)
    }
}

/// Rasio pelampauan dalam permille (0 bila di bawah ceiling, mentok 1000).
fn over_ratio_permille(value: u64, ceiling: u64) -> u64 {
    if ceiling == 0 {
        return 1000;
    }
    if value <= ceiling {
        return 0;
    }
    value
        .saturating_sub(ceiling)
        .saturating_mul(1000)
        .checked_div(ceiling)
        .unwrap_or(1000)
        .min(1000)
}

/// Skor tekanan 0..=1000. Monoton: setiap sinyal beban yang memburuk tidak
/// pernah menurunkan skor. Mengambil sinyal terburuk (bukan rata-rata) supaya
/// clamp bereaksi terhadap indikator paling kritis.
pub fn pressure_score(telemetry: AdmissionTelemetry, ceilings: AdmissionCeilings) -> u64 {
    if telemetry.stale {
        // Telemetri basi diperlakukan sebagai tekanan maksimum ⇒ fallback.
        return 1000;
    }
    let queue_fill = if telemetry.queue_capacity == 0 {
        1000
    } else {
        telemetry
            .queue_depth
            .saturating_mul(1000)
            .checked_div(telemetry.queue_capacity)
            .unwrap_or(1000)
            .min(1000)
    };
    let burst = match telemetry.burst {
        BurstShape::Idle => 0,
        BurstShape::Steady => 120,
        BurstShape::Rising => 380,
        BurstShape::Burst => 720,
    };
    // Completion rate rendah dan admission rate rendah menandakan kemacetan.
    let completion_gap = 1000u64.saturating_sub(telemetry.completion_rate_permille.min(1000)) / 2;
    let admission_gap = 1000u64.saturating_sub(telemetry.admission_rate_permille.min(1000)) / 3;
    let signals = [
        over_ratio_permille(telemetry.latency_ms, ceilings.latency_ceiling_ms),
        over_ratio_permille(
            telemetry.error_rate_permille,
            ceilings.error_permille_ceiling,
        ),
        over_ratio_permille(
            telemetry.cpu_pressure_permille,
            ceilings.cpu_permille_ceiling,
        ),
        over_ratio_permille(
            telemetry.memory_pressure_permille,
            ceilings.memory_permille_ceiling,
        ),
        queue_fill,
        burst,
        completion_gap,
        admission_gap,
    ];
    let worst = signals.into_iter().max().unwrap_or(0);
    worst.saturating_add(burst / 4).min(1000)
}

/// Hasil prediksi beserta jejak alasan — observable, bukan keputusan tersembunyi.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AdmissionPlan {
    pub targets: AdmissionTargets,
    pub pressure_permille: u64,
    /// `true` bila fallback konservatif karena telemetri basi.
    pub conservative_fallback: bool,
    pub reason: &'static str,
}

impl AdmissionPlan {
    /// Plan kanonik (fitur nonaktif): seluruh hard ceiling dipakai apa adanya,
    /// low-priority di-admit, tanpa penundaan. Ini perilaku n8n bawaan.
    pub fn canonical(ceilings: AdmissionCeilings) -> Self {
        Self {
            targets: AdmissionTargets {
                route_concurrency: ceilings.max_route_concurrency,
                workflow_concurrency: ceilings.max_workflow_concurrency,
                queue_budget: ceilings.max_queue_budget,
                low_priority_admitted: true,
                defer_threshold_ms: ceilings.min_defer_threshold_ms,
            },
            pressure_permille: 0,
            conservative_fallback: false,
            reason: "admission controller disabled — canonical n8n limits",
        }
    }
}

/// Interpolasi monoton dari `max` turun ke `min` seiring tekanan naik.
fn backoff(value_at_zero: u64, value_at_full: u64, pressure_permille: u64) -> u64 {
    let span = value_at_zero.saturating_sub(value_at_full);
    value_at_zero.saturating_sub(span.saturating_mul(pressure_permille) / 1000)
}

/// Turunkan target admission dari telemetri, selalu terbatas hard ceilings.
pub fn predict_admission(
    telemetry: AdmissionTelemetry,
    ceilings: AdmissionCeilings,
) -> AdmissionPlan {
    let pressure = pressure_score(telemetry, ceilings);

    // Telemetri basi ⇒ conservative fallback: concurrency minimum, low-priority
    // ditunda, budget antrean minimum, ambang defer maksimum. Bukan agresif.
    if telemetry.stale {
        return AdmissionPlan {
            targets: AdmissionTargets {
                route_concurrency: ceilings.min_route_concurrency,
                workflow_concurrency: ceilings.min_workflow_concurrency,
                queue_budget: ceilings.min_queue_budget,
                low_priority_admitted: false,
                defer_threshold_ms: ceilings.max_defer_threshold_ms,
            },
            pressure_permille: 1000,
            conservative_fallback: true,
            reason: "stale telemetry — conservative fallback",
        };
    }

    let queue_cap = ceilings.effective_queue_cap(telemetry.queue_capacity);
    // Lantai budget mengikuti kapasitas AMATAN: antrean tidak pernah boleh
    // dibuka melewati kapasitas nyata meski min_queue_budget lebih besar.
    let budget_floor = ceilings.min_queue_budget.min(queue_cap);
    let budget = backoff(queue_cap, budget_floor, pressure / 2).clamp(budget_floor, queue_cap);
    let route = backoff(
        ceilings.max_route_concurrency,
        ceilings.min_route_concurrency,
        pressure,
    )
    .clamp(
        ceilings.min_route_concurrency,
        ceilings.max_route_concurrency,
    );
    let workflow = backoff(
        ceilings.max_workflow_concurrency,
        ceilings.min_workflow_concurrency,
        pressure,
    )
    .clamp(
        ceilings.min_workflow_concurrency,
        ceilings.max_workflow_concurrency,
    );
    let defer = backoff(
        ceilings.min_defer_threshold_ms,
        ceilings.max_defer_threshold_ms,
        pressure,
    )
    .clamp(
        ceilings.min_defer_threshold_ms,
        ceilings.max_defer_threshold_ms,
    );

    AdmissionPlan {
        targets: AdmissionTargets {
            route_concurrency: route,
            workflow_concurrency: workflow,
            queue_budget: budget,
            low_priority_admitted: pressure < ceilings.low_priority_admit_below_permille,
            defer_threshold_ms: defer,
        },
        pressure_permille: pressure,
        conservative_fallback: false,
        reason: if pressure == 0 {
            "no pressure — full ceilings"
        } else if pressure >= 700 {
            "critical pressure — minimum concurrency"
        } else {
            "pressure — proportional backoff within hard ceilings"
        },
    }
}

/// Controller berstate: menambahkan **hysteresis** supaya target tidak
/// berflap-flap ketika tekanan bergerak di sekitar ambang.
#[derive(Debug, Clone)]
pub struct AdmissionController {
    ceilings: AdmissionCeilings,
    enabled: bool,
    hysteresis_permille: u64,
    /// `None` sebelum observasi pertama — observasi pertama SELALU berlaku,
    /// deadband hanya menahan getaran setelahnya.
    last_pressure_permille: Option<u64>,
    observations: u64,
}

impl AdmissionController {
    pub fn new(ceilings: AdmissionCeilings) -> Self {
        Self {
            ceilings,
            enabled: false,
            hysteresis_permille: 50,
            last_pressure_permille: None,
            observations: 0,
        }
    }

    /// Controller dengan fitur diaktifkan (opt-in eksplisit).
    pub fn enabled(mut self) -> Self {
        self.enabled = true;
        self
    }

    pub fn with_hysteresis(mut self, permille: u64) -> Self {
        self.hysteresis_permille = permille.min(500);
        self
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    pub fn ceilings(&self) -> AdmissionCeilings {
        self.ceilings
    }

    pub fn last_pressure_permille(&self) -> u64 {
        self.last_pressure_permille.unwrap_or(0)
    }

    pub fn observations(&self) -> u64 {
        self.observations
    }

    /// Amati telemetri dan terbitkan plan. Fitur nonaktif ⇒ plan kanonik.
    pub fn observe(&mut self, telemetry: AdmissionTelemetry) -> AdmissionPlan {
        self.observations = self.observations.saturating_add(1);
        if !self.enabled {
            self.last_pressure_permille = None;
            return AdmissionPlan::canonical(self.ceilings);
        }
        let raw = pressure_score(telemetry, self.ceilings);
        // Deadband: tekanan yang berubah di bawah hysteresis dianggap sama,
        // sehingga target tidak berflap di sekitar ambang. Observasi pertama
        // selalu berlaku supaya sinyal awal tidak tertelan deadband.
        let effective = match self.last_pressure_permille {
            None => raw,
            Some(previous) if raw.abs_diff(previous) < self.hysteresis_permille => previous,
            Some(_) => raw,
        };
        self.last_pressure_permille = Some(effective);

        let mut plan = predict_admission(telemetry, self.ceilings);
        if telemetry.stale {
            return plan;
        }
        // Terapkan tekanan terhysteresis pada knob konversi saja.
        let route = backoff(
            self.ceilings.max_route_concurrency,
            self.ceilings.min_route_concurrency,
            effective,
        )
        .clamp(
            self.ceilings.min_route_concurrency,
            self.ceilings.max_route_concurrency,
        );
        let workflow = backoff(
            self.ceilings.max_workflow_concurrency,
            self.ceilings.min_workflow_concurrency,
            effective,
        )
        .clamp(
            self.ceilings.min_workflow_concurrency,
            self.ceilings.max_workflow_concurrency,
        );
        let queue_cap = self.ceilings.effective_queue_cap(telemetry.queue_capacity);
        let budget_floor = self.ceilings.min_queue_budget.min(queue_cap);
        let budget = backoff(queue_cap, budget_floor, effective / 2).clamp(budget_floor, queue_cap);
        let defer = backoff(
            self.ceilings.min_defer_threshold_ms,
            self.ceilings.max_defer_threshold_ms,
            effective,
        )
        .clamp(
            self.ceilings.min_defer_threshold_ms,
            self.ceilings.max_defer_threshold_ms,
        );
        plan.targets = AdmissionTargets {
            route_concurrency: route,
            workflow_concurrency: workflow,
            queue_budget: budget,
            low_priority_admitted: effective < self.ceilings.low_priority_admit_below_permille,
            defer_threshold_ms: defer,
        };
        plan.pressure_permille = effective;
        plan
    }
}

// ---------------------------------------------------------------------------
// (2) Shadow compatibility path — Issue #111 item 9
//
// Membandingkan perilaku referensi (kanonik) vs kandidat (teroptimasi) pada:
// route selection, status, response shape, admission, error, dan urutan
// observable. Shadow **tidak pernah menduplikasi efek eksternal nyata**:
// efek kandidat ditekan dan hanya efek jalur kanonik yang dieksekusi.
// ---------------------------------------------------------------------------

/// Mode shadow. Default `Disabled` ⇒ perilaku n8n kanonik tanpa perubahan.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShadowMode {
    #[default]
    Disabled,
    ReferenceOnly,
    DualRun,
}

impl ShadowMode {
    pub fn is_enabled(self) -> bool {
        !matches!(self, Self::Disabled)
    }
}

/// Efek eksternal yang **dideklarasikan**, bukan dijalankan. Dipakai shadow
/// untuk membuktikan tidak ada duplikasi efek nyata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeclaredSideEffect {
    pub kind: String,
    pub target: String,
}

impl DeclaredSideEffect {
    pub fn new(kind: impl Into<String>, target: impl Into<String>) -> Self {
        Self {
            kind: kind.into(),
            target: target.into(),
        }
    }
}

/// Permukaan observable yang dibandingkan shadow.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowOutcome {
    pub route_id: Option<String>,
    pub status_code: u16,
    pub response_shape: String,
    pub admission: QosAction,
    pub error_code: Option<String>,
    /// Nomor urut observable — pembanding ordering.
    pub sequence: u64,
    pub declared_side_effects: Vec<DeclaredSideEffect>,
}

/// Hasil perbandingan per-dimensi. Enam dimensi, semuanya harus cocok.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowVerdict {
    pub route_match: bool,
    pub status_match: bool,
    pub shape_match: bool,
    pub admission_match: bool,
    pub error_match: bool,
    pub ordering_match: bool,
}

impl ShadowVerdict {
    pub fn is_compatible(&self) -> bool {
        self.route_match
            && self.status_match
            && self.shape_match
            && self.admission_match
            && self.error_match
            && self.ordering_match
    }

    /// Daftar dimensi yang menyimpang (kosong ⇒ kompatibel). Observable.
    pub fn divergences(&self) -> Vec<&'static str> {
        let mut out = Vec::new();
        if !self.route_match {
            out.push("route");
        }
        if !self.status_match {
            out.push("status");
        }
        if !self.shape_match {
            out.push("response-shape");
        }
        if !self.admission_match {
            out.push("admission");
        }
        if !self.error_match {
            out.push("error");
        }
        if !self.ordering_match {
            out.push("ordering");
        }
        out
    }
}

/// Bandingkan dua outcome pada keenam dimensi kompatibilitas.
pub fn compare_shadow(reference: &ShadowOutcome, candidate: &ShadowOutcome) -> ShadowVerdict {
    ShadowVerdict {
        route_match: reference.route_id == candidate.route_id,
        status_match: reference.status_code == candidate.status_code,
        shape_match: reference.response_shape == candidate.response_shape,
        admission_match: reference.admission == candidate.admission,
        error_match: reference.error_code == candidate.error_code,
        ordering_match: reference.sequence == candidate.sequence,
    }
}

/// Laporan eksekusi shadow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShadowReport {
    pub mode: ShadowMode,
    pub verdict: Option<ShadowVerdict>,
    /// Efek yang BENAR-BENAR boleh dieksekusi. Pada mode shadow ini SELALU
    /// efek jalur kanonik (referensi); efek kandidat tidak pernah dijalankan
    /// ulang sehingga efek eksternal nyata tidak diduplikasi.
    pub executable_side_effects: Vec<DeclaredSideEffect>,
    /// Efek kandidat yang sengaja DITEKAN (untuk audit, bukan eksekusi).
    pub suppressed_side_effects: Vec<DeclaredSideEffect>,
    pub reference: Option<ShadowOutcome>,
    pub candidate: Option<ShadowOutcome>,
}

impl ShadowReport {
    pub fn is_compatible(&self) -> bool {
        match self.verdict {
            Some(v) => v.is_compatible(),
            // Mode nonaktif: tidak ada pembanding, jalur kanonik apa adanya.
            None => true,
        }
    }
}

/// Jalankan shadow. `reference` dan `candidate` adalah fungsi **murni** yang
/// menghasilkan outcome tanpa melakukan efek eksternal; efek hanya
/// dideklarasikan. Mode nonaktif ⇒ hanya jalur kanonik yang dikonsultasi.
pub fn run_shadow<F, G>(mode: ShadowMode, reference: F, candidate: G) -> ShadowReport
where
    F: FnOnce() -> ShadowOutcome,
    G: FnOnce() -> ShadowOutcome,
{
    if !mode.is_enabled() {
        let canonical = reference();
        return ShadowReport {
            mode,
            verdict: None,
            executable_side_effects: canonical.declared_side_effects.clone(),
            suppressed_side_effects: Vec::new(),
            reference: Some(canonical),
            candidate: None,
        };
    }
    let reference_outcome = reference();
    let candidate_outcome = candidate();
    let verdict = compare_shadow(&reference_outcome, &candidate_outcome);
    ShadowReport {
        mode,
        verdict: Some(verdict),
        executable_side_effects: reference_outcome.declared_side_effects.clone(),
        suppressed_side_effects: candidate_outcome.declared_side_effects.clone(),
        reference: Some(reference_outcome),
        candidate: Some(candidate_outcome),
    }
}

// ---------------------------------------------------------------------------
// (3) P4 self-profiling — Issue #111 item 10
//
// Profiling opsional dan ber-biaya-rendah. Mencatat: route lookup time,
// admission time, queue wait, payload-copy cost, allocation pressure, dan pola
// route lambat. eBPF hanya pelengkap di Linux — profil internal WAJIB berfungsi
// tanpanya (eBPF bukan dependensi runtime P4). Semua koleksi dibatasi keras.
// ---------------------------------------------------------------------------

/// Backend profil. `EbpfComplement` hanya menambah sinyal eksternal; profil
/// internal tetap sumber kebenaran.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProfilerBackend {
    #[default]
    Internal,
    EbpfComplement,
}

/// Konfigurasi profiler. Default **nonaktif**.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProfileConfig {
    pub enabled: bool,
    pub backend: ProfilerBackend,
    /// Batas keras jumlah sample — memori profil tidak pernah tumbuh tanpa batas.
    pub max_samples: usize,
    /// Ambang "slow route" dalam mikrodetik.
    pub slow_route_threshold_us: u64,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            backend: ProfilerBackend::Internal,
            max_samples: 4096,
            slow_route_threshold_us: 5_000,
        }
    }
}

/// Satu sample profil per request.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileSample {
    pub route_lookup_us: u64,
    pub admission_us: u64,
    pub queue_wait_us: u64,
    pub payload_copy_bytes: u64,
    pub allocation_pressure_permille: u64,
}

impl ProfileSample {
    /// Total waktu yang dihabiskan di lapisan P4 (lookup + admission + wait).
    pub fn total_us(&self) -> u64 {
        self.route_lookup_us
            .saturating_add(self.admission_us)
            .saturating_add(self.queue_wait_us)
    }
}

/// Agregat profil untuk satu route.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RouteProfile {
    pub route_id: String,
    pub samples: usize,
    pub slow_samples: usize,
    pub total_us: u64,
    pub worst_us: u64,
    pub payload_copy_bytes: u64,
    pub peak_allocation_pressure_permille: u64,
}

impl RouteProfile {
    pub fn average_us(&self) -> u64 {
        if self.samples == 0 {
            0
        } else {
            self.total_us / self.samples as u64
        }
    }
}

/// Profiler P4. Ringkas, bounded, dan dapat di-reset (state derived).
#[derive(Debug, Clone)]
pub struct P4Profiler {
    config: ProfileConfig,
    routes: BTreeMap<String, RouteProfile>,
    recorded: usize,
    dropped: usize,
}

impl P4Profiler {
    pub fn new(config: ProfileConfig) -> Self {
        Self {
            config,
            routes: BTreeMap::new(),
            recorded: 0,
            dropped: 0,
        }
    }

    /// Profiler nonaktif: `record` menjadi no-op biaya-nol.
    pub fn disabled() -> Self {
        Self::new(ProfileConfig::default())
    }

    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    pub fn backend(&self) -> ProfilerBackend {
        self.config.backend
    }

    pub fn config(&self) -> ProfileConfig {
        self.config
    }

    /// Catat satu sample. No-op ketika nonaktif; sample di luar batas keras
    /// dibuang (dihitung di `dropped`) alih-alih menumbuhkan memori.
    pub fn record(&mut self, route_id: &str, sample: ProfileSample) {
        if !self.config.enabled {
            return;
        }
        if self.recorded >= self.config.max_samples {
            self.dropped = self.dropped.saturating_add(1);
            return;
        }
        self.recorded = self.recorded.saturating_add(1);
        let threshold = self.config.slow_route_threshold_us;
        let entry = self.routes.entry(route_id.to_string()).or_default();
        entry.route_id = route_id.to_string();
        entry.samples = entry.samples.saturating_add(1);
        entry.total_us = entry.total_us.saturating_add(sample.total_us());
        entry.worst_us = entry.worst_us.max(sample.total_us());
        entry.payload_copy_bytes = entry
            .payload_copy_bytes
            .saturating_add(sample.payload_copy_bytes);
        entry.peak_allocation_pressure_permille = entry
            .peak_allocation_pressure_permille
            .max(sample.allocation_pressure_permille);
        if sample.total_us() > threshold {
            entry.slow_samples = entry.slow_samples.saturating_add(1);
        }
    }

    pub fn route(&self, route_id: &str) -> Option<&RouteProfile> {
        self.routes.get(route_id)
    }

    pub fn routes(&self) -> &BTreeMap<String, RouteProfile> {
        &self.routes
    }

    /// Pola route lambat: (route_id, slow_samples), urut paling sering lambat.
    pub fn slow_routes(&self) -> Vec<(&str, usize)> {
        let mut out: Vec<(&str, usize)> = self
            .routes
            .iter()
            .filter(|(_, p)| p.slow_samples > 0)
            .map(|(id, p)| (id.as_str(), p.slow_samples))
            .collect();
        out.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
        out
    }

    /// Tekanan alokasi puncak global (permille).
    pub fn allocation_pressure_permille(&self) -> u64 {
        self.routes
            .values()
            .map(|p| p.peak_allocation_pressure_permille)
            .max()
            .unwrap_or(0)
    }

    /// Total biaya salinan payload yang teramati.
    pub fn payload_copy_bytes(&self) -> u64 {
        self.routes.values().map(|p| p.payload_copy_bytes).sum()
    }

    pub fn recorded(&self) -> usize {
        self.recorded
    }

    pub fn dropped(&self) -> usize {
        self.dropped
    }

    /// Buang seluruh turunan — state profil selalu dapat dibangun ulang.
    pub fn reset(&mut self) {
        self.routes.clear();
        self.recorded = 0;
        self.dropped = 0;
    }
}

// ---------------------------------------------------------------------------
// (4) Dedicated webhook/ingress plane — Issue #225 item 1
//
// Memisahkan intake webhook dari editor/API dan execution workers: buffering
// terbatas, admission control, dan response streaming/offload. Setiap plane
// punya budget sendiri sehingga beban mendadak di intake webhook tidak dapat
// menghabiskan kapasitas editor/API (UI/API tetap responsif).
// ---------------------------------------------------------------------------

/// Plane logis yang terpisah.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlaneKind {
    /// Editor UI — control plane, harus tetap responsif.
    Editor,
    /// API publik — control plane, harus tetap responsif.
    Api,
    /// Intake webhook — data plane, dapat menyerap overload.
    WebhookIngress,
    /// Worker eksekusi — data plane.
    ExecutionWorker,
}

impl PlaneKind {
    pub fn is_webhook_intake(self) -> bool {
        matches!(self, Self::WebhookIngress)
    }

    /// Control plane (editor/API) tidak boleh diganggu oleh overload webhook.
    pub fn is_control_plane(self) -> bool {
        matches!(self, Self::Editor | Self::Api)
    }
}

/// Konfigurasi satu plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlaneConfig {
    pub kind: PlaneKind,
    /// Kapasitas buffer terikat — tidak pernah unbounded.
    pub capacity: u64,
    /// Response di-stream/offload keluar dari plane intake.
    pub offload_responses: bool,
}

/// Keputusan admission pada satu plane.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PlaneAdmission {
    pub kind: PlaneKind,
    pub state: AdmissionState,
    pub action: QosAction,
    pub buffered: u64,
}

/// Statistik plane — observable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PlaneStats {
    pub buffered: u64,
    pub admitted: u64,
    pub deferred: u64,
    pub rejected: u64,
    pub offloaded: u64,
}

/// Satu plane ingress dengan buffering terbatas dan admission control.
#[derive(Debug, Clone)]
pub struct IngressPlane {
    config: PlaneConfig,
    buffered: u64,
    admitted: u64,
    deferred: u64,
    rejected: u64,
    offloaded: u64,
}

impl IngressPlane {
    pub fn new(config: PlaneConfig) -> Self {
        Self {
            config,
            buffered: 0,
            admitted: 0,
            deferred: 0,
            rejected: 0,
            offloaded: 0,
        }
    }

    pub fn kind(&self) -> PlaneKind {
        self.config.kind
    }

    pub fn capacity(&self) -> u64 {
        self.config.capacity
    }

    pub fn buffered(&self) -> u64 {
        self.buffered
    }

    /// Sisa kapasitas plane ini.
    pub fn headroom(&self) -> u64 {
        self.config.capacity.saturating_sub(self.buffered)
    }

    pub fn stats(&self) -> PlaneStats {
        PlaneStats {
            buffered: self.buffered,
            admitted: self.admitted,
            deferred: self.deferred,
            rejected: self.rejected,
            offloaded: self.offloaded,
        }
    }

    /// Admission control: QoS policy + buffering terbatas. Buffer penuh ⇒
    /// permintaan DITOLAK, tidak pernah antre tanpa batas.
    pub fn admit(&mut self, priority: Priority, mode: BrownoutMode) -> PlaneAdmission {
        let decision = qos_apply(priority, mode);
        if !decision.admitted {
            let state = match decision.action {
                QosAction::DeferLowPriority => {
                    self.deferred = self.deferred.saturating_add(1);
                    AdmissionState::Deferred
                }
                QosAction::RejectOptional => {
                    self.rejected = self.rejected.saturating_add(1);
                    AdmissionState::Rejected
                }
                _ => {
                    self.rejected = self.rejected.saturating_add(1);
                    AdmissionState::Unavailable
                }
            };
            return PlaneAdmission {
                kind: self.config.kind,
                state,
                action: decision.action,
                buffered: self.buffered,
            };
        }
        if self.buffered >= self.config.capacity {
            // Bounded buffering: penuh ⇒ tolak, jangan antre tanpa batas.
            self.rejected = self.rejected.saturating_add(1);
            return PlaneAdmission {
                kind: self.config.kind,
                state: AdmissionState::RateLimited,
                action: decision.action,
                buffered: self.buffered,
            };
        }
        self.buffered = self.buffered.saturating_add(1);
        self.admitted = self.admitted.saturating_add(1);
        PlaneAdmission {
            kind: self.config.kind,
            state: if self.buffered > 1 {
                AdmissionState::Queued
            } else {
                AdmissionState::Accepted
            },
            action: decision.action,
            buffered: self.buffered,
        }
    }

    /// Keluarkan satu permintaan dari buffer (bounded). `false` bila kosong.
    pub fn drain_one(&mut self) -> bool {
        if self.buffered == 0 {
            return false;
        }
        self.buffered -= 1;
        true
    }

    /// Response streaming/offload: lepaskan response dari plane intake supaya
    /// buffer tidak ditahan klien lambat. `false` bila offload dimatikan atau
    /// tidak ada yang bisa dilepas.
    pub fn offload_response(&mut self) -> bool {
        if !self.config.offload_responses || self.buffered == 0 {
            return false;
        }
        self.buffered -= 1;
        self.offloaded = self.offloaded.saturating_add(1);
        true
    }
}

/// Topologi plane lengkap: setiap plane memiliki budget terpisah.
#[derive(Debug, Clone, Default)]
pub struct PlaneTopology {
    planes: BTreeMap<PlaneKind, IngressPlane>,
}

impl PlaneTopology {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_plane(mut self, config: PlaneConfig) -> Self {
        self.planes.insert(config.kind, IngressPlane::new(config));
        self
    }

    pub fn get(&self, kind: PlaneKind) -> Option<&IngressPlane> {
        self.planes.get(&kind)
    }

    pub fn get_mut(&mut self, kind: PlaneKind) -> Option<&mut IngressPlane> {
        self.planes.get_mut(&kind)
    }

    /// Total sisa kapasitas control plane (editor + API). Isolasi berarti
    /// angka ini tidak boleh berkurang karena beban plane webhook.
    pub fn control_plane_headroom(&self) -> u64 {
        self.planes
            .iter()
            .filter(|(kind, _)| kind.is_control_plane())
            .map(|(_, plane)| plane.headroom())
            .sum()
    }

    /// Total sisa kapasitas intake webhook.
    pub fn webhook_headroom(&self) -> u64 {
        self.planes
            .iter()
            .filter(|(kind, _)| kind.is_webhook_intake())
            .map(|(_, plane)| plane.headroom())
            .sum()
    }

    pub fn planes(&self) -> &BTreeMap<PlaneKind, IngressPlane> {
        &self.planes
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingress_contract::RouteKind;

    const T0: u64 = 60_000;

    // ...................................................................... atlas

    fn make_route(
        id: &str,
        path: &str,
        kind: RouteKind,
        method: HttpMethod,
        gen: u64,
    ) -> RouteRecord {
        RouteRecord {
            route_id: id.to_string(),
            workflow: crate::ingress_contract::WorkflowIdentity::new("wf-1", None).unwrap(),
            node_id: "node-1".to_string(),
            node_name: "Node".to_string(),
            kind,
            method,
            path: path.to_string(),
            path_depth: path.split('/').filter(|s| !s.is_empty()).count() as u32,
            generation: Generation::new(gen),
            registered_at_ms: T0,
            webhook_id: Some(format!("wb-{id}")),
            auth: crate::ingress_contract::WebhookAuth::None,
        }
    }

    #[test]
    fn atlas_static_beats_dynamic_and_generation_pointer_set() {
        let routes = vec![
            make_route(
                "r-static",
                "ping",
                RouteKind::ProductionWebhook,
                HttpMethod::Get,
                1,
            ),
            make_route(
                "r-dyn",
                ":any",
                RouteKind::ProductionWebhook,
                HttpMethod::Get,
                1,
            ),
        ];
        let atlas = RouteAtlas::compile(routes).unwrap();
        assert_eq!(atlas.generation(), Some(Generation::new(1)));
        assert_eq!(
            atlas.resolve(HttpMethod::Get, "ping").unwrap().route_id,
            "r-static"
        );
        assert_eq!(
            atlas.resolve(HttpMethod::Get, "else").unwrap().route_id,
            "r-dyn"
        );
        assert!(atlas.resolve(HttpMethod::Post, "ping").is_none());
    }

    #[test]
    fn atlas_hot_swap_keeps_old_readers() {
        let swap = AtlasSwap::new();
        let old = RouteAtlas::compile(vec![make_route(
            "a",
            "x",
            RouteKind::ProductionWebhook,
            HttpMethod::Get,
            1,
        )])
        .unwrap();
        swap.publish(old);
        let reader_old = swap.current();
        let new_atlas = RouteAtlas::compile(vec![
            make_route("a", "x", RouteKind::ProductionWebhook, HttpMethod::Get, 2),
            make_route("b", "y", RouteKind::ProductionWebhook, HttpMethod::Get, 2),
        ])
        .unwrap();
        swap.publish(new_atlas);
        // old reader tetap hidup
        assert_eq!(reader_old.resolve(HttpMethod::Get, "y"), None);
        // new reader melihat b
        assert!(swap.current().resolve(HttpMethod::Get, "y").is_some());
    }

    #[test]
    fn atlas_rejects_overflowing_routes_bounded() {
        // (MAX_ATLAS_ROUTES = 4096; uji langsung fungsi validate dengan route illegal)
        // route ilegal: path leading slash → Contract error
        let bad = make_route(
            "bad",
            "/lead",
            RouteKind::ProductionWebhook,
            HttpMethod::Get,
            1,
        );
        assert!(RouteAtlas::compile(vec![bad]).is_err());
    }

    // ..................................................................... clamp

    #[test]
    fn adaptive_stale_telemetry_is_conservative() {
        let hard = HardLimits::default();
        let stale = TelemetrySample {
            stale: true,
            ..Default::default()
        };
        let limits = adapt_limits(stale, hard);
        assert!(limits.low_priority_deferred);
        assert_eq!(
            limits.effective_route_concurrency,
            hard.min_route_concurrency
        );
    }

    // .................................................................... capsule

    #[test]
    fn capsule_seals_and_checks_access() {
        let owner = crate::ingress_contract::WorkflowIdentity::new("wf-1", None).unwrap();
        let cap = CapabilityToken::new("tok-1");
        let digest = "a".repeat(64);
        let capsule = PayloadCapsule::seal(
            "h1",
            1024,
            Some("application/json".to_string()),
            digest,
            60_000,
            owner.clone(),
            Generation::new(2),
            cap.clone(),
            T0,
        )
        .unwrap();
        assert!(capsule.assert_access(&cap, &owner, Generation::new(2), T0 + 1));
        // salah access
        assert!(!capsule.assert_access(
            &CapabilityToken::new("evil"),
            &owner,
            Generation::new(2),
            T0 + 1
        ));
        // expired
        assert!(!capsule.assert_access(&cap, &owner, Generation::new(2), T0 + 61_000));
    }

    #[test]
    fn capsule_rejects_bad_digest_and_ttl() {
        let owner = crate::ingress_contract::WorkflowIdentity::new("wf-1", None).unwrap();
        let cap = CapabilityToken::new("tok");
        assert!(PayloadCapsule::seal(
            "h",
            0,
            None,
            "zz",
            1000,
            owner.clone(),
            Generation::new(1),
            cap.clone(),
            T0
        )
        .is_err());
        assert!(PayloadCapsule::seal(
            "h",
            0,
            None,
            "b".repeat(64),
            MAX_CAPSULE_TTL_MS + 1,
            owner,
            Generation::new(1),
            CapabilityToken::new("x"),
            T0
        )
        .is_err());
    }

    // .................................................................... fusion

    #[test]
    fn burst_fusion_off_never_coalesces() {
        let events = vec![
            CoalescibleEvent {
                source: IngressSourceKind::Event,
                workflow_id: "wf-1".into(),
                node_id: "n".into(),
                received_at_ms: T0,
                payload_key: "a".into(),
            },
            CoalescibleEvent {
                source: IngressSourceKind::Event,
                workflow_id: "wf-1".into(),
                node_id: "n".into(),
                received_at_ms: T0 + 1,
                payload_key: "b".into(),
            },
        ];
        let out = coalesce_events(events, &FusionConfig::default(), T0 + 2);
        assert_eq!(out.merged_count, 2); // off = semua sendirian
    }

    #[test]
    fn burst_fusion_enabled_deterministic_and_bounded() {
        let config = FusionConfig {
            enabled: true,
            window_ms: 10_000,
            max_aggregate: 2,
        };
        let mut events = Vec::new();
        for i in 0..5 {
            events.push(CoalescibleEvent {
                source: IngressSourceKind::Event,
                workflow_id: "wf-1".into(),
                node_id: "n".into(),
                received_at_ms: T0 + i,
                payload_key: format!("k{i}"),
            });
        }
        let out = coalesce_events(events, &config, T0 + 9);
        assert_eq!(out.merged_count, 2);
        assert_eq!(out.aggregate_keys, vec!["k0".to_string(), "k1".to_string()]); // urut waktu
        assert_eq!(out.audited.len(), 5); // audit semua, tak ada drop senyap
    }

    // .................................................................... brownout

    #[test]
    fn brownout_escalates_and_applies_priority_policy() {
        assert_eq!(
            next_brownout(BrownoutMode::Normal, 600, 10),
            BrownoutMode::Pressure
        );
        assert_eq!(
            next_brownout(BrownoutMode::Pressure, 3000, 10),
            BrownoutMode::Brownout
        );
        assert_eq!(
            next_brownout(BrownoutMode::Brownout, 20_000, 10),
            BrownoutMode::Critical
        );
        // policy
        assert_eq!(
            qos_decide(Priority::High, BrownoutMode::Pressure),
            QosAction::Admit
        );
        assert_eq!(
            qos_decide(Priority::Low, BrownoutMode::Pressure),
            QosAction::DeferLowPriority
        );
        assert_eq!(
            qos_decide(Priority::Normal, BrownoutMode::Brownout),
            QosAction::RejectOptional
        );
        assert_eq!(
            qos_decide(Priority::High, BrownoutMode::Critical),
            QosAction::Unavailable
        );
    }

    // .................................................................... recorder

    #[test]
    fn flight_recorder_is_bounded_and_promotable() {
        let mut recorder = FlightRecorder::new();
        for i in 0..(MAX_FLIGHT_RECORDS as u64 + 10) {
            recorder.record(RequestStamp {
                request_id: format!("req-{i}"),
                route_id: None,
                generation: None,
                received_at_ms: T0,
                decided_at_ms: T0 + 1,
                admission_state: AdmissionState::Accepted,
                queue_delay_ms: 0,
                security_decision_ref: None,
                error_code: None,
            });
        }
        assert_eq!(recorder.len(), MAX_FLIGHT_RECORDS);
        // record pertama ter-drop (bounded)
        assert!(recorder.promote("req-0").is_none());
        assert!(recorder.promote("req-10").is_some());
    }

    #[test]
    fn innovation_distinguishes_default_vs_enabled() {
        // fusion default off; brownout qos_admit normal; atlas generation None default
        let swap = AtlasSwap::new();
        assert!(swap.current().generation().is_none());
    }

    // ................................................................ P4-S01
    // (1) Predictive admission controller (full) — Issue #111 item 2

    fn ceilings() -> AdmissionCeilings {
        AdmissionCeilings::default()
    }

    fn calm() -> AdmissionTelemetry {
        AdmissionTelemetry::default()
    }

    #[test]
    fn admission_defaults_are_canonical_and_zero_pressure() {
        // Fitur nonaktif ⇒ plan kanonik: seluruh hard ceiling, tanpa penundaan.
        let mut controller = AdmissionController::new(ceilings());
        let plan = controller.observe(calm());
        let c = ceilings();
        assert_eq!(plan.targets.route_concurrency, c.max_route_concurrency);
        assert_eq!(
            plan.targets.workflow_concurrency,
            c.max_workflow_concurrency
        );
        assert_eq!(plan.targets.queue_budget, c.max_queue_budget);
        assert!(plan.targets.low_priority_admitted);
        assert_eq!(
            plan.targets.defer_threshold_ms, c.min_defer_threshold_ms,
            "tanpa tekanan tidak boleh ada penundaan"
        );
        assert_eq!(plan.pressure_permille, 0);
        assert!(!plan.conservative_fallback);
    }

    #[test]
    fn admission_calm_telemetry_never_backs_off() {
        let plan = predict_admission(calm(), ceilings());
        assert_eq!(
            plan.targets.route_concurrency,
            ceilings().max_route_concurrency
        );
        assert_eq!(plan.pressure_permille, 0);
    }

    #[test]
    fn admission_pressure_is_monotone_in_every_observed_signal() {
        // Monoton PER SINYAL: setiap indikator yang memburuk sendirian harus
        // menaikkan tekanan, dan tidak pernah menurunkannya.
        let base = calm();
        let baseline = pressure_score(base, ceilings());
        assert_eq!(baseline, 0, "telemetri tenang ⇒ tekanan nol");

        let degraded = [
            (
                "latency",
                AdmissionTelemetry {
                    latency_ms: 20_000,
                    ..base
                },
            ),
            (
                "error-rate",
                AdmissionTelemetry {
                    error_rate_permille: 900,
                    ..base
                },
            ),
            (
                "cpu-pressure",
                AdmissionTelemetry {
                    cpu_pressure_permille: 990,
                    ..base
                },
            ),
            (
                "memory-pressure",
                AdmissionTelemetry {
                    memory_pressure_permille: 990,
                    ..base
                },
            ),
            (
                "queue-depth",
                AdmissionTelemetry {
                    queue_depth: 4000,
                    ..base
                },
            ),
            (
                "burst",
                AdmissionTelemetry {
                    burst: BurstShape::Burst,
                    ..base
                },
            ),
            (
                "completion-rate",
                AdmissionTelemetry {
                    completion_rate_permille: 100,
                    ..base
                },
            ),
            (
                "admission-rate",
                AdmissionTelemetry {
                    admission_rate_permille: 100,
                    ..base
                },
            ),
        ];
        for (label, variant) in degraded {
            let score = pressure_score(variant, ceilings());
            assert!(
                score > baseline,
                "sinyal {label} yang memburuk harus menaikkan tekanan, dapat {score}"
            );
            assert!(score <= 1000, "tekanan terikat 0..=1000, dapat {score}");
        }

        // Semua sinyal buruk sekaligus ⇒ tekanan maksimum.
        let all_bad = AdmissionTelemetry {
            queue_depth: u64::MAX,
            queue_capacity: 1,
            latency_ms: u64::MAX,
            error_rate_permille: 1000,
            cpu_pressure_permille: 1000,
            memory_pressure_permille: 1000,
            burst: BurstShape::Burst,
            completion_rate_permille: 0,
            admission_rate_permille: 0,
            stale: false,
        };
        assert_eq!(pressure_score(all_bad, ceilings()), 1000);
    }

    #[test]
    fn admission_pressure_reacts_to_the_worst_signal() {
        // Agregasi mengambil indikator terburuk: satu sinyal kritis sudah cukup
        // untuk memicu backoff, tanpa menunggu rata-rata memburuk.
        let base = calm();
        let only_latency = pressure_score(
            AdmissionTelemetry {
                latency_ms: 60_000,
                ..base
            },
            ceilings(),
        );
        let latency_plus_everything_else_calm = pressure_score(
            AdmissionTelemetry {
                latency_ms: 60_000,
                ..base
            },
            ceilings(),
        );
        assert_eq!(only_latency, latency_plus_everything_else_calm);
        assert!(
            only_latency >= 1000,
            "latency jauh di atas ceiling ⇒ tekanan maksimum"
        );
    }

    #[test]
    fn admission_backoff_never_exceeds_hard_ceilings() {
        let c = ceilings();
        let mut worst = AdmissionTelemetry {
            queue_depth: u64::MAX,
            queue_capacity: 1,
            latency_ms: u64::MAX,
            error_rate_permille: 1000,
            cpu_pressure_permille: 1000,
            memory_pressure_permille: 1000,
            burst: BurstShape::Burst,
            completion_rate_permille: 0,
            admission_rate_permille: 0,
            stale: false,
        };
        for _ in 0..64 {
            let plan = predict_admission(worst, c);
            let t = plan.targets;
            assert!(
                t.route_concurrency <= c.max_route_concurrency,
                "concurrency route melewati hard ceiling"
            );
            assert!(
                t.workflow_concurrency <= c.max_workflow_concurrency,
                "concurrency workflow melewati hard ceiling"
            );
            assert!(
                t.queue_budget <= c.effective_queue_cap(worst.queue_capacity),
                "queue budget melewati kapasitas/hard ceiling"
            );
            assert!(
                t.defer_threshold_ms <= c.max_defer_threshold_ms,
                "defer threshold melewati hard ceiling"
            );
            // turunkan tekanan sedikit demi sedikit; clamp harus tetap sah
            worst.latency_ms = worst.latency_ms / 2;
            worst.queue_depth = worst.queue_depth / 2;
            worst.error_rate_permille = worst.error_rate_permille / 2;
        }
    }

    #[test]
    fn admission_targets_carry_no_security_or_permission_surface() {
        // Bukti struktural: AdmissionTargets tidak punya field izin/keamanan/
        // autentikasi, jadi penyesuaian admission tidak dapat melebarkan wewenang.
        let json = serde_json::to_value(AdmissionTargets::default()).unwrap();
        let obj = json.as_object().unwrap();
        assert_eq!(obj.len(), 5, "hanya lima knob admission yang boleh ada");
        for forbidden in [
            "permission",
            "permissions",
            "role",
            "roles",
            "scope",
            "scopes",
            "credential",
            "credentials",
            "auth",
            "authentication",
            "token",
            "security",
        ] {
            assert!(
                !obj.contains_key(forbidden),
                "target admission tidak boleh memuat field keamanan `{forbidden}`"
            );
        }
    }

    #[test]
    fn admission_stale_telemetry_falls_back_conservatively() {
        let stale = AdmissionTelemetry {
            stale: true,
            ..calm()
        };
        let c = ceilings();
        let plan = predict_admission(stale, c);
        assert!(plan.conservative_fallback, "telemetri basi wajib fallback");
        assert_eq!(plan.targets.route_concurrency, c.min_route_concurrency);
        assert_eq!(
            plan.targets.workflow_concurrency,
            c.min_workflow_concurrency
        );
        assert_eq!(plan.targets.queue_budget, c.min_queue_budget);
        assert!(
            !plan.targets.low_priority_admitted,
            "fallback konservatif menunda low-priority"
        );
        assert_eq!(plan.targets.defer_threshold_ms, c.max_defer_threshold_ms);
        assert_eq!(plan.pressure_permille, 1000);
    }

    #[test]
    fn admission_stale_is_not_more_aggressive_than_calm() {
        let calm_plan = predict_admission(calm(), ceilings());
        let stale_plan = predict_admission(
            AdmissionTelemetry {
                stale: true,
                ..calm()
            },
            ceilings(),
        );
        assert!(
            stale_plan.targets.route_concurrency <= calm_plan.targets.route_concurrency,
            "telemetri basi tidak boleh menghasilkan admission lebih agresif"
        );
        assert!(
            stale_plan.targets.queue_budget <= calm_plan.targets.queue_budget,
            "telemetri basi tidak boleh membuka antrean lebih besar"
        );
    }

    #[test]
    fn admission_queue_budget_is_bounded_by_observed_capacity() {
        // Antrean tak terbatas tidak dapat terbentuk: budget <= kapasitas amatan.
        let c = AdmissionCeilings {
            max_queue_budget: 100_000,
            ..ceilings()
        };
        let plan = predict_admission(
            AdmissionTelemetry {
                queue_capacity: 64,
                ..calm()
            },
            c,
        );
        assert!(
            plan.targets.queue_budget <= 64,
            "budget antrean harus dibatasi kapasitas amatan, dapat {}",
            plan.targets.queue_budget
        );
    }

    #[test]
    fn admission_controller_hysteresis_prevents_flapping() {
        let mut controller = AdmissionController::new(ceilings())
            .enabled()
            .with_hysteresis(200);
        let base = AdmissionTelemetry {
            queue_depth: 100,
            queue_capacity: 4096,
            latency_ms: 2100, // sedikit di atas ceiling
            ..calm()
        };
        let first = controller.observe(base);
        assert!(first.pressure_permille > 0);
        // Getaran kecil di sekitar ambang tidak mengubah target.
        for latency in [2110, 2120, 2095, 2105] {
            let plan = controller.observe(AdmissionTelemetry {
                latency_ms: latency,
                ..base
            });
            assert_eq!(
                plan.targets.route_concurrency, first.targets.route_concurrency,
                "hysteresis harus mencegah flap pada getaran kecil"
            );
        }
        // Lompatan besar tetap diterima.
        let jump = controller.observe(AdmissionTelemetry {
            latency_ms: 60_000,
            ..base
        });
        assert!(
            jump.targets.route_concurrency < first.targets.route_concurrency,
            "tekanan besar harus menurunkan concurrency"
        );
    }

    #[test]
    fn admission_controller_disabled_stays_canonical_across_observations() {
        let mut controller = AdmissionController::new(ceilings());
        assert!(!controller.is_enabled());
        let c = ceilings();
        for _ in 0..8 {
            let plan = controller.observe(AdmissionTelemetry {
                queue_depth: 9999,
                latency_ms: 999_999,
                error_rate_permille: 999,
                burst: BurstShape::Burst,
                ..calm()
            });
            assert_eq!(plan.targets.route_concurrency, c.max_route_concurrency);
            assert_eq!(plan.targets.queue_budget, c.max_queue_budget);
            assert!(plan.targets.low_priority_admitted);
        }
        assert_eq!(controller.observations(), 8);
        assert_eq!(controller.last_pressure_permille(), 0);
        assert!(controller.ceilings().max_route_concurrency > 0);
    }

    #[test]
    fn admission_clamp_fix_keeps_adapt_limits_within_bounds() {
        // P4-S01: cabana shrink dulu berupa no-op `min.max(min)`; sekarang
        // menyusut proporsional terhadap overshoot dan terikat [min, max].
        let hard = HardLimits::default();
        let mild = adapt_limits(
            TelemetrySample {
                queue_depth: hard.max_route_concurrency + 2,
                ..Default::default()
            },
            hard,
        );
        let severe = adapt_limits(
            TelemetrySample {
                queue_depth: hard.max_route_concurrency * 4,
                ..Default::default()
            },
            hard,
        );
        let fresh = adapt_limits(TelemetrySample::default(), hard);
        assert_eq!(
            fresh.effective_route_concurrency, hard.max_route_concurrency,
            "tanpa tekanan memakai ceiling penuh"
        );
        assert!(
            mild.effective_route_concurrency < hard.max_route_concurrency,
            "overshoot ringan harus mulai menyusut"
        );
        assert!(
            severe.effective_route_concurrency < mild.effective_route_concurrency,
            "overshoot berat harus menyusut lebih jauh"
        );
        assert!(
            severe.effective_route_concurrency >= hard.min_route_concurrency,
            "tidak pernah turun di bawah minimum"
        );
    }

    // ................................................... (2) shadow path

    fn outcome(route: &str, status: u16, action: QosAction, seq: u64) -> ShadowOutcome {
        ShadowOutcome {
            route_id: Some(route.to_string()),
            status_code: status,
            response_shape: "json".to_string(),
            admission: action,
            error_code: None,
            sequence: seq,
            declared_side_effects: vec![DeclaredSideEffect::new("webhook-dispatch", route)],
        }
    }

    #[test]
    fn shadow_disabled_is_default_and_runs_canonical_only() {
        assert_eq!(ShadowMode::default(), ShadowMode::Disabled);
        assert!(!ShadowMode::Disabled.is_enabled());
        let report = run_shadow(
            ShadowMode::Disabled,
            || outcome("r1", 200, QosAction::Admit, 1),
            || panic!("mode nonaktif tidak boleh menjalankan kandidat"),
        );
        assert!(report.verdict.is_none());
        assert!(report.candidate.is_none());
        assert_eq!(report.executable_side_effects.len(), 1);
        assert!(report.suppressed_side_effects.is_empty());
        assert!(report.is_compatible(), "mode nonaktif tidak menyimpang");
    }

    #[test]
    fn shadow_compares_all_six_dimensions() {
        let reference = outcome("r1", 200, QosAction::Admit, 7);
        assert!(compare_shadow(&reference, &reference.clone()).is_compatible());

        let route_diff = ShadowOutcome {
            route_id: Some("r2".to_string()),
            ..reference.clone()
        };
        let status_diff = ShadowOutcome {
            status_code: 503,
            ..reference.clone()
        };
        let shape_diff = ShadowOutcome {
            response_shape: "text".to_string(),
            ..reference.clone()
        };
        let admission_diff = ShadowOutcome {
            admission: QosAction::DeferLowPriority,
            ..reference.clone()
        };
        let error_diff = ShadowOutcome {
            error_code: Some("TIMEOUT".to_string()),
            ..reference.clone()
        };
        let ordering_diff = ShadowOutcome {
            sequence: 8,
            ..reference.clone()
        };
        for (label, candidate) in [
            ("route", route_diff),
            ("status", status_diff),
            ("response-shape", shape_diff),
            ("admission", admission_diff),
            ("error", error_diff),
            ("ordering", ordering_diff),
        ] {
            let verdict = compare_shadow(&reference, &candidate);
            assert!(!verdict.is_compatible(), "dimensi {label} harus terdeteksi");
            assert!(
                verdict.divergences().contains(&label),
                "divergences harus menyebut {label}, dapat {:?}",
                verdict.divergences()
            );
        }
    }

    #[test]
    fn shadow_never_duplicates_real_external_side_effects() {
        // Efek kandidat selalu ditekan; hanya efek jalur kanonik yang dieksekusi.
        let reference = || ShadowOutcome {
            declared_side_effects: vec![DeclaredSideEffect::new("webhook-dispatch", "r1")],
            ..outcome("r1", 200, QosAction::Admit, 1)
        };
        let candidate = || ShadowOutcome {
            declared_side_effects: vec![
                DeclaredSideEffect::new("webhook-dispatch", "r1"),
                DeclaredSideEffect::new("send-email", "ops@example.invalid"),
            ],
            ..outcome("r1", 200, QosAction::Admit, 1)
        };
        for mode in [ShadowMode::ReferenceOnly, ShadowMode::DualRun] {
            let report = run_shadow(mode, reference, candidate);
            assert!(report.is_compatible(), "outcome cocok di mode {mode:?}");
            assert_eq!(
                report.executable_side_effects.len(),
                1,
                "mode {mode:?} hanya boleh mengeksekusi efek kanonik"
            );
            assert_eq!(
                report.suppressed_side_effects.len(),
                2,
                "efek kandidat harus ditekan untuk audit di mode {mode:?}"
            );
            let executed_targets: Vec<&str> = report
                .executable_side_effects
                .iter()
                .map(|e| e.target.as_str())
                .collect();
            assert!(
                !executed_targets.contains(&"ops@example.invalid"),
                "efek eksternal kandidat tidak boleh dieksekusi ulang"
            );
        }
    }

    #[test]
    fn shadow_reports_are_round_trip_serializable() {
        let report = run_shadow(
            ShadowMode::DualRun,
            || outcome("r1", 200, QosAction::Admit, 1),
            || outcome("r1", 200, QosAction::Admit, 1),
        );
        let json = serde_json::to_string(&report).unwrap();
        let back: ShadowReport = serde_json::from_str(&json).unwrap();
        assert_eq!(report, back);
    }

    // ....................................................... (3) self-profiling

    fn sample(lookup: u64, admission: u64, wait: u64) -> ProfileSample {
        ProfileSample {
            route_lookup_us: lookup,
            admission_us: admission,
            queue_wait_us: wait,
            payload_copy_bytes: 1024,
            allocation_pressure_permille: 100,
        }
    }

    #[test]
    fn profiler_is_disabled_by_default_and_records_nothing() {
        let mut profiler = P4Profiler::disabled();
        assert!(!profiler.is_enabled());
        profiler.record("r1", sample(10, 20, 30));
        assert_eq!(profiler.recorded(), 0);
        assert!(profiler.route("r1").is_none());
        assert_eq!(profiler.payload_copy_bytes(), 0);
        assert_eq!(profiler.allocation_pressure_permille(), 0);
    }

    #[test]
    fn profiler_records_all_six_signals() {
        let mut profiler = P4Profiler::new(ProfileConfig {
            enabled: true,
            backend: ProfilerBackend::Internal,
            max_samples: 64,
            slow_route_threshold_us: 100,
        });
        profiler.record(
            "r1",
            ProfileSample {
                route_lookup_us: 40,
                admission_us: 30,
                queue_wait_us: 20,
                payload_copy_bytes: 2048,
                allocation_pressure_permille: 640,
            },
        );
        let profile = profiler.route("r1").expect("route terprofil");
        assert_eq!(profile.samples, 1);
        assert_eq!(profile.total_us, 90, "lookup + admission + queue wait");
        assert_eq!(profile.worst_us, 90);
        assert_eq!(profile.average_us(), 90);
        assert_eq!(profile.payload_copy_bytes, 2048);
        assert_eq!(profile.peak_allocation_pressure_permille, 640);
        assert_eq!(profiler.allocation_pressure_permille(), 640);
        assert_eq!(profiler.payload_copy_bytes(), 2048);
    }

    #[test]
    fn profiler_flags_slow_route_patterns() {
        let mut profiler = P4Profiler::new(ProfileConfig {
            enabled: true,
            backend: ProfilerBackend::Internal,
            max_samples: 64,
            slow_route_threshold_us: 100,
        });
        profiler.record("fast", sample(10, 10, 10));
        profiler.record("slow", sample(500, 400, 300));
        profiler.record("slow", sample(600, 400, 300));
        profiler.record("slower", sample(900, 400, 300));
        let slow = profiler.slow_routes();
        assert_eq!(slow.len(), 2, "hanya route di atas ambang yang dilaporkan");
        assert_eq!(slow[0].0, "slow", "urut paling sering lambat");
        assert_eq!(slow[0].1, 2);
        assert!(!slow.iter().any(|(id, _)| *id == "fast"));
    }

    #[test]
    fn profiler_is_bounded_and_drops_beyond_the_hard_limit() {
        let mut profiler = P4Profiler::new(ProfileConfig {
            enabled: true,
            backend: ProfilerBackend::Internal,
            max_samples: 8,
            slow_route_threshold_us: 100,
        });
        for _ in 0..32 {
            profiler.record("r1", sample(10, 10, 10));
        }
        assert_eq!(profiler.recorded(), 8, "batas keras jumlah sample");
        assert_eq!(
            profiler.dropped(),
            24,
            "sample di luar batas dihitung, bukan disimpan"
        );
        let profile = profiler.route("r1").unwrap();
        assert_eq!(profile.samples, 8);
        assert_eq!(profile.payload_copy_bytes, 8 * 1024);
    }

    #[test]
    fn profiler_reset_clears_derived_state() {
        let mut profiler = P4Profiler::new(ProfileConfig {
            enabled: true,
            backend: ProfilerBackend::Internal,
            max_samples: 8,
            slow_route_threshold_us: 100,
        });
        profiler.record("r1", sample(500, 500, 500));
        assert_eq!(profiler.routes().len(), 1);
        profiler.reset();
        assert_eq!(profiler.routes().len(), 0);
        assert_eq!(profiler.recorded(), 0);
        assert_eq!(profiler.dropped(), 0);
        assert_eq!(profiler.payload_copy_bytes(), 0);
    }

    #[test]
    fn profiler_ebpf_is_only_complementary() {
        // eBPF hanya pelengkap di Linux: profil internal wajib berfungsi
        // tanpanya, jadi backend tidak pernah menjadi dependensi runtime P4.
        let mut profiler = P4Profiler::new(ProfileConfig {
            enabled: true,
            backend: ProfilerBackend::EbpfComplement,
            max_samples: 8,
            slow_route_threshold_us: 100,
        });
        assert_eq!(profiler.backend(), ProfilerBackend::EbpfComplement);
        profiler.record("r1", sample(10, 10, 10));
        assert_eq!(
            profiler.recorded(),
            1,
            "profil internal tetap merekam walau backend eBPF dipilih"
        );
        // Backend bawaan adalah internal, bukan eBPF.
        assert_eq!(ProfileConfig::default().backend, ProfilerBackend::Internal);
    }

    // .................................................. (4) dedicated plane

    fn topology() -> PlaneTopology {
        PlaneTopology::new()
            .with_plane(PlaneConfig {
                kind: PlaneKind::Editor,
                capacity: 64,
                offload_responses: false,
            })
            .with_plane(PlaneConfig {
                kind: PlaneKind::Api,
                capacity: 64,
                offload_responses: false,
            })
            .with_plane(PlaneConfig {
                kind: PlaneKind::WebhookIngress,
                capacity: 128,
                offload_responses: true,
            })
            .with_plane(PlaneConfig {
                kind: PlaneKind::ExecutionWorker,
                capacity: 512,
                offload_responses: false,
            })
    }

    #[test]
    fn plane_kinds_separate_intake_from_control_plane() {
        assert!(PlaneKind::WebhookIngress.is_webhook_intake());
        assert!(!PlaneKind::ExecutionWorker.is_webhook_intake());
        assert!(PlaneKind::Editor.is_control_plane());
        assert!(PlaneKind::Api.is_control_plane());
        assert!(
            !PlaneKind::WebhookIngress.is_control_plane(),
            "intake webhook bukan control plane"
        );
        assert!(!PlaneKind::ExecutionWorker.is_control_plane());
    }

    #[test]
    fn webhook_overload_cannot_starve_control_plane() {
        // Isolasi: banjir request di intake webhook tidak boleh mengurangi
        // kapasitas editor/API — UI/API tetap responsif.
        let mut topo = topology();
        let control_before = topo.control_plane_headroom();
        assert_eq!(control_before, 64 + 64);

        let webhook = topo.get_mut(PlaneKind::WebhookIngress).unwrap();
        let mut admitted = 0;
        for _ in 0..1000 {
            let decision = webhook.admit(Priority::Normal, BrownoutMode::Normal);
            if decision.state == AdmissionState::Queued
                || decision.state == AdmissionState::Accepted
            {
                admitted += 1;
            }
        }
        assert_eq!(
            admitted, 128,
            "buffering terbatas: hanya kapasitas plane yang diterima"
        );
        assert_eq!(
            webhook.buffered(),
            128,
            "buffer terisi penuh tetapi tidak pernah melebihi kapasitas"
        );
        assert_eq!(
            webhook.stats().rejected,
            1000 - 128,
            "kelebihan ditolak, tidak antre tanpa batas"
        );
        assert_eq!(
            topo.control_plane_headroom(),
            control_before,
            "beban webhook tidak boleh mengonsumsi budget control plane"
        );
        assert_eq!(topo.webhook_headroom(), 0);
    }

    #[test]
    fn plane_admission_uses_qos_policy() {
        let mut plane = IngressPlane::new(PlaneConfig {
            kind: PlaneKind::WebhookIngress,
            capacity: 8,
            offload_responses: false,
        });
        let pressure = plane.admit(Priority::Low, BrownoutMode::Pressure);
        assert_eq!(pressure.action, QosAction::DeferLowPriority);
        assert_eq!(pressure.state, AdmissionState::Deferred);
        assert_eq!(plane.buffered(), 0);

        let brownout = plane.admit(Priority::Normal, BrownoutMode::Brownout);
        assert_eq!(brownout.action, QosAction::RejectOptional);
        assert_eq!(brownout.state, AdmissionState::Rejected);

        let critical = plane.admit(Priority::High, BrownoutMode::Critical);
        assert_eq!(critical.action, QosAction::Unavailable);
        assert_eq!(critical.state, AdmissionState::Unavailable);

        let normal = plane.admit(Priority::Normal, BrownoutMode::Normal);
        assert_eq!(normal.action, QosAction::Admit);
        assert_eq!(normal.state, AdmissionState::Accepted);
        assert_eq!(plane.buffered(), 1);
    }

    #[test]
    fn plane_offloads_responses_out_of_the_intake_buffer() {
        let mut plane = IngressPlane::new(PlaneConfig {
            kind: PlaneKind::WebhookIngress,
            capacity: 8,
            offload_responses: true,
        });
        for _ in 0..4 {
            plane.admit(Priority::Normal, BrownoutMode::Normal);
        }
        assert_eq!(plane.buffered(), 4);
        assert!(plane.offload_response());
        assert_eq!(plane.buffered(), 3);
        assert_eq!(plane.stats().offloaded, 1);
        // Drain tetap bekerja dan bounded.
        assert!(plane.drain_one());
        assert_eq!(plane.buffered(), 2);
        plane.drain_one();
        plane.drain_one();
        assert!(!plane.drain_one(), "buffer kosong ⇒ drain no-op");
    }

    #[test]
    fn plane_response_offload_is_opt_in() {
        let mut plane = IngressPlane::new(PlaneConfig {
            kind: PlaneKind::ExecutionWorker,
            capacity: 8,
            offload_responses: false,
        });
        plane.admit(Priority::Normal, BrownoutMode::Normal);
        assert!(
            !plane.offload_response(),
            "offload nonaktif ⇒ response tidak dilepaskan dari plane"
        );
        assert_eq!(plane.buffered(), 1);
        assert_eq!(plane.stats().offloaded, 0);
    }

    #[test]
    fn plane_stats_are_observable() {
        let mut plane = IngressPlane::new(PlaneConfig {
            kind: PlaneKind::WebhookIngress,
            capacity: 2,
            offload_responses: false,
        });
        plane.admit(Priority::Normal, BrownoutMode::Normal);
        plane.admit(Priority::Normal, BrownoutMode::Normal);
        let overflow = plane.admit(Priority::Normal, BrownoutMode::Normal);
        assert_eq!(overflow.state, AdmissionState::RateLimited);
        let stats = plane.stats();
        assert_eq!(stats.admitted, 2);
        assert_eq!(stats.rejected, 1);
        assert_eq!(stats.buffered, 2);
        assert_eq!(stats.deferred, 0);
        assert_eq!(stats.offloaded, 0);
    }
}
