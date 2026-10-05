//! P4.6 (Agent 2) — **Event / Manual / Test / Waiting ingress orchestration**.
//!
//! Owns *all non-production ingress modes* (Issue #108) yang masih perlu
//! compat n8n kelas satu, atas nilai beku P4.1/P4.2/P4.5:
//!
//! * **new execution vs resume** — dibedakan ketat: `waiting-*` = RESUME dari
//!   execution yang sudah tersuspensi (Wait node), yang lain = NEW.
//! * **manual/editor + test/listen** — first-emission semantics: `*` (test
//!   webhook) boleh sekali melayani, lalu selesai (n8n `testWebhook` = listen
//!   untuk satu kiriman, tidak membuat route produksi);
//! * **waiting webhook/form** — resolve executionId, validate state, duplicate
//!   resume protection, expired/not-found/error mapping, correlation,
//!   generation checks;
//! * **event** — verbatim event names n8n (`n8n.{domain}.{object}.{verb}`) →
//!   update-aktivasi/start handlers yang terikat generation;
//! * **bounded resource retention** — setiap "pending"/"listen" ada caps &
//!   timeout; tidak ada state tak terbatas.
//!
//! Batas: P3 owns execution internals — modul ini hanya menerbitkan
//! [`ModeDecision`] (handoff new/resume + reason code + status HTTP). Tidak ada
//! queue tak terbatas, tidak ada scheduler kedua, tidak menyentuh P5/P6.
//!
//! Jangkar referensi: `waiting-webhooks.ts` (404 execution-not-found;
//! 409 "running already"/"finished already"/error; `disableNode` agar tidak
//! start ulang), `test-webhooks.ts` (listen satu kiriman), `live-webhooks.ts`
//! (active-version lookup), `events` (`n8n.workflow.started`, dst).

use crate::ingress_contract::{
    admission_reason, AdmissionDecision, AdmissionState, ExecutionMode, Generation,
    IngressContractError, IngressSourceKind, MAX_ID_LEN,
};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

// ---------------------------------------------------------------------------
// Intent — apa yang diinginkan sebuah ingress
// ---------------------------------------------------------------------------

/// Distinction canonical #108: new vs resume vs (legacy) poll.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IngressIntent {
    /// Mulai execution baru (webhook prod/test, form, manual, event, schedule).
    NewExecution,
    /// Resume execution tersuspensi (waiting webhook/form).
    ResumeExecution,
    /// Poll trigger: mulai execution baru TAPI tanpa sekali-lewat route prod
    /// (mekanisme legacy — diwakilkan, bukan dijalankan di sini).
    PollOnce,
}

impl IngressIntent {
    pub fn classify(kind: IngressSourceKind) -> Option<Self> {
        match kind {
            IngressSourceKind::WaitingWebhook | IngressSourceKind::WaitingForm => {
                Some(Self::ResumeExecution)
            }
            IngressSourceKind::ProductionWebhook
            | IngressSourceKind::TestWebhook
            | IngressSourceKind::ProductionForm
            | IngressSourceKind::TestForm
            | IngressSourceKind::Manual
            | IngressSourceKind::Event
            | IngressSourceKind::Internal
            | IngressSourceKind::Schedule => Some(Self::NewExecution),
            IngressSourceKind::Poll => Some(Self::PollOnce),
        }
    }

    pub fn is_resume(self) -> bool {
        self == Self::ResumeExecution
    }
}

// ---------------------------------------------------------------------------
// Hasil resolusi waiting (resume)
// ---------------------------------------------------------------------------

/// Bagaimana sebuah waiting webhook/form ditindaklanjuti — hasil validasi.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WaitingVerdict {
    Ready,
    NotFound,
    AlreadyRunning,
    AlreadyFinished,
    FinishedWithError,
    SignatureInvalid,
}

#[derive(Debug, Clone, PartialEq)]
pub struct WaitingResolution {
    pub execution_id: String,
    pub verdict: WaitingVerdict,
    /// dipakai untuk API host → status HTTP n8n.
    pub status: u16,
    pub reason_code: &'static str,
}

/// Parse `path` waiting dari bentuk `:executionId/:suffix`.
/// Path relatif non-kosong; suffix opsional, dipisahkan '/'.
pub fn resolve_waiting_path(rel_path: &str) -> (String, Option<String>) {
    let mut segs = rel_path.split('/').filter(|s| !s.is_empty());
    let execution_id = segs.next().unwrap_or_default().to_string();
    let suffix = segs.next().map(|s| s.to_string());
    (execution_id, suffix)
}

/// Validasi status execution terhadap resume (kontrak #108 + anchor waiting-webhooks).
/// `status` di sini berupa tag generik host-P3; tanpa ikatan struktur internal P3.
pub fn waiting_verdict(
    status: &ExecutionStatusTag,
    finished: bool,
    has_error: bool,
) -> WaitingVerdict {
    if has_error {
        return WaitingVerdict::FinishedWithError;
    }
    if finished {
        return WaitingVerdict::AlreadyFinished;
    }
    match status {
        ExecutionStatusTag::Running => WaitingVerdict::AlreadyRunning,
        ExecutionStatusTag::Waiting => WaitingVerdict::Ready,
        _ => WaitingVerdict::NotFound,
    }
}

/// Tag status generic yang dikirim host dari sisi P3 (tanpa melanggar isolasi).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExecutionStatusTag {
    Running,
    Waiting,
    Succeeded,
    Failed,
    Unknown,
}

impl ExecutionStatusTag {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

/// Hasil satu resolusi intent (value murni).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeDecision {
    pub intent: IngressIntent,
    pub kind: IngressSourceKind,
    /// mode eksekusi yang dipakai di handoff (`ExecutionMode` verbatim n8n).
    pub execution_mode: ExecutionMode,
    /// khusus resume: executionId yang harus diresume.
    pub resume_execution_id: Option<String>,
    /// status HTTP untuk ACK (403/404/409/…).
    pub http_status: u16,
    /// reason code kanonik (admission_reason) — bisa OK.
    pub reason_code: &'static str,
    /// keputusan admission lengkap (receipt) bila sudah bisa diterbitkan.
    pub admission: AdmissionDecision,
    /// kunci dedupe resume (executionId) — melindungi double resume.
    pub dedupe_key: Option<String>,
}

// ---------------------------------------------------------------------------
// Event ingress — nama event verbatim n8n
// ---------------------------------------------------------------------------

/// Nama event canonical (verbatim n8n: `n8n.{domain}.{object}.{verb}`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "camelCase")]
pub struct EventName(pub String);

impl EventName {
    pub fn new(name: impl Into<String>) -> Result<Self, IngressContractError> {
        let name = name.into();
        if name.is_empty() {
            return Err(IngressContractError::EmptyId { field: "eventName" });
        }
        if name.len() > MAX_ID_LEN {
            return Err(IngressContractError::IdTooLong {
                field: "eventName",
                max: MAX_ID_LEN,
                actual: name.len(),
            });
        }
        Ok(Self(name))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Klasifikasi event → aksi yang diizinkan P4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EventAction {
    /// `n8n.audit.workflow.*` — mutation metadata/aktivasi, bukan execution baru.
    ActivationLifecycle,
    /// `n8n.workflow.*` dst. — memulai execution baru (start).
    StartExecution,
    /// Tak dikenal → ignorable (host memutuskan; di sini fail-safe reject).
    Unknown,
}

/// Pengenalan aksi event dari namanya (prefix-match canonical).
pub fn classify_event(name: &str) -> EventAction {
    if let Some(rest) = name.strip_prefix("n8n.audit.workflow.") {
        match rest {
            "created" | "updated" | "archived" | "unarchived" | "deleted" | "activated"
            | "deactivated" | "version.updated" => EventAction::ActivationLifecycle,
            _ => EventAction::Unknown,
        }
    } else if name.starts_with("n8n.workflow.") || name.starts_with("n8n.queue.") {
        EventAction::StartExecution
    } else if name == "n8n.workflow.started" {
        EventAction::StartExecution
    } else {
        EventAction::Unknown
    }
}

// ---------------------------------------------------------------------------
// Test/listen — first emission semantics
// ---------------------------------------------------------------------------

/// "Listen" mode test-webhook: satu kiriman pertama yang match, lalu habis
/// (tidak menetap). `registered_at_ms`/`timeout_ms` membatasi retention.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TestListen {
    pub workflow_id: String,
    pub node_id: String,
    pub route_id: String,
    pub generation: Generation,
    pub deadline_ms: u64,
    pub consumed: bool,
}

#[derive(Debug, Default)]
pub struct ListenPool {
    listens: BTreeMap<String, TestListen>,
    order: Vec<String>,
}

const MAX_LISTEN_QUEUE: usize = 64;

impl ListenPool {
    /// Daftarkan pendengar one-shot; ekstra di luar bound ditolak (retention).
    pub fn register(
        &mut self,
        listen: TestListen,
        now_ms: u64,
    ) -> Result<(), IngressContractError> {
        if listen.deadline_ms <= now_ms {
            return Err(IngressContractError::DeadlineNotAfterReceived {
                received_at_ms: now_ms,
                deadline_ms: listen.deadline_ms,
            });
        }
        if self.listens.len() >= MAX_LISTEN_QUEUE {
            return Err(IngressContractError::TooManyEntries {
                which: "listenPool",
                max: MAX_LISTEN_QUEUE,
                actual: self.listens.len(),
            });
        }
        let key = listen.route_id.clone();
        self.listens.insert(key.clone(), listen);
        self.order.push(key);
        // prune expired defensively (bounded)
        self.prune(now_ms);
        Ok(())
    }

    /// Konsumsi (tembakan pertama) bila cocok & belum kedaluwarsa.
    pub fn consume(&mut self, route_id: &str, now_ms: u64) -> Option<TestListen> {
        let expired = self
            .listens
            .get(route_id)
            .is_some_and(|l| l.deadline_ms <= now_ms);
        if expired {
            let key = route_id.to_string();
            self.listens.remove(&key);
            if let Some(pos) = self.order.iter().position(|r| r == &key) {
                self.order.remove(pos);
            }
            return None;
        }
        let listen = self.listens.get_mut(route_id)?;
        if listen.consumed {
            return None;
        }
        listen.consumed = true;
        Some(listen.clone())
    }

    fn prune(&mut self, now_ms: u64) {
        let keys: Vec<String> = self
            .listens
            .iter()
            .filter(|(_, l)| l.deadline_ms <= now_ms)
            .map(|(k, _)| k.clone())
            .collect();
        if keys.is_empty() {
            return;
        }
        for key in keys {
            self.listens.remove(&key);
        }
        self.order.retain(|k| self.listens.contains_key(k));
    }
}

// ---------------------------------------------------------------------------
// Manual — first-emission (one-shot per editor trigger)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManualTrigger {
    pub correlation_id: String,
    pub workflow_id: String,
    pub generation: Generation,
    pub deadline_ms: u64,
    pub emitted: bool,
}

/// Emisi pertama manual/listen dilestarikan; duplikat & kadaluwarsa ditolak.
pub fn manual_first_emission(
    mt: &mut ManualTrigger,
    now_ms: u64,
) -> Result<(), ManualEmissionError> {
    if mt.deadline_ms <= now_ms {
        return Err(ManualEmissionError::Expired);
    }
    if mt.emitted {
        return Err(ManualEmissionError::AlreadyEmitted);
    }
    mt.emitted = true;
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ManualEmissionError {
    #[error("manual trigger kadaluwarsa")]
    Expired,
    #[error("manual trigger sudah diemisi")]
    AlreadyEmitted,
}

// ---------------------------------------------------------------------------
// IngressIntentResolver — tampung mode non-produksi
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct IntentResolver {
    listens: ListenPool,
    /// event-watchers bounded (kategori yang ter-registrasi)
    watchers: HashMap<String, Generation>,
    manual_triggers: HashMap<String, ManualTrigger>,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum IntentError {
    #[error(transparent)]
    Contract(#[from] IngressContractError),
    #[error("kelebihan batas {which}: max {max}")]
    OverCapacity { which: &'static str, max: usize },
}

impl IntentResolver {
    pub fn new() -> Self {
        Self::default()
    }

    // ------------------------------------------------------ waiting pathways

    /// Resolve waiting: execution id + status → verdict → status HTTP n8n.
    pub fn resolve_waiting(
        &mut self,
        rel_path: &str,
        status: ExecutionStatusTag,
        finished: bool,
        has_error: bool,
        kind: IngressSourceKind,
        now_ms: u64,
    ) -> Result<ModeDecision, IntentError> {
        let (execution_id, _suffix) = resolve_waiting_path(rel_path);
        let verdict = waiting_verdict(&status, finished, has_error);
        let (status_code, reason_code, resume) = match verdict {
            WaitingVerdict::Ready => (202, admission_reason::OK, true),
            WaitingVerdict::NotFound => (404, admission_reason::ROUTE_NOT_FOUND, false),
            WaitingVerdict::AlreadyRunning => (409, "ALREADY_RUNNING", false),
            WaitingVerdict::AlreadyFinished => (409, "ALREADY_FINISHED", false),
            WaitingVerdict::FinishedWithError => (409, "FINISHED_WITH_ERROR", false),
            WaitingVerdict::SignatureInvalid => (401, admission_reason::AUTH_DENIED, false),
        };
        let execution_mode = match kind {
            IngressSourceKind::WaitingForm | IngressSourceKind::WaitingWebhook => {
                ExecutionMode::Webhook
            }
            other => match other {
                IngressSourceKind::TestWebhook | IngressSourceKind::TestForm => {
                    ExecutionMode::Webhook // test resume diwakili webhook
                }
                _ => ExecutionMode::Webhook,
            },
        };
        let admission = AdmissionDecision::new(
            if resume {
                AdmissionState::Accepted
            } else {
                AdmissionState::Rejected
            },
            reason_code,
            now_ms,
        )?;
        let dedupe_key = resume.then(|| execution_id.clone());
        Ok(ModeDecision {
            intent: IngressIntent::ResumeExecution,
            kind,
            execution_mode,
            resume_execution_id: if resume { Some(execution_id) } else { None },
            http_status: status_code,
            reason_code,
            admission,
            dedupe_key,
        })
    }

    // ------------------------------------------------------ manual pathways

    /// Register manual trigger → resolver (dapet ditekan sekali).
    pub fn register_manual(&mut self, key: &str, mt: ManualTrigger) -> Result<(), IntentError> {
        if self.manual_triggers.len() >= MAX_LISTEN_QUEUE {
            return Err(IntentError::OverCapacity {
                which: "manualTriggers",
                max: MAX_LISTEN_QUEUE,
            });
        }
        self.manual_triggers.insert(key.to_string(), mt);
        Ok(())
    }

    pub fn manual_press(
        &mut self,
        key: &str,
        now_ms: u64,
        workflow_id: &str,
    ) -> Result<ModeDecision, IntentError> {
        let mut decision =
            self.basic_new_decision(IngressSourceKind::Manual, workflow_id, now_ms)?;
        let emit = match self.manual_triggers.get_mut(key) {
            Some(mt) => manual_first_emission(mt, now_ms),
            None => {
                return Err(IntentError::Contract(
                    IngressContractError::InvalidCombination("manual key tidak terdaftar"),
                ))
            }
        };
        match emit {
            Ok(()) => {
                decision.http_status = 200;
                decision.reason_code = admission_reason::OK;
            }
            Err(ManualEmissionError::AlreadyEmitted) => {
                decision.http_status = 409;
                decision.reason_code = "ALREADY_EMITTED";
                decision.admission =
                    AdmissionDecision::new(AdmissionState::Rejected, "ALREADY_EMITTED", now_ms)?;
            }
            Err(ManualEmissionError::Expired) => {
                decision.http_status = 410;
                decision.reason_code = admission_reason::DEADLINE_EXCEEDED;
                decision.admission = AdmissionDecision::new(
                    AdmissionState::Expired,
                    admission_reason::DEADLINE_EXCEEDED,
                    now_ms,
                )?;
            }
        }
        Ok(decision)
    }

    // ------------------------------------------------------ event pathways

    pub fn register_event_watcher(
        &mut self,
        name: &EventName,
        generation: Generation,
    ) -> Result<(), IntentError> {
        if self.watchers.len() >= MAX_LISTEN_QUEUE {
            return Err(IntentError::OverCapacity {
                which: "eventWatchers",
                max: MAX_LISTEN_QUEUE,
            });
        }
        self.watchers.insert(name.as_str().to_string(), generation);
        Ok(())
    }

    pub fn event_decision(
        &self,
        name: &str,
        workflow_id: &str,
        generation: Generation,
    ) -> ModeDecision {
        use EventAction::*;
        let action = classify_event(name);
        // generation fence atas watcher
        let generation_mismatch = self
            .watchers
            .get(name)
            .is_some_and(|registered| *registered != generation);
        if generation_mismatch {
            return ModeDecision {
                intent: IngressIntent::NewExecution,
                kind: IngressSourceKind::Event,
                execution_mode: ExecutionMode::Webhook,
                resume_execution_id: None,
                http_status: 409,
                reason_code: admission_reason::STALE_GENERATION,
                admission: AdmissionDecision::new(
                    AdmissionState::Rejected,
                    admission_reason::STALE_GENERATION,
                    generation.get(),
                )
                .unwrap_or_else(|_| {
                    AdmissionDecision::new(
                        AdmissionState::Rejected,
                        "STALE_GENERATION",
                        generation.get(),
                    )
                    .unwrap()
                }),
                dedupe_key: Some(name.to_string()),
            };
        }
        match action {
            ActivationLifecycle => ModeDecision {
                intent: IngressIntent::NewExecution,
                kind: IngressSourceKind::Event,
                execution_mode: ExecutionMode::Internal,
                resume_execution_id: None,
                http_status: 200,
                reason_code: admission_reason::OK,
                admission: AdmissionDecision::new(
                    AdmissionState::Accepted,
                    admission_reason::OK,
                    generation.get(),
                )
                .unwrap(),
                dedupe_key: Some(name.to_string()),
            },
            StartExecution => self
                .basic_new_decision(IngressSourceKind::Event, workflow_id, 0)
                .unwrap_or(ModeDecision {
                    intent: IngressIntent::NewExecution,
                    kind: IngressSourceKind::Event,
                    execution_mode: ExecutionMode::Trigger,
                    resume_execution_id: None,
                    http_status: 200,
                    reason_code: admission_reason::OK,
                    admission: AdmissionDecision::new(
                        AdmissionState::Accepted,
                        admission_reason::OK,
                        0,
                    )
                    .unwrap(),
                    dedupe_key: Some(name.to_string()),
                }),
            Unknown => ModeDecision {
                intent: IngressIntent::NewExecution,
                kind: IngressSourceKind::Event,
                execution_mode: ExecutionMode::Webhook,
                resume_execution_id: None,
                http_status: 404,
                reason_code: admission_reason::ROUTE_NOT_FOUND,
                admission: AdmissionDecision::new(
                    AdmissionState::Rejected,
                    admission_reason::ROUTE_NOT_FOUND,
                    generation.get(),
                )
                .unwrap(),
                dedupe_key: Some(name.to_string()),
            },
        }
    }

    // ------------------------------------------------------------------ util

    fn basic_new_decision(
        &self,
        kind: IngressSourceKind,
        workflow_id: &str,
        now_ms: u64,
    ) -> Result<ModeDecision, IntentError> {
        let execution_mode = match kind {
            IngressSourceKind::TestWebhook | IngressSourceKind::TestForm => ExecutionMode::Webhook,
            IngressSourceKind::Manual => ExecutionMode::Manual,
            IngressSourceKind::Event => ExecutionMode::Trigger,
            IngressSourceKind::Schedule => ExecutionMode::Trigger,
            _ => ExecutionMode::Webhook,
        };
        let _ = workflow_id;
        Ok(ModeDecision {
            intent: IngressIntent::NewExecution,
            kind,
            execution_mode,
            resume_execution_id: None,
            http_status: 202,
            reason_code: admission_reason::OK,
            admission: AdmissionDecision::new(
                AdmissionState::Accepted,
                admission_reason::OK,
                now_ms,
            )?,
            dedupe_key: None,
        })
    }

    /// One-shot test listener: kunci by route-id, before dead-time.
    pub fn register_test_listen(
        &mut self,
        listen: TestListen,
        now_ms: u64,
    ) -> Result<(), IntentError> {
        self.listens
            .register(listen, now_ms)
            .map_err(IntentError::Contract)
    }

    pub fn test_listen_consume(&mut self, route_id: &str, now_ms: u64) -> Option<TestListen> {
        self.listens.consume(route_id, now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: u64 = 30_000;
    const GEN1: u64 = 1;

    fn gen1() -> Generation {
        Generation::new(GEN1)
    }

    // ------------------------------------------------------- intent classify

    #[test]
    fn intent_classification_distinguishes_new_vs_resume() {
        assert_eq!(
            IngressIntent::classify(IngressSourceKind::WaitingWebhook),
            Some(IngressIntent::ResumeExecution)
        );
        assert_eq!(
            IngressIntent::classify(IngressSourceKind::WaitingForm),
            Some(IngressIntent::ResumeExecution)
        );
        assert_eq!(
            IngressIntent::classify(IngressSourceKind::ProductionWebhook),
            Some(IngressIntent::NewExecution)
        );
        assert_eq!(
            IngressIntent::classify(IngressSourceKind::Manual),
            Some(IngressIntent::NewExecution)
        );
        // Poll tipe khusus
        assert_eq!(
            IngressIntent::classify(IngressSourceKind::Poll),
            Some(IngressIntent::PollOnce)
        );
    }

    #[test]
    fn waiting_path_extracts_execution_id_and_suffix() {
        assert_eq!(
            resolve_waiting_path("exec-123"),
            ("exec-123".to_string(), None)
        );
        assert_eq!(
            resolve_waiting_path("exec-123/confirm"),
            ("exec-123".to_string(), Some("confirm".to_string()))
        );
        assert_eq!(
            resolve_waiting_path("/exec-123/confirm"),
            ("exec-123".to_string(), Some("confirm".to_string()))
        );
    }

    // ------------------------------------------------------ waiting verdicts

    #[test]
    fn waiting_verdicts_map_like_n8n() {
        // ok resume
        assert_eq!(
            waiting_verdict(&ExecutionStatusTag::Waiting, false, false),
            WaitingVerdict::Ready
        );
        // running already → conflict
        assert_eq!(
            waiting_verdict(&ExecutionStatusTag::Running, false, false),
            WaitingVerdict::AlreadyRunning
        );
        // finished
        assert_eq!(
            waiting_verdict(&ExecutionStatusTag::Succeeded, true, false),
            WaitingVerdict::AlreadyFinished
        );
        // error
        assert_eq!(
            waiting_verdict(&ExecutionStatusTag::Failed, false, true),
            WaitingVerdict::FinishedWithError
        );
    }

    #[test]
    fn resolve_waiting_emits_404_and_409() {
        let mut resolver = IntentResolver::new();
        let not_found = resolver
            .resolve_waiting(
                "exec-x",
                ExecutionStatusTag::Unknown,
                false,
                false,
                IngressSourceKind::WaitingWebhook,
                T0,
            )
            .unwrap();
        assert_eq!(not_found.http_status, 404);
        assert!(not_found.resume_execution_id.is_none());

        let running = resolver
            .resolve_waiting(
                "exec-x",
                ExecutionStatusTag::Running,
                false,
                false,
                IngressSourceKind::WaitingWebhook,
                T0,
            )
            .unwrap();
        assert_eq!(running.http_status, 409);
        assert_eq!(running.reason_code, "ALREADY_RUNNING");

        let ready = resolver
            .resolve_waiting(
                "exec-x",
                ExecutionStatusTag::Waiting,
                false,
                false,
                IngressSourceKind::WaitingWebhook,
                T0,
            )
            .unwrap();
        assert_eq!(ready.http_status, 202);
        assert_eq!(ready.resume_execution_id.as_deref(), Some("exec-x"));
        assert_eq!(ready.dedupe_key.as_deref(), Some("exec-x"));
    }

    // ------------------------------------------------- test listen one-shot

    #[test]
    fn test_listen_fires_exactly_once() {
        let mut resolver = IntentResolver::new();
        let listen = TestListen {
            workflow_id: "wf-1".to_string(),
            node_id: "hook-1".to_string(),
            route_id: "wb-test:wf-1:hook-1".to_string(),
            generation: gen1(),
            deadline_ms: T0 + 120_000,
            consumed: false,
        };
        resolver.register_test_listen(listen, T0).unwrap();
        let first = resolver
            .test_listen_consume("wb-test:wf-1:hook-1", T0)
            .unwrap();
        assert_eq!(first.node_id, "hook-1");
        // tembakan kedua tidak boleh terjadi
        assert!(resolver
            .test_listen_consume("wb-test:wf-1:hook-1", T0 + 10)
            .is_none());
    }

    #[test]
    fn expired_listen_returns_none() {
        let mut resolver = IntentResolver::new();
        let listen = TestListen {
            workflow_id: "wf-1".to_string(),
            node_id: "hook-1".to_string(),
            route_id: "wb-test:wf-1:hook-1".to_string(),
            generation: gen1(),
            deadline_ms: T0 + 1000,
            consumed: false,
        };
        resolver.register_test_listen(listen, T0).unwrap();
        assert!(resolver
            .test_listen_consume("wb-test:wf-1:hook-1", T0 + 2000)
            .is_none());
    }

    // ------------------------------------------------------ manual first-emission

    #[test]
    fn manual_trigger_preserves_first_emission() {
        let mut mt = ManualTrigger {
            correlation_id: "corr-1".to_string(),
            workflow_id: "wf-1".to_string(),
            generation: gen1(),
            deadline_ms: T0 + 60_000,
            emitted: false,
        };
        assert!(manual_first_emission(&mut mt, T0).is_ok());
        assert!(matches!(
            manual_first_emission(&mut mt, T0),
            Err(ManualEmissionError::AlreadyEmitted)
        ));
        let mut expired = ManualTrigger {
            correlation_id: "c2".to_string(),
            workflow_id: "wf-1".to_string(),
            generation: gen1(),
            deadline_ms: T0 + 1,
            emitted: false,
        };
        assert!(matches!(
            manual_first_emission(&mut expired, T0 + 2),
            Err(ManualEmissionError::Expired)
        ));
    }

    // ------------------------------------------------------ event pathway

    #[test]
    fn event_names_and_actions_are_verbatim() {
        assert_eq!(
            classify_event("n8n.audit.workflow.activated"),
            EventAction::ActivationLifecycle
        );
        assert_eq!(
            classify_event("n8n.workflow.started"),
            EventAction::StartExecution
        );
        assert_eq!(classify_event("n8n.unknown.thing"), EventAction::Unknown);
    }

    #[test]
    fn event_decision_checks_generation_fence() {
        let mut resolver = IntentResolver::new();
        resolver
            .register_event_watcher(&EventName::new("n8n.workflow.started").unwrap(), gen1())
            .unwrap();
        // generation lawas → stale
        let decision = resolver.event_decision("n8n.workflow.started", "wf-1", Generation::new(7));
        assert_eq!(decision.reason_code, admission_reason::STALE_GENERATION);
        // generation cocok → ok
        let ok = resolver.event_decision("n8n.workflow.started", "wf-1", gen1());
        assert_eq!(ok.reason_code, admission_reason::OK);
    }

    #[test]
    fn event_name_is_bounded() {
        assert!(EventName::new("").is_err());
        assert!(EventName::new("x".repeat(500)).is_err());
    }
}
