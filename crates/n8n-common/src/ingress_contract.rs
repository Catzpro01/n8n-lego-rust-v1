//! Kanonisasi P4 (Agent 2) — **Canonical Ingress Contracts** `ingress.contracts@0.1.0`.
//!
//! P4 adalah *Ingress + Activation Orchestration Plane*. Modul ini mem-bekukan
//! kontrak nilai (value contracts) yang mengalir pada jalur kanonik:
//!
//! ```text
//! EXTERNAL EVENT → INGEST → NORMALIZE → RESOLVE → SECURITY → DEDUPE/IDEMPOTENCY
//!              → ADMISSION → EXECUTION REQUEST → ACK/RESPONSE
//! ```
//!
//! Modul ini sengaja **hanya berisi nilai + aturan invariant murni**:
//!
//! * tidak ada server HTTP, tidak ada `hyper`/`axum` — envelope tidak boleh
//!   coupled ke detail transport (webhook adapter P4.3 yang memetakan HTTP →
//!   [`IngressEnvelope`]);
//! * tidak ada execution engine — hand-off ke P3 dinyatakan sebagai value
//!   [`ExecutionRequest`]; queue/admission runtime adalah P4.5;
//! * tidak ada implementasi autentikasi — P4 mengonsumsi *keputusan* security
//!   lewat [`SecurityDecisionRef`] (boundary di luar P4, fail-closed);
//! * tidak ada sumber kebenaran kedua — `RouteRecord`/`ActivationRecord` adalah
//!   proyeksi dari canonical state (workflow + activation), bukan penggantinya.
//!
//! Semua invariant divalidasi **fail-closed**: nilai di luar kontrak ditolak di
//! konstruktor / [`IngressEnvelope::validate`], bukan diam-diam dipaksa masuk.
//!
//! Jangkar kompatibilitas n8n 2.9.4 (verbatim, lihat `contracts/` Phase-2 dan
//! referensi ter-hash di `reference/n8n`):
//!
//! | kosakata P4 | sumber referensi |
//! | :--- | :--- |
//! | [`ExecutionMode`] (10 nilai) | `packages/workflow/src/execution-context.ts` (`WorkflowExecuteModeSchema`) |
//! | [`ActivationMode`] (6 nilai) | `packages/workflow/src/interfaces.ts` (`WorkflowActivateMode`) |
//! | [`RouteKind`] path prefix | `packages/@n8n/config/src/configs/endpoints.config.ts` (`webhook`, `webhook-test`, `webhook-waiting`, `form`, `form-test`, `form-waiting`) |
//! | [`HttpMethod`], [`WebhookAuth`], [`ResponseMode`], [`ResponseDataKind`] | `packages/nodes-base/nodes/Webhook/description.ts` |
//! | [`AdmissionState`], activation state machine | Issue #99 §B/§D (P4 deep design) — kosakata P4, bukan string wire n8n |
//! | `path_depth` (specificity) | `packages/cli/src/webhooks/webhook.service.ts` (`pathLength`) |

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;

/// Versi kontrak yang dibekukan oleh modul ini.
pub const CONTRACT_VERSION: &str = "ingress.contracts@0.1.0";

/// Versi wire dari [`IngressEnvelope`] (field `version`). Naik hanya lewat
/// kontrak baru — deserializer envelope wajib fail-closed pada versi asing.
pub const ENVELOPE_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// Batas eksplisit (boundedness, master prompt §2.4)
// ---------------------------------------------------------------------------

/// Panjang maksimum identitas string (request/correlation/idempotency/route id).
pub const MAX_ID_LEN: usize = 128;
/// Payload inline (JSON kecil di dalam envelope) dibatasi; yang lebih besar
/// wajib lewat referensi [`PayloadRef::External`] — envelope tidak boleh
/// menjadi buffer tak terbatas.
pub const MAX_INLINE_PAYLOAD_BYTES: usize = 64 * 1024;
/// Jumlah header HTTP yang dibawa metadata ter-normalisasi.
pub const MAX_HEADERS: usize = 64;
/// Ukuran satu nilai header.
pub const MAX_HEADER_VALUE_BYTES: usize = 8 * 1024;
/// Jumlah parameter query.
pub const MAX_QUERY_PARAMS: usize = 64;
/// Ukuran satu nilai parameter query.
pub const MAX_QUERY_VALUE_BYTES: usize = 4 * 1024;
/// Panjang maksimum machine reason-code (admission/security).
pub const MAX_REASON_CODE_LEN: usize = 64;
/// Panjang maksimum path route relatif (tanpa prefix, mis. `user/:id/create`).
pub const MAX_ROUTE_PATH_LEN: usize = 512;

// ---------------------------------------------------------------------------
// Error kontrak — terstruktur, tanpa panic, no hidden semantics
// ---------------------------------------------------------------------------

/// Seluruh pelanggaran kontrak ingress. Setiap varian adalah *alasan* yang
/// dapat dicatat dan dijadikan `reason_code` admission — tidak ada `unwrap`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IngressContractError {
    #[error("{field} tidak boleh kosong")]
    EmptyId { field: &'static str },

    #[error("{field} terlalu panjang: maks {max} bytes, dapat {actual}")]
    IdTooLong {
        field: &'static str,
        max: usize,
        actual: usize,
    },

    #[error("payload inline terlalu besar: maks {max} bytes, dapat {actual} — gunakan PayloadRef::External")]
    InlinePayloadTooLarge { max: usize, actual: usize },

    #[error("terlalu banyak entri {which}: maks {max}, dapat {actual}")]
    TooManyEntries {
        which: &'static str,
        max: usize,
        actual: usize,
    },

    #[error("nilai {which} terlalu besar: maks {max} bytes, dapat {actual}")]
    ValueTooLarge {
        which: &'static str,
        max: usize,
        actual: usize,
    },

    #[error(
        "nama header '{name}' harus lowercase (normalisasi terjadi di adapter HTTP, bukan di sini)"
    )]
    NonLowercaseHeader { name: String },

    #[error("deadline {deadline_ms} tidak berada setelah waktu terima {received_at_ms}")]
    DeadlineNotAfterReceived {
        received_at_ms: u64,
        deadline_ms: u64,
    },

    #[error("generation basi: envelope mengamati {observed}, activation saat ini {current}")]
    StaleGeneration { observed: u64, current: u64 },

    #[error("keputusan security wajib ada untuk ingress '{kind}' tetapi tidak ada — fail-closed")]
    MissingSecurityDecision { kind: &'static str },

    #[error("workflow identity belum ter-resolve pada saat hand-off execution")]
    UnresolvedWorkflow,

    #[error("generation token belum ter-resolve pada saat hand-off execution")]
    UnresolvedGeneration,

    #[error("kombinasi tidak valid: {0}")]
    InvalidCombination(&'static str),

    #[error("referensi tidak valid pada {which}: {why}")]
    InvalidReference {
        which: &'static str,
        why: &'static str,
    },

    #[error("versi envelope {0} tidak didukung (build ini berbicara {ENVELOPE_VERSION})")]
    UnsupportedEnvelopeVersion(u32),
}

// ---------------------------------------------------------------------------
// Identitas string ter-batas (request / correlation / idempotency)
// ---------------------------------------------------------------------------

macro_rules! bounded_id {
    ($(#[$meta:meta])* $name:ident) => {
        $(#[$meta])*
        ///
        /// String kosong dan di atas [`MAX_ID_LEN`] ditolak di konstruktor
        /// **dan** saat deserialisasi wire (fail-closed di kedua sisi).
        #[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, IngressContractError> {
                let value = value.into();
                if value.is_empty() {
                    return Err(IngressContractError::EmptyId {
                        field: stringify!($name),
                    });
                }
                if value.len() > MAX_ID_LEN {
                    return Err(IngressContractError::IdTooLong {
                        field: stringify!($name),
                        max: MAX_ID_LEN,
                        actual: value.len(),
                    });
                }
                Ok(Self(value))
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl std::str::FromStr for $name {
            type Err = IngressContractError;

            fn from_str(value: &str) -> Result<Self, Self::Err> {
                Self::new(value)
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                serializer.serialize_str(&self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let raw = String::deserialize(deserializer)?;
                Self::new(raw).map_err(serde::de::Error::custom)
            }
        }
    };
}

bounded_id! {
    /// Identitas unik *satu* permintaan ingress (ULID/UUID dipilih produsen —
    /// kontrak hanya menuntut non-kosong, bounded, dan unik per produsen).
    RequestId
}

bounded_id! {
    /// Mengikat request ↔ admission ↔ execution ↔ observability. Bila produsen
    /// tidak mengirim, default-nya diambil dari [`RequestId`] oleh adapter —
    /// lihat [`IngressEnvelope::correlation`].
    CorrelationId
}

bounded_id! {
    /// Kunci deduplikasi eksplisit dari produsen (mis. header `Idempotency-Key`).
    /// Semantik default plane: **at-least-once**; kunci ini men-suppress duplikat
    /// di admission (P4.5), bukan klaim exactly-once.
    IdempotencyKey
}

// ---------------------------------------------------------------------------
// Identitas workflow + generation fencing
// ---------------------------------------------------------------------------

/// Identitas workflow kanonik: `workflow_id` + `versionId` persistence
/// (n8n `workflow_entity.versionId`). Version ikut dibawa agar aktivasi versi
/// lama dapat difence terhadap versi baru.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowIdentity {
    pub workflow_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow_version_id: Option<String>,
}

impl WorkflowIdentity {
    pub fn new(
        workflow_id: impl Into<String>,
        workflow_version_id: Option<String>,
    ) -> Result<Self, IngressContractError> {
        let identity = Self {
            workflow_id: workflow_id.into(),
            workflow_version_id,
        };
        if identity.workflow_id.is_empty() {
            return Err(IngressContractError::EmptyId {
                field: "workflowId",
            });
        }
        if identity.workflow_id.len() > MAX_ID_LEN {
            return Err(IngressContractError::IdTooLong {
                field: "workflowId",
                max: MAX_ID_LEN,
                actual: identity.workflow_id.len(),
            });
        }
        if let Some(version) = &identity.workflow_version_id {
            if version.is_empty() {
                return Err(IngressContractError::EmptyId {
                    field: "workflowVersionId",
                });
            }
            if version.len() > MAX_ID_LEN {
                return Err(IngressContractError::IdTooLong {
                    field: "workflowVersionId",
                    max: MAX_ID_LEN,
                    actual: version.len(),
                });
            }
        }
        Ok(identity)
    }
}

/// Token epoch activation. Monotonic naik setiap kali sebuah workflow memasuki
/// `ACTIVATING`; bitmask "siapa yang boleh melayani" dipegang oleh nilai ini.
///
/// Fungsi fence-nya satu-satunya yang kanonik: [`fence_generation`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct Generation(u64);

impl Generation {
    pub const fn new(value: u64) -> Self {
        Self(value)
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    pub fn next(self) -> Self {
        Self(self.0 + 1)
    }

    /// `true` bila token ini lebih tua dari activation yang sekarang.
    pub fn is_stale_against(self, current: Generation) -> bool {
        self.0 < current.0
    }
}

impl fmt::Display for Generation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Generation fencing kanonik (fail-closed).
///
/// `observed` ter-capture saat envelope di-resolve; `current` adalah activation
/// generation yang hidup saat admission mengevaluasi. **Setiap ketidakcocokan
/// ditolak** — lebih tua berarti aktivasi basi, lebih baru berarti envelope
/// mengklaim masa depan (replay/race) — keduanya tidak boleh lolos menjadi
/// execution yang salah.
pub fn fence_generation(
    observed: Generation,
    current: Generation,
) -> Result<(), IngressContractError> {
    if observed == current {
        Ok(())
    } else {
        Err(IngressContractError::StaleGeneration {
            observed: observed.get(),
            current: current.get(),
        })
    }
}

// ---------------------------------------------------------------------------
// Mode execution + mode activation (verbatim n8n)
// ---------------------------------------------------------------------------

/// `WorkflowExecuteMode` n8n 2.9.4 (zod union di
/// `packages/workflow/src/execution-context.ts`) — sepuluh literal, verbatim.
///
/// Catatan relasi: `n8n_workflow::trigger::ExecutionMode` (agent-01) adalah
/// sub-set 4 nilai untuk trigger-LEGO internals; tipe ini adalah kosakata
/// kanonik penuh di batas ingress. Konvergensi (adapter) ditangani P4.2+
/// lewat pemetaan eksplisit — tidak ada cast diam-diam.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionMode {
    Cli,
    Error,
    Integrated,
    Internal,
    Manual,
    Retry,
    Trigger,
    Webhook,
    Evaluation,
    Chat,
}

impl Default for ExecutionMode {
    fn default() -> Self {
        ExecutionMode::Trigger
    }
}

/// `WorkflowActivateMode` n8n 2.9.4 (`packages/workflow/src/interfaces.ts`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivationMode {
    Init,
    Create,
    Update,
    Activate,
    Manual,
    LeadershipChange,
}

impl Default for ActivationMode {
    fn default() -> Self {
        ActivationMode::Activate
    }
}

// ---------------------------------------------------------------------------
// Activation state machine (Issue #99 §B, master prompt P4.2)
// ---------------------------------------------------------------------------

/// State lifecycle activation kanonik P4.
///
/// Transisi yang sah **hanya** yang terdaftar di [`CANONICAL_TRANSITIONS`] dan
/// dicek lewat [`ActivationState::can_transition`] — deterministic, tidak ada
/// short-cut (mis. `ACTIVE → FAILED` harus lewat `DEGRADED`; `INACTIVE → ACTIVE`
/// harus lewat `ACTIVATING`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ActivationState {
    Inactive,
    Activating,
    Active,
    Degraded,
    Failed,
    Draining,
    Deactivating,
}

impl ActivationState {
    /// Apakah routes state ini boleh *melayani* request activation-nya.
    /// `DEGRADED` masih melayani (sebagian trigger mati), `FAILED` tidak.
    pub fn is_serving(self) -> bool {
        matches!(self, Self::Active | Self::Degraded)
    }

    pub fn can_transition(self, to: ActivationState) -> bool {
        CANONICAL_TRANSITIONS.contains(&(self, to))
    }

    /// Seluruh state yang dapat dicapai dalam satu transisi dari `self`.
    pub fn successors(self) -> impl Iterator<Item = ActivationState> {
        CANONICAL_TRANSITIONS
            .iter()
            .filter(move |(from, _)| *from == self)
            .map(|(_, to)| *to)
    }
}

/// Tabel transisi canonical (Issue #99 §B). Satu-satunya sumber kebenaran
/// untuk pembatasan transisi — runtime P4.2 tidak menambah transisi lain.
pub const CANONICAL_TRANSITIONS: &[(ActivationState, ActivationState)] = &[
    // mulai aktivasi: generation baru diterbitkan di sini
    (ActivationState::Inactive, ActivationState::Activating),
    // commit aktivasi sukses
    (ActivationState::Activating, ActivationState::Active),
    // aktivasi gagal (error tercatat, rollback parsial selesai)
    (ActivationState::Activating, ActivationState::Failed),
    // aktivasi dibatalkan bersih tanpa error (mis. update dibatalkan kebijakan)
    (ActivationState::Activating, ActivationState::Inactive),
    // sebagian trigger/rute gagal saat sukses — workflow tetap melayani
    (ActivationState::Active, ActivationState::Degraded),
    // update/shutdown grace: berhenti menerima request baru, selesaikan yang ada
    (ActivationState::Active, ActivationState::Draining),
    // teardown segera (tanpa grace)
    (ActivationState::Active, ActivationState::Deactivating),
    // pemulihan penuh dari degraded
    (ActivationState::Degraded, ActivationState::Active),
    (ActivationState::Degraded, ActivationState::Draining),
    (ActivationState::Degraded, ActivationState::Deactivating),
    // eskalasi: degraded berkembang menjadi kegagalan penuh
    (ActivationState::Degraded, ActivationState::Failed),
    // drain selesai / deadline drain lewat → teardown
    (ActivationState::Draining, ActivationState::Deactivating),
    // teardown selesai bersih
    (ActivationState::Deactivating, ActivationState::Inactive),
    // teardown gagal — catat error, rekonsiliasi P4.7 membersihkan
    (ActivationState::Deactivating, ActivationState::Failed),
    // retry eksplisit atau pembersihan error oleh operator/rekonsiliasi
    (ActivationState::Failed, ActivationState::Activating),
    (ActivationState::Failed, ActivationState::Inactive),
];

/// Satu failure activation tercatat (pesan diekspos seperti
/// `ActivationErrorsService` n8n → `GET /rest/active-workflows/error/:id`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node: Option<String>,
    pub at_ms: u64,
}

/// Snapshot canonical activation sebuah workflow (proyeksi; sumber kebenaran
/// tetap workflow + activation store P4.2 — record ini value-nya).
///
/// Invariant fail-closed ([`ActivationRecord::validate`]):
/// * `drain_deadline_ms` hanya boleh ada saat `Draining`, dan wajib ada saat itu;
/// * `last_error` hanya boleh ada saat `Failed` atau `Degraded`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationRecord {
    pub workflow: WorkflowIdentity,
    pub state: ActivationState,
    pub generation: Generation,
    pub activation_mode: ActivationMode,
    pub entered_state_at_ms: u64,
    pub updated_at_ms: u64,
    /// Instance pemilik activation (batas leadership multi-main; readiness
    /// tanpa mewajibkan infrastruktur terdistribusi sekarang).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_instance: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub drain_deadline_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<ActivationError>,
}

impl ActivationRecord {
    pub fn new(
        workflow: WorkflowIdentity,
        state: ActivationState,
        generation: Generation,
        activation_mode: ActivationMode,
        now_ms: u64,
    ) -> Self {
        Self {
            workflow,
            state,
            generation,
            activation_mode,
            entered_state_at_ms: now_ms,
            updated_at_ms: now_ms,
            owner_instance: None,
            drain_deadline_ms: None,
            last_error: None,
        }
    }

    pub fn validate(&self) -> Result<(), IngressContractError> {
        match (self.state, self.drain_deadline_ms.is_some()) {
            (ActivationState::Draining, false) => {
                return Err(IngressContractError::InvalidCombination(
                    "drain_deadline_ms wajib ada saat state Draining",
                ));
            }
            (ActivationState::Draining, true) => {}
            (_, true) => {
                return Err(IngressContractError::InvalidCombination(
                    "drain_deadline_ms hanya boleh ada saat state Draining",
                ));
            }
            _ => {}
        }
        if self.last_error.is_some()
            && !matches!(
                self.state,
                ActivationState::Failed | ActivationState::Degraded
            )
        {
            return Err(IngressContractError::InvalidCombination(
                "last_error hanya boleh ada saat state Failed/Degraded",
            ));
        }
        if self.entered_state_at_ms > self.updated_at_ms {
            return Err(IngressContractError::InvalidCombination(
                "entered_state_at_ms tidak boleh lebih baru dari updated_at_ms",
            ));
        }
        Ok(())
    }

    /// Guard transisi penuh: cek [`CANONICAL_TRANSITIONS`] **dan** invariant
    /// record hasil transisi — satu pintu, deterministic.
    pub fn can_advance(&self, to: ActivationState) -> bool {
        self.state.can_transition(to)
    }
}

// ---------------------------------------------------------------------------
// Route (webhook/form) — kontrak routing, bukan implementasi atlas (P4.3)
// ---------------------------------------------------------------------------

/// Keluarga route HTTP yang dilayani plane ini. Enam nilai mengikuti enam
/// endpoint segment n8n (lihat `endpoints.config.ts`); prefix-nya *default*
/// n8n dan dapat diubah konfigurasi deployment — karena itu record menyimpan
/// path relatif, adapter P4.3 yang melepaskan prefix aktual.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RouteKind {
    ProductionWebhook,
    TestWebhook,
    WaitingWebhook,
    ProductionForm,
    TestForm,
    WaitingForm,
}

impl RouteKind {
    /// Path prefix default n8n 2.9.4 (configurable; hanya nilai *default*).
    pub fn default_path_prefix(self) -> &'static str {
        match self {
            Self::ProductionWebhook => "/webhook/",
            Self::TestWebhook => "/webhook-test/",
            Self::WaitingWebhook => "/webhook-waiting/",
            Self::ProductionForm => "/form/",
            Self::TestForm => "/form-test/",
            Self::WaitingForm => "/form-waiting/",
        }
    }

    /// Route "waiting" = resume execution yang sudah ada — BUKAN membuat
    /// execution baru (P4.6 menegakkan ini).
    pub fn is_resume(self) -> bool {
        matches!(self, Self::WaitingWebhook | Self::WaitingForm)
    }

    /// Route test (editor listen / form test).
    pub fn is_test(self) -> bool {
        matches!(self, Self::TestWebhook | Self::TestForm)
    }
}

/// Metode HTTP yang didukung node Webhook n8n 2.9.4
/// (`Webhook/description.ts`: DELETE, GET, HEAD, PATCH, POST, PUT).
/// Serialisasi UPPERCASE — sama dengan wire n8n.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum HttpMethod {
    Delete,
    Get,
    Head,
    Patch,
    Post,
    Put,
}

impl HttpMethod {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Delete => "DELETE",
            Self::Get => "GET",
            Self::Head => "HEAD",
            Self::Patch => "PATCH",
            Self::Post => "POST",
            Self::Put => "PUT",
        }
    }
}

/// Skema autentikasi yang diminta node webhook (`authentication` param,
/// verbatim). P4 **tidak mengimplementasi** skema ini — ia hanya membawanya
/// ke batas security; keputusan akhir adalah [`SecurityDecisionRef`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WebhookAuth {
    BasicAuth,
    HeaderAuth,
    JwtAuth,
    None,
}

impl Default for WebhookAuth {
    fn default() -> Self {
        WebhookAuth::None
    }
}

/// Satu route terdaftar (proyeksi dari route atlas/registration P4.3).
///
/// Specificity: `path` bersifat statis murni (tanpa `:` dan `*`) selalu
/// menang atas yang dinamis; sesama dinamis, `path_depth` (analog
/// `pathLength` referensi) menjadi tie-break — kebijakan konflik penuh (kolisi
/// statis identik, duplikasi metode) milik P4.3, kontrak ini hanya membekukan
/// input yang harus ada agar kebijakan itu deterministic.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRecord {
    pub route_id: String,
    pub workflow: WorkflowIdentity,
    /// `INode.id` — stabil terhadap rename node.
    pub node_id: String,
    /// Nama node saat registrasi (untuk observability/pesan error).
    pub node_name: String,
    pub kind: RouteKind,
    pub method: HttpMethod,
    /// Path relatif terhadap prefix kind (mis. `user/:id/create` atau uuid
    /// untuk route waiting), tanpa leading slash.
    pub path: String,
    /// Input specificity: jumlah segmen `path` (analog `pathLength` n8n).
    pub path_depth: u32,
    /// Activation generation saat route ini diregistrasi — dibandingkan
    /// dengan envelope lewat [`fence_generation`].
    pub generation: Generation,
    pub registered_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub webhook_id: Option<String>,
    pub auth: WebhookAuth,
}

impl RouteRecord {
    /// `true` bila path tidak mengandung parameter (`:seg`) maupun wildcard (`*`).
    pub fn is_static(&self) -> bool {
        !self.path.contains(':') && !self.path.contains('*')
    }

    pub fn validate(&self) -> Result<(), IngressContractError> {
        if self.route_id.is_empty() {
            return Err(IngressContractError::EmptyId { field: "routeId" });
        }
        if self.route_id.len() > MAX_ID_LEN {
            return Err(IngressContractError::IdTooLong {
                field: "routeId",
                max: MAX_ID_LEN,
                actual: self.route_id.len(),
            });
        }
        if self.node_id.is_empty() {
            return Err(IngressContractError::EmptyId { field: "nodeId" });
        }
        if self.path.is_empty() {
            return Err(IngressContractError::EmptyId { field: "path" });
        }
        if self.path.len() > MAX_ROUTE_PATH_LEN {
            return Err(IngressContractError::IdTooLong {
                field: "path",
                max: MAX_ROUTE_PATH_LEN,
                actual: self.path.len(),
            });
        }
        if self.path.starts_with('/') {
            return Err(IngressContractError::InvalidCombination(
                "route path harus relatif (tanpa leading '/') — prefix milik adapter HTTP",
            ));
        }
        if self.path_depth == 0 {
            return Err(IngressContractError::InvalidCombination(
                "path_depth harus >= 1 untuk path non-kosong",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Security decision reference (dikonsumsi P4, diproduksi di luar P4)
// ---------------------------------------------------------------------------

/// Hasil keputusan security pada batas ingress.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SecurityOutcome {
    Allow,
    Deny,
    /// Bukti tidak cukup — diperlakukan sama dengan Deny (fail-closed).
    Indeterminate,
}

/// Referensi *keputusan* security (bukan kredensial, bukan proses).
/// `authority` menunjuk siapa yang memutuskan (mis. webhook-auth service,
/// api-key middleware); P4 hanya membawa referensinya untuk audit/fencing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityDecisionRef {
    pub decision_id: String,
    pub authority: String,
    pub outcome: SecurityOutcome,
    pub decided_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason_code: Option<String>,
}

impl SecurityDecisionRef {
    /// Satu-satunya kondisi mengizinkan: keputusan eksplisit `Allow`.
    pub fn must_admit(&self) -> bool {
        self.outcome == SecurityOutcome::Allow
    }
}

// ---------------------------------------------------------------------------
// Payload + metadata referensi (bounded; binary lewat External)
// ---------------------------------------------------------------------------

/// Referensi payload kanonik. JSON kecil boleh inline; payload besar dan
/// **seluruh binary** wajib `External` (body-store/binary plane di luar P4;
/// envelope tidak mengangkut base64).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PayloadRef {
    Inline {
        json: Value,
    },
    External {
        uri: String,
        sha256: String,
        size_bytes: u64,
        #[serde(skip_serializing_if = "Option::is_none")]
        media_type: Option<String>,
    },
}

impl PayloadRef {
    /// Konstruktor inline dengan cap [`MAX_INLINE_PAYLOAD_BYTES`] — diukur
    /// dari serialisasi JSON-nya (bukan tebakan).
    pub fn inline(json: Value) -> Result<Self, IngressContractError> {
        let size = serde_json::to_vec(&json)
            .map_err(|_| IngressContractError::InvalidReference {
                which: "payload",
                why: "JSON tidak dapat diserialisasi",
            })?
            .len();
        if size > MAX_INLINE_PAYLOAD_BYTES {
            return Err(IngressContractError::InlinePayloadTooLarge {
                max: MAX_INLINE_PAYLOAD_BYTES,
                actual: size,
            });
        }
        Ok(Self::Inline { json })
    }

    /// Konstruktor referensi eksternal: URI non-kosong, digest sha256 hex
    /// lowercase 64 karakter (fail-closed — referensi yang tidak dapat
    /// diverifikasi tidak masuk plane).
    pub fn external(
        uri: impl Into<String>,
        sha256: impl Into<String>,
        size_bytes: u64,
        media_type: Option<String>,
    ) -> Result<Self, IngressContractError> {
        let uri = uri.into();
        let sha256 = sha256.into();
        if uri.is_empty() {
            return Err(IngressContractError::EmptyId { field: "uri" });
        }
        let valid_digest = sha256.len() == 64
            && sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase());
        if !valid_digest {
            return Err(IngressContractError::InvalidReference {
                which: "payload",
                why: "sha256 harus hex lowercase 64 karakter",
            });
        }
        Ok(Self::External {
            uri,
            sha256,
            size_bytes,
            media_type,
        })
    }

    pub fn is_inline(&self) -> bool {
        matches!(self, Self::Inline { .. })
    }

    /// Batas atas byte yang akan diangkut plane untuk payload ini.
    pub fn size_hint_bytes(&self) -> u64 {
        match self {
            Self::Inline { .. } => MAX_INLINE_PAYLOAD_BYTES as u64,
            Self::External { size_bytes, .. } => *size_bytes,
        }
    }
}

/// Metadata transport ter-normalisasi (hasil NORMALIZE): pasangan
/// `(nama, nilai)` berurutan dan boleh duplikat — persis semantik HTTP.
/// Nama header wajib lowercase (normalisasi case terjadi di adapter HTTP saat
/// masuk; kontrak menolak yang belum ternormalisasi agar tidak ada dua bentuk
/// kebenaran nama header).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MetadataRef {
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub query: Vec<(String, String)>,
}

impl MetadataRef {
    pub fn new(
        headers: Vec<(String, String)>,
        query: Vec<(String, String)>,
    ) -> Result<Self, IngressContractError> {
        checked_pairs(
            &headers,
            "header",
            MAX_HEADERS,
            MAX_HEADER_VALUE_BYTES,
            true,
        )?;
        checked_pairs(
            &query,
            "query",
            MAX_QUERY_PARAMS,
            MAX_QUERY_VALUE_BYTES,
            false,
        )?;
        Ok(Self { headers, query })
    }

    /// Nilai pertama untuk nama (header case-insensitive tidak diperlukan —
    /// kontrak menjamin lowercase).
    pub fn header<'a>(&'a self, name: &str) -> Option<&'a str> {
        self.headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    pub fn query_param<'a>(&'a self, name: &str) -> Option<&'a str> {
        self.query
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
}

fn checked_pairs(
    pairs: &[(String, String)],
    which: &'static str,
    max_entries: usize,
    max_value_bytes: usize,
    require_lowercase: bool,
) -> Result<(), IngressContractError> {
    if pairs.len() > max_entries {
        return Err(IngressContractError::TooManyEntries {
            which,
            max: max_entries,
            actual: pairs.len(),
        });
    }
    for (name, value) in pairs {
        if name.is_empty() {
            return Err(IngressContractError::EmptyId { field: which });
        }
        if require_lowercase && name.bytes().any(|b| b.is_ascii_uppercase()) {
            return Err(IngressContractError::NonLowercaseHeader { name: name.clone() });
        }
        if value.len() > max_value_bytes {
            return Err(IngressContractError::ValueTooLarge {
                which,
                max: max_value_bytes,
                actual: value.len(),
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Sumber ingress
// ---------------------------------------------------------------------------

/// Dari pintu mana suatu request masuk. Enam nilai pertama berpasangan 1:1
/// dengan [`RouteKind`] (HTTP edge); sisanya bukan HTTP.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IngressSourceKind {
    ProductionWebhook,
    TestWebhook,
    WaitingWebhook,
    ProductionForm,
    TestForm,
    WaitingForm,
    Schedule,
    Poll,
    Event,
    Manual,
    Internal,
}

impl IngressSourceKind {
    /// Apakah sumber ini tiba lewat HTTP edge (dan karena itu punya route kind).
    pub fn to_route_kind(self) -> Option<RouteKind> {
        match self {
            Self::ProductionWebhook => Some(RouteKind::ProductionWebhook),
            Self::TestWebhook => Some(RouteKind::TestWebhook),
            Self::WaitingWebhook => Some(RouteKind::WaitingWebhook),
            Self::ProductionForm => Some(RouteKind::ProductionForm),
            Self::TestForm => Some(RouteKind::TestForm),
            Self::WaitingForm => Some(RouteKind::WaitingForm),
            _ => None,
        }
    }

    /// Keputusan security wajib ada untuk sumber yang melintasi batas
    /// eksternal instance (HTTP edge + event bus). Schedule/poll/manual/internal
    /// berasal dari dalam batas trust sehingga putusan security-nya milik
    /// caller — bukan envelope.
    pub fn requires_security_decision(self) -> bool {
        self.to_route_kind().is_some() || matches!(self, Self::Event)
    }
}

/// Sumber ter-normalisasi: dari mana + bentuk mentah request pada edge.
/// `received_method`/`received_path` wajib ada untuk sumber HTTP (RESOLVE
/// membutuhkannya), wajib absen untuk sumber non-HTTP.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressSource {
    pub kind: IngressSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_method: Option<HttpMethod>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub received_path: Option<String>,
}

impl IngressSource {
    pub fn http(kind: IngressSourceKind, method: HttpMethod, path: impl Into<String>) -> Self {
        Self {
            kind,
            received_method: Some(method),
            received_path: Some(path.into()),
        }
    }

    pub fn internal(kind: IngressSourceKind) -> Self {
        Self {
            kind,
            received_method: None,
            received_path: None,
        }
    }

    fn validate(&self) -> Result<(), IngressContractError> {
        let is_http = self.kind.to_route_kind().is_some();
        match (
            is_http,
            self.received_method.is_some(),
            self.received_path.is_some(),
        ) {
            (true, true, true) => Ok(()),
            (true, _, _) => Err(IngressContractError::InvalidCombination(
                "sumber HTTP wajib membawa received_method + received_path",
            )),
            (false, false, false) => Ok(()),
            (false, _, _) => Err(IngressContractError::InvalidCombination(
                "sumber non-HTTP tidak boleh membawa received_method/received_path",
            )),
        }
    }
}

/// Prioritas kanonik admission (tiga kelas; hierarki lanjutan = P4.8).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Priority {
    Low,
    #[default]
    Normal,
    High,
}

// ---------------------------------------------------------------------------
// IngressEnvelope — objek kanonik "External Request → canonical ingress object"
// ---------------------------------------------------------------------------

/// Kontrak nilai pusat P4: satu permintaan eksternal yang sudah
/// ter-normalisasi dan siap di-admit.
///
/// `workflow` dan `generation` adalah hasil RESOLVE dan `Option` karena RESOLVE
/// berjalan setelah NORMALIZE; admission (P4.5) + hand-off
/// ([`ExecutionRequest::from_envelope`]) menolak keduanya bila absen.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IngressEnvelope {
    /// Selalu [`ENVELOPE_VERSION`] — versi lain ditolak saat validate.
    pub version: u32,
    pub request_id: RequestId,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub correlation_id: Option<CorrelationId>,
    pub received_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    pub priority: Priority,
    pub source: IngressSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workflow: Option<WorkflowIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub generation: Option<Generation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tenant_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub security: Option<SecurityDecisionRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<IdempotencyKey>,
    pub payload: PayloadRef,
    #[serde(default)]
    pub metadata: MetadataRef,
}

impl IngressEnvelope {
    /// Pemeriksaan invariant penuh, fail-closed. Dipanggil adapter tepat
    /// setelah NORMALIZE dan wajib dipanggil ulang sebelum ADMISSION.
    pub fn validate(&self) -> Result<(), IngressContractError> {
        if self.version != ENVELOPE_VERSION {
            return Err(IngressContractError::UnsupportedEnvelopeVersion(
                self.version,
            ));
        }
        self.source.validate()?;
        if let Some(deadline) = self.deadline_ms {
            if deadline <= self.received_at_ms {
                return Err(IngressContractError::DeadlineNotAfterReceived {
                    received_at_ms: self.received_at_ms,
                    deadline_ms: deadline,
                });
            }
        }
        if self.source.kind.requires_security_decision() && self.security.is_none() {
            return Err(IngressContractError::MissingSecurityDecision {
                kind: match self.source.kind {
                    IngressSourceKind::ProductionWebhook => "productionWebhook",
                    IngressSourceKind::TestWebhook => "testWebhook",
                    IngressSourceKind::WaitingWebhook => "waitingWebhook",
                    IngressSourceKind::ProductionForm => "productionForm",
                    IngressSourceKind::TestForm => "testForm",
                    IngressSourceKind::WaitingForm => "waitingForm",
                    IngressSourceKind::Event => "event",
                    _ => "http",
                },
            });
        }
        if let Some(security) = &self.security {
            if let Some(code) = &security.reason_code {
                if code.len() > MAX_REASON_CODE_LEN {
                    return Err(IngressContractError::ValueTooLarge {
                        which: "reasonCode",
                        max: MAX_REASON_CODE_LEN,
                        actual: code.len(),
                    });
                }
            }
        }
        Ok(())
    }

    /// Korelasi efektif: eksplisit bila ada, jika tidak correlation = request id
    /// (keputusan default ini satu-satunya yang kanonik — adapter tidak
    /// membuat skema lain).
    pub fn correlation(&self) -> CorrelationId {
        match &self.correlation_id {
            Some(id) => id.clone(),
            None => CorrelationId(self.request_id.as_str().to_string()),
        }
    }

    /// Apakah batas waktu sudah terlampaui pada `now_ms` (input admission
    /// `EXPIRED`; keputusan akhir milik P4.5).
    pub fn is_expired_at(&self, now_ms: u64) -> bool {
        self.deadline_ms.is_some_and(|deadline| now_ms >= deadline)
    }

    /// `true` bila RESOLVE sudah mengikat target + generation.
    pub fn is_resolved(&self) -> bool {
        self.workflow.is_some() && self.generation.is_some()
    }
}

// ---------------------------------------------------------------------------
// Admission (kosakata statenya dibekukan di sini; mesinnya P4.5)
// ---------------------------------------------------------------------------

/// State keputusan admission — set persis dari Issue #99 §D.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdmissionState {
    Accepted,
    Queued,
    Deferred,
    RateLimited,
    Rejected,
    Duplicate,
    Expired,
    Unavailable,
}

impl AdmissionState {
    /// Apakah request lanjut menuju execution (sekarang atau setelah queue).
    pub fn is_admitting(self) -> bool {
        matches!(self, Self::Accepted | Self::Queued)
    }
}

/// Machine reason-codes kanonik (bounded lihat [`MAX_REASON_CODE_LEN`]).
/// String-string ini adalah kosakata P4 — observable, stabil, dapat digrep.
pub mod admission_reason {
    pub const ROUTE_NOT_FOUND: &str = "ROUTE_NOT_FOUND";
    pub const STALE_GENERATION: &str = "STALE_GENERATION";
    pub const WORKFLOW_INACTIVE: &str = "WORKFLOW_INACTIVE";
    pub const AUTH_DENIED: &str = "AUTH_DENIED";
    pub const MALFORMED_REQUEST: &str = "MALFORMED_REQUEST";
    pub const BODY_TOO_LARGE: &str = "BODY_TOO_LARGE";
    pub const OVERLOAD: &str = "OVERLOAD";
    pub const RATE_LIMIT: &str = "RATE_LIMIT";
    pub const DEADLINE_EXCEEDED: &str = "DEADLINE_EXCEEDED";
    pub const DUPLICATE: &str = "DUPLICATE";
    pub const CONTRACT_VIOLATION: &str = "CONTRACT_VIOLATION";
    pub const OK: &str = "OK";
}

/// Keputusan admission immutable (receipt-nya P4.5 yang menerbitkan —
/// kontrak ini nilai + invariantnya saja).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdmissionDecision {
    pub state: AdmissionState,
    pub reason_code: String,
    pub decided_at_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<RequestId>,
}

impl AdmissionDecision {
    pub fn new(
        state: AdmissionState,
        reason_code: impl Into<String>,
        decided_at_ms: u64,
    ) -> Result<Self, IngressContractError> {
        let reason_code = reason_code.into();
        if reason_code.is_empty() {
            return Err(IngressContractError::EmptyId {
                field: "reasonCode",
            });
        }
        if reason_code.len() > MAX_REASON_CODE_LEN {
            return Err(IngressContractError::ValueTooLarge {
                which: "reasonCode",
                max: MAX_REASON_CODE_LEN,
                actual: reason_code.len(),
            });
        }
        Ok(Self {
            state,
            reason_code,
            decided_at_ms,
            retry_after_ms: None,
            duplicate_of: None,
        })
    }

    pub fn with_retry_after(mut self, retry_after_ms: u64) -> Self {
        self.retry_after_ms = Some(retry_after_ms);
        self
    }

    pub fn with_duplicate_of(mut self, original: RequestId) -> Self {
        self.duplicate_of = Some(original);
        self
    }

    pub fn validate(&self) -> Result<(), IngressContractError> {
        if self.state == AdmissionState::Duplicate && self.duplicate_of.is_none() {
            return Err(IngressContractError::InvalidCombination(
                "state Duplicate wajib membawa duplicate_of (request asli)",
            ));
        }
        if self.retry_after_ms.is_some()
            && !matches!(
                self.state,
                AdmissionState::Deferred
                    | AdmissionState::RateLimited
                    | AdmissionState::Unavailable
            )
        {
            return Err(IngressContractError::InvalidCombination(
                "retry_after_ms hanya bermakna untuk Deferred/RateLimited/Unavailable",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Response plan (bagaimana HTTP edge menjawab; nilai verbatim node webhook)
// ---------------------------------------------------------------------------

/// `responseMode` node Webhook n8n 2.9.4 — empat nilai, verbatim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResponseMode {
    /// Jawab segera saat request diterima (default n8n), tanpa hasil execution.
    OnReceived,
    /// Jawab dengan output node terakhir setelah execution selesai.
    LastNode,
    /// Jawab lewat node "Respond to Webhook".
    ResponseNode,
    /// Jawab streaming (chunked) dari execution.
    Streaming,
}

/// `responseData` node Webhook (hanya bermakna pada mode `lastNode`,
/// sebagaimana `displayOptions` referensi yang hanya menampilkannya di sana).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResponseDataKind {
    AllEntries,
    FirstEntryJson,
    FirstEntryBinary,
    NoData,
}

/// Rencana menjawab pemanggil HTTP — diputuskan dari parameter node pada
/// RESOLVE dan dibawa sampai ACK/RESPONSE. Invariant:
/// `response_data` hanya boleh ada pada [`ResponseMode::LastNode`], `status_code`
/// dalam rentang HTTP valid, header mematuhi batas yang sama dengan metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResponsePlan {
    pub mode: ResponseMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_data: Option<ResponseDataKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_code: Option<u16>,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
}

impl ResponsePlan {
    pub fn validate(&self) -> Result<(), IngressContractError> {
        if self.mode != ResponseMode::LastNode && self.response_data.is_some() {
            return Err(IngressContractError::InvalidCombination(
                "response_data hanya bermakna untuk mode lastNode",
            ));
        }
        if let Some(code) = self.status_code {
            if !(100..=599).contains(&code) {
                return Err(IngressContractError::InvalidCombination(
                    "status_code di luar rentang HTTP 100..=599",
                ));
            }
        }
        checked_pairs(
            &self.headers,
            "header",
            MAX_HEADERS,
            MAX_HEADER_VALUE_BYTES,
            true,
        )
    }

    /// Mode yang menjawab tanpa menunggu hasil execution.
    pub fn responds_immediately(&self) -> bool {
        self.mode == ResponseMode::OnReceived
    }
}

impl Default for ResponsePlan {
    /// Default n8n: `responseMode: onReceived`, tanpa response_data.
    fn default() -> Self {
        Self {
            mode: ResponseMode::OnReceived,
            response_data: None,
            status_code: None,
            headers: Vec::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Execution request (ADMISSION → P3 hand-off)
// ---------------------------------------------------------------------------

/// Permintaan eksekusi yang keluar dari plane P4 menuju batas eksekusi P3
/// ("P4 emits a stable execution/admission request contract" — Issue #99).
///
/// Relasi: `n8n_workflow::trigger::ExecutionRequest` (agent-01) adalah hand-off
/// internal trigger-LEGO (data-first, per-emit). Tipe ini nilai kanonik di
/// batas P4→P3: membawa identitas request end-to-end, fence generation,
/// deadline, dan payload *referensi* — bukan salinan data plane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionRequest {
    pub request_id: RequestId,
    pub correlation_id: CorrelationId,
    pub workflow: WorkflowIdentity,
    pub mode: ExecutionMode,
    /// Node trigger/webhook yang memulai (nama node — pesan error n8n memakai nama).
    pub start_node_name: String,
    pub source: IngressSourceKind,
    pub generation: Generation,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deadline_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<IdempotencyKey>,
    pub payload: PayloadRef,
    pub enqueued_at_ms: u64,
}

impl ExecutionRequest {
    /// Bind RESOLVE + ADMISSION ke hand-off, fail-closed:
    /// envelope harus (a) valid, (b) sudah ter-resolve, (c) tidak kedaluwarsa
    /// pada saat ini. `mode` adalah keputusan eksplisit ingress runtime
    /// (P4.2+), bukan tebakan dari sumber — sesuai aturan no hidden semantics.
    pub fn from_envelope(
        envelope: &IngressEnvelope,
        mode: ExecutionMode,
        start_node_name: impl Into<String>,
        now_ms: u64,
    ) -> Result<Self, IngressContractError> {
        envelope.validate()?;
        let workflow = envelope
            .workflow
            .clone()
            .ok_or(IngressContractError::UnresolvedWorkflow)?;
        let generation = envelope
            .generation
            .ok_or(IngressContractError::UnresolvedGeneration)?;
        if envelope.is_expired_at(now_ms) {
            return Err(IngressContractError::DeadlineNotAfterReceived {
                received_at_ms: envelope.received_at_ms,
                deadline_ms: envelope.deadline_ms.unwrap_or(now_ms),
            });
        }
        let start_node_name = start_node_name.into();
        if start_node_name.is_empty() {
            return Err(IngressContractError::EmptyId {
                field: "startNodeName",
            });
        }
        Ok(Self {
            request_id: envelope.request_id.clone(),
            correlation_id: envelope.correlation(),
            workflow,
            mode,
            start_node_name,
            source: envelope.source.kind,
            generation,
            deadline_ms: envelope.deadline_ms,
            idempotency_key: envelope.idempotency_key.clone(),
            payload: envelope.payload.clone(),
            enqueued_at_ms: now_ms,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // ---------------------------------------------------------------- fixtures

    fn sha256_hex() -> String {
        "a".repeat(64)
    }

    fn http_envelope() -> IngressEnvelope {
        IngressEnvelope {
            version: ENVELOPE_VERSION,
            request_id: RequestId::new("req-0001").unwrap(),
            correlation_id: None,
            received_at_ms: 1_000,
            deadline_ms: Some(31_000),
            priority: Priority::Normal,
            source: IngressSource::http(
                IngressSourceKind::ProductionWebhook,
                HttpMethod::Post,
                "ab12cd34/orders/:id",
            ),
            workflow: Some(WorkflowIdentity::new("wf-9", Some("ver-3".to_string())).unwrap()),
            generation: Some(Generation::new(7)),
            tenant_id: None,
            security: Some(SecurityDecisionRef {
                decision_id: "sec-1".to_string(),
                authority: "webhook-auth".to_string(),
                outcome: SecurityOutcome::Allow,
                decided_at_ms: 999,
                reason_code: None,
            }),
            idempotency_key: Some(IdempotencyKey::new("idem-xyz").unwrap()),
            payload: PayloadRef::inline(json!({ "hello": "world" })).unwrap(),
            metadata: MetadataRef::new(
                vec![("x-api-key".to_string(), "k".to_string())],
                vec![("verbose".to_string(), "1".to_string())],
            )
            .unwrap(),
        }
    }

    fn sample_route() -> RouteRecord {
        RouteRecord {
            route_id: "route-1".to_string(),
            workflow: WorkflowIdentity::new("wf-9", Some("ver-3".to_string())).unwrap(),
            node_id: "node-uuid-1".to_string(),
            node_name: "Webhook".to_string(),
            kind: RouteKind::ProductionWebhook,
            method: HttpMethod::Post,
            path: "ab12cd34/orders/:id".to_string(),
            path_depth: 3,
            generation: Generation::new(7),
            registered_at_ms: 500,
            webhook_id: Some("wh-77".to_string()),
            auth: WebhookAuth::HeaderAuth,
        }
    }

    fn activation(state: ActivationState) -> ActivationRecord {
        let mut record = ActivationRecord::new(
            WorkflowIdentity::new("wf-9", Some("ver-3".to_string())).unwrap(),
            state,
            Generation::new(7),
            ActivationMode::Activate,
            100,
        );
        if state == ActivationState::Draining {
            record.drain_deadline_ms = Some(5_000);
        }
        record
    }

    // ------------------------------------------------- kontrak & versi wire

    #[test]
    fn contract_version_is_pinned() {
        assert_eq!(CONTRACT_VERSION, "ingress.contracts@0.1.0");
        assert_eq!(ENVELOPE_VERSION, 1);
    }

    #[test]
    fn execution_and_activation_modes_match_n8n_strings_verbatim() {
        let modes = [
            (ExecutionMode::Cli, "cli"),
            (ExecutionMode::Error, "error"),
            (ExecutionMode::Integrated, "integrated"),
            (ExecutionMode::Internal, "internal"),
            (ExecutionMode::Manual, "manual"),
            (ExecutionMode::Retry, "retry"),
            (ExecutionMode::Trigger, "trigger"),
            (ExecutionMode::Webhook, "webhook"),
            (ExecutionMode::Evaluation, "evaluation"),
            (ExecutionMode::Chat, "chat"),
        ];
        for (mode, wire) in modes {
            assert_eq!(serde_json::to_value(mode).unwrap(), json!(wire), "{wire}");
        }
        let activation_modes = [
            (ActivationMode::Init, "init"),
            (ActivationMode::Create, "create"),
            (ActivationMode::Update, "update"),
            (ActivationMode::Activate, "activate"),
            (ActivationMode::Manual, "manual"),
            (ActivationMode::LeadershipChange, "leadershipChange"),
        ];
        for (mode, wire) in activation_modes {
            assert_eq!(serde_json::to_value(mode).unwrap(), json!(wire), "{wire}");
        }
    }

    #[test]
    fn route_kinds_and_methods_match_n8n_endpoint_segments() {
        assert_eq!(
            RouteKind::ProductionWebhook.default_path_prefix(),
            "/webhook/"
        );
        assert_eq!(
            RouteKind::TestWebhook.default_path_prefix(),
            "/webhook-test/"
        );
        assert_eq!(
            RouteKind::WaitingWebhook.default_path_prefix(),
            "/webhook-waiting/"
        );
        assert_eq!(RouteKind::ProductionForm.default_path_prefix(), "/form/");
        assert_eq!(RouteKind::TestForm.default_path_prefix(), "/form-test/");
        assert_eq!(
            RouteKind::WaitingForm.default_path_prefix(),
            "/form-waiting/"
        );
        assert!(RouteKind::WaitingWebhook.is_resume() && RouteKind::WaitingForm.is_resume());
        assert!(!RouteKind::ProductionWebhook.is_resume());
        let methods = [
            (HttpMethod::Delete, "DELETE"),
            (HttpMethod::Get, "GET"),
            (HttpMethod::Head, "HEAD"),
            (HttpMethod::Patch, "PATCH"),
            (HttpMethod::Post, "POST"),
            (HttpMethod::Put, "PUT"),
        ];
        for (method, wire) in methods {
            assert_eq!(serde_json::to_value(method).unwrap(), json!(wire), "{wire}");
            assert_eq!(method.as_str(), wire);
        }
    }

    #[test]
    fn webhook_auth_and_response_enums_match_node_description() {
        let auth = [
            (WebhookAuth::BasicAuth, "basicAuth"),
            (WebhookAuth::HeaderAuth, "headerAuth"),
            (WebhookAuth::JwtAuth, "jwtAuth"),
            (WebhookAuth::None, "none"),
        ];
        for (value, wire) in auth {
            assert_eq!(serde_json::to_value(value).unwrap(), json!(wire), "{wire}");
        }
        let modes = [
            (ResponseMode::OnReceived, "onReceived"),
            (ResponseMode::LastNode, "lastNode"),
            (ResponseMode::ResponseNode, "responseNode"),
            (ResponseMode::Streaming, "streaming"),
        ];
        for (value, wire) in modes {
            assert_eq!(serde_json::to_value(value).unwrap(), json!(wire), "{wire}");
        }
        let data = [
            (ResponseDataKind::AllEntries, "allEntries"),
            (ResponseDataKind::FirstEntryJson, "firstEntryJson"),
            (ResponseDataKind::FirstEntryBinary, "firstEntryBinary"),
            (ResponseDataKind::NoData, "noData"),
        ];
        for (value, wire) in data {
            assert_eq!(serde_json::to_value(value).unwrap(), json!(wire), "{wire}");
        }
    }

    #[test]
    fn admission_states_match_issue_99d_vocabulary() {
        let states = [
            (AdmissionState::Accepted, "accepted"),
            (AdmissionState::Queued, "queued"),
            (AdmissionState::Deferred, "deferred"),
            (AdmissionState::RateLimited, "rateLimited"),
            (AdmissionState::Rejected, "rejected"),
            (AdmissionState::Duplicate, "duplicate"),
            (AdmissionState::Expired, "expired"),
            (AdmissionState::Unavailable, "unavailable"),
        ];
        for (state, wire) in states {
            assert_eq!(serde_json::to_value(state).unwrap(), json!(wire), "{wire}");
        }
        assert!(AdmissionState::Accepted.is_admitting());
        assert!(AdmissionState::Queued.is_admitting());
        assert!(!AdmissionState::RateLimited.is_admitting());
        assert!(!AdmissionState::Duplicate.is_admitting());
    }

    // -------------------------------------------------------------- payloads

    #[test]
    fn inline_payload_is_bounded_by_serialized_size() {
        let small = PayloadRef::inline(json!({"ok": true})).unwrap();
        assert!(small.is_inline());

        // 64 KiB + sedikit pasti ditolak; disusun dari string besar agar pasti melewati cap.
        let big = json!({ "blob": "x".repeat(MAX_INLINE_PAYLOAD_BYTES) });
        let error = PayloadRef::inline(big).unwrap_err();
        assert!(matches!(
            error,
            IngressContractError::InlinePayloadTooLarge { max, .. } if max == MAX_INLINE_PAYLOAD_BYTES
        ));
    }

    #[test]
    fn external_payload_requires_verifiable_reference() {
        let ok = PayloadRef::external(
            "s3://bucket/bin-1",
            sha256_hex(),
            42,
            Some("application/octet-stream".into()),
        )
        .unwrap();
        assert!(!ok.is_inline());
        assert_eq!(ok.size_hint_bytes(), 42);

        assert!(PayloadRef::external("", sha256_hex(), 1, None).is_err());
        // digest uppercase / terlalu pendek ditolak
        assert!(PayloadRef::external("s3://b/x", "A".repeat(64), 1, None).is_err());
        assert!(PayloadRef::external("s3://b/x", "abc", 1, None).is_err());
    }

    // ------------------------------------------------------------- metadata

    #[test]
    fn metadata_enforces_bounds_and_lowercase_headers() {
        assert!(
            MetadataRef::new(vec![("X-Api-Key".to_string(), "k".to_string())], vec![],).is_err()
        );
        assert!(MetadataRef::new(vec![], vec![]).unwrap().headers.is_empty());

        // 65 headers melewati cap.
        let many: Vec<(String, String)> = (0..=MAX_HEADERS)
            .map(|i| (format!("h-{i}"), "v".to_string()))
            .collect();
        assert!(matches!(
            MetadataRef::new(many, vec![]),
            Err(IngressContractError::TooManyEntries {
                which: "header",
                ..
            })
        ));

        let meta = MetadataRef::new(
            vec![("x-one".into(), "1".into()), ("x-one".into(), "2".into())],
            vec![("q".into(), "v".into())],
        )
        .unwrap();
        // duplikat dipertahankan berurutan; header() mengambil yang pertama
        assert_eq!(meta.header("x-one"), Some("1"));
        assert_eq!(meta.query_param("q"), Some("v"));
    }

    // -------------------------------------------------------------- envelope

    #[test]
    fn envelope_wire_shape_is_camel_case_and_stable() {
        let envelope = http_envelope();
        let wire = serde_json::to_value(&envelope).unwrap();
        assert_eq!(wire["version"], 1);
        assert_eq!(wire["requestId"], "req-0001");
        assert_eq!(wire["receivedAtMs"], 1000);
        assert_eq!(wire["deadlineMs"], 31000);
        assert_eq!(wire["source"]["kind"], "productionWebhook");
        assert_eq!(wire["source"]["receivedMethod"], "POST");
        assert_eq!(wire["source"]["receivedPath"], "ab12cd34/orders/:id");
        assert_eq!(wire["workflow"]["workflowId"], "wf-9");
        assert_eq!(wire["workflow"]["workflowVersionId"], "ver-3");
        assert_eq!(wire["generation"], 7);
        assert_eq!(wire["security"]["authority"], "webhook-auth");
        assert_eq!(wire["security"]["outcome"], "allow");
        assert_eq!(wire["idempotencyKey"], "idem-xyz");
        assert_eq!(wire["payload"]["kind"], "inline");
        assert_eq!(wire["metadata"]["headers"][0], json!(["x-api-key", "k"]));

        // roundtrip penuh — tidak ada field yang hilang/berubah.
        let decoded: IngressEnvelope = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, envelope);
        decoded.validate().unwrap();
    }

    #[test]
    fn envelope_defaults_correlation_to_request_id() {
        let mut envelope = http_envelope();
        assert_eq!(envelope.correlation().as_str(), "req-0001");
        envelope.correlation_id = Some(CorrelationId::new("corr-2").unwrap());
        assert_eq!(envelope.correlation().as_str(), "corr-2");
    }

    #[test]
    fn envelope_rejects_external_source_without_security_decision() {
        let mut envelope = http_envelope();
        envelope.security = None;
        let error = envelope.validate().unwrap_err();
        assert!(matches!(
            error,
            IngressContractError::MissingSecurityDecision {
                kind: "productionWebhook"
            }
        ));
    }

    #[test]
    fn envelope_allows_internal_sources_without_security_decision() {
        let mut envelope = http_envelope();
        envelope.security = None;
        envelope.source = IngressSource::internal(IngressSourceKind::Schedule);
        envelope.validate().unwrap();

        // Event lintas batas trust → wajib keputusan.
        envelope.source = IngressSource::internal(IngressSourceKind::Event);
        assert!(matches!(
            envelope.validate(),
            Err(IngressContractError::MissingSecurityDecision { kind: "event" })
        ));
    }

    #[test]
    fn envelope_rejects_deadline_at_or_before_receipt() {
        let mut envelope = http_envelope();
        envelope.deadline_ms = Some(envelope.received_at_ms);
        assert!(matches!(
            envelope.validate(),
            Err(IngressContractError::DeadlineNotAfterReceived { .. })
        ));
        envelope.deadline_ms = Some(envelope.received_at_ms - 1);
        assert!(envelope.validate().is_err());
    }

    #[test]
    fn envelope_rejects_foreign_versions_fail_closed() {
        let envelope = http_envelope();
        let mut wire = serde_json::to_value(&envelope).unwrap();
        wire["version"] = json!(2);
        let decoded: IngressEnvelope = serde_json::from_value(wire).unwrap();
        assert!(matches!(
            decoded.validate(),
            Err(IngressContractError::UnsupportedEnvelopeVersion(2))
        ));
    }

    #[test]
    fn envelope_http_sources_require_method_and_path() {
        let mut envelope = http_envelope();
        envelope.source = IngressSource {
            kind: IngressSourceKind::ProductionWebhook,
            received_method: None,
            received_path: None,
        };
        assert!(matches!(
            envelope.validate(),
            Err(IngressContractError::InvalidCombination(_))
        ));
    }

    #[test]
    fn bounded_ids_reject_empty_and_oversized_values() {
        assert!(RequestId::new("").is_err());
        assert!(RequestId::new("x".repeat(MAX_ID_LEN)).is_ok());
        assert!(RequestId::new("x".repeat(MAX_ID_LEN + 1)).is_err());
        // fail-closed juga saat masuk lewat wire:
        let bad = serde_json::from_str::<IdempotencyKey>(&format!("\"{}\"", "y".repeat(200)));
        assert!(bad.is_err());
        let good: IdempotencyKey = serde_json::from_str("\"idem-1\"").unwrap();
        assert_eq!(good.as_str(), "idem-1");
    }

    // -------------------------------------------------------------- generation

    #[test]
    fn generation_fencing_is_exact_match_only() {
        let observed = Generation::new(7);
        assert!(fence_generation(observed, Generation::new(7)).is_ok());

        let stale = fence_generation(observed, Generation::new(8)).unwrap_err();
        assert_eq!(
            stale,
            IngressContractError::StaleGeneration {
                observed: 7,
                current: 8
            }
        );
        // "lebih baru dari current" (replay/race) juga ditolak:
        assert!(fence_generation(Generation::new(9), Generation::new(8)).is_err());

        assert!(Generation::new(1).is_stale_against(Generation::new(2)));
        assert!(!Generation::new(2).is_stale_against(Generation::new(2)));
        assert_eq!(Generation::new(2).next(), Generation::new(3));
    }

    // ------------------------------------------------- activation state machine

    #[test]
    fn every_canonical_activation_transition_is_accepted() {
        for (from, to) in CANONICAL_TRANSITIONS {
            assert!(from.can_transition(*to), "{from:?} -> {to:?} harus sah");
            assert!(
                from.successors().any(|candidate| candidate == *to),
                "{to:?} harus muncul di successors({from:?})"
            );
        }
    }

    #[test]
    fn illegal_activation_transitions_are_rejected() {
        let illegal = [
            (ActivationState::Inactive, ActivationState::Active),
            (ActivationState::Inactive, ActivationState::Draining),
            (ActivationState::Inactive, ActivationState::Degraded),
            (ActivationState::Activating, ActivationState::Draining),
            (ActivationState::Activating, ActivationState::Degraded),
            (ActivationState::Active, ActivationState::Inactive),
            (ActivationState::Active, ActivationState::Failed),
            (ActivationState::Active, ActivationState::Activating),
            (ActivationState::Draining, ActivationState::Active),
            (ActivationState::Draining, ActivationState::Inactive),
            (ActivationState::Deactivating, ActivationState::Active),
            (ActivationState::Deactivating, ActivationState::Draining),
            (ActivationState::Failed, ActivationState::Active),
            (ActivationState::Failed, ActivationState::Degraded),
        ];
        for (from, to) in illegal {
            assert!(!from.can_transition(to), "{from:?} -> {to:?} harus ilegal");
        }
        // tidak ada transisi ke diri sendiri
        let states = [
            ActivationState::Inactive,
            ActivationState::Activating,
            ActivationState::Active,
            ActivationState::Degraded,
            ActivationState::Failed,
            ActivationState::Draining,
            ActivationState::Deactivating,
        ];
        for state in states {
            assert!(
                !state.can_transition(state),
                "self-transition {state:?} dilarang"
            );
        }
    }

    #[test]
    fn happy_path_activation_lifecycle_walks_the_full_cycle() {
        let path = [
            ActivationState::Inactive,
            ActivationState::Activating,
            ActivationState::Active,
            ActivationState::Draining,
            ActivationState::Deactivating,
            ActivationState::Inactive,
        ];
        let mut record = activation(ActivationState::Inactive);
        for window in path.windows(2) {
            let (from, to) = (window[0], window[1]);
            assert_eq!(record.state, from);
            assert!(record.can_advance(to));
            record.state = to;
            // kontrak: drain_deadline_ms hidup tepat selama Draining
            if to == ActivationState::Draining {
                record.drain_deadline_ms = Some(5_000);
            }
            if from == ActivationState::Draining && to != ActivationState::Draining {
                record.drain_deadline_ms = None;
            }
            record.validate().unwrap();
        }
        assert_eq!(record.state, ActivationState::Inactive);
        assert!(!ActivationState::Failed.is_serving());
        assert!(ActivationState::Active.is_serving());
        assert!(ActivationState::Degraded.is_serving());
    }

    #[test]
    fn activation_record_invariants_are_fail_closed() {
        // drain_deadline hanya saat Draining:
        let mut record = activation(ActivationState::Active);
        record.drain_deadline_ms = Some(1_000);
        assert!(record.validate().is_err());
        let mut record = activation(ActivationState::Draining);
        record.drain_deadline_ms = None;
        assert!(record.validate().is_err());

        // last_error hanya saat Failed/Degraded:
        let mut record = activation(ActivationState::Active);
        record.last_error = Some(ActivationError {
            message: "x".into(),
            node: None,
            at_ms: 7,
        });
        assert!(record.validate().is_err());
        let mut record = activation(ActivationState::Failed);
        record.last_error = Some(ActivationError {
            message: "x".into(),
            node: Some("Webhook".into()),
            at_ms: 7,
        });
        record.validate().unwrap();
    }

    #[test]
    fn activation_record_roundtrips_on_wire() {
        let mut record = activation(ActivationState::Degraded);
        record.owner_instance = Some("main-1".into());
        record.last_error = Some(ActivationError {
            message: "poll exploded".into(),
            node: Some("Poller".into()),
            at_ms: 120,
        });
        let wire = serde_json::to_value(&record).unwrap();
        assert_eq!(wire["state"], "degraded");
        assert_eq!(wire["generation"], 7);
        assert_eq!(wire["activationMode"], "activate");
        assert_eq!(wire["workflow"]["workflowId"], "wf-9");
        assert_eq!(wire["lastError"]["node"], "Poller");
        let decoded: ActivationRecord = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, record);
        decoded.validate().unwrap();
    }

    // ---------------------------------------------------------------- routes

    #[test]
    fn route_record_static_vs_dynamic_and_validation() {
        let mut route = sample_route();
        assert!(!route.is_static()); // mengandung ':'
        route.path = "ab12cd34/orders/all".into();
        route.path_depth = 3;
        assert!(route.is_static());
        route.validate().unwrap();

        let mut route = sample_route();
        route.path = "/orders".into(); // leading slash dilarang — prefix milik adapter
        assert!(matches!(
            route.validate(),
            Err(IngressContractError::InvalidCombination(_))
        ));

        let mut route = sample_route();
        route.path_depth = 0;
        assert!(route.validate().is_err());
    }

    #[test]
    fn route_record_roundtrip_is_complete() {
        let route = sample_route();
        let wire = serde_json::to_value(&route).unwrap();
        assert_eq!(wire["kind"], "productionWebhook");
        assert_eq!(wire["method"], "POST");
        assert_eq!(wire["path"], "ab12cd34/orders/:id");
        assert_eq!(wire["pathDepth"], 3);
        assert_eq!(wire["generation"], 7);
        assert_eq!(wire["auth"], "headerAuth");
        let decoded: RouteRecord = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, route);
        decoded.validate().unwrap();
    }

    // ---------------------------------------------------------------- security

    #[test]
    fn security_decision_fail_closed_only_allow_admits() {
        let mut decision = SecurityDecisionRef {
            decision_id: "d-1".into(),
            authority: "webhook-auth".into(),
            outcome: SecurityOutcome::Allow,
            decided_at_ms: 1,
            reason_code: None,
        };
        assert!(decision.must_admit());
        decision.outcome = SecurityOutcome::Deny;
        assert!(!decision.must_admit());
        decision.outcome = SecurityOutcome::Indeterminate;
        assert!(!decision.must_admit(), "indeterminate = deny");
    }

    // ---------------------------------------------------------------- admission

    #[test]
    fn admission_decision_invariants_and_builders() {
        let ok = AdmissionDecision::new(AdmissionState::Accepted, admission_reason::OK, 1).unwrap();
        ok.validate().unwrap();
        assert_eq!(ok.reason_code, "OK");

        // Duplicate wajib membawa request aslinya:
        let dup = AdmissionDecision::new(AdmissionState::Duplicate, admission_reason::DUPLICATE, 2);
        assert!(dup.unwrap().validate().is_err());
        let dup = AdmissionDecision::new(AdmissionState::Duplicate, admission_reason::DUPLICATE, 2)
            .unwrap()
            .with_duplicate_of(RequestId::new("req-0001").unwrap());
        dup.validate().unwrap();

        // retry_after hanya bermakna untuk sinyal "coba lagi nanti":
        let limited =
            AdmissionDecision::new(AdmissionState::RateLimited, admission_reason::RATE_LIMIT, 3)
                .unwrap()
                .with_retry_after(250);
        limited.validate().unwrap();
        let rejected =
            AdmissionDecision::new(AdmissionState::Rejected, admission_reason::AUTH_DENIED, 3)
                .unwrap()
                .with_retry_after(250);
        assert!(rejected.validate().is_err());

        // reason code kosong/kepanjangan ditolak:
        assert!(AdmissionDecision::new(AdmissionState::Rejected, "", 0).is_err());
        assert!(AdmissionDecision::new(
            AdmissionState::Rejected,
            "x".repeat(MAX_REASON_CODE_LEN + 1),
            0
        )
        .is_err());
    }

    // ---------------------------------------------------------------- response

    #[test]
    fn response_plan_follows_node_rules() {
        let plan = ResponsePlan::default();
        assert!(plan.responds_immediately());
        plan.validate().unwrap();
        assert_eq!(serde_json::to_value(&plan).unwrap()["mode"], "onReceived");
        // field opsional yang kosong tidak ikut diserialisasi (kabel tetap ramping):
        assert!(serde_json::to_value(&plan).unwrap()["responseData"].is_null());

        let mut plan = ResponsePlan {
            mode: ResponseMode::LastNode,
            response_data: Some(ResponseDataKind::FirstEntryJson),
            status_code: Some(200),
            headers: vec![("content-type".into(), "application/json".into())],
        };
        plan.validate().unwrap();

        // responseData di luar lastNode = larangan (no hidden semantics):
        plan.mode = ResponseMode::OnReceived;
        assert!(plan.validate().is_err());
        plan.mode = ResponseMode::LastNode;
        plan.status_code = Some(99);
        assert!(plan.validate().is_err());
        plan.status_code = Some(600);
        assert!(plan.validate().is_err());
        plan.status_code = Some(302);
        plan.headers = vec![("X-Bad".into(), "v".into())];
        assert!(matches!(
            plan.validate(),
            Err(IngressContractError::NonLowercaseHeader { .. })
        ));
    }

    // ---------------------------------------------------------------- hand-off

    #[test]
    fn execution_request_binds_resolved_envelope_fail_closed() {
        let envelope = http_envelope();
        let request =
            ExecutionRequest::from_envelope(&envelope, ExecutionMode::Webhook, "Webhook", 1_005)
                .unwrap();
        assert_eq!(request.request_id.as_str(), "req-0001");
        assert_eq!(request.correlation_id.as_str(), "req-0001");
        assert_eq!(request.workflow.workflow_id, "wf-9");
        assert_eq!(request.generation, Generation::new(7));
        assert_eq!(request.mode, ExecutionMode::Webhook);
        assert_eq!(request.source, IngressSourceKind::ProductionWebhook);
        assert_eq!(
            request.idempotency_key.as_ref().unwrap().as_str(),
            "idem-xyz"
        );
        assert_eq!(request.enqueued_at_ms, 1_005);

        // wire camelCase penuh + roundtrip:
        let wire = serde_json::to_value(&request).unwrap();
        assert_eq!(wire["requestId"], "req-0001");
        assert_eq!(wire["correlationId"], "req-0001");
        assert_eq!(wire["startNodeName"], "Webhook");
        assert_eq!(wire["payload"]["kind"], "inline");
        let decoded: ExecutionRequest = serde_json::from_value(wire).unwrap();
        assert_eq!(decoded, request);
    }

    #[test]
    fn execution_request_rejects_unresolved_or_expired_envelopes() {
        let mut envelope = http_envelope();
        envelope.workflow = None;
        assert_eq!(
            ExecutionRequest::from_envelope(&envelope, ExecutionMode::Webhook, "Webhook", 1_005)
                .unwrap_err(),
            IngressContractError::UnresolvedWorkflow
        );

        let mut envelope = http_envelope();
        envelope.generation = None;
        assert_eq!(
            ExecutionRequest::from_envelope(&envelope, ExecutionMode::Webhook, "Webhook", 1_005)
                .unwrap_err(),
            IngressContractError::UnresolvedGeneration
        );

        // sudah kedaluwarsa saat hand-off:
        let envelope = http_envelope();
        assert!(matches!(
            ExecutionRequest::from_envelope(&envelope, ExecutionMode::Webhook, "Webhook", 31_000)
                .unwrap_err(),
            IngressContractError::DeadlineNotAfterReceived { .. }
        ));

        // start node kosong ditolak:
        let envelope = http_envelope();
        assert!(
            ExecutionRequest::from_envelope(&envelope, ExecutionMode::Webhook, "", 1_005).is_err()
        );
    }

    #[test]
    fn stale_generation_block_stops_the_canonical_path() {
        // simulasi pipeline: envelope resolved pada gen 7; route kini gen 8.
        let envelope = http_envelope();
        let route = RouteRecord {
            generation: Generation::new(8),
            ..sample_route()
        };
        let fence = fence_generation(envelope.generation.unwrap(), route.generation);
        assert!(matches!(
            fence,
            Err(IngressContractError::StaleGeneration {
                observed: 7,
                current: 8
            })
        ));
    }
}
