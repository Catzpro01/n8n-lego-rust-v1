//! P4.3 (Agent 2) — **Webhook ingress: registration, route resolution, normalization,
//! serving gate, dan acknowledge (ACK)**.
//!
//! Memiliki batas produk "webhook ingress" canonical P4 (Issue #103) di atas
//! building block beku: [`ActivationRegistry`] (P4.2) memegang lifecycle;
//! tipe nilai P4.1 (`RouteRecord`, `RouteKind`, `HttpMethod`, `IngressEnvelope`,
//! `ResponsePlan`, `ExecutionRequest`, `fence_generation`) menyediakan kata
//! wire. Modul ini **tidak** menyentuh internal eksekusi P3, registry node P6,
//! maupun otoritas kredensial P5 — ia berhenti di handoff
//! `ExecutionRequest → P3` + sebuah ACK HTTP.
//!
//! # Pemisahan tanggung jawab (jalur canonical)
//!
//! ```text
//! INGEST   RawWebhookRequest            (adapter HTTP di luar modul ini)
//! NORMALIZE normalize_request()         → NormalizedRequest (bounded, deterministic)
//! RESOLVE  resolve_http()               → RouteResolution::Matched(ResolvedRoute)
//! SECURITY caller menyetor SecurityDecisionRef (fail-closed: hanya Allow lolos)
//! SERVING  fence: route.generation vs activation.generation  (fail-closed)
//! EMIT     ExecutionRequest::from_envelope(...)              (ADMISSION P4.5 nanti)
//! ACK      build_response(plan, ...)    → WebhookResponse (status/headers/body)
//! ```
//!
//! Yang **belum** di sini (antisipasi batas slice): dedupe/replay idempotency
//! penuh + bounds queue = P4.5; waiting-route lifecycle execution = P4.6;
//! persistence journal = P4.7. Fencing generation sudah ditegakkan di sini —
//! inilah bagian "replay" yang bisa dibuktikan sekarang.

use crate::activation::{
    ActivationRegistry, ActivationTransitionError, DeactivateOutcome, DeactivationKind,
};
use crate::ingress_contract::{
    fence_generation, ActivationError, ActivationMode, ActivationState, Generation, HttpMethod,
    IngressContractError, PayloadRef, ResponseDataKind, ResponseMode, ResponsePlan, RouteKind,
    RouteRecord, SecurityDecisionRef, SecurityOutcome, WebhookAuth, WorkflowIdentity, MAX_HEADERS,
    MAX_ID_LEN, MAX_QUERY_PARAMS, MAX_QUERY_VALUE_BYTES, MAX_ROUTE_PATH_LEN,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet, HashMap};

// ---------------------------------------------------------------------------
// Error umbrella
// ---------------------------------------------------------------------------

/// Kesalahan pada plane webhook. `Contract`/`Activation` membungkus error
/// lapisan bawah; sisanya spesifik routing/normalisasi.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WebhookError {
    #[error(transparent)]
    Contract(#[from] IngressContractError),
    #[error(transparent)]
    Activation(#[from] ActivationTransitionError),
    #[error(transparent)]
    Normalize(#[from] NormalizeError),
    #[error("route '{route_id}' (path '{path}') bentrok dengan route '{other}': path/method statis sama dalam satu tabel")]
    RouteConflict {
        route_id: String,
        path: String,
        other: String,
    },
    #[error("workflow '{workflow_id}' tidak punya record aktivasi (daftarkan dulu lewat register_workflow)")]
    UnknownWorkflow { workflow_id: String },
    #[error("urutan operasi salah: workflow '{workflow_id}' harus Inactive sebelum memakai update tertunda")]
    UpdateNotReady { workflow_id: String },
    #[error("workflow '{workflow_id}' tidak memiliki update webhook tertunda")]
    NoPendingUpdate { workflow_id: String },
}

/// Kesalahan normalisasi body/URL (bounded, deterministic).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum NormalizeError {
    #[error("body {actual} byte melebihi batas {limit}")]
    BodyTooLarge { limit: usize, actual: usize },
    #[error("path+query {actual} byte melebihi batas {limit}")]
    UriTooLarge { limit: usize, actual: usize },
    #[error("path harus dimulai '/' — dapat '{0}'")]
    BadPath(String),
    #[error("jumlah query param {actual} melebihi batas {limit}")]
    TooManyQueryParams { limit: usize, actual: usize },
    #[error("jumlah header {actual} melebihi batas {limit}")]
    TooManyHeaders { limit: usize, actual: usize },
    #[error("header '{0}' tidak lowercase")]
    NonLowercaseHeader(String),
}

// ---------------------------------------------------------------------------
// Spesifikasi node webhook (input registration; serializable untuk adapter)
// ---------------------------------------------------------------------------

/// Deklarasi satu node webhook pada satu workflow. Nilai ini adalah **input**
/// registration — bukan kontrak canonical; ia proyeksi dari parameter node
/// (`Webhook/description.ts`) yang sudah diverifikasi di P4.1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodeWebhookSpec {
    pub node_id: String,
    pub node_name: String,
    pub method: HttpMethod,
    /// Path relatif terhadap prefix kind-nya (tanpa leading slash).
    pub path: String,
    #[serde(default)]
    pub auth: WebhookAuth,
    pub response_mode: ResponseMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_data: Option<ResponseDataKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_status_code: Option<u16>,
    #[serde(default)]
    pub response_headers: Vec<(String, String)>,
}

impl NodeWebhookSpec {
    /// Membangun + memvalidasi [`ResponsePlan`] (menegakkan invariant P4.1:
    /// `response_data` hanya untuk `lastNode`, status 100..=599, header bounded).
    pub fn response_plan(&self) -> Result<ResponsePlan, IngressContractError> {
        let plan = ResponsePlan {
            mode: self.response_mode,
            response_data: self.response_data,
            status_code: self.response_status_code,
            headers: self.response_headers.clone(),
        };
        plan.validate()?;
        Ok(plan)
    }

    /// Validasi penuh sebuah spec sebelum ia boleh menyentuh route table
    /// (fail-closed: spec ilegal = ABAKAN seluruh registration, tidak parsial).
    pub fn validate(&self) -> Result<(), IngressContractError> {
        if self.node_id.is_empty() || self.node_id.len() > MAX_ID_LEN {
            return Err(IngressContractError::IdTooLong {
                field: "nodeId",
                max: MAX_ID_LEN,
                actual: self.node_id.len(),
            });
        }
        if self.path.is_empty() || self.path.len() > MAX_ROUTE_PATH_LEN {
            return Err(IngressContractError::IdTooLong {
                field: "path",
                max: MAX_ROUTE_PATH_LEN,
                actual: self.path.len(),
            });
        }
        if self.path.starts_with('/') {
            return Err(IngressContractError::InvalidCombination(
                "path spec harus relatif (prefix milik adapter HTTP)",
            ));
        }
        self.response_plan()?;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Path matching (segmen + matcher)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
enum Segment {
    Literal(String),
    Param(String),
    Wildcard,
}

fn parse_segments(rel_path: &str) -> Vec<Segment> {
    rel_path
        .split('/')
        .filter(|seg| !seg.is_empty())
        .map(|seg| {
            if seg == "*" {
                Segment::Wildcard
            } else if let Some(name) = seg.strip_prefix(':') {
                Segment::Param(name.to_string())
            } else {
                Segment::Literal(seg.to_string())
            }
        })
        .collect()
}

/// Satu route terpasang di table (record + segmen ter-parse).
#[derive(Debug, Clone)]
struct MountedRoute {
    record: RouteRecord,
    segments: Vec<Segment>,
}

/// Hasil pemasangan matcher pada path relatif.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct MatchResult {
    params: BTreeMap<String, String>,
    wildcard_tail: Option<String>,
}

impl MountedRoute {
    /// Coba cocokkan `rel_segments` (path relatif dipecah tanpa segmen kosong).
    /// Static memenangkan dynamic di layer pemanggil; di sini hanya matching.
    fn try_match(&self, rel_segments: &[String]) -> Option<MatchResult> {
        // Path relatif kosong ("" atau "/") hanya cocok dengan route path "" ?
        // Route path tidak boleh kosong (P4.1), jadi tidak ada match kosong.
        if rel_segments.is_empty() {
            return None;
        }
        let mut out = MatchResult::default();
        for (idx, seg) in self.segments.iter().enumerate() {
            match seg {
                Segment::Literal(lit) => {
                    if rel_segments.get(idx) != Some(lit) {
                        return None;
                    }
                }
                Segment::Param(name) => match rel_segments.get(idx) {
                    Some(value) if !value.is_empty() => {
                        out.params.insert(name.clone(), value.clone());
                    }
                    _ => return None,
                },
                // Wildcard menangkap sisa path sebagai tail (analog n8n `*`).
                Segment::Wildcard => {
                    let tail: Vec<String> = rel_segments[idx..].to_vec();
                    out.wildcard_tail = if tail.is_empty() {
                        None
                    } else {
                        Some(tail.join("/"))
                    };
                    return Some(out);
                }
            }
        }
        if rel_segments.len() == self.segments.len() {
            Some(out)
        } else {
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Route table (per kind-group: prod / test / waiting)
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct RouteTable {
    by_id: BTreeMap<String, MountedRoute>,
    /// static: method → (rel path → route_id)
    static_by_method: HashMap<HttpMethod, BTreeMap<String, String>>,
    /// wildcard: method → rel path → route_id (specificity tie-break = path_depth)
    wild_by_method: HashMap<HttpMethod, BTreeMap<String, String>>,
    /// path_depth index untuk wildcard tie-break
    wild_depths: HashMap<String, u32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RouteResolution {
    Matched(ResolvedRoute),
    /// Prefix dikenal (mis. /webhook/) tapi tidak ada route → 404.
    NotFound,
    /// Bukan prefix ingress yang dikenal (bukan urusan P4) → 404.
    PrefixUnknown,
    MethodNotAllowed {
        allowed: Vec<String>,
    },
    /// Defensive: dua route statis identik lolos dari cek insert.
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedRoute {
    pub route_id: String,
    pub workflow: WorkflowIdentity,
    pub node_id: String,
    pub kind: RouteKind,
    pub method: HttpMethod,
    pub generation: Generation,
    pub params: BTreeMap<String, String>,
    pub wildcard_tail: Option<String>,
    pub webhook_id: Option<String>,
}

impl RouteTable {
    fn insert(&mut self, route: MountedRoute) -> Result<(), WebhookError> {
        let record = route.record.clone();
        record.validate()?;
        // depth harus konsisten dengan segmen yang ter-parse (P4.1 `path_depth`).
        if record.path_depth as usize != route.segments.len() {
            return Err(IngressContractError::InvalidCombination(
                "path_depth tidak sama dengan jumlah segmen path",
            )
            .into());
        }
        let rel = record.path.clone();
        if route
            .segments
            .iter()
            .all(|s| matches!(s, Segment::Literal(_)))
        {
            if let Some(other) = self
                .static_by_method
                .get(&record.method)
                .and_then(|m| m.get(&rel))
            {
                return Err(WebhookError::RouteConflict {
                    route_id: record.route_id.clone(),
                    path: rel,
                    other: other.clone(),
                });
            }
            self.static_by_method
                .entry(record.method)
                .or_default()
                .insert(rel, record.route_id.clone());
        } else {
            if let Some(other) = self
                .wild_by_method
                .get(&record.method)
                .and_then(|m| m.get(&rel))
            {
                return Err(WebhookError::RouteConflict {
                    route_id: record.route_id.clone(),
                    path: rel,
                    other: other.clone(),
                });
            }
            self.wild_by_method
                .entry(record.method)
                .or_default()
                .insert(rel, record.route_id.clone());
            self.wild_depths
                .insert(record.route_id.clone(), record.path_depth);
        }
        let route_id = record.route_id.clone();
        self.by_id.insert(route_id.clone(), route);
        Ok(())
    }

    fn remove(&mut self, route_id: &str) -> Option<MountedRoute> {
        let route = self.by_id.remove(route_id)?;
        let record = &route.record;
        let rel = &record.path;
        if route
            .segments
            .iter()
            .all(|s| matches!(s, Segment::Literal(_)))
        {
            if let Some(m) = self.static_by_method.get_mut(&record.method) {
                if m.get(rel).map(|s| s.as_str()) == Some(route_id) {
                    m.remove(rel);
                }
            }
        } else if let Some(m) = self.wild_by_method.get_mut(&record.method) {
            if m.get(rel).map(|s| s.as_str()) == Some(route_id) {
                m.remove(rel);
            }
        }
        self.wild_depths.remove(route_id);
        Some(route)
    }

    fn lookup(&self, method: HttpMethod, rel_path: &str) -> Option<&MountedRoute> {
        // static dulu
        if let Some(id) = self
            .static_by_method
            .get(&method)
            .and_then(|m| m.get(rel_path))
        {
            return self.by_id.get(id);
        }
        // wildcard: specific tertinggi (path_depth terbesar)
        let rel_segments: Vec<String> = rel_path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        let mut best: Option<&MountedRoute> = None;
        let mut best_depth: u32 = 0;
        if let Some(wilds) = self.wild_by_method.get(&method) {
            for id in wilds.values() {
                if let Some(route) = self.by_id.get(id) {
                    if route.try_match(&rel_segments).is_some() {
                        let depth = self.wild_depths.get(id).copied().unwrap_or(0);
                        if best.is_none() || depth > best_depth {
                            best = Some(route);
                            best_depth = depth;
                        }
                    }
                }
            }
        }
        best
    }

    /// Metode http yang memiliki route untuk path ini (untuk 405).
    fn allowed_methods(&self, rel_path: &str) -> Vec<String> {
        let mut out = BTreeSet::new();
        for (method, m) in &self.static_by_method {
            if m.contains_key(rel_path) {
                out.insert(method.as_str().to_string());
            }
        }
        let rel_segments: Vec<String> = rel_path
            .split('/')
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string())
            .collect();
        for (method, wilds) in &self.wild_by_method {
            for id in wilds.values() {
                if let Some(route) = self.by_id.get(id) {
                    if route.try_match(&rel_segments).is_some() {
                        out.insert(method.as_str().to_string());
                    }
                }
            }
        }
        out.into_iter().collect()
    }
}

// ---------------------------------------------------------------------------
// Raw webhook request (input INGEST dari adapter) + hasil normalisasi
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawWebhookRequest {
    pub method: HttpMethod,
    /// Path + query mentah mis. `/webhook/demo/:id?x=1` (query opsional).
    pub path_and_query: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub content_type: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct NormalizedRequest {
    pub method: HttpMethod,
    pub path: String,
    pub query: Vec<(String, String)>,
    pub headers: Vec<(String, String)>,
    pub payload: PayloadRef,
    pub received_at_ms: u64,
}

#[derive(Debug, Clone)]
pub struct NormalizeLimits {
    pub max_body_bytes: usize,
    /// Batas total path+query request (default: 16KiB — lebih longgar dari
    /// `MAX_ROUTE_PATH_LEN` path dan `MAX_QUERY_VALUE_BYTES` per value).
    pub max_uri_bytes: usize,
}

impl Default for NormalizeLimits {
    fn default() -> Self {
        Self {
            max_body_bytes: 16 * 1024 * 1024,
            max_uri_bytes: 16 * 1024,
        }
    }
}

fn is_json_content_type(ct: &str) -> bool {
    ct.contains("json")
}

/// Cookie sensitif ingress yang disanitasi sebelum menjadi input workflow —
/// paritas dengan `webhooks/webhook-request-sanitizer.ts` pada reference n8n
/// (pinned): `n8n-auth` (= `AUTH_COOKIE_NAME`) dan `n8n-browserId`.
/// Deterministik, bounded, versioned; penyimpanan kredensial tetap di luar P4
/// (kontrak P5). Lihat [#99-I "Webhook request sanitization"].
pub const SANITIZED_COOKIE_NAMES: &[&str] = &["n8n-auth", "n8n-browserId"];

/// Saring cookie terlarang dari nilai header `cookie` (pemanggilan per nama,
/// bukan pembuangan header — paritas observasi dengan n8n: header tetap ada,
/// nilai tersaring; bila semua tersaring hasilnya string kosong persis seperti
/// `req.headers.cookie = filteredCookies.join('; ')` di reference).
fn sanitize_cookie_header(value: &str) -> String {
    value
        .split(';')
        .map(str::trim)
        .filter(|cookie| {
            let name = cookie.split('=').next().unwrap_or("");
            !SANITIZED_COOKIE_NAMES.contains(&name)
        })
        .collect::<Vec<_>>()
        .join("; ")
}

/// NORMALIZE: pecah path/query, bound-check URL/body/header/query, klasifikasi
/// payload (JSON inline bila parseable, string inline sebaliknya — n8n meneruskan
/// binary sebagai raw ke node). Deterministik & fail-closed.
pub fn normalize_request(
    raw: &RawWebhookRequest,
    limits: &NormalizeLimits,
    received_at_ms: u64,
) -> Result<NormalizedRequest, NormalizeError> {
    if raw.path_and_query.len() > limits.max_uri_bytes {
        return Err(NormalizeError::UriTooLarge {
            limit: limits.max_uri_bytes,
            actual: raw.path_and_query.len(),
        });
    }
    let (path, query_raw) = match raw.path_and_query.split_once('?') {
        Some((p, q)) => (p.to_string(), Some(q.to_string())),
        None => (raw.path_and_query.clone(), None),
    };
    if !path.starts_with('/') {
        return Err(NormalizeError::BadPath(path));
    }
    let mut query = Vec::new();
    if let Some(q) = query_raw {
        for pair in q.split('&').filter(|p| !p.is_empty()) {
            let (name, value) = match pair.split_once('=') {
                Some((n, v)) => (n.to_string(), v.to_string()),
                None => (pair.to_string(), String::new()),
            };
            if query.len() >= MAX_QUERY_PARAMS {
                return Err(NormalizeError::TooManyQueryParams {
                    limit: MAX_QUERY_PARAMS,
                    actual: query.len() + 1,
                });
            }
            if value.len() > MAX_QUERY_VALUE_BYTES {
                return Err(NormalizeError::UriTooLarge {
                    limit: MAX_QUERY_VALUE_BYTES,
                    actual: value.len(),
                });
            }
            query.push((name, value));
        }
    }
    if raw.body.len() > limits.max_body_bytes {
        return Err(NormalizeError::BodyTooLarge {
            limit: limits.max_body_bytes,
            actual: raw.body.len(),
        });
    }
    for (name, _) in &raw.headers {
        if name.bytes().any(|b| b.is_ascii_uppercase()) {
            return Err(NormalizeError::NonLowercaseHeader(name.clone()));
        }
    }
    if raw.headers.len() > MAX_HEADERS {
        return Err(NormalizeError::TooManyHeaders {
            limit: MAX_HEADERS,
            actual: raw.headers.len(),
        });
    }
    let is_json = raw
        .content_type
        .as_deref()
        .map(is_json_content_type)
        .unwrap_or_else(|| {
            let t = raw.body.trim_start();
            t.starts_with('{') || t.starts_with('[')
        });
    let json = if is_json {
        serde_json::from_str::<serde_json::Value>(&raw.body)
            .unwrap_or_else(|_| serde_json::Value::String(raw.body.clone()))
    } else {
        serde_json::Value::String(raw.body.clone())
    };
    // Sanitasi (#99-I): cookie internal/browser tidak boleh bocor ke input
    // workflow. Header name sudah dipaksa lowercase oleh validasi di atas.
    let headers = raw
        .headers
        .iter()
        .map(|(name, value)| {
            let sanitized = if name == "cookie" {
                sanitize_cookie_header(value)
            } else {
                value.clone()
            };
            (name.clone(), sanitized)
        })
        .collect();
    Ok(NormalizedRequest {
        method: raw.method,
        path,
        query,
        headers,
        payload: PayloadRef::Inline { json },
        received_at_ms,
    })
}

// ---------------------------------------------------------------------------
// WebhookRegistry — plane webhook P4.3
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookRecord {
    pub workflow: WorkflowIdentity,
    /// node_id → spec canonical (hasil deserialisasi/validasi).
    pub nodes: BTreeMap<String, NodeWebhookSpec>,
    pub active: bool,
}

#[derive(Debug, Default)]
pub struct WebhookRegistry {
    activation: ActivationRegistry,
    prod: RouteTable,
    test: RouteTable,
    waiting: RouteTable,
    records: BTreeMap<String, WebhookRecord>,
    webhook_index: HashMap<String, String>,
    pending_nodes: BTreeMap<String, Vec<NodeWebhookSpec>>,
}

fn route_id(schema: &str, workflow_id: &str, node_id: &str) -> String {
    format!("{schema}:{workflow_id}:{node_id}")
}

fn webhook_id(schema: &str, workflow_id: &str, node_id: &str) -> String {
    format!("{schema}-{workflow_id}-{node_id}")
}

impl WebhookRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn activation(&self) -> &ActivationRegistry {
        &self.activation
    }

    pub fn record(&self, workflow_id: &str) -> Option<&WebhookRecord> {
        self.records.get(workflow_id)
    }

    pub fn is_serving(&self, workflow_id: &str) -> bool {
        self.activation
            .record(workflow_id)
            .map(|r| r.state.is_serving())
            .unwrap_or(false)
    }

    fn table_mut(&mut self, kind: RouteKind) -> &mut RouteTable {
        match kind {
            RouteKind::ProductionWebhook | RouteKind::ProductionForm => &mut self.prod,
            RouteKind::TestWebhook | RouteKind::TestForm => &mut self.test,
            RouteKind::WaitingWebhook | RouteKind::WaitingForm => &mut self.waiting,
        }
    }

    fn table(&self, kind: RouteKind) -> &RouteTable {
        match kind {
            RouteKind::ProductionWebhook | RouteKind::ProductionForm => &self.prod,
            RouteKind::TestWebhook | RouteKind::TestForm => &self.test,
            RouteKind::WaitingWebhook | RouteKind::WaitingForm => &self.waiting,
        }
    }

    fn build_route(
        kind: RouteKind,
        workflow: &WorkflowIdentity,
        spec: &NodeWebhookSpec,
        generation: Generation,
        registered_at_ms: u64,
        schema: &str,
    ) -> RouteRecord {
        RouteRecord {
            route_id: route_id(schema, &workflow.workflow_id, &spec.node_id),
            workflow: workflow.clone(),
            node_id: spec.node_id.clone(),
            node_name: spec.node_name.clone(),
            kind,
            method: spec.method,
            path: spec.path.clone(),
            path_depth: spec.path.split('/').filter(|s| !s.is_empty()).count() as u32,
            generation,
            registered_at_ms,
            webhook_id: Some(webhook_id(schema, &workflow.workflow_id, &spec.node_id)),
            auth: spec.auth,
        }
    }

    // ------------------------------------------------- registrasi lifecycle

    /// Memulai aktivasi workflow DAN meregistrasi seluruh rutenya
    /// (test + production) dengan generation barunya. Mengembalikan generation
    /// yang wajib dipakai caller untuk commit/abort/fail. On registration error:
    /// aktivasi di-rollback (fail_activation) — tidak ada state setengah-jadi.
    pub fn register_workflow(
        &mut self,
        workflow: WorkflowIdentity,
        specs: &[NodeWebhookSpec],
        activation_mode: ActivationMode,
        owner_instance: Option<String>,
        now_ms: u64,
    ) -> Result<Generation, WebhookError> {
        // 1) validasi penuh spec lebih dulu (fail-closed, sebelum menyentuh apa pun)
        let mut validated = Vec::with_capacity(specs.len());
        for spec in specs {
            spec.validate()?;
            validated.push(spec.clone());
        }
        // 2) mulai aktivasi → generation baru
        let generation = self.activation.begin_activation(
            workflow.clone(),
            activation_mode,
            owner_instance,
            None,
            now_ms,
        )?;
        // 3) registrasi route (rollback penuh bila ada yang bentrok/gagal)
        for spec in &validated {
            for (kind, schema) in [
                (RouteKind::ProductionWebhook, "wb"),
                (RouteKind::TestWebhook, "wb-test"),
            ] {
                let route = Self::build_route(kind, &workflow, spec, generation, now_ms, schema);
                if let Err(error) = self.mount(route) {
                    // rollback: catat kegagalan aktivasi + lepas semua route parsial
                    let activation_error = ActivationError {
                        message: error.to_string(),
                        node: Some(spec.node_id.clone()),
                        at_ms: now_ms,
                    };
                    self.activation
                        .fail_activation(&workflow.workflow_id, activation_error, None, now_ms)
                        .ok();
                    self.unmount_workflow(&workflow.workflow_id);
                    return Err(error);
                }
            }
        }
        // 4) catat record binding
        let nodes: BTreeMap<String, NodeWebhookSpec> = validated
            .iter()
            .map(|s| (s.node_id.clone(), s.clone()))
            .collect();
        self.records.insert(
            workflow.workflow_id.clone(),
            WebhookRecord {
                workflow: workflow.clone(),
                nodes,
                active: false,
            },
        );
        Ok(generation)
    }

    /// COMMIT: aktivasi berhasil → route production dipasang ke jalur serving.
    /// Route test tetap melayani sejak registration (mode `Activating`).
    pub fn commit_workflow(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), WebhookError> {
        self.activation
            .commit_activation(workflow_id, expected, now_ms)?;
        if let Some(record) = self.records.get_mut(workflow_id) {
            record.active = true;
        }
        Ok(())
    }

    /// ABORT: aktivasi dibatalkan bersih → seluruh route (test) dilepas.
    pub fn abort_workflow(
        &mut self,
        workflow_id: &str,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), WebhookError> {
        self.activation
            .abort_activation(workflow_id, expected, now_ms)?;
        self.unmount_workflow(workflow_id);
        Ok(())
    }

    /// FAIL: aktivasi gagal → route dilepas, error tercatat (activasi-error visibility).
    pub fn fail_workflow(
        &mut self,
        workflow_id: &str,
        error: ActivationError,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), WebhookError> {
        self.activation
            .fail_activation(workflow_id, error, expected, now_ms)?;
        self.unmount_workflow(workflow_id);
        Ok(())
    }

    /// DEACTIVATE + lepas route (permukaan idempotent P4.2 dilapisi disini).
    pub fn deactivate_workflow(
        &mut self,
        workflow_id: &str,
        kind: DeactivationKind,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<DeactivateOutcome, WebhookError> {
        let outcome = self
            .activation
            .deactivate(workflow_id, kind, expected, now_ms)?;
        // Pada boundary yang meninggalkan serving, route wajib turun:
        match outcome {
            DeactivateOutcome::Draining
            | DeactivateOutcome::Deactivating
            | DeactivateOutcome::CancelledActivation
            | DeactivateOutcome::NotActive => self.unmount_workflow(workflow_id),
            DeactivateOutcome::AlreadyDraining | DeactivateOutcome::AlreadyDeactivating => {}
        }
        Ok(outcome)
    }

    /// Workflow masuk `Draining` + antrikan set spec baru (update tanpa
    /// duplikasi registrasi). Spec target divalidasi penuh sekarang.
    pub fn request_update_workflow(
        &mut self,
        workflow_id: &str,
        new_identity: WorkflowIdentity,
        activation_mode: ActivationMode,
        new_specs: &[NodeWebhookSpec],
        drain_deadline_ms: u64,
        expected: Option<Generation>,
        now_ms: u64,
    ) -> Result<(), WebhookError> {
        if new_identity.workflow_id != workflow_id {
            return Err(IngressContractError::InvalidCombination(
                "identitas baru harus workflow yang sama (id identik)",
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
            new_identity,
            activation_mode,
            drain_deadline_ms,
            expected,
            now_ms,
        )?;
        self.unmount_workflow(workflow_id);
        self.pending_nodes
            .insert(workflow_id.to_string(), validated);
        Ok(())
    }

    /// Setelah drain chain selesai (`Inactive`), terapkan update: pasang set
    /// baru, mulai aktivasi target, kembalikan generation barunya.
    pub fn apply_pending_update(
        &mut self,
        workflow_id: &str,
        now_ms: u64,
    ) -> Result<Generation, WebhookError> {
        let state = self
            .activation
            .record(workflow_id)
            .map(|r| r.state)
            .ok_or_else(|| WebhookError::UnknownWorkflow {
                workflow_id: workflow_id.to_string(),
            })?;
        if state != ActivationState::Inactive {
            return Err(WebhookError::UpdateNotReady {
                workflow_id: workflow_id.to_string(),
            });
        }
        let specs = self.pending_nodes.remove(workflow_id).ok_or_else(|| {
            WebhookError::NoPendingUpdate {
                workflow_id: workflow_id.to_string(),
            }
        })?;
        let pending = self
            .activation
            .take_pending_update(workflow_id)
            .ok_or_else(|| WebhookError::NoPendingUpdate {
                workflow_id: workflow_id.to_string(),
            })?;
        // Record webhook lama di-refresh dengan identitas + spec baru.
        self.register_workflow(
            pending.target,
            &specs,
            pending.activation_mode,
            None,
            now_ms,
        )
    }

    // ---------------------------------------------------------- routing core

    fn mount(&mut self, route: RouteRecord) -> Result<(), WebhookError> {
        let kind = route.kind;
        let webhook_id = route.webhook_id.clone();
        let route_id = route.route_id.clone();
        let segments = parse_segments(&route.path);
        let mounted = MountedRoute {
            record: route,
            segments,
        };
        self.table_mut(kind).insert(mounted)?;
        if let Some(wid) = webhook_id {
            self.webhook_index.insert(wid, route_id);
        }
        Ok(())
    }

    fn unmount_workflow(&mut self, workflow_id: &str) {
        // kumpulkan semua route id milik workflow ini dari seluruh table
        let ids: Vec<String> = self.collect_route_ids(workflow_id);
        for id in ids {
            for table in [&mut self.prod, &mut self.test, &mut self.waiting] {
                if let Some(removed) = table.remove(&id) {
                    if let Some(wid) = &removed.record.webhook_id {
                        self.webhook_index.remove(wid);
                    }
                }
            }
        }
        if let Some(record) = self.records.get_mut(workflow_id) {
            record.active = false;
        }
    }

    fn collect_route_ids(&self, workflow_id: &str) -> Vec<String> {
        let mut ids = Vec::new();
        for table in [&self.prod, &self.test, &self.waiting] {
            for (id, route) in &table.by_id {
                if route.record.workflow.workflow_id == workflow_id {
                    ids.push(id.clone());
                }
            }
        }
        ids
    }

    /// Semua route id yang masih terpasang untuk satu workflow.
    pub fn mounted_route_ids(&self, workflow_id: &str) -> Vec<String> {
        self.collect_route_ids(workflow_id)
    }

    /// RESOLVE: cari route untuk sebuah request HTTP mentah. Memisahkan prefix
    /// ingress (6 prefix n8n), mengekstrak param path & wildcard tail.
    pub fn resolve_http(&self, method: HttpMethod, raw_path: &str) -> RouteResolution {
        let (kind, rel) = match strip_known_prefix(raw_path) {
            Some(v) => v,
            None => return RouteResolution::PrefixUnknown,
        };
        self.resolve_table(method, kind, &rel)
    }

    fn resolve_table(&self, method: HttpMethod, kind: RouteKind, rel: &str) -> RouteResolution {
        let table = self.table(kind);
        if let Some(route) = table.lookup(method, rel) {
            let rel_segments: Vec<String> = rel
                .split('/')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();
            let matched = route.try_match(&rel_segments);
            let (params, wildcard_tail) = matched
                .map(|m| (m.params, m.wildcard_tail))
                .unwrap_or_default();
            return RouteResolution::Matched(ResolvedRoute {
                route_id: route.record.route_id.clone(),
                workflow: route.record.workflow.clone(),
                node_id: route.record.node_id.clone(),
                kind,
                method,
                generation: route.record.generation,
                params,
                wildcard_tail,
                webhook_id: route.record.webhook_id.clone(),
            });
        }
        let allowed = table.allowed_methods(rel);
        if !allowed.is_empty() {
            return RouteResolution::MethodNotAllowed { allowed };
        }
        RouteResolution::NotFound
    }

    // ------------------------------------------------------------- serving

    /// Gate serving webhook: kombinasikan status aktivasi + fence generation.
    /// Prod/waiting menuntut `Active|Degraded`; test mengizinkan `Activating` juga
    /// (mode uji selama aktivasi). Generation exact-match (fail-closed).
    pub fn serving_check(
        &self,
        route: &ResolvedRoute,
        activation: &ActivationRegistry,
    ) -> Result<(), ServingDenied> {
        let record = activation
            .record(&route.workflow.workflow_id)
            .ok_or(ServingDenied::NotActive)?;
        let allowed = match route.kind {
            RouteKind::TestWebhook | RouteKind::TestForm => matches!(
                record.state,
                ActivationState::Active | ActivationState::Activating | ActivationState::Degraded
            ),
            _ => record.state.is_serving(),
        };
        if !allowed {
            return Err(ServingDenied::NotActive);
        }
        fence_generation(route.generation, record.generation)
            .map_err(|_| ServingDenied::StaleGeneration)
    }

    /// Bersihkan route basi (cleanup #103): unmount semua route yang workflow-nya
    /// tidak ada / tidak serving / generation-nya tidak lagi cocok dengan
    /// record aktivasi. Mengembalikan route_id yang dilepas.
    pub fn cleanup_stale_routes(&mut self) -> Vec<String> {
        let mut removed = Vec::new();
        // snapshot untuk menghindari borrow konflik saat mutasi
        let stale: Vec<String> = {
            let mut stale = Vec::new();
            let tables = [&self.prod, &self.test, &self.waiting];
            for table in tables {
                for (id, route) in &table.by_id {
                    let wid = &route.record.workflow.workflow_id;
                    let keep = match self.activation.record(wid) {
                        Some(record) => {
                            record.state.is_serving()
                                && record.generation == route.record.generation
                        }
                        None => false,
                    };
                    if !keep {
                        stale.push(id.clone());
                    }
                }
            }
            stale
        };
        for id in stale {
            for table in [&mut self.prod, &mut self.test, &mut self.waiting] {
                if let Some(route) = table.remove(&id) {
                    if let Some(wid) = &route.record.webhook_id {
                        self.webhook_index.remove(wid);
                    }
                    removed.push(id.clone());
                }
            }
        }
        if !removed.is_empty() {
            // Record webhook apa pun yang kehilangan seluruh rutenya ditandai
            // tidak aktif (route basi = tidak ada lagi yang bisa dilayani).
            let empty: Vec<String> = self
                .records
                .iter()
                .filter(|(wid, _)| self.collect_route_ids(wid).is_empty())
                .map(|(wid, _)| wid.clone())
                .collect();
            for wid in empty {
                if let Some(record) = self.records.get_mut(&wid) {
                    record.active = false;
                }
            }
        }
        removed
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServingDenied {
    NotActive,
    StaleGeneration,
}

// ---------------------------------------------------------------------------
// prefix handling (6 prefix n8n 2.9.4 — default; prefix dapat diganti adapter)
// ---------------------------------------------------------------------------

fn strip_known_prefix(raw_path: &str) -> Option<(RouteKind, String)> {
    const KINDS: [RouteKind; 6] = [
        RouteKind::ProductionWebhook,
        RouteKind::TestWebhook,
        RouteKind::WaitingWebhook,
        RouteKind::ProductionForm,
        RouteKind::TestForm,
        RouteKind::WaitingForm,
    ];
    for kind in KINDS {
        let prefix = kind.default_path_prefix();
        if let Some(rest) = raw_path.strip_prefix(prefix) {
            return Some((kind, rest.to_string()));
        }
    }
    None
}

// ---------------------------------------------------------------------------
// ACK — membangun respons HTTP dari ResponsePlan
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WebhookResponse {
    pub status_code: u16,
    pub headers: Vec<(String, String)>,
    pub body: Option<serde_json::Value>,
}

/// Membangun respons ACK deterministik dari rencana respons node webhook.
/// OnReceived → 200 + body n8n-style; LastNode/ResponseNode/Streaming →
/// 202 (resolusi data = P4.5, tetapi ACK-nya stabil sekarang).
pub fn build_response(plan: &ResponsePlan, allowed: bool) -> WebhookResponse {
    if !allowed {
        return WebhookResponse {
            status_code: 403,
            headers: Vec::new(),
            body: Some(serde_json::json!({ "message": "Request denied by security policy" })),
        };
    }
    let status = plan.status_code.unwrap_or(match plan.mode {
        ResponseMode::OnReceived => 200,
        _ => 202,
    });
    let body = match plan.mode {
        ResponseMode::OnReceived => Some(serde_json::json!({ "message": "Workflow was started" })),
        _ => Some(serde_json::json!({ "message": "Request accepted" })),
    };
    WebhookResponse {
        status_code: status,
        headers: plan.headers.clone(),
        body,
    }
}

// ---------------------------------------------------------------------------
// Hasil satu request end-to-end (untuk adapter + test deterministik)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq)]
pub struct WebhookIngressOutcome {
    pub resolution: RouteResolution,
    pub serving: Result<(), ServingDenied>,
    pub execution_request: Option<ExecutionRequestStub>,
    pub response: WebhookResponse,
}

/// Stub handoff P4→P3 (P4.3): berisi hanya yang relevan untuk ACK;
/// `ExecutionRequest` penuh dibangun lewat [`IngressRequestBaton`].
#[derive(Debug, Clone, PartialEq)]
pub struct ExecutionRequestStub {
    pub request_id: String,
    pub workflow_id: String,
    pub node_id: String,
    pub generation: u64,
    pub mode: ExecutionModeStub,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionModeStub {
    Trigger,
    Test,
    Waiting,
}

/// Perjalanan penuh satu request webhook (normalize → resolve → security →
/// serving → emit) sebagai fungsi murni atas &self — digunakan adapter dan test.
/// P4.3 tidak melakukan dedupe stateful (itu P4.5); fencing stale-generation
/// adalah lapisan replay-protection yang tersedia sekarang.
pub fn process_webhook_request(
    registry: &WebhookRegistry,
    raw: &RawWebhookRequest,
    security: &SecurityDecisionRef,
    limits: &NormalizeLimits,
    now_ms: u64,
) -> Result<WebhookIngressOutcome, WebhookError> {
    // INGEST + NORMALIZE
    let normalized = normalize_request(raw, limits, now_ms)?;
    // RESOLVE
    let resolution = registry.resolve_http(normalized.method, &normalized.path);
    // SECURITY fail-closed
    let security_ok = security.outcome == SecurityOutcome::Allow;
    if !security_ok {
        let out = WebhookIngressOutcome {
            resolution: resolution.clone(),
            serving: Ok(()),
            execution_request: None,
            response: build_response(&ResponsePlan::default(), false),
        };
        return Ok(out);
    }
    match &resolution {
        RouteResolution::Matched(route) => {
            let serving = registry.serving_check(route, registry.activation());
            let execution_request = match &serving {
                Ok(()) => {
                    let mode = match route.kind {
                        RouteKind::TestWebhook | RouteKind::TestForm => ExecutionModeStub::Test,
                        RouteKind::WaitingWebhook | RouteKind::WaitingForm => {
                            ExecutionModeStub::Waiting
                        }
                        _ => ExecutionModeStub::Trigger,
                    };
                    Some(ExecutionRequestStub {
                        request_id: format!(
                            "req-{}",
                            &normalized.path.chars().take(16).collect::<String>()
                        ),
                        workflow_id: route.workflow.workflow_id.clone(),
                        node_id: route.node_id.clone(),
                        generation: route.generation.get(),
                        mode,
                    })
                }
                Err(_) => None,
            };
            let plan = registry
                .record(&route.workflow.workflow_id)
                .and_then(|rec| rec.nodes.get(&route.node_id))
                .map(|spec| spec.response_plan().unwrap_or_default())
                .unwrap_or_default();
            Ok(WebhookIngressOutcome {
                resolution: resolution.clone(),
                serving,
                execution_request,
                response: build_response(&plan, serving.is_ok()),
            })
        }
        RouteResolution::NotFound | RouteResolution::PrefixUnknown => Ok(WebhookIngressOutcome {
            resolution: resolution.clone(),
            serving: Err(ServingDenied::NotActive),
            execution_request: None,
            response: WebhookResponse {
                status_code: 404,
                headers: Vec::new(),
                body: Some(
                    serde_json::json!({ "message": "The requested webhook is not registered." }),
                ),
            },
        }),
        RouteResolution::MethodNotAllowed { allowed } => Ok(WebhookIngressOutcome {
            resolution: resolution.clone(),
            serving: Err(ServingDenied::NotActive),
            execution_request: None,
            response: WebhookResponse {
                status_code: 405,
                headers: vec![("allow".to_string(), allowed.join(", "))],
                body: Some(serde_json::json!({ "message": "Method not allowed" })),
            },
        }),
        RouteResolution::Conflict => Ok(WebhookIngressOutcome {
            resolution: resolution.clone(),
            serving: Err(ServingDenied::NotActive),
            execution_request: None,
            response: WebhookResponse {
                status_code: 500,
                headers: Vec::new(),
                body: Some(serde_json::json!({ "message": "Route conflict" })),
            },
        }),
    }
}

// ---------------------------------------------------------------------------
// Tests (semua dijalankan oleh rig; deterministic & fail-closed)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 20_000;

    fn wf(id: &str, version: u64) -> WorkflowIdentity {
        WorkflowIdentity::new(id, Some(format!("v{version}"))).unwrap()
    }

    fn spec(node_id: &str, method: HttpMethod, path: &str) -> NodeWebhookSpec {
        NodeWebhookSpec {
            node_id: node_id.to_string(),
            node_name: format!("{} Node", node_id),
            method,
            path: path.to_string(),
            auth: WebhookAuth::None,
            response_mode: ResponseMode::OnReceived,
            response_data: None,
            response_status_code: None,
            response_headers: Vec::new(),
        }
    }

    fn allow(did: &str) -> SecurityDecisionRef {
        SecurityDecisionRef {
            decision_id: did.to_string(),
            authority: "webhook-auth".to_string(),
            outcome: SecurityOutcome::Allow,
            decided_at_ms: T0,
            reason_code: None,
        }
    }

    fn deny(did: &str) -> SecurityDecisionRef {
        SecurityDecisionRef {
            decision_id: did.to_string(),
            authority: "webhook-auth".to_string(),
            outcome: SecurityOutcome::Deny,
            decided_at_ms: T0,
            reason_code: Some("token-invalid".to_string()),
        }
    }

    fn raw(method: HttpMethod, path_and_query: &str) -> RawWebhookRequest {
        RawWebhookRequest {
            method,
            path_and_query: path_and_query.to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: "{}".to_string(),
            content_type: Some("application/json".to_string()),
        }
    }

    // ----------------------------------------------------------- registration

    #[test]
    fn register_mounts_test_and_prod_routes() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo/:id")];
        let gen = reg
            .register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        assert_eq!(gen, Generation::new(1));
        // test route langsung melayani saat ACTIVATING
        let resolution = reg.resolve_http(HttpMethod::Post, "/webhook-test/demo/42");
        assert!(matches!(resolution, RouteResolution::Matched(_)));
        // prod route juga terpasang (melayani setelah commit/Active)
        let resolution = reg.resolve_http(HttpMethod::Post, "/webhook/demo/42");
        assert!(matches!(resolution, RouteResolution::Matched(_)));
        // commit → aktif
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        assert!(reg.is_serving("wf-1"));
        assert_eq!(reg.mounted_route_ids("wf-1").len(), 2);
    }

    #[test]
    fn registration_failures_roll_back_activation() {
        let mut reg = WebhookRegistry::new();
        // path ilegal (leading slash) → registration gagal → rollback
        let specs = vec![spec("hook-1", HttpMethod::Post, "/bad-path")];
        let err = reg
            .register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap_err();
        assert!(matches!(err, WebhookError::Contract(_)));
        // spec gagal validasi SEBELUM aktivasi dimulai → tidak ada record, tidak ada route
        assert!(reg.activation().record("wf-1").is_none());
        assert!(!reg.is_serving("wf-1"));
        assert_eq!(reg.mounted_route_ids("wf-1").len(), 0);
    }

    #[test]
    fn duplicate_static_route_is_conflict_and_fail_closed() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![
            spec("hook-1", HttpMethod::Get, "same"),
            spec("hook-2", HttpMethod::Get, "same"),
        ];
        let err = reg
            .register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap_err();
        assert!(matches!(err, WebhookError::RouteConflict { .. }));
    }

    // -------------------------------------------------------------- resolving

    #[test]
    fn resolve_extracts_params_and_wildcard_tail() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![
            spec("hook-1", HttpMethod::Post, "user/:uid/profile"),
            spec("hook-2", HttpMethod::Get, "asset/*"),
        ];
        reg.register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        match reg.resolve_http(HttpMethod::Post, "/webhook/user/77/profile") {
            RouteResolution::Matched(route) => {
                assert_eq!(route.node_id, "hook-1");
                assert_eq!(route.params.get("uid").map(|s| s.as_str()), Some("77"));
                assert!(route.wildcard_tail.is_none());
            }
            other => panic!("diharapkan Matched, dapat {other:?}"),
        }
        match reg.resolve_http(HttpMethod::Get, "/webhook/asset/a/b/c") {
            RouteResolution::Matched(route) => {
                assert_eq!(route.node_id, "hook-2");
                assert_eq!(route.wildcard_tail.as_deref(), Some("a/b/c"));
            }
            other => panic!("diharapkan Matched, dapat {other:?}"),
        }
    }

    #[test]
    fn static_beats_wildcard_on_tie() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![
            spec("hook-static", HttpMethod::Get, "ping"),
            spec("hook-wild", HttpMethod::Get, ":anything"),
        ];
        reg.register_workflow(wf("wf-2", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        match reg.resolve_http(HttpMethod::Get, "/webhook/ping") {
            RouteResolution::Matched(route) => assert_eq!(route.node_id, "hook-static"),
            other => panic!("diharapkan Matched, dapat {other:?}"),
        }
    }

    #[test]
    fn resolve_returns_not_found_and_method_not_allowed() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "only-post")];
        reg.register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        assert!(matches!(
            reg.resolve_http(HttpMethod::Post, "/webhook/ghost"),
            RouteResolution::NotFound
        ));
        assert!(matches!(
            reg.resolve_http(HttpMethod::Get, "/webhook/only-post"),
            RouteResolution::MethodNotAllowed { .. }
        ));
        assert!(matches!(
            reg.resolve_http(HttpMethod::Get, "/other/prefix/x"),
            RouteResolution::PrefixUnknown
        ));
    }

    // ------------------------------------------------------------- normalize

    #[test]
    fn normalize_splits_path_query_and_classifies_body() {
        let req = RawWebhookRequest {
            method: HttpMethod::Post,
            path_and_query: "/webhook/demo/9?a=1&b=2".to_string(),
            headers: vec![("content-type".to_string(), "application/json".to_string())],
            body: r#"{"k":"v"}"#.to_string(),
            content_type: Some("application/json".to_string()),
        };
        let normalized = normalize_request(&req, &NormalizeLimits::default(), T0).unwrap();
        assert_eq!(normalized.path, "/webhook/demo/9");
        assert_eq!(normalized.query.len(), 2);
        match &normalized.payload {
            PayloadRef::Inline { json } => {
                assert_eq!(json.get("k").and_then(|v| v.as_str()), Some("v"));
            }
            other => panic!("diharapkan Inline, dapat {other:?}"),
        }
    }

    #[test]
    fn normalize_binary_body_becomes_string_inline() {
        let req = RawWebhookRequest {
            method: HttpMethod::Post,
            path_and_query: "/webhook/demo".to_string(),
            headers: Vec::new(),
            body: "RAWBYTES".to_string(),
            content_type: Some("application/octet-stream".to_string()),
        };
        let normalized = normalize_request(&req, &NormalizeLimits::default(), T0).unwrap();
        match &normalized.payload {
            PayloadRef::Inline { json } => {
                assert_eq!(json.as_str(), Some("RAWBYTES"));
            }
            other => panic!("diharapkan Inline, dapat {other:?}"),
        }
    }

    #[test]
    fn sensitive_cookies_are_stripped_like_n8n_reference() {
        let req = RawWebhookRequest {
            method: HttpMethod::Post,
            path_and_query: "/webhook/demo".to_string(),
            headers: vec![
                (
                    "cookie".to_string(),
                    "session=keep; n8n-auth=SECRET; other=x; n8n-browserId=B".to_string(),
                ),
                ("content-type".to_string(), "application/json".to_string()),
            ],
            body: "{}".to_string(),
            content_type: Some("application/json".to_string()),
        };
        let normalized = normalize_request(&req, &NormalizeLimits::default(), T0).unwrap();
        let cookie = normalized
            .headers
            .iter()
            .find(|(k, _)| k == "cookie")
            .expect("header cookie tetap ada (paritas n8n)");
        assert!(
            !cookie.1.contains("n8n-auth"),
            "auth cookie harus tersaring: {}",
            cookie.1
        );
        assert!(
            !cookie.1.contains("n8n-browserId"),
            "browserId harus tersaring: {}",
            cookie.1
        );
        assert!(
            cookie.1.contains("session=keep"),
            "cookie biasa dipertahankan: {}",
            cookie.1
        );
        assert!(
            cookie.1.contains("other=x"),
            "cookie biasa dipertahankan: {}",
            cookie.1
        );
        assert!(
            normalized.headers.iter().any(|(k, _)| k == "content-type"),
            "header non-cookie tidak disentuh"
        );
    }

    #[test]
    fn cookie_header_with_only_sensitive_cookies_becomes_empty_like_n8n() {
        let req = RawWebhookRequest {
            method: HttpMethod::Post,
            path_and_query: "/webhook/demo".to_string(),
            headers: vec![(
                "cookie".to_string(),
                "n8n-auth=x; n8n-browserId=y".to_string(),
            )],
            body: "{}".to_string(),
            content_type: Some("application/json".to_string()),
        };
        let normalized = normalize_request(&req, &NormalizeLimits::default(), T0).unwrap();
        let cookie = normalized
            .headers
            .iter()
            .find(|(k, _)| k == "cookie")
            .expect("header cookie tetap ada");
        // reference: req.headers.cookie = filteredCookies.join("; ") → ""
        assert_eq!(
            cookie.1, "",
            "paritas n8n: string kosong, bukan hapus header"
        );
    }

    #[test]
    fn normalize_enforces_body_size_limit() {
        let req = RawWebhookRequest {
            method: HttpMethod::Post,
            path_and_query: "/webhook/demo".to_string(),
            headers: Vec::new(),
            body: "X".repeat(64),
            content_type: None,
        };
        let limits = NormalizeLimits {
            max_body_bytes: 32,
            ..Default::default()
        };
        assert!(matches!(
            normalize_request(&req, &limits, T0),
            Err(NormalizeError::BodyTooLarge { .. })
        ));
    }

    // -------------------------------------------------- unregistration & dur

    #[test]
    fn deactivation_unmounts_routes_so_stale_routes_cannot_serve() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo")];
        let gen = reg
            .register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        reg.deactivate_workflow("wf-1", DeactivationKind::Immediate, None, T0 + 2)
            .unwrap();
        assert_eq!(reg.mounted_route_ids("wf-1").len(), 0);
        assert!(matches!(
            reg.resolve_http(HttpMethod::Post, "/webhook/demo"),
            RouteResolution::NotFound
        ));
        let _ = gen;
    }

    #[test]
    fn cleanup_stale_routes_removes_stale_generation_routes() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo")];
        reg.register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        // jalur utama: deactivate → route turun, cleanup idempotent
        reg.deactivate_workflow("wf-1", DeactivationKind::Immediate, None, T0 + 2)
            .unwrap();
        assert_eq!(reg.mounted_route_ids("wf-1").len(), 0);
        assert!(reg.cleanup_stale_routes().is_empty());
        // jalur parsial: record menuju state non-serving TAPI route sebagian
        // masih ter-insert (invariance dilanggar semenjak luar) — cleanup
        // wajib tetap mencabut route yang generation-nya tak cocok.
        let specs2 = vec![spec("hook-2", HttpMethod::Get, "orphan")];
        let gen2 = reg
            .register_workflow(
                wf("wf-2", 1),
                &specs2,
                ActivationMode::Activate,
                None,
                T0 + 3,
            )
            .unwrap();
        reg.commit_workflow("wf-2", None, T0 + 4).unwrap();
        // paksa route tetap terpasang walau record-nya bukan serving lagi
        // (ini jalan bila ada crash di antara finish dan unmount):
        reg.activation
            .begin_deactivation_immediate("wf-2", None, T0 + 5)
            .unwrap();
        let removed = reg.cleanup_stale_routes();
        assert_eq!(removed.len(), 2, "route test+prod wf-2 harus dicabut");
        let _ = gen2;
    }

    #[test]
    fn generation_fencing_blocks_stale_route_serving() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo")];
        let gen1 = reg
            .register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        // update workflow → drain → teardown → apply → generation baru
        let new_specs = vec![spec("hook-1", HttpMethod::Post, "demo-v2")];
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
        // route lama sudah turun; route baru aktif
        assert!(matches!(
            reg.resolve_http(HttpMethod::Post, "/webhook/demo"),
            RouteResolution::NotFound
        ));
        assert!(matches!(
            reg.resolve_http(HttpMethod::Post, "/webhook/demo-v2"),
            RouteResolution::Matched(_)
        ));
    }

    #[test]
    fn full_request_flow_accepts_and_acks() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo/:id")];
        reg.register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        let req = raw(HttpMethod::Post, "/webhook/demo/99?r=1");
        let outcome = process_webhook_request(
            &reg,
            &req,
            &allow("d-1"),
            &NormalizeLimits::default(),
            T0 + 2,
        )
        .unwrap();
        assert!(outcome.serving.is_ok());
        let stub = outcome.execution_request.expect("harus emit");
        assert_eq!(stub.workflow_id, "wf-1");
        assert_eq!(stub.node_id, "hook-1");
        assert_eq!(stub.generation, 1);
        assert_eq!(outcome.response.status_code, 200);
    }

    #[test]
    fn security_deny_fails_closed() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo")];
        reg.register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        let req = raw(HttpMethod::Post, "/webhook/demo");
        let outcome = process_webhook_request(
            &reg,
            &req,
            &deny("d-2"),
            &NormalizeLimits::default(),
            T0 + 2,
        )
        .unwrap();
        assert!(outcome.execution_request.is_none());
        assert_eq!(outcome.response.status_code, 403);
    }

    #[test]
    fn stale_envelope_is_not_replayed() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo")];
        registry_hit_old_generation(&mut reg, &specs);
    }

    // Helper uji di bawah — memisahkan karena membutuhkan akses mutasi bertingkat.
    fn registry_hit_old_generation(reg: &mut WebhookRegistry, specs: &[NodeWebhookSpec]) {
        let gen1 = reg
            .register_workflow(wf("wf-1", 1), specs, ActivationMode::Activate, None, T0)
            .unwrap();
        reg.commit_workflow("wf-1", None, T0 + 1).unwrap();
        let route = match reg.resolve_http(HttpMethod::Post, "/webhook/demo") {
            RouteResolution::Matched(route) => route,
            other => panic!("diharapkan Matched, dapat {other:?}"),
        };
        // Simulasikan envelope yang ter-capture pada generation lawas (gen1-1):
        let stale_route = ResolvedRoute {
            generation: Generation::new(0),
            ..route.clone()
        };
        // serving_check pada route lawas vs record aktif → StaleGeneration
        assert!(matches!(
            reg.serving_check(&stale_route, reg.activation()),
            Err(ServingDenied::StaleGeneration)
        ));
        let _ = gen1;
    }

    #[test]
    fn aborted_workflow_does_not_serve() {
        let mut reg = WebhookRegistry::new();
        let specs = vec![spec("hook-1", HttpMethod::Post, "demo")];
        reg.register_workflow(wf("wf-1", 1), &specs, ActivationMode::Activate, None, T0)
            .unwrap();
        // janji: register lalu abort (bukan commit)
        reg.abort_workflow("wf-1", None, T0 + 1).unwrap();
        assert!(matches!(
            reg.resolve_http(HttpMethod::Post, "/webhook/demo"),
            RouteResolution::NotFound
        ));
    }
}
