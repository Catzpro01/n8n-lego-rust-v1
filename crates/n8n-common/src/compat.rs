//! P4.9 (Agent 2) — **Compatibility & performance acceptance (#107)**.
//!
//! Matrix reference-vs-runtime deterministik untuk path ingress canonical.
//! Tiga alat:
//!
//! 1. [`CompatCase`] — satu kasus matriks (path, mode, expektasi verbatim n8n)
//!    yang dapat dijalankan terhadap harness decision.
//! 2. [`CompatMatrix`] — koleksi kasus + statistika pass/fail.
//! 3. [`ReplayCapsule`] + [`replay_admission`]/[`replay_resolution`] —
//!    **Deterministic Ingress Replay** (#111-#8): sanitized replay capsule.
//!
//! Semua **solve layak on/off** — alat verifikasi yang tidak mengubah perilaku
//! produksi; ia hanya *menilai* yang sudah dibangun P4.1–P4.8.

use crate::ingress_contract::{
    AdmissionDecision, AdmissionState, ExecutionMode, HttpMethod, IngressSourceKind,
};
use serde::{Deserialize, Serialize};

pub const MAX_COMPAT_CASES: usize = 512;

// ---------------------------------------------------------------------------
// Matrix compatibility
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CompatVerdict {
    Pass,
    Fail,
    NotApplicable,
}

/// Kata wire n8n verbatim yang wajib dibawa satu kasus.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WireExpectation {
    /// metode uppercase (DELETE/GET/HEAD/PATCH/POST/PUT).
    pub method: HttpMethod,
    /// prefix kind (mis. "webhook", "webhook-test", "form", …).
    pub prefix: String,
    /// hasil sintetis: status HTTP ≥ (untuk ACK).
    pub min_status: u16,
    /// mode eksekusi yang diharapkan.
    pub mode: ExecutionMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatCase {
    pub case_id: String,
    pub kind: IngressSourceKind,
    pub description: String,
    pub expectation: WireExpectation,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CompatMatrix {
    cases: Vec<CompatCase>,
    results: Vec<(CompatCase, CompatVerdict)>,
}

impl CompatMatrix {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn add(&mut self, case: CompatCase) -> Result<(), MatrixError> {
        if self.cases.len() >= MAX_COMPAT_CASES {
            return Err(MatrixError::TooMany {
                max: MAX_COMPAT_CASES,
            });
        }
        self.cases.push(case);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.cases.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cases.is_empty()
    }

    pub fn cases(&self) -> &[CompatCase] {
        &self.cases
    }

    pub fn results(&self) -> &[(CompatCase, CompatVerdict)] {
        &self.results
    }

    pub fn pass_count(&self) -> usize {
        self.results
            .iter()
            .filter(|(_, v)| *v == CompatVerdict::Pass)
            .count()
    }

    /// Jalankan sebuah aksi keseluruhan & catat verdict. `run_case` menerima
    /// kasus dan mengembalikan `true` bila ekspektasi terpenuhi.
    pub fn run<F>(&mut self, run_case: F)
    where
        F: Fn(&CompatCase) -> bool,
    {
        let cases = std::mem::take(&mut self.cases);
        for case in cases {
            let verdict = if run_case(&case) {
                CompatVerdict::Pass
            } else {
                CompatVerdict::Fail
            };
            self.results.push((case, verdict));
        }
    }

    pub fn all_pass(&self) -> bool {
        !self.results.is_empty()
            && self
                .results
                .iter()
                .all(|(_, v)| *v == CompatVerdict::Pass || *v == CompatVerdict::NotApplicable)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MatrixError {
    #[error("terlalu banyak kasus: max {max}")]
    TooMany { max: usize },
}

/// Kit kasus default yang memverifikasi kata verbatim n8n (modes, prefixes,
/// methods) — konsumsi #108/#105/#106 untuk acceptance.
pub fn default_compat_matrix() -> Result<CompatMatrix, MatrixError> {
    let mut matrix = CompatMatrix::new();
    let specs: [(
        IngressSourceKind,
        &str,
        ExecutionMode,
        HttpMethod,
        u16,
        &str,
    ); 12] = [
        (
            IngressSourceKind::ProductionWebhook,
            "webhook",
            ExecutionMode::Webhook,
            HttpMethod::Post,
            200,
            "prod webhook onReceived default ACK",
        ),
        (
            IngressSourceKind::TestWebhook,
            "webhook-test",
            ExecutionMode::Webhook,
            HttpMethod::Post,
            202,
            "test webhook first emission",
        ),
        (
            IngressSourceKind::WaitingWebhook,
            "webhook-waiting",
            ExecutionMode::Webhook,
            HttpMethod::Post,
            202,
            "waiting webhook resume",
        ),
        (
            IngressSourceKind::ProductionForm,
            "form",
            ExecutionMode::Webhook,
            HttpMethod::Post,
            200,
            "prod form",
        ),
        (
            IngressSourceKind::TestForm,
            "form-test",
            ExecutionMode::Webhook,
            HttpMethod::Post,
            202,
            "form test",
        ),
        (
            IngressSourceKind::WaitingForm,
            "form-waiting",
            ExecutionMode::Webhook,
            HttpMethod::Post,
            202,
            "waiting form resume",
        ),
        (
            IngressSourceKind::Schedule,
            "schedule",
            ExecutionMode::Trigger,
            HttpMethod::Post,
            200,
            "schedule tick → trigger",
        ),
        (
            IngressSourceKind::Event,
            "event",
            ExecutionMode::Trigger,
            HttpMethod::Post,
            200,
            "event start",
        ),
        (
            IngressSourceKind::Manual,
            "manual",
            ExecutionMode::Manual,
            HttpMethod::Post,
            200,
            "manual run",
        ),
        (
            IngressSourceKind::Internal,
            "internal",
            ExecutionMode::Internal,
            HttpMethod::Post,
            200,
            "internal event",
        ),
        (
            IngressSourceKind::Poll,
            "poll",
            ExecutionMode::Trigger,
            HttpMethod::Get,
            200,
            "poll trigger",
        ),
        (
            IngressSourceKind::ProductionWebhook,
            "webhook",
            ExecutionMode::Webhook,
            HttpMethod::Get,
            200,
            "webhook GET (allowed method)",
        ),
    ];
    for (idx, (kind, prefix, mode, method, min_status, description)) in
        specs.into_iter().enumerate()
    {
        matrix.add(CompatCase {
            case_id: format!("compat-{:03}", idx + 1),
            kind,
            description: description.to_string(),
            expectation: WireExpectation {
                method,
                prefix: prefix.to_string(),
                min_status,
                mode,
            },
        })?;
    }
    Ok(matrix)
}

// ---------------------------------------------------------------------------
// Deterministic Ingress Replay (#111-#8)
// ---------------------------------------------------------------------------

/// Modus replay.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplayMode {
    AdmissionOnly,
    ResolutionOnly,
    DryRun,
    #[serde(other)]
    Compatibility,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplayCapsule {
    pub request_id: String,
    pub route_id: Option<String>,
    pub generation: Option<u64>,
    pub admission_state: AdmissionState,
    /// kontrak versi yang frozen saat direkam.
    pub contract_version: String,
    pub recorded_at_ms: u64,
}

impl ReplayCapsule {
    pub fn new(
        request_id: impl Into<String>,
        route_id: Option<String>,
        generation: Option<u64>,
        admission_state: AdmissionState,
        recorded_at_ms: u64,
    ) -> Self {
        Self {
            request_id: request_id.into(),
            route_id,
            generation,
            admission_state,
            contract_version: crate::ingress_contract::CONTRACT_VERSION.to_string(),
            recorded_at_ms,
        }
    }
}

/// Replay admission-only: nilai `AdmissionDecision` saat ini. dry-run = tanpa
/// efek dedupe.
pub fn replay_admission(
    capsule: &ReplayCapsule,
    decision: AdmissionDecision,
    mode: ReplayMode,
    _now_ms: u64,
) -> AdmissionDecision {
    // admission-only/dry-run tidak mengubah state; hanya mengembalikan keputusan
    // (host membandingkan sebelum/).
    let _ = capsule;
    let _ = (mode, decision.state);
    decision
}

/// Ketepatan resolution — output sintetis deterministic: kembalikan route_id
/// bila capsule mencatat ada route.
pub fn replay_resolution(capsule: &ReplayCapsule) -> Option<String> {
    capsule.route_id.clone()
}

// ---------------------------------------------------------------------------
// Acceptance harness — mengikat matrix ke kasus runtime P4.1–P4.8
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AcceptResult {
    pub case_id: String,
    pub verdict: CompatVerdict,
    pub observed: String,
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct AcceptanceSuite {
    pub results: Vec<AcceptResult>,
}

impl AcceptanceSuite {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record(&mut self, result: AcceptResult) {
        self.results.push(result);
    }

    pub fn ok(&self) -> bool {
        !self.results.is_empty()
            && self
                .results
                .iter()
                .all(|r| r.verdict != CompatVerdict::Fail)
    }
}

// ---------------------------------------------------------------------------
// Kata verbatim tambahan (referensi n8n) dites hal-hal stable
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ingress_contract::RouteKind;

    #[test]
    fn default_matrix_covers_dozen_of_expected_cases() {
        let matrix = default_compat_matrix().unwrap();
        assert!(matrix.len() >= 10);
        // semua route kind wajib diketahui (prefix non-kosong)
        for case in matrix.cases() {
            assert!(!case.expectation.prefix.is_empty(), "{}", case.case_id);
        }
        // prefixes verbatim n8n 2.9.4
        let prefixes: std::collections::BTreeSet<&str> = matrix
            .cases()
            .iter()
            .map(|c| c.expectation.prefix.as_str())
            .collect();
        for expected in [
            "webhook",
            "webhook-test",
            "webhook-waiting",
            "form",
            "form-test",
            "form-waiting",
        ] {
            assert!(prefixes.contains(expected), "prefix '{expected}' wajib ada");
        }
    }

    #[test]
    fn compat_matrix_runs_and_allows_pass_fail_tracking() {
        let mut matrix = default_compat_matrix().unwrap();
        matrix.run(|case| case.case_id.ends_with("01")); // hanya 1 yang pass
        assert_eq!(matrix.results().len(), 12);
        assert_eq!(matrix.pass_count(), 1);
        assert!(!matrix.all_pass());
    }

    #[test]
    fn compat_matrix_all_pass() {
        let mut matrix = CompatMatrix::new();
        matrix
            .add(CompatCase {
                case_id: "c1".into(),
                kind: IngressSourceKind::Manual,
                description: "x".into(),
                expectation: WireExpectation {
                    method: HttpMethod::Post,
                    prefix: "manual".into(),
                    min_status: 200,
                    mode: ExecutionMode::Manual,
                },
            })
            .unwrap();
        matrix.run(|_| true);
        assert!(matrix.all_pass());
    }

    #[test]
    fn compat_matrix_caps_cases() {
        let mut matrix = CompatMatrix::new();
        let mut exceeded = false;
        for i in 0..(MAX_COMPAT_CASES as u32 + 1) {
            let res = matrix.add(CompatCase {
                case_id: format!("c{i}"),
                kind: IngressSourceKind::Manual,
                description: "d".into(),
                expectation: WireExpectation {
                    method: HttpMethod::Post,
                    prefix: "manual".into(),
                    min_status: 200,
                    mode: ExecutionMode::Manual,
                },
            });
            if res.is_err() {
                exceeded = true;
                break;
            }
        }
        assert!(exceeded);
    }

    #[test]
    fn replay_resolution_returns_recorded_route() {
        let capsule = ReplayCapsule::new(
            "req-1",
            Some("wb:wf:hook".to_string()),
            Some(1),
            AdmissionState::Accepted,
            100,
        );
        assert_eq!(replay_resolution(&capsule).as_deref(), Some("wb:wf:hook"));
        assert_eq!(
            capsule.contract_version.as_str(),
            crate::ingress_contract::CONTRACT_VERSION
        );
    }

    #[test]
    fn replay_admission_is_pure() {
        let capsule = ReplayCapsule::new("req-2", None, Some(2), AdmissionState::Queued, 200);
        let decision = AdmissionDecision::new(AdmissionState::Accepted, "OK", 200).unwrap();
        let replayed = replay_admission(&capsule, decision.clone(), ReplayMode::DryRun, 300);
        assert_eq!(replayed.state, AdmissionState::Accepted);
    }

    #[test]
    fn acceptance_suite_records_and_judges() {
        let mut suite = AcceptanceSuite::new();
        suite.record(AcceptResult {
            case_id: "a".into(),
            verdict: CompatVerdict::Pass,
            observed: "ok".into(),
        });
        suite.record(AcceptResult {
            case_id: "b".into(),
            verdict: CompatVerdict::NotApplicable,
            observed: "n/a".into(),
        });
        assert!(suite.ok());
        suite.record(AcceptResult {
            case_id: "c".into(),
            verdict: CompatVerdict::Fail,
            observed: "mismatch".into(),
        });
        assert!(!suite.ok());
    }

    #[test]
    fn route_kind_prefixes_are_verbatim() {
        // bangun expectations dari RouteKind::default_path_prefix
        for (route_kind, expected_prefix) in [
            (RouteKind::ProductionWebhook, "/webhook/"),
            (RouteKind::TestWebhook, "/webhook-test/"),
            (RouteKind::WaitingWebhook, "/webhook-waiting/"),
            (RouteKind::ProductionForm, "/form/"),
            (RouteKind::TestForm, "/form-test/"),
            (RouteKind::WaitingForm, "/form-waiting/"),
        ] {
            assert_eq!(route_kind.default_path_prefix(), expected_prefix);
        }
    }
}
