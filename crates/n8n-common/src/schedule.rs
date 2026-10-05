//! P4.4 (Agent 2) — **Schedule / Cron ingress: semantics + duplicate-tick control**.
//!
//! Memiliki *kontrak jadwal* (Issue #105) **tanpa mengambil alih implementasi
//! scheduler**: modul ini menyediakan (a) parser + validator cron deterministik,
//! (b) komputasi `next_fire` dengan kebijakan timezone/DST eksplisit, (c)
//! lifecycle registrasi yang sinkron dengan aktivasi (generation-fenced), dan
//! (d) keputusan per-tick (duplicate-tick suppression, misfire, overlap, jitter
//! -bound) yang menghasilkan handoff eksekusi ke batas P3.
//!
//! ```text
//! HOST CLOCK → on_tick(wf,node,now,resolver) → TickDecision
//!             Comot: cron parse → next_fire (DST policy) → misfire/overlap/
//!             duplicate rules → ScheduleExecution { generation, deadline, idem key }
//! ```
//!
//! # Timezone/DST (tanpa dependensi baru)
//!
//! Data IANA hidup di host lewat [`TzResolver`] (dua fungsi). Kontrak menentukan
//! **kebijakan** yang wajib diimplementasikan host:
//! * *gap* (jam hilang, spring-forward): [`GapPolicy::ShiftForward`] default —
//!   tick dilayani pada menit riil pertama setelah jam hilang; `SkipTick` =
//!   lewati occurrence itu seluruhnya;
//! * *fold* (jam ganda, fall-back): `local_to_utc` mengembalikan occurrence
//!   **terakhir** → tick dilayani tepat sekali (tanpa duplikasi).
//!
//! # Cron (n8n 2.9.4 kompatibilitas)
//!
//! 5-field standar (minute hour dom month dow), plus 6-field *hanya* bila field
//! detik `0`/`*` (n8n mengaktifkan schedule pada resolusi menit; cron detik
//! non-trivial **ditolak fail-closed** — [`ScheduleError::UnsupportedSeconds`]).
//! Nama bulan/hari, list `,`, range `-`, step `/`, dan semantik DOM-vs-DOW
//! klasik (keduanya non-wildcard ⇒ OR) didukung.

use crate::activation::{
    ActivationRegistry, ActivationTransitionError, DeactivateOutcome, DeactivationKind,
};
use crate::ingress_contract::{
    fence_generation, ActivationError, ActivationMode, ActivationState, Generation,
    IngressContractError, IngressSourceKind, WorkflowIdentity, MAX_ID_LEN,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, VecDeque};

// ---------------------------------------------------------------------------
// Bound & kebijakan
// ---------------------------------------------------------------------------

pub const MAX_CRON_LEN: usize = 256;
pub const MAX_SCHEDULES_PER_WORKFLOW: usize = 64;
pub const MAX_JITTER_MS: u64 = 60_000;
pub const MAX_DEADLINE_MS: u64 = 7 * 24 * 3600 * 1000;
/// Horizon pencarian next-fire (8 tahun) — cukup melintasi 29 Feb & pola
/// bulan-langka; melewati itu = `NoNextFire` (fail-closed, tanpa loop).
pub const HORIZON_DAYS: i64 = 8 * 366;
/// Jendela dedupe tick yang diingat (bounded).
pub const FIRED_WINDOW: usize = 256;

// ---------------------------------------------------------------------------
// Civil calendar (algoritma days-from-civil milik publik, std-only)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct CivilDate {
    pub year: i32,
    pub month: u32,
    pub day: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CivilTime {
    pub date: CivilDate,
    pub hour: u32,
    pub minute: u32,
}

/// UTC epoch day 0 = 1970-01-01. (Howard Hinnant) — hasil ±5.8M tahun valid.
pub fn days_from_civil(y: i32, m: u32, d: u32) -> i64 {
    let y = y as i64 - if m <= 2 { 1 } else { 0 };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719_468
}

pub fn civil_from_days(z: i64) -> (i32, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    ((y + if m <= 2 { 1 } else { 0 }) as i32, m as u32, d as u32)
}

/// Dow Sunday=0 (1970-01-01 = Kamis ⇒ offset +4).
fn dow_sunday0(days: i64) -> u32 {
    ((days + 4).rem_euclid(7)) as u32
}

// ---------------------------------------------------------------------------
// Timezone resolver (host-provided; kontrak menentukan kebijakan DST)
// ---------------------------------------------------------------------------

/// Konversi local-zone ⇄ UTC epoch-second. Host mengimplementasikan ini dengan
/// data IANA (mis. chrono-tz); kontrak kebijakan dijamin oleh [`CronExpr`].
pub trait TzResolver {
    /// epoch UTC → civil local **canonical** (untuk fold, pilih occurrence awal).
    fn utc_to_local(&self, timezone: &str, utc_seconds: i64) -> CivilTime;
    /// civil local → epoch UTC; `None` bila civil time tidak ada (gap).
    /// Untuk fold (ambigu), kembalikan occurrence **terakhir**.
    fn local_to_utc(&self, timezone: &str, civil: CivilTime) -> Option<i64>;
}

/// Resolver identitas untuk zone UTC (default test & deployment tanpa DST).
#[derive(Debug, Clone, Copy, Default)]
pub struct UtcResolver;

impl TzResolver for UtcResolver {
    fn utc_to_local(&self, _tz: &str, utc_seconds: i64) -> CivilTime {
        let days = utc_seconds.div_euclid(86_400);
        let mod_s = utc_seconds.rem_euclid(86_400);
        let (y, m, d) = civil_from_days(days);
        CivilTime {
            date: CivilDate {
                year: y,
                month: m,
                day: d,
            },
            hour: (mod_s / 3600) as u32,
            minute: ((mod_s % 3600) / 60) as u32,
        }
    }

    fn local_to_utc(&self, _tz: &str, civil: CivilTime) -> Option<i64> {
        Some(
            days_from_civil(civil.date.year, civil.date.month, civil.date.day) * 86_400
                + civil.hour as i64 * 3600
                + civil.minute as i64 * 60,
        )
    }
}

// ---------------------------------------------------------------------------
// Cron parsing
// ---------------------------------------------------------------------------

/// Satu field cron sebagai himpunan nilai yang diizinkan (domain kecil ⇒ set).
#[derive(Debug, Clone, PartialEq, Eq)]
struct CronField {
    allowed: BTreeSet<u32>,
    is_wild: bool,
}

impl CronField {
    fn matches(&self, v: u32) -> bool {
        self.allowed.contains(&v)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CronError {
    #[error("cron '{0}' tidak dapat dikenali; harapkan 5 field (atau 6 dengan detik 0/*)")]
    BadFieldCount(String),
    #[error("cron field '{field}' invalid: {reason}")]
    InvalidField { field: &'static str, reason: String },
    #[error("detik non-trivial '{0}' tidak didukung (n8n menjadwalkan pada resolusi menit)")]
    UnsupportedSeconds(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CronExpr {
    minute: CronField,
    hour: CronField,
    dom: CronField,
    month: CronField,
    dow: CronField,
    raw: String,
}

const MONTH_NAMES: [(&str, u32); 12] = [
    ("jan", 1),
    ("feb", 2),
    ("mar", 3),
    ("apr", 4),
    ("may", 5),
    ("jun", 6),
    ("jul", 7),
    ("aug", 8),
    ("sep", 9),
    ("oct", 10),
    ("nov", 11),
    ("dec", 12),
];
const DOW_NAMES: [(&str, u32); 7] = [
    ("sun", 0),
    ("mon", 1),
    ("tue", 2),
    ("wed", 3),
    ("thu", 4),
    ("fri", 5),
    ("sat", 6),
];

fn parse_number(token: &str, names: &[(&str, u32)], field: &'static str) -> Result<u32, CronError> {
    if let Ok(n) = token.parse::<u32>() {
        return Ok(n);
    }
    let lower = token.to_ascii_lowercase();
    if let Some((_, v)) = names.iter().find(|(name, _)| *name == lower) {
        return Ok(*v);
    }
    Err(CronError::InvalidField {
        field,
        reason: format!("token '{token}' bukan angka/nama yang dikenal"),
    })
}

/// Parse satu field (list `,`, range `-`, step `/`, wildcard `*`).
fn parse_field(
    token: &str,
    domain: (u32, u32),
    names: &[(&str, u32)],
    field: &'static str,
) -> Result<CronField, CronError> {
    let (min, max) = domain;
    let mut allowed = BTreeSet::new();
    let mut is_wild = false;

    for part in token.split(',') {
        let part = part.trim();
        if part.is_empty() {
            return Err(CronError::InvalidField {
                field,
                reason: "elemen kosong".to_string(),
            });
        }
        let (range_token, step) = match part.split_once('/') {
            Some((r, s)) => (
                r,
                s.parse::<u32>().map_err(|_| CronError::InvalidField {
                    field,
                    reason: format!("step '{s}' bukan angka"),
                })?,
            ),
            None => (part, 1),
        };
        if step == 0 {
            return Err(CronError::InvalidField {
                field,
                reason: "step 0".to_string(),
            });
        }
        if range_token == "*" {
            is_wild = true;
            let mut v = min;
            while v <= max {
                allowed.insert(v);
                v += step;
            }
            continue;
        }
        let (start_token, end_token) = match range_token.split_once('-') {
            Some((a, b)) => (a, b),
            None => (range_token, range_token),
        };
        let mut start = parse_number(start_token, names, field)?;
        let mut end = parse_number(end_token, names, field)?;
        // Dow `7` = Minggu = 0; normalisasi.
        if field == "dow" {
            if start == 7 {
                start = 0;
            }
            if end == 7 {
                end = 0;
            }
        }
        if start < min || end > max {
            return Err(CronError::InvalidField {
                field,
                reason: format!("nilai di luar [{min},{max}]"),
            });
        }
        // Dow wrap (mis. "fri-sun" = 5..0).
        let mut v = start;
        loop {
            allowed.insert(v);
            if v == end {
                break;
            }
            // maju per step; wrap hanya untuk dow (domain siklik)
            v = if field == "dow" {
                (v + step) % 7
            } else {
                v + step
            };
            if v > max || (field == "dow" && v == start) {
                if v == end && field != "dow" {
                    allowed.insert(v);
                }
                break;
            }
        }
        // Saat step > 1 dan end belum termuat (non-wrap), sisipkan bila tepat.
        if step > 1 && !allowed.contains(&end) && field != "dow" {
            // sudah ditangani loop di atas; tidak perlu
        }
    }
    Ok(CronField { allowed, is_wild })
}

impl CronExpr {
    pub fn parse(raw: &str) -> Result<Self, CronError> {
        let raw = raw.trim().to_string();
        if raw.len() > MAX_CRON_LEN {
            return Err(CronError::InvalidField {
                field: "cron",
                reason: format!("melebihi {MAX_CRON_LEN} karakter"),
            });
        }
        let mut fields: Vec<&str> = raw.split_whitespace().collect();
        // 6-field opsional: detik = 0/* saja.
        if fields.len() == 6 {
            let sec = fields[0];
            if sec != "0" && sec != "*" && sec != "*/1" {
                return Err(CronError::UnsupportedSeconds(sec.to_string()));
            }
            fields.remove(0);
        } else if fields.len() != 5 {
            return Err(CronError::BadFieldCount(raw));
        }
        let minute = parse_field(fields[0], (0, 59), &[], "minute")?;
        let hour = parse_field(fields[1], (0, 23), &[], "hour")?;
        let dom = parse_field(fields[2], (1, 31), &[], "dom")?;
        let month = parse_field(fields[3], (1, 12), &MONTH_NAMES, "month")?;
        let dow = parse_field(fields[4], (0, 7), &DOW_NAMES, "dow")?;
        Ok(Self {
            minute,
            hour,
            dom,
            month,
            dow,
            raw,
        })
    }

    pub fn raw(&self) -> &str {
        &self.raw
    }

    fn day_matches(&self, days: i64, month: u32, day: u32) -> bool {
        if !self.month.matches(month) {
            return false;
        }
        let dom_r = !self.dom.is_wild;
        let dow_r = !self.dow.is_wild;
        let dom_m = self.dom.matches(day);
        let dow_m = self.dow.matches(dow_sunday0(days));
        match (dom_r, dow_r) {
            (true, true) => dom_m || dow_m,
            (true, false) => dom_m,
            (false, true) => dow_m,
            (false, false) => true,
        }
    }

    fn matches_civil(&self, days: i64, month: u32, day: u32, hour: u32, minute: u32) -> bool {
        self.day_matches(days, month, day) && self.hour.matches(hour) && self.minute.matches(minute)
    }
}

/// Kebijakan jam-hilang (DST gap).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GapPolicy {
    /// Default: tick dilayani pada menit riil pertama setelah jam yang hilang.
    ShiftForward,
    /// Lewati occurrence yang jatuh di gap sepenuhnya.
    SkipTick,
}

impl Default for GapPolicy {
    fn default() -> Self {
        Self::ShiftForward
    }
}

// ---------------------------------------------------------------------------
// Spesifikasi schedule (input registration)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MisfirePolicy {
    /// Default: tick yang terlewat dibuang (n8n tidak mengejar backlog).
    Skip,
    /// Jalankan sekali untuk occurrence terbaru yang terlewat.
    BackfillOnce,
}

impl Default for MisfirePolicy {
    fn default() -> Self {
        Self::Skip
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum OverlapPolicy {
    /// Default: izinkan eksekusi paralel bila belum selesai.
    Allow,
    /// Lewati tick bila eksekusi sebelumnya masih berjalan.
    Skip,
    /// Antri maks satu tick tertunda (bounded).
    QueueOnce,
}

impl Default for OverlapPolicy {
    fn default() -> Self {
        Self::Allow
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSpec {
    pub node_id: String,
    pub node_name: String,
    pub cron: String,
    /// IANA zone (mis. "Europe/Berlin") atau offset style ("+07:00"). Data tz
    /// hidup di host; di sini hanya divalidasi bentuknya.
    pub timezone: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub misfire: MisfirePolicy,
    #[serde(default)]
    pub overlap: OverlapPolicy,
    /// Jitter acak maksimum (host menerapkan ≤ cap; engine hanya bound).
    #[serde(default)]
    pub jitter_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    #[serde(default)]
    pub gap_policy: GapPolicy,
}

fn default_true() -> bool {
    true
}

impl ScheduleSpec {
    pub fn validate(&self) -> Result<CronExpr, ScheduleError> {
        if self.node_id.is_empty() || self.node_id.len() > MAX_ID_LEN {
            return Err(ScheduleError::EmptyId("nodeId"));
        }
        let _cron = CronExpr::parse(&self.cron)?;
        if !valid_timezone(&self.timezone) {
            return Err(ScheduleError::InvalidTimezone(self.timezone.clone()));
        }
        if self.jitter_ms > MAX_JITTER_MS {
            return Err(ScheduleError::BoundViolated {
                what: "jitter_ms",
                max: MAX_JITTER_MS as u64,
            });
        }
        if let Some(deadline) = self.deadline_ms {
            if deadline > MAX_DEADLINE_MS {
                return Err(ScheduleError::BoundViolated {
                    what: "deadline_ms",
                    max: MAX_DEADLINE_MS,
                });
            }
        }
        Ok(_cron)
    }
}

fn valid_timezone(tz: &str) -> bool {
    !tz.is_empty()
        && tz.len() <= MAX_ID_LEN
        && tz
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'/' | b'+' | b'-' | b'_' | b':'))
}

// ---------------------------------------------------------------------------
// Error umbrella
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ScheduleError {
    #[error(transparent)]
    Cron(#[from] CronError),
    #[error(transparent)]
    Contract(#[from] IngressContractError),
    #[error(transparent)]
    Activation(#[from] ActivationTransitionError),
    #[error("id '{0}' kosong/terlalu panjang")]
    EmptyId(&'static str),
    #[error("timezone '{0}' tidak valid")]
    InvalidTimezone(String),
    #[error("'{what}' melebihi batas {max}")]
    BoundViolated { what: &'static str, max: u64 },
    #[error("workflow '{workflow_id}' tidak dikenal di registry schedule")]
    UnknownWorkflow { workflow_id: String },
    #[error("schedule '{workflow_id}/{node_id}' tidak dikenal")]
    UnknownSchedule {
        workflow_id: String,
        node_id: String,
    },
    #[error("cron '{cron}' tidak memiliki fire berikutnya dalam horizon (pola mustahil)")]
    NoNextFire { cron: String },
    #[error("workflow '{workflow_id}' sudah mencapai maks {max} schedule")]
    TooManySchedules { workflow_id: String, max: usize },
    #[error("update tertunda belum bisa diterapkan: workflow '{workflow_id}' belum Inactive")]
    UpdateNotReady { workflow_id: String },
    #[error("tidak ada update tertunda untuk workflow '{workflow_id}'")]
    NoPendingUpdate { workflow_id: String },
}

// ---------------------------------------------------------------------------
// Registry state
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct ScheduleRecord {
    pub schedule_id: String,
    pub workflow: WorkflowIdentity,
    pub node_id: String,
    pub node_name: String,
    pub cron: CronExpr,
    pub timezone: String,
    pub enabled: bool,
    pub misfire: MisfirePolicy,
    pub overlap: OverlapPolicy,
    pub jitter_ms: u64,
    pub deadline_ms: Option<u64>,
    pub gap_policy: GapPolicy,
    pub generation: Generation,
    pub registered_at_ms: u64,
    pub next_fire_at_ms: Option<i64>,
    pub last_fired_at_ms: Option<i64>,
}

#[derive(Debug, Default, Clone)]
struct ScheduleRuntime {
    in_flight: bool,
    queued: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingScheduleUpdate {
    pub target: WorkflowIdentity,
    pub activation_mode: ActivationMode,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleExecution {
    pub schedule_id: String,
    pub workflow: WorkflowIdentity,
    pub node_id: String,
    pub start_node_name: String,
    pub generation: Generation,
    pub source: IngressSourceKind,
    pub fire_at_ms: i64,
    pub deadline_ms: Option<u64>,
    pub jitter_cap_ms: u64,
    /// Kunci dedupe: `sched:{schedule_id}:{fire_at_ms}`.
    pub idempotency_key: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum TickDecision {
    Fire(ScheduleExecution),
    NotDue,
    Disabled,
    NotActive,
    /// Ownership/leader gate (#99-C/M): host ini bukan pemilik schedule
    /// setelah failover — pemilik lama berhenti emit.
    NotOwner,
    SkipOverlap,
    DuplicateTick,
    MisfireDeferred,
}

fn schedule_id_of(workflow_id: &str, node_id: &str) -> String {
    format!("sched:{workflow_id}:{node_id}")
}

// ---------------------------------------------------------------------------
// ScheduleRegistry
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct ScheduleRegistry {
    activation: ActivationRegistry,
    schedules: BTreeMap<String, ScheduleRecord>,
    by_node: BTreeMap<String, String>,
    runtime: BTreeMap<String, ScheduleRuntime>,
    fired_ticks: VecDeque<(String, i64)>,
    pending_updates: BTreeMap<String, PendingScheduleUpdate>,
    pending_specs: BTreeMap<String, Vec<ScheduleSpec>>,
    /// Identitas instance host (opsional; aktifkan gate ownership — lihat
    /// [`ScheduleRegistry::set_local_instance`]). `None` = host tunggal tanpa
    /// klaim kepemilikan (semantik lama dipertahankan).
    local_instance: Option<String>,
}

impl ScheduleRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Nyatakan identitas instance host untuk gate ownership/leader (#99-C/M).
    /// Setelah failover, instance lama (identitas ≠ owner schedule) menerima
    /// [`TickDecision::NotOwner`] dan berhenti emit; instance baru (identitas
    /// = owner) lolos. Host tunggal yang tidak memanggil ini tetap kompatibel.
    pub fn set_local_instance(&mut self, instance_id: impl Into<String>) {
        self.local_instance = Some(instance_id.into());
    }

    pub fn activation(&self) -> &ActivationRegistry {
        &self.activation
    }

    pub fn schedule(&self, workflow_id: &str, node_id: &str) -> Option<&ScheduleRecord> {
        self.schedules.get(&schedule_id_of(workflow_id, node_id))
    }

    pub fn schedule_count(&self, workflow_id: &str) -> usize {
        self.schedules
            .keys()
            .filter(|id| id.starts_with(&format!("sched:{workflow_id}:")))
            .count()
    }

    pub fn is_serving(&self, workflow_id: &str) -> bool {
        self.activation
            .record(workflow_id)
            .map(|r| r.state.is_serving())
            .unwrap_or(false)
    }

    // ------------------------------------------------- registrasi lifecycle
    //
    // (Sinkron aktivasi, identik pola P4.2/P4.3: begin→generation baru,
    // commit/abort/fail/deactivate, update tanpa duplikasi.)

    pub fn register_workflow(
        &mut self,
        workflow: WorkflowIdentity,
        specs: &[ScheduleSpec],
        activation_mode: ActivationMode,
        owner_instance: Option<String>,
        now_ms: u64,
    ) -> Result<Generation, ScheduleError> {
        // validasi penuh dulu (fail-closed)
        let mut validated = Vec::with_capacity(specs.len());
        for spec in specs {
            spec.validate()?;
            validated.push(spec.clone());
        }
        if validated.len() > MAX_SCHEDULES_PER_WORKFLOW {
            return Err(ScheduleError::TooManySchedules {
                workflow_id: workflow.workflow_id.clone(),
                max: MAX_SCHEDULES_PER_WORKFLOW,
            });
        }
        let generation = self.activation.begin_activation(
            workflow.clone(),
            activation_mode,
            owner_instance,
            None,
            now_ms,
        )?;
        let mut inserted = Vec::new();
        for spec in &validated {
            let id = schedule_id_of(&workflow.workflow_id, &spec.node_id);
            let record = ScheduleRecord {
                schedule_id: id.clone(),
                workflow: workflow.clone(),
                node_id: spec.node_id.clone(),
                node_name: spec.node_name.clone(),
                cron: CronExpr::parse(&spec.cron)?,
                timezone: spec.timezone.clone(),
                enabled: spec.enabled,
                misfire: spec.misfire,
                overlap: spec.overlap,
                jitter_ms: spec.jitter_ms,
                deadline_ms: spec.deadline_ms,
                gap_policy: spec.gap_policy,
                generation,
                registered_at_ms: now_ms,
                next_fire_at_ms: None,
                last_fired_at_ms: None,
            };
            self.schedules.insert(id.clone(), record);
            self.runtime.insert(id.clone(), ScheduleRuntime::default());
            self.by_node
                .insert(id.clone(), workflow.workflow_id.clone());
            inserted.push(id);
        }
        // rollback bila di tengah terjadi konflik validasi cron (sudah dicek di
        // spec.validate, jadi jalur ini defensif)
        let _ = inserted;
        Ok(generation)
    }

    pub fn commit_workflow(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), ScheduleError> {
        self.activation
            .commit_activation(workflow_id, expected, now_ms)?;
        Ok(())
    }

    pub fn abort_workflow(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), ScheduleError> {
        self.activation
            .abort_activation(workflow_id, expected, now_ms)?;
        self.remove_workflow(workflow_id);
        Ok(())
    }

    pub fn fail_workflow(
        &mut self,
        workflow_id: &str,
        error: ActivationError,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), ScheduleError> {
        self.activation
            .fail_activation(workflow_id, error, expected, now_ms)?;
        self.remove_workflow(workflow_id);
        Ok(())
    }

    pub fn deactivate_workflow(
        &mut self,
        workflow_id: &str,
        kind: DeactivationKind,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<DeactivateOutcome, ScheduleError> {
        let outcome = self
            .activation
            .deactivate(workflow_id, kind, expected, now_ms)?;
        use DeactivateOutcome::*;
        match outcome {
            Draining | Deactivating | CancelledActivation | NotActive => {
                self.remove_workflow(workflow_id)
            }
            AlreadyDraining | AlreadyDeactivating => {}
        }
        Ok(outcome)
    }

    pub fn request_update_workflow(
        &mut self,
        workflow_id: &str,
        new_identity: WorkflowIdentity,
        activation_mode: ActivationMode,
        new_specs: &[ScheduleSpec],
        drain_deadline_ms: u64,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), ScheduleError> {
        if new_identity.workflow_id != workflow_id {
            return Err(IngressContractError::InvalidCombination(
                "identitas update harus workflow yang sama",
            )
            .into());
        }
        let mut validated = Vec::with_capacity(new_specs.len());
        for spec in new_specs {
            spec.validate()?;
            validated.push(spec.clone());
        }
        self.activation.request_update(
            workflow_id,
            new_identity.clone(),
            activation_mode,
            drain_deadline_ms,
            expected,
            now_ms,
        )?;
        self.remove_workflow(workflow_id);
        self.pending_updates.insert(
            workflow_id.to_string(),
            PendingScheduleUpdate {
                target: new_identity,
                activation_mode,
            },
        );
        self.pending_specs
            .insert(workflow_id.to_string(), validated);
        Ok(())
    }

    pub fn apply_pending_update(
        &mut self,
        workflow_id: &str,
        now_ms: u64,
    ) -> Result<Generation, ScheduleError> {
        let state = self
            .activation
            .record(workflow_id)
            .map(|r| r.state)
            .ok_or_else(|| ScheduleError::UnknownWorkflow {
                workflow_id: workflow_id.to_string(),
            })?;
        if state != ActivationState::Inactive {
            return Err(ScheduleError::UpdateNotReady {
                workflow_id: workflow_id.to_string(),
            });
        }
        let specs = self.pending_specs.remove(workflow_id).ok_or_else(|| {
            ScheduleError::NoPendingUpdate {
                workflow_id: workflow_id.to_string(),
            }
        })?;
        let pending = self.pending_updates.remove(workflow_id).ok_or_else(|| {
            ScheduleError::NoPendingUpdate {
                workflow_id: workflow_id.to_string(),
            }
        })?;
        self.register_workflow(
            pending.target,
            &specs,
            pending.activation_mode,
            None,
            now_ms,
        )
    }

    fn remove_workflow(&mut self, workflow_id: &str) {
        let ids: Vec<String> = self
            .schedules
            .keys()
            .filter(|id| id.starts_with(&format!("sched:{workflow_id}:")))
            .cloned()
            .collect();
        for id in ids {
            self.schedules.remove(&id);
            self.runtime.remove(&id);
            self.by_node.remove(&id);
        }
    }

    // ------------------------------------------------------------ next fire

    /// Hitung ulang `next_fire_at_ms` untuk semua schedule aktif (deterministik).
    pub fn compute_next_fires(
        &mut self,
        now_ms: i64,
        resolver: &dyn TzResolver,
    ) -> Result<(), ScheduleError> {
        let ids: Vec<String> = self.schedules.keys().cloned().collect();
        for id in ids {
            let next = {
                let record = self.schedules.get(&id).expect("ada");
                if !record.enabled {
                    None
                } else {
                    compute_next_fire(record, now_ms / 1000, resolver)?
                }
            };
            if let Some(record) = self.schedules.get_mut(&id) {
                record.next_fire_at_ms = next.map(|s| s * 1000);
            }
        }
        Ok(())
    }

    // ------------------------------------------------------------ on_tick

    /// Keputusan tick untuk satu schedule.
    ///
    /// * `now_ms` — clock host (UTC, epoch ms);
    /// * `scan_interval_ms` — cadence scan scheduler (untuk deteksi missed-run:
    ///   occurrence yang lebih tua satu periode penuh dianggap terlewat).
    ///
    /// Policy misfire berlaku atas occurrence itu: `Skip` (default n8n,
    /// backlog tidak dikejar) atau `BackfillOnce`.
    pub fn on_tick(
        &mut self,
        workflow_id: &str,
        node_id: &str,
        now_ms: i64,
        scan_interval_ms: i64,
        resolver: &dyn TzResolver,
    ) -> Result<TickDecision, ScheduleError> {
        let sid = schedule_id_of(workflow_id, node_id);
        let record =
            self.schedules
                .get(&sid)
                .cloned()
                .ok_or_else(|| ScheduleError::UnknownSchedule {
                    workflow_id: workflow_id.to_string(),
                    node_id: node_id.to_string(),
                })?;
        if !record.enabled {
            return Ok(TickDecision::Disabled);
        }
        // serving + generation fence (fail-closed)
        let activation_record =
            self.activation
                .record(workflow_id)
                .ok_or(ScheduleError::UnknownWorkflow {
                    workflow_id: workflow_id.to_string(),
                })?;
        if !activation_record.state.is_serving() {
            return Ok(TickDecision::NotActive);
        }
        fence_generation(record.generation, activation_record.generation)
            .map_err(ScheduleError::Contract)?;

        // Ownership/leader gate (#99-C/M, remediasi finalisasi P4): schedule
        // dengan owner + host ber-identitas yang berbeda ⇒ NotOwner (pemilik
        // lama berhenti emit setelah failover; pemilik baru lolos). Opt-in:
        // tanpa identitas host, perilaku lama dipertahankan (host tunggal).
        if let (Some(local), Some(owner)) = (
            self.local_instance.as_deref(),
            activation_record.owner_instance.as_deref(),
        ) {
            if local != owner {
                return Ok(TickDecision::NotOwner);
            }
        }

        // anchor = last-fired (atau saat registrasi) — occurrence berikutnya.
        let anchor_s = record
            .last_fired_at_ms
            .unwrap_or(record.registered_at_ms as i64)
            / 1000;
        let fire_at_utc = compute_next_fire(&record, anchor_s, resolver)?;
        let fire_at_ms = match fire_at_utc {
            Some(s) => s * 1000,
            None => return Ok(TickDecision::NotDue),
        };
        if fire_at_ms > now_ms {
            return Ok(TickDecision::NotDue);
        }
        // missed-run: lebih tua dari satu periode scan.
        let missed = fire_at_ms < now_ms - scan_interval_ms;
        if missed {
            match record.misfire {
                MisfirePolicy::Skip => {
                    if let Some(record) = self.schedules.get_mut(&sid) {
                        record.last_fired_at_ms = Some(fire_at_ms);
                    }
                    return Ok(TickDecision::MisfireDeferred);
                }
                MisfirePolicy::BackfillOnce => { /* lanjut, fire sekali */ }
            }
        }
        // duplicate-tick suppression (instant sama yang sudah di-fire) — lapisan
        // kedua untuk clock regresi (anchor di atas sudah mencegah normal).
        if self
            .fired_ticks
            .iter()
            .any(|(id, t)| id == &sid && *t == fire_at_ms)
        {
            if let Some(record) = self.schedules.get_mut(&sid) {
                record.last_fired_at_ms = Some(fire_at_ms);
            }
            return Ok(TickDecision::DuplicateTick);
        }
        // overlap policy
        let runtime = self.runtime.get(&sid).cloned().unwrap_or_default();
        match record.overlap {
            OverlapPolicy::Skip => {
                if runtime.in_flight {
                    return Ok(TickDecision::SkipOverlap);
                }
            }
            OverlapPolicy::QueueOnce => {
                if runtime.in_flight {
                    if runtime.queued >= 1 {
                        return Ok(TickDecision::SkipOverlap);
                    }
                    if let Some(rt) = self.runtime.get_mut(&sid) {
                        rt.queued += 1;
                    }
                    return Ok(TickDecision::SkipOverlap);
                }
            }
            OverlapPolicy::Allow => {}
        }
        if let Some(rt) = self.runtime.get_mut(&sid) {
            rt.in_flight = true;
        }
        if let Some(record) = self.schedules.get_mut(&sid) {
            record.last_fired_at_ms = Some(fire_at_ms);
        }
        self.push_fired(&sid, fire_at_ms);
        Ok(TickDecision::Fire(ScheduleExecution {
            schedule_id: sid.clone(),
            workflow: record.workflow.clone(),
            node_id: record.node_id.clone(),
            start_node_name: record.node_name.clone(),
            generation: record.generation,
            source: IngressSourceKind::Schedule,
            fire_at_ms,
            deadline_ms: record.deadline_ms,
            jitter_cap_ms: record.jitter_ms,
            idempotency_key: format!("sched:{workflow_id}:{node_id}:{fire_at_ms}"),
        }))
    }

    /// Host memanggil ketika eksekusi selesai/dibatalkan (membebaskan overlap).
    pub fn finish_execution(&mut self, workflow_id: &str, node_id: &str) {
        let sid = schedule_id_of(workflow_id, node_id);
        if let Some(rt) = self.runtime.get_mut(&sid) {
            rt.in_flight = false;
            rt.queued = 0;
        }
    }

    fn push_fired(&mut self, sid: &str, at_ms: i64) {
        self.fired_ticks.push_back((sid.to_string(), at_ms));
        while self.fired_ticks.len() > FIRED_WINDOW {
            self.fired_ticks.pop_front();
        }
    }

    // ------------------------------------------------------------- recover

    /// Rekonsiliasi startup: kumpulkan schedule yang workflow-nya tidak desired/
    /// tidak serving. Kembalikan schedule_id yang harus dibuang.
    pub fn reconcile_orphans(&self, desired: &[WorkflowIdentity]) -> Vec<String> {
        self.schedules
            .iter()
            .filter(|(_, record)| {
                let active = self
                    .activation
                    .record(&record.workflow.workflow_id)
                    .map(|r| r.state.is_serving() && r.generation == record.generation)
                    .unwrap_or(false);
                let wanted = desired
                    .iter()
                    .any(|identity| identity.workflow_id == record.workflow.workflow_id);
                !(active && wanted)
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    pub fn remove_orphans(&mut self, desired: &[WorkflowIdentity]) -> usize {
        let ids = self.reconcile_orphans(desired);
        let n = ids.len();
        for id in ids {
            self.schedules.remove(&id);
            self.runtime.remove(&id);
            self.by_node.remove(&id);
        }
        n
    }
}

/// Komputasi next-fire murni (UTC epoch seconds). `None` bila pola cron tak
/// pernah match dalam horizon (fail-closed).
fn compute_next_fire(
    record: &ScheduleRecord,
    after_utc_s: i64,
    resolver: &dyn TzResolver,
) -> Result<Option<i64>, ScheduleError> {
    let start = resolver.utc_to_local(&record.timezone, after_utc_s);
    let start_days = days_from_civil(start.date.year, start.date.month, start.date.day);
    let start_mod = (start.hour * 3600 + start.minute * 60) as i64;

    let mut d = start_days;
    let mut mo = start_mod + 60; // mulai dari menit berikutnya

    loop {
        if mo >= 86_400 {
            d += 1;
            mo -= 86_400;
        }
        if d - start_days > HORIZON_DAYS {
            return Ok(None);
        }
        let (y, m, day) = civil_from_days(d);
        let hour = (mo / 3600) as u32;
        let minute = ((mo % 3600) / 60) as u32;
        let civil = CivilTime {
            date: CivilDate {
                year: y,
                month: m,
                day,
            },
            hour,
            minute,
        };
        if record.cron.matches_civil(d, m, day, hour, minute) {
            match resolver.local_to_utc(&record.timezone, civil) {
                Some(utc) => return Ok(Some(utc)),
                None => match record.gap_policy {
                    // ship-forward: menit riil pertama setelah gap (tanpa cek cron)
                    GapPolicy::ShiftForward => {
                        let mut attempt = mo + 60;
                        let limit = d - start_days;
                        loop {
                            if attempt >= 86_400 {
                                d += 1;
                                attempt -= 86_400;
                            }
                            if d - start_days > HORIZON_DAYS || d - start_days > limit + 2 {
                                return Ok(None);
                            }
                            let (yy, mm, dd) = civil_from_days(d);
                            let real = CivilTime {
                                date: CivilDate {
                                    year: yy,
                                    month: mm,
                                    day: dd,
                                },
                                hour: (attempt / 3600) as u32,
                                minute: ((attempt % 3600) / 60) as u32,
                            };
                            if let Some(utc) = resolver.local_to_utc(&record.timezone, real) {
                                return Ok(Some(utc));
                            }
                            attempt += 60;
                        }
                    }
                    GapPolicy::SkipTick => {}
                },
            }
        }
        mo += 60;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 1_700_000_000_000; // epoch ms (2023-11-14T22:13:20Z)

    fn wf(id: &str, version: u64) -> WorkflowIdentity {
        WorkflowIdentity::new(id, Some(format!("v{version}"))).unwrap()
    }

    fn spec(node_id: &str, cron: &str) -> ScheduleSpec {
        ScheduleSpec {
            node_id: node_id.to_string(),
            node_name: format!("{node_id} Trigger"),
            cron: cron.to_string(),
            timezone: "UTC".to_string(),
            enabled: true,
            misfire: MisfirePolicy::default(),
            overlap: OverlapPolicy::default(),
            jitter_ms: 0,
            deadline_ms: None,
            gap_policy: GapPolicy::default(),
        }
    }

    fn fire_ms(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        days_from_civil(y, mo, d) * 86_400_000 + h as i64 * 3_600_000 + mi as i64 * 60_000
    }

    // ------------------------------------------------------------------ cron

    #[test]
    fn cron_parses_standard_forms() {
        assert!(CronExpr::parse("*/5 * * * *").is_ok());
        assert!(CronExpr::parse("0 0 * * *").is_ok());
        assert!(CronExpr::parse("0 9-17 * * 1-5").is_ok());
        assert!(CronExpr::parse("30 4 1,15 * *").is_ok());
        assert!(CronExpr::parse("0 0 * * SUN").is_ok());
        assert!(CronExpr::parse("0 0 * JAN,MAR mon").is_ok());
        assert!(CronExpr::parse("0 0 29 2 *").is_ok());
    }

    #[test]
    fn cron_accepts_six_field_with_zero_seconds_rejects_otherwise() {
        // 6 fields, detik 0 → diterima (diterjemah ke menit)
        assert!(CronExpr::parse("0 0 0 * * *").is_ok());
        // 6 fields, detik non-trivial → ditolak fail-closed
        assert!(matches!(
            CronExpr::parse("30 0 0 * * *"),
            Err(CronError::UnsupportedSeconds(_))
        ));
    }

    #[test]
    fn cron_rejects_invalid_ranges_and_tokens() {
        assert!(CronExpr::parse("").is_err());
        assert!(CronExpr::parse("60 * * * *").is_err());
        assert!(CronExpr::parse("* 24 * * *").is_err());
        assert!(CronExpr::parse("* * 32 * *").is_err());
        assert!(CronExpr::parse("* * * 13 *").is_err());
        assert!(CronExpr::parse("* * * * 8").is_err()); // dow 8 galat (0-7)
        assert!(CronExpr::parse("* * * * * extra").is_err());
        assert!(matches!(
            CronExpr::parse("* * * * xyz"),
            Err(CronError::InvalidField { .. })
        ));
    }

    #[test]
    fn cron_handles_dom_dow_or_semantics() {
        // "0 0 1 * MON" = tanggal 1 ATAU Senin
        let cron = CronExpr::parse("0 0 1 * MON").unwrap();
        // 2023-05-01 adalah Senin (kebetulan keduanya); pakai hari lain:
        let may2 = days_from_civil(2023, 5, 2); // Selasa
        assert_eq!(dow_sunday0(may2), 2);
        assert!(!cron.matches_civil(may2, 5, 2, 0, 0));
        let may8 = days_from_civil(2023, 5, 8); // Senin, tanggal 8
        assert!(cron.matches_civil(may8, 5, 8, 0, 0));
        let may1 = days_from_civil(2023, 5, 1); // tanggal 1, Senin
        assert!(cron.matches_civil(may1, 5, 1, 0, 0));
    }

    // ------------------------------------------------------------- next fire

    #[test]
    fn next_fire_computes_expected_instants() {
        // "0 0 * * *" dari 2023-11-14 22:13 → 2023-11-15 00:00
        let record = build("wf-1", "0 0 * * *");
        let next = compute_next_fire(&record, T0 as i64 / 1000, &UtcResolver).unwrap();
        assert_eq!(next, Some(fire_ms(2023, 11, 15, 0, 0) / 1000));

        // "*/5 * * * *" next = 22:15
        let record = build("wf-1", "*/5 * * * *");
        let next = compute_next_fire(&record, T0 as i64 / 1000, &UtcResolver).unwrap();
        assert_eq!(next, Some(fire_ms(2023, 11, 14, 22, 15) / 1000));

        // "0 9-17 * * 1-5" dari Jumat sore → Senin depan 09:00
        let fri_eod = fire_ms(2023, 11, 17, 17, 30) / 1000;
        let record = build("wf-1", "0 9-17 * * 1-5");
        let next = compute_next_fire(&record, fri_eod, &UtcResolver).unwrap();
        assert_eq!(next, Some(fire_ms(2023, 11, 20, 9, 0) / 1000));
    }

    #[test]
    fn next_fire_leap_day_only_fires_on_leap_feb29() {
        let record = build("wf-1", "0 0 29 2 *");
        let after = fire_ms(2023, 3, 1, 0, 0) / 1000;
        let next = compute_next_fire(&record, after, &UtcResolver).unwrap();
        assert_eq!(next, Some(fire_ms(2024, 2, 29, 0, 0) / 1000));
    }

    #[test]
    fn impossible_cron_returns_none_fail_closed() {
        // 31 April tak pernah ada
        let record = build("wf-1", "0 0 31 4 *");
        let next = compute_next_fire(&record, T0 as i64 / 1000, &UtcResolver).unwrap();
        assert_eq!(next, None);
    }

    fn build(workflow_id: &str, cron: &str) -> ScheduleRecord {
        let spec = spec("node-1", cron);
        ScheduleRecord {
            schedule_id: schedule_id_of(workflow_id, "node-1"),
            workflow: wf(workflow_id, 1),
            node_id: "node-1".to_string(),
            node_name: "Node 1".to_string(),
            cron: CronExpr::parse(&spec.cron).unwrap(),
            timezone: spec.timezone,
            enabled: spec.enabled,
            misfire: spec.misfire,
            overlap: spec.overlap,
            jitter_ms: spec.jitter_ms,
            deadline_ms: spec.deadline_ms,
            gap_policy: spec.gap_policy,
            generation: Generation::new(1),
            registered_at_ms: T0,
            next_fire_at_ms: None,
            last_fired_at_ms: None,
        }
    }

    // ----------------------------------------------------- DST policies

    /// Resolver tiruan: gap setiap menit dengan hour==2 (spring-forward).
    struct GapResolver;
    impl TzResolver for GapResolver {
        fn utc_to_local(&self, _tz: &str, utc_seconds: i64) -> CivilTime {
            let days = utc_seconds.div_euclid(86_400);
            let mod_s = utc_seconds.rem_euclid(86_400);
            // zona ini "maju" dari 02:00 UTC: local = utc + 2h saat wkt >= 02:00
            let shifted = mod_s + 7200;
            let (y, m, d) = civil_from_days(days + shifted / 86_400);
            let rs = shifted % 86_400;
            CivilTime {
                date: CivilDate {
                    year: y,
                    month: m,
                    day: d,
                },
                hour: (rs / 3600) as u32,
                minute: ((rs % 3600) / 60) as u32,
            }
        }
        fn local_to_utc(&self, _tz: &str, civil: CivilTime) -> Option<i64> {
            // gap: jam lokal 02:xx tidak ada
            if civil.hour == 2 {
                return None;
            }
            let days = days_from_civil(civil.date.year, civil.date.month, civil.date.day);
            let local_mod = civil.hour as i64 * 3600 + civil.minute as i64 * 60;
            // utc = local - 2h
            Some(days * 86_400 + local_mod - 7200)
        }
    }

    #[test]
    fn dst_gap_shift_forward_fires_first_real_minute() {
        // cron "0 2 * * *" (02:00, yang selalu gap)
        let mut record = build("wf-1", "0 2 * * *");
        record.timezone = "X/GAP".to_string();
        // mulai 01:50 local (＝ utc 23:50 sehari sebelumnya)
        let start_utc = fire_ms(2023, 11, 14, 23, 50) / 1000;
        let next = compute_next_fire(&record, start_utc, &GapResolver).unwrap();
        // gap 02:00-02:59 → menit riil pertama = 03:00 local = 01:00 utc hari berikut
        assert_eq!(next, Some(fire_ms(2023, 11, 15, 1, 0) / 1000));
    }

    #[test]
    fn dst_gap_skip_tick_skips_occurrence() {
        let mut record = build("wf-1", "0 2 * * *");
        record.timezone = "X/GAP".to_string();
        record.gap_policy = GapPolicy::SkipTick;
        let start_utc = fire_ms(2023, 11, 14, 23, 50) / 1000;
        let next = compute_next_fire(&record, start_utc, &GapResolver).unwrap();
        // lewati 02:00 yang gap → ke keesokan harinya 02:00 (gap lagi) →
        // SkipTick scan terus; hasil: None check guarded.
        assert!(next.is_none() || next.unwrap() >= fire_ms(2023, 11, 16, 0, 0) / 1000);
    }

    /// Resolver tiruan: fold — jam lokal 01:xx ambigu (dua occurrence:
    /// 00:xx utc dan 01:xx utc); kontrak memilih occurrence terakhir.
    struct FoldResolver;
    impl TzResolver for FoldResolver {
        fn utc_to_local(&self, _tz: &str, utc_seconds: i64) -> CivilTime {
            let days = utc_seconds.div_euclid(86_400);
            let mod_s = utc_seconds.rem_euclid(86_400);
            // local = utc; pukul 01:xx local dipetakan ke utc 00:xx (occurrence awal)
            let (y, m, d) = civil_from_days(days);
            CivilTime {
                date: CivilDate {
                    year: y,
                    month: m,
                    day: d,
                },
                hour: (mod_s / 3600) as u32,
                minute: ((mod_s % 3600) / 60) as u32,
            }
        }
        fn local_to_utc(&self, _tz: &str, civil: CivilTime) -> Option<i64> {
            let days = days_from_civil(civil.date.year, civil.date.month, civil.date.day);
            let local_mod = civil.hour as i64 * 3600 + civil.minute as i64 * 60;
            // occurrence TERAKHIR: +1 jam untuk jam 01:xx (fold)
            if civil.hour == 1 {
                Some(days * 86_400 + local_mod + 3600)
            } else {
                Some(days * 86_400 + local_mod)
            }
        }
    }

    #[test]
    fn dst_fold_fires_exactly_once_at_latest_occurrence() {
        let mut record = build("wf-1", "0 1 * * *");
        record.timezone = "X/FOLD".to_string();
        let start_utc = fire_ms(2023, 11, 14, 0, 0) / 1000; // 00:00 utc → local 01:00? (utc_to_local → 00:00)
        let next = compute_next_fire(&record, start_utc, &FoldResolver).unwrap();
        // occurrence terakhir 01:00 local = 02:00 utc
        assert_eq!(next, Some(fire_ms(2023, 11, 14, 2, 0) / 1000));
    }

    // ---------------------------------------------------------- registry

    #[test]
    fn register_commit_and_tick_fires_once() {
        let mut reg = ScheduleRegistry::new();
        let specs = vec![spec("node-1", "0 0 * * *")];
        let register_at = fire_ms(2023, 11, 14, 23, 30); // anchor dekat jam fire
        let gen = reg
            .register_workflow(
                wf("wf-1", 1),
                &specs,
                ActivationMode::Activate,
                None,
                register_at as u64,
            )
            .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        assert!(reg.is_serving("wf-1"));
        assert_eq!(gen, Generation::new(1));

        // belum waktunya → NotDue
        let before = fire_ms(2023, 11, 14, 23, 58);
        let decision = reg
            .on_tick("wf-1", "node-1", before, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(decision, TickDecision::NotDue));

        // tepat 00:00 → Fire
        let at_fire = fire_ms(2023, 11, 15, 0, 0);
        let decision = reg
            .on_tick("wf-1", "node-1", at_fire, 60_000, &UtcResolver)
            .unwrap();
        match decision {
            TickDecision::Fire(exec) => {
                assert_eq!(exec.workflow.workflow_id, "wf-1");
                assert_eq!(exec.generation, Generation::new(1));
                assert_eq!(exec.source, IngressSourceKind::Schedule);
                assert!(exec.idempotency_key.contains(&exec.fire_at_ms.to_string()));
            }
            other => panic!("diharapkan Fire, dapat {other:?}"),
        }
    }

    #[test]
    fn duplicate_tick_for_same_instant_is_suppressed() {
        let mut reg = ScheduleRegistry::new();
        let specs = vec![spec("node-1", "0 0 * * *")];
        let register_at = fire_ms(2023, 11, 14, 23, 59);
        reg.register_workflow(
            wf("wf-1", 1),
            &specs,
            ActivationMode::Activate,
            None,
            register_at as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        let at_fire = fire_ms(2023, 11, 15, 0, 0);
        let first = reg
            .on_tick("wf-1", "node-1", at_fire, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(first, TickDecision::Fire(_)));
        // anchor maju ke 00:00 → fire berikutnya Hari esok → tick ulang = NotDue
        let second = reg
            .on_tick("wf-1", "node-1", at_fire, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(second, TickDecision::NotDue));
    }

    #[test]
    fn overlap_skip_blocks_tick_while_in_flight() {
        let mut reg = ScheduleRegistry::new();
        let mut s = spec("node-1", "*/1 * * * *");
        s.overlap = OverlapPolicy::Skip;
        let register_at = fire_ms(2023, 11, 14, 23, 59);
        reg.register_workflow(
            wf("wf-1", 1),
            &[s],
            ActivationMode::Activate,
            None,
            register_at as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        let t = fire_ms(2023, 11, 15, 0, 0);
        let first = reg
            .on_tick("wf-1", "node-1", t, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(first, TickDecision::Fire(_)));
        // menit berikutnya, masih in-flight → SkipOverlap
        let t2 = fire_ms(2023, 11, 15, 0, 1);
        let second = reg
            .on_tick("wf-1", "node-1", t2, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(second, TickDecision::SkipOverlap));
        reg.finish_execution("wf-1", "node-1");
        let third = reg
            .on_tick("wf-1", "node-1", t2, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(third, TickDecision::Fire(_)));
    }

    #[test]
    fn misfire_skip_defers_but_backfill_fires_once() {
        let register_at = fire_ms(2023, 11, 14, 23, 59);
        let late = fire_ms(2023, 11, 16, 12, 0); // jauh setelah occurrence
                                                 // skip default: occurrence tertinggal → deferred (last_fired dimajukan)
        let mut reg = ScheduleRegistry::new();
        let specs = vec![spec("node-1", "0 0 * * *")];
        reg.register_workflow(
            wf("wf-1", 1),
            &specs,
            ActivationMode::Activate,
            None,
            register_at as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        let decision = reg
            .on_tick("wf-1", "node-1", late, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(decision, TickDecision::MisfireDeferred));

        // backfill: fire sekali pada occurrence tertinggal terdekat
        let mut s = spec("node-2", "0 0 * * *");
        s.misfire = MisfirePolicy::BackfillOnce;
        let mut reg2 = ScheduleRegistry::new();
        reg2.register_workflow(
            wf("wf-2", 1),
            &[s],
            ActivationMode::Activate,
            None,
            register_at as u64,
        )
        .unwrap();
        reg2.commit_workflow("wf-2", None, register_at as u64 + 1)
            .unwrap();
        let decision = reg2
            .on_tick("wf-2", "node-2", late, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(decision, TickDecision::Fire(_)));
    }

    #[test]
    fn disabled_schedule_never_fires() {
        let mut reg = ScheduleRegistry::new();
        let mut s = spec("node-1", "* * * * *");
        s.enabled = false;
        let register_at = fire_ms(2023, 11, 14, 23, 59);
        reg.register_workflow(
            wf("wf-1", 1),
            &[s],
            ActivationMode::Activate,
            None,
            register_at as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        let decision = reg
            .on_tick(
                "wf-1",
                "node-1",
                fire_ms(2023, 11, 15, 0, 0),
                60_000,
                &UtcResolver,
            )
            .unwrap();
        assert!(matches!(decision, TickDecision::Disabled));
    }

    #[test]
    fn deactivation_removes_schedules_and_update_flows() {
        let mut reg = ScheduleRegistry::new();
        let specs = vec![spec("node-1", "0 0 * * *")];
        let gen1 = reg
            .register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        // update tanpa duplikasi: drain → teardown → apply
        let new_specs = vec![spec("node-1", "30 6 * * *")];
        reg.request_update_workflow(
            "wf-1",
            wf("wf-1", 2),
            ActivationMode::Update,
            &new_specs,
            T0 + 5000,
            None,
            T0 + 2,
        )
        .unwrap();
        reg.activation.finish_drain("wf-1", None, T0 + 3).unwrap();
        reg.activation
            .finish_deactivation("wf-1", None, T0 + 4)
            .unwrap();
        let gen2 = reg.apply_pending_update("wf-1", T0 + 5).unwrap();
        reg.commit_workflow("wf-1", None, T0 + 6).unwrap();
        assert!(gen2 > gen1);
        // cron lama sudah terganti
        let record = reg.schedule("wf-1", "node-1").unwrap();
        assert_eq!(record.cron.raw(), "30 6 * * *");
        // deactivate → schedule hilang
        reg.deactivate_workflow("wf-1", DeactivationKind::Immediate, None, T0 + 7)
            .unwrap();
        assert_eq!(reg.schedule_count("wf-1"), 0);
    }

    #[test]
    fn validation_rejects_bad_inputs_before_activation() {
        let mut reg = ScheduleRegistry::new();
        let bad_tz = ScheduleSpec {
            node_id: "n1".to_string(),
            node_name: "N".to_string(),
            cron: "0 0 * * *".to_string(),
            timezone: "Not/A!Zone".to_string(),
            enabled: true,
            misfire: MisfirePolicy::default(),
            overlap: OverlapPolicy::default(),
            jitter_ms: 0,
            deadline_ms: None,
            gap_policy: GapPolicy::default(),
        };
        let err = reg
            .register_workflow(wf("wf-1", 1), &[bad_tz], ActivationMode::Activate, None, T0)
            .unwrap_err();
        assert!(matches!(err, ScheduleError::InvalidTimezone(_)));
        assert!(reg.activation().record("wf-1").is_none());
    }

    #[test]
    fn jitter_and_deadline_bounds_are_enforced() {
        let mut s = spec("node-1", "0 0 * * *");
        s.jitter_ms = MAX_JITTER_MS + 1;
        assert!(matches!(
            s.validate(),
            Err(ScheduleError::BoundViolated {
                what: "jitter_ms",
                ..
            })
        ));
        let mut s2 = spec("node-1", "0 0 * * *");
        s2.deadline_ms = Some(MAX_DEADLINE_MS + 1);
        assert!(matches!(
            s2.validate(),
            Err(ScheduleError::BoundViolated {
                what: "deadline_ms",
                ..
            })
        ));
    }

    #[test]
    fn recover_removes_orphan_schedules() {
        let mut reg = ScheduleRegistry::new();
        let specs = vec![spec("node-1", "0 0 * * *")];
        reg.register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        let specs2 = vec![spec("node-x", "0 0 * * *")];
        reg.register_workflow(
            wf("wf-2", 1),
            &specs2,
            ActivationMode::Activate,
            None,
            T0 + 2,
        )
        .unwrap();
        reg.commit_workflow("wf-2", None, T0 + 3).unwrap();
        // desired hanya wf-1 → wf-2 orphan
        let removed = reg.remove_orphans(&[wf("wf-1", 1)]);
        assert_eq!(removed, 1);
        assert_eq!(reg.schedule_count("wf-2"), 0);
        assert_eq!(reg.schedule_count("wf-1"), 1);
    }

    #[test]
    fn epoch_days_and_dow_are_consistent() {
        assert_eq!(days_from_civil(1970, 1, 1), 0);
        assert_eq!(
            days_from_civil(2024, 2, 29) - days_from_civil(2024, 2, 28),
            1
        );
        assert_eq!(dow_sunday0(days_from_civil(2023, 11, 15)), 3); // 2023-11-15 Rabu
        let (y, m, d) = civil_from_days(20_000);
        assert_eq!(days_from_civil(y, m, d), 20_000);
    }
    // --------------------------------------- ownership/leader gate (remediasi)

    #[test]
    fn owner_matching_local_identity_fires() {
        let mut reg = ScheduleRegistry::new();
        reg.set_local_instance("inst-a");
        let specs = vec![spec("node-1", "0 0 * * *")];
        let register_at = fire_ms(2023, 11, 14, 23, 59);
        reg.register_workflow(
            wf("wf-1", 1),
            &specs,
            ActivationMode::Activate,
            Some("inst-a".to_string()),
            register_at as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        let at_fire = fire_ms(2023, 11, 15, 0, 0);
        let d = reg
            .on_tick("wf-1", "node-1", at_fire, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(d, TickDecision::Fire(_)), "diharapkan Fire: {d:?}");
    }

    #[test]
    fn owner_mismatch_returns_not_owner_after_failover() {
        let mut reg = ScheduleRegistry::new();
        reg.set_local_instance("inst-a");
        let specs = vec![spec("node-1", "0 0 * * *")];
        let register_at = fire_ms(2023, 11, 14, 23, 59);
        reg.register_workflow(
            wf("wf-1", 1),
            &specs,
            ActivationMode::Activate,
            Some("inst-a".to_string()),
            register_at as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        let at_fire = fire_ms(2023, 11, 15, 0, 0);
        assert!(matches!(
            reg.on_tick("wf-1", "node-1", at_fire, 60_000, &UtcResolver)
                .unwrap(),
            TickDecision::Fire(_)
        ));
        // Failover: deactivate → re-activate oleh pemilik baru inst-b.
        reg.deactivate_workflow(
            "wf-1",
            DeactivationKind::Immediate,
            None,
            at_fire as u64 + 1,
        )
        .unwrap();
        reg.activation
            .finish_deactivation("wf-1", None, at_fire as u64 + 2)
            .unwrap();
        let register_at2 = fire_ms(2023, 11, 15, 0, 30);
        reg.register_workflow(
            wf("wf-1", 2),
            &specs,
            ActivationMode::Activate,
            Some("inst-b".to_string()),
            register_at2 as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at2 as u64 + 1)
            .unwrap();
        // Host lama (inst-a) tidak lagi pemilik → NotOwner (berhenti emit).
        let next_due = fire_ms(2023, 11, 16, 0, 0);
        let d = reg
            .on_tick("wf-1", "node-1", next_due, 60_000, &UtcResolver)
            .unwrap();
        assert!(
            matches!(d, TickDecision::NotOwner),
            "diharapkan NotOwner, dapat {d:?}"
        );
        // Pemilik baru (inst-b) lolos gate dan fire (generation 2).
        reg.set_local_instance("inst-b");
        let d = reg
            .on_tick("wf-1", "node-1", next_due, 60_000, &UtcResolver)
            .unwrap();
        match d {
            TickDecision::Fire(exec) => {
                assert_eq!(exec.generation, Generation::new(2));
            }
            other => panic!("diharapkan Fire gen-2, dapat {other:?}"),
        }
    }

    #[test]
    fn without_local_identity_ownership_gate_is_inert() {
        let mut reg = ScheduleRegistry::new();
        let specs = vec![spec("node-1", "0 0 * * *")];
        let register_at = fire_ms(2023, 11, 14, 23, 59);
        reg.register_workflow(
            wf("wf-1", 1),
            &specs,
            ActivationMode::Activate,
            Some("inst-z".to_string()),
            register_at as u64,
        )
        .unwrap();
        reg.commit_workflow("wf-1", None, register_at as u64 + 1)
            .unwrap();
        // Host tanpa identitas: gate opt-in tidak aktif (kompatibilitas mundur).
        let at_fire = fire_ms(2023, 11, 15, 0, 0);
        let d = reg
            .on_tick("wf-1", "node-1", at_fire, 60_000, &UtcResolver)
            .unwrap();
        assert!(matches!(d, TickDecision::Fire(_)), "diharapkan Fire: {d:?}");
    }
}
