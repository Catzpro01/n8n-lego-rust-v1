//! P4.5 (Agent 2) — **Ingress admission: backpressure, bounds, idempotency**.
//!
//! Memiliki `AdmissionState` machine (verbatim nga Issue #106) sebagai satu-satunya
//! pembuat [`AdmissionDecision`] kanonik. Jalur:
//!
//! ```text
//! ENVELOPE (resolve POST)
//!   → pipeline:(validitas → expiry → security → route → serving/fence → dedupe
//!     → per-request route-auth → kepada batas rate → kepada batas burst/compact)
//!   → (Accepted|Queued) ⇒ emit ExecutionRequest (batas P3)
//!   → selain itu ⇒ receipt dengan alasan kanonik + retry-after bila relevan
//! ```
//!
//! Batas yang ditegakkan (sehat fail-closed, tanpa membahkan overflow):
//! * **expiry** — `deadline_ms` lewat ⇒ `Expired` (`DEADLINE_EXCEEDED`);
//! * **security** — hanya `Allow` yang melanjutkan (Deny/Indeterminate ⇒
//!   `Rejected`/`AUTH_DENIED`);
//! * **generation fence** — mismatch exact-match ⇒ `Rejected` (`STALE_GENERATION`);
//! * **duplicate** — same kanonik idempotency-key ⇒ `Duplicate`(duplicate_of);
//! * **rate limit** — per-route token bucket ⇒ `RateLimited`(retry_after_ms);
//! * **overload** — count/payload melebihi config ⇒ item berlebih direject
//!   load sliced ⇒ `Unavailable`/`RateLimited`;
//! * **malformed/bounds** — route tak dikenal, payload over-size, dll ⇒
//!   `Rejected`(alasan khusus).
//!
//! Set CANNOT mengizinkan pemakaian admission P3; i ni bidang ke-sekonomian
//! ingress; [`AdmissionOutcome`] adalah value murni — host yang menerapkan
//! (adapter HTTP/tokio).

use crate::activation::ActivationRegistry;
use crate::ingress_contract::{
    admission_reason, fence_generation, AdmissionDecision, AdmissionState, Generation, HttpMethod,
    IngressContractError, IngressEnvelope, IngressSourceKind, RequestId, SecurityOutcome,
    MAX_INLINE_PAYLOAD_BYTES,
};
use std::collections::{HashMap, VecDeque};

// ---------------------------------------------------------------------------
// Limiter — deterministic, bounded, std-only
// ---------------------------------------------------------------------------

/// Hasil token-bucket: `Ok(())` bila lolos; `Err(wait_ms)` bila harus menunggu.
/// Deterministik — tidak ada `rand`/`Sleep` (jitter milik host).
type BucketResult = Result<(), u64>;

#[derive(Debug, Clone)]
struct RouteLimiter {
    /// token tersedia, selalu ≤ capacity
    tokens: u64,
    capacity: u64,
    refill_per_s: u64,
    last_refill_ms: u64,
}

impl RouteLimiter {
    fn new(capacity: u64, refill_per_s: u64, now_ms: u64) -> Self {
        Self {
            tokens: capacity,
            capacity,
            refill_per_s,
            last_refill_ms: now_ms,
        }
    }

    fn refill(&mut self, now_ms: u64) {
        if now_ms <= self.last_refill_ms {
            return;
        }
        let elapsed = now_ms - self.last_refill_ms;
        let add = (elapsed / 1000) * self.refill_per_s;
        if add > 0 {
            self.tokens = self.tokens.saturating_add(add).min(self.capacity);
            self.last_refill_ms += (elapsed / 1000) * 1000;
        }
    }

    /// `weight` = biaya token request (>0). Lolos ⇒ 1 token dikonsumsi.
    fn try_acquire(&mut self, now_ms: u64, weight: u64) -> BucketResult {
        self.refill(now_ms);
        if self.tokens == 0 {
            return Err(1000); // retry-after ~ 1s (host boleh menghaluskan)
        }
        let cost = weight.clamp(1, self.capacity);
        if cost > self.tokens {
            let deficit_ms = ((cost - self.tokens) * 1000).div_ceil(self.refill_per_s.max(1));
            return Err(deficit_ms.max(1000));
        }
        self.tokens -= cost;
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// State admission
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
struct AdmissionRuntimeState {
    /// route key (kind:method:rel) → limiter
    limiters: HashMap<String, RouteLimiter>,
    /// kanonik idempotency key → (request_id, generation)
    seen: HashMap<String, (RequestId, Generation)>,
    /// ring buffer ringkas untuk memotong limiter tak terbatas (bounded)
    seen_order: VecDeque<String>,
    /// concurrency in-flight admitted (plane admission TAHU berapa, sebenarnya
    /// eksekusi milik P3)
    in_flight: u64,
    /// payload bytes in-flight (pendekatan boundedness)
    payload_bytes: u64,
    pub accepted_total: u64,
    pub duplicate_total: u64,
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AdmissionConfig {
    /// max in-flight admitted per registry (overload → shed)
    pub max_in_flight: u64,
    /// max total payload bytes admitted (0 = unlimited)
    pub max_payload_bytes: u64,
    /// max bytes per single payload
    pub max_body_bytes: u64,
    /// token bucket default per-route
    pub route_capacity: u64,
    pub route_refill_per_s: u64,
    /// window ring dedupe — jumlah kunci yang diingat (bounded)
    pub seen_capacity: usize,
    /// jendela dedupe (ms) — kunci lebih tua dibuang
    pub dedupe_window_ms: u64,
}

impl Default for AdmissionConfig {
    fn default() -> Self {
        Self {
            max_in_flight: 128,
            max_payload_bytes: 0,
            max_body_bytes: 16 * 1024 * 1024,
            route_capacity: 1_000,
            route_refill_per_s: 200,
            seen_capacity: 512,
            dedupe_window_ms: 60_000,
        }
    }
}

/// Normalisasi hasil dedupe: apa arti sebuah kunci.
pub fn canonical_idempotency_key(
    source_kind: IngressSourceKind,
    workflow_id: &str,
    node_id: &str,
    fire_at_ms: Option<i64>,
) -> String {
    match fire_at_ms {
        Some(at) => format!("sched:{workflow_id}:{node_id}:{at}"),
        None => format!("{source_kind:?}:{workflow_id}:{node_id}"),
    }
}

// ---------------------------------------------------------------------------
// Outcome admission
// ---------------------------------------------------------------------------

/// Request yang diterima — dibawa ke P3 execution request.
#[derive(Debug, Clone)]
pub struct AdmissionAccepted {
    pub admission: AdmissionDecision,
    /// Kunci kanonik — jalan setapak reply dari sini (stream, idempotency, dll)
    pub idempotency_key: Option<String>,
    /// Envelope asli (untuk emit execution request)
    pub envelope: IngressEnvelope,
}

/// Value murni hasil admission — deterministic, tanpa effect eksekusi.
#[derive(Debug, Clone)]
pub enum AdmissionOutcome {
    Admitted(AdmissionAccepted),
    Rejected {
        admission: AdmissionDecision,
        /// true ⇒ beri HTTP 429/503 + retry-after (kepada pusat host)
        retryable: bool,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum AdmissionError {
    #[error(transparent)]
    Contract(#[from] IngressContractError),
}

// ---------------------------------------------------------------------------
// AdmissionControl — evaluator utama
// ---------------------------------------------------------------------------

/// Registri admission canonical (owned P4). Tidak menunggu jadwal/P3.
/// Semua queues bounded oleh config (assert di init).
#[derive(Debug)]
pub struct AdmissionControl {
    config: AdmissionConfig,
    state: AdmissionRuntimeState,
}

fn route_key(envelope: &IngressEnvelope) -> Option<String> {
    let _ = envelope.source.kind.to_route_kind()?;
    Some(format!(
        "{}:{}",
        envelope
            .source
            .received_method
            .unwrap_or(HttpMethod::Post)
            .as_str(),
        envelope.source.received_path.as_deref().unwrap_or("")
    ))
}

impl AdmissionControl {
    pub fn new(config: AdmissionConfig) -> Result<Self, AdmissionError> {
        // fail-closed: config mustahil ditolak
        if config.max_in_flight == 0 {
            return Err(AdmissionError::Contract(
                IngressContractError::InvalidCombination("max_in_flight harus > 0"),
            ));
        }
        if config.route_capacity == 0 || config.route_refill_per_s == 0 {
            return Err(AdmissionError::Contract(
                IngressContractError::InvalidCombination("route limiter capacity/refill > 0"),
            ));
        }
        if config.seen_capacity == 0 {
            return Err(AdmissionError::Contract(
                IngressContractError::InvalidCombination("seen_capacity harus > 0"),
            ));
        }
        Ok(Self {
            config,
            state: AdmissionRuntimeState::default(),
        })
    }

    pub fn in_flight(&self) -> u64 {
        self.state.in_flight
    }

    pub fn accepted_total(&self) -> u64 {
        self.state.accepted_total
    }

    pub fn duplicate_total(&self) -> u64 {
        self.state.duplicate_total
    }

    /// Normalisasi batas payload payload (inline JSON) atau lulus (external)
    /// guna forBody check.
    fn payload_bytes(envelope: &IngressEnvelope) -> u64 {
        match &envelope.payload {
            crate::ingress_contract::PayloadRef::Inline { json } => json.to_string().len() as u64,
            crate::ingress_contract::PayloadRef::External { size_bytes, .. } => *size_bytes,
        }
    }

    /// pipeline admission penuh — deterministic & murni terhadap soal eksyekusi.
    pub fn admit_probe(
        &mut self,
        envelope: IngressEnvelope,
        activation: &ActivationRegistry,
        now_ms: u64,
    ) -> Result<AdmissionOutcome, AdmissionError> {
        // 1. VALIDITAS fail-closed (kontrak P4.1) → malformed = Rejected
        if envelope.validate().is_err() {
            let decision = AdmissionDecision::new(
                AdmissionState::Rejected,
                admission_reason::MALFORMED_REQUEST,
                now_ms,
            )?;
            return Ok(AdmissionOutcome::Rejected {
                admission: decision,
                retryable: false,
            });
        }
        // 2. EXPIRED
        if envelope.is_expired_at(now_ms) {
            let decision = AdmissionDecision::new(
                AdmissionState::Expired,
                admission_reason::DEADLINE_EXCEEDED,
                now_ms,
            )?;
            return Ok(AdmissionOutcome::Rejected {
                admission: decision,
                retryable: false,
            });
        }
        // 3. SECURITY — fail-closed
        if let Some(security) = &envelope.security {
            match security.outcome {
                SecurityOutcome::Allow => {}
                SecurityOutcome::Deny | SecurityOutcome::Indeterminate => {
                    let decision = AdmissionDecision::new(
                        AdmissionState::Rejected,
                        admission_reason::AUTH_DENIED,
                        now_ms,
                    )?;
                    return Ok(AdmissionOutcome::Rejected {
                        admission: decision,
                        retryable: false,
                    });
                }
            }
        }
        // 4. ROUTE / workflow resolve
        let workflow = envelope.workflow.clone().ok_or(AdmissionError::Contract(
            IngressContractError::UnresolvedWorkflow,
        ))?;
        // 5. SERVING + GENERATION (fence) — jalur P4.1/P4.2; keduanya adalah
        //    *decision* (receipt machine-readable), bukan error internal.
        let record = match activation.record(&workflow.workflow_id) {
            Some(record) => record,
            None => {
                return Ok(AdmissionOutcome::Rejected {
                    admission: AdmissionDecision::new(
                        AdmissionState::Rejected,
                        admission_reason::WORKFLOW_INACTIVE,
                        now_ms,
                    )?,
                    retryable: false,
                });
            }
        };
        if !record.state.is_serving() {
            return Ok(AdmissionOutcome::Rejected {
                admission: AdmissionDecision::new(
                    AdmissionState::Rejected,
                    admission_reason::WORKFLOW_INACTIVE,
                    now_ms,
                )?,
                retryable: false,
            });
        }
        if let Some(observed) = envelope.generation {
            if fence_generation(observed, record.generation).is_err() {
                return Ok(AdmissionOutcome::Rejected {
                    admission: AdmissionDecision::new(
                        AdmissionState::Rejected,
                        admission_reason::STALE_GENERATION,
                        now_ms,
                    )?,
                    retryable: false,
                });
            }
        }
        // 6. DEDUPE — at-least-once (default), canonical same-key ⇒ Duplicate
        if let Some(key_ref) = &envelope.idempotency_key {
            let key = key_ref.as_str().to_string();
            if let Some(original) = self.state.seen.get(&key) {
                self.state.duplicate_total += 1;
                let decision = AdmissionDecision::new(
                    AdmissionState::Duplicate,
                    admission_reason::DUPLICATE,
                    now_ms,
                )?
                .with_duplicate_of(original.0.clone());
                return Ok(AdmissionOutcome::Rejected {
                    admission: decision,
                    retryable: false,
                });
            }
        }
        // 7. RATE LIMIT per-route
        if let Some(key) = route_key(&envelope) {
            let now = now_ms;
            let limiter = self.state.limiters.entry(key).or_insert_with(|| {
                RouteLimiter::new(
                    self.config.route_capacity,
                    self.config.route_refill_per_s,
                    now,
                )
            });
            if let Err(retry_after_ms) = limiter.try_acquire(now_ms, 1) {
                let decision = AdmissionDecision::new(
                    AdmissionState::RateLimited,
                    admission_reason::RATE_LIMIT,
                    now_ms,
                )?
                .with_retry_after(retry_after_ms);
                return Ok(AdmissionOutcome::Rejected {
                    admission: decision,
                    retryable: true,
                });
            }
        }
        // 8. OVERLOAD — count + payload (shed bila penuh)
        let payload_bytes = Self::payload_bytes(&envelope);
        let max_bytes = self.config.max_payload_bytes;
        if payload_bytes > self.config.max_body_bytes {
            return Ok(AdmissionOutcome::Rejected {
                admission: AdmissionDecision::new(
                    AdmissionState::Rejected,
                    admission_reason::BODY_TOO_LARGE,
                    now_ms,
                )?,
                retryable: false,
            });
        }
        if self.state.in_flight >= self.config.max_in_flight
            || (max_bytes > 0 && self.state.payload_bytes.saturating_add(payload_bytes) > max_bytes)
        {
            return Ok(AdmissionOutcome::Rejected {
                admission: AdmissionDecision::new(
                    AdmissionState::Unavailable,
                    admission_reason::OVERLOAD,
                    now_ms,
                )?,
                retryable: true,
            });
        }
        // kanonik cap inline payload (kontrak berlaku lagi di sini)
        if let crate::ingress_contract::PayloadRef::Inline { json } = &envelope.payload {
            if json.to_string().len() > MAX_INLINE_PAYLOAD_BYTES {
                return Ok(AdmissionOutcome::Rejected {
                    admission: AdmissionDecision::new(
                        AdmissionState::Rejected,
                        admission_reason::BODY_TOO_LARGE,
                        now_ms,
                    )?,
                    retryable: false,
                });
            }
        }
        // 9. ADMIT
        self.state.in_flight += 1;
        self.state.payload_bytes = self.state.payload_bytes.saturating_add(payload_bytes);
        self.state.accepted_total += 1;
        if let Some(key_ref) = &envelope.idempotency_key {
            self.remember_seen(
                key_ref.as_str().to_string(),
                envelope.request_id.clone(),
                envelope.generation.unwrap_or(Generation::new(0)),
            );
        }
        let decision =
            AdmissionDecision::new(AdmissionState::Accepted, admission_reason::OK, now_ms)?;
        Ok(AdmissionOutcome::Admitted(AdmissionAccepted {
            admission: decision,
            idempotency_key: envelope
                .idempotency_key
                .as_ref()
                .map(|k| k.as_str().to_string()),
            envelope,
        }))
    }

    fn remember_seen(&mut self, key: String, request_id: RequestId, _generation: Generation) {
        self.state
            .seen
            .insert(key.clone(), (request_id, _generation));
        self.state.seen_order.push_back(key);
        while self.state.seen_order.len() > self.config.seen_capacity {
            if let Some(evict) = self.state.seen_order.pop_front() {
                self.state.seen.remove(&evict);
            }
        }
    }

    /// Host memanggil bila eksekusi selesai: bebaskan in-flight & payload.
    pub fn finish_execution(&mut self, payload_bytes: u64) {
        self.state.in_flight = self.state.in_flight.saturating_sub(1);
        self.state.payload_bytes = self.state.payload_bytes.saturating_sub(payload_bytes);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activation::ActivationRegistry as TestActivationRegistry;
    use crate::ingress_contract::{
        admission_reason, ActivationMode, AdmissionState, CorrelationId, Generation, HttpMethod,
        IdempotencyKey, IngressSource, IngressSourceKind, MetadataRef, PayloadRef, Priority,
        RequestId, SecurityDecisionRef, SecurityOutcome, WorkflowIdentity, ENVELOPE_VERSION,
        MAX_INLINE_PAYLOAD_BYTES,
    };

    const T0: u64 = 20_000;

    fn envelope_with_idempotency(key: &str) -> IngressEnvelope {
        let mut env = envelope_default();
        env.idempotency_key = Some(IdempotencyKey::new(key).unwrap());
        env
    }

    fn envelope_default() -> IngressEnvelope {
        IngressEnvelope {
            version: ENVELOPE_VERSION,
            request_id: RequestId::new("req-1").unwrap(),
            correlation_id: Some(CorrelationId::new("corr-1").unwrap()),
            received_at_ms: T0,
            deadline_ms: Some(T0 + 5000),
            priority: Priority::Normal,
            source: IngressSource {
                kind: IngressSourceKind::ProductionWebhook,
                received_method: Some(HttpMethod::Post),
                received_path: Some("/x".to_string()),
            },
            workflow: Some(crate::ingress_contract::WorkflowIdentity::new("wf-1", None).unwrap()),
            generation: Some(Generation::new(1)),
            tenant_id: None,
            security: Some(SecurityDecisionRef {
                decision_id: "sec-1".to_string(),
                authority: "webhook-auth".to_string(),
                outcome: SecurityOutcome::Allow,
                decided_at_ms: T0,
                reason_code: None,
            }),
            idempotency_key: None,
            payload: PayloadRef::Inline {
                json: serde_json::json!({"a": 1}),
            },
            metadata: MetadataRef {
                headers: Vec::new(),
                query: Vec::new(),
            },
        }
    }

    fn activated_registry() -> TestActivationRegistry {
        let mut reg = TestActivationRegistry::new();
        let wf = WorkflowIdentity {
            workflow_id: "wf-1".to_string(),
            workflow_version_id: None,
        };
        reg.begin_activation(wf, ActivationMode::Activate, None, None, T0)
            .unwrap();
        reg.commit_activation("wf-1", None, T0 + 1).unwrap();
        reg
    }

    // ----------------------------------------------------- admission pipeline

    #[test]
    fn valid_envelope_is_admitted() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let reg = activated_registry();
        let outcome = control
            .admit_probe(envelope_default(), &reg, T0 + 2)
            .unwrap();
        assert!(matches!(outcome, AdmissionOutcome::Admitted(_)));
        assert_eq!(control.in_flight(), 1);
    }

    #[test]
    fn expired_envelope_is_rejected_with_deadline_exceeded() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let reg = activated_registry();
        let mut env = envelope_default();
        env.deadline_ms = Some(T0 + 10);
        let outcome = control.admit_probe(env, &reg, T0 + 20).unwrap();
        match outcome {
            AdmissionOutcome::Rejected { admission, .. } => {
                assert_eq!(admission.state, AdmissionState::Expired);
                assert_eq!(admission.reason_code, admission_reason::DEADLINE_EXCEEDED);
            }
            other => panic!("diharapkan Rejected, dapat {other:?}"),
        }
    }

    #[test]
    fn denied_security_is_fail_closed() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let reg = activated_registry();
        let mut env = envelope_default();
        env.security = Some(SecurityDecisionRef {
            decision_id: "s".to_string(),
            authority: "auth".to_string(),
            outcome: SecurityOutcome::Deny,
            decided_at_ms: T0,
            reason_code: Some("token-invalid".to_string()),
        });
        let outcome = control.admit_probe(env, &reg, T0 + 2).unwrap();
        match outcome {
            AdmissionOutcome::Rejected { admission, .. } => {
                assert_eq!(admission.reason_code, admission_reason::AUTH_DENIED);
            }
            other => panic!("diharapkan Rejected, dapat {other:?}"),
        }
    }

    #[test]
    fn duplicate_idempotency_key_is_suppressed() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let reg = activated_registry();
        let first = control
            .admit_probe(envelope_with_idempotency("key-1"), &reg, T0 + 2)
            .unwrap();
        assert!(matches!(first, AdmissionOutcome::Admitted(_)));
        let second = control
            .admit_probe(envelope_with_idempotency("key-1"), &reg, T0 + 2)
            .unwrap();
        match second {
            AdmissionOutcome::Rejected { admission, .. } => {
                assert_eq!(admission.state, AdmissionState::Duplicate);
                assert!(admission.duplicate_of.is_some());
            }
            other => panic!("diharapkan Duplicate, dapat {other:?}"),
        }
        assert_eq!(control.duplicate_total(), 1);
    }

    #[test]
    fn stale_generation_is_rejected() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let reg = activated_registry();
        let mut env = envelope_default();
        env.generation = Some(Generation::new(99)); // lebih baru dari record (1)
        let outcome = control.admit_probe(env, &reg, T0 + 2).unwrap();
        match outcome {
            AdmissionOutcome::Rejected { admission, .. } => {
                assert_eq!(admission.reason_code, admission_reason::STALE_GENERATION);
            }
            other => panic!("diharapkan Rejected, dapat {other:?}"),
        }
    }

    #[test]
    fn inactive_workflow_is_rejected() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let mut reg = TestActivationRegistry::new();
        let wf = WorkflowIdentity {
            workflow_id: "wf-1".to_string(),
            workflow_version_id: None,
        };
        reg.begin_activation(wf, ActivationMode::Activate, None, None, T0)
            .unwrap();
        let outcome = control
            .admit_probe(envelope_default(), &reg, T0 + 2)
            .unwrap();
        match outcome {
            AdmissionOutcome::Rejected { admission, .. } => {
                assert_eq!(admission.reason_code, admission_reason::WORKFLOW_INACTIVE);
            }
            other => panic!("diharapkan Rejected, dapat {other:?}"),
        }
    }

    #[test]
    fn rate_limit_is_enforced_and_retryable() {
        let mut config = AdmissionConfig::default();
        config.route_capacity = 1;
        config.route_refill_per_s = 1;
        let mut control = AdmissionControl::new(config).unwrap();
        let reg = activated_registry();
        let first = control
            .admit_probe(envelope_default(), &reg, T0 + 2)
            .unwrap();
        assert!(matches!(first, AdmissionOutcome::Admitted(_)));
        // sebelumnnya konsumsi 1; bucket kosong → next request rate-limited
        control.finish_execution(10);
        let second = control
            .admit_probe(envelope_default(), &reg, T0 + 2)
            .unwrap();
        match second {
            AdmissionOutcome::Rejected {
                admission,
                retryable,
            } => {
                assert_eq!(admission.state, AdmissionState::RateLimited);
                assert_eq!(admission.reason_code, admission_reason::RATE_LIMIT);
                assert!(admission.retry_after_ms.is_some());
                assert!(retryable);
            }
            other => panic!("diharapkan RateLimited, dapat {other:?}"),
        }
    }

    #[test]
    fn overload_sheds_when_in_flight_exceeded() {
        let mut config = AdmissionConfig::default();
        config.max_in_flight = 1;
        let mut control = AdmissionControl::new(config).unwrap();
        let reg = activated_registry();
        let first = control
            .admit_probe(envelope_default(), &reg, T0 + 2)
            .unwrap();
        assert!(matches!(first, AdmissionOutcome::Admitted(_)));
        let second = control
            .admit_probe(envelope_default(), &reg, T0 + 2)
            .unwrap();
        match second {
            AdmissionOutcome::Rejected {
                admission,
                retryable,
            } => {
                assert_eq!(admission.state, AdmissionState::Unavailable);
                assert_eq!(admission.reason_code, admission_reason::OVERLOAD);
                assert!(retryable);
            }
            other => panic!("diharapkan Unavailable, dapat {other:?}"),
        }
    }

    #[test]
    fn oversized_payload_is_rejected() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let reg = activated_registry();
        let mut env = envelope_default();
        let huge = "x".repeat(MAX_INLINE_PAYLOAD_BYTES + 1);
        env.payload = PayloadRef::Inline {
            json: serde_json::json!(huge),
        };
        let outcome = control.admit_probe(env, &reg, T0 + 2).unwrap();
        match outcome {
            AdmissionOutcome::Rejected { admission, .. } => {
                assert_eq!(admission.reason_code, admission_reason::BODY_TOO_LARGE);
            }
            other => panic!("diharapkan Rejected, dapat {other:?}"),
        }
    }

    #[test]
    fn malformed_envelope_is_rejected() {
        let mut control = AdmissionControl::new(AdmissionConfig::default()).unwrap();
        let reg = activated_registry();
        let mut env = envelope_default();
        env.version = ENVELOPE_VERSION + 1;
        let outcome = control.admit_probe(env, &reg, T0 + 2).unwrap();
        match outcome {
            AdmissionOutcome::Rejected { admission, .. } => {
                assert_eq!(admission.reason_code, admission_reason::MALFORMED_REQUEST);
            }
            other => panic!("diharapkan Rejected, dapat {other:?}"),
        }
    }

    #[test]
    fn config_rejects_impossible_values() {
        let mut c = AdmissionConfig::default();
        c.max_in_flight = 0;
        assert!(AdmissionControl::new(c).is_err());
    }

    #[test]
    fn finish_execution_releases_fast() {
        let mut config = AdmissionConfig::default();
        config.max_in_flight = 1;
        let mut control = AdmissionControl::new(config).unwrap();
        let reg = activated_registry();
        let first = control
            .admit_probe(envelope_default(), &reg, T0 + 2)
            .unwrap();
        assert!(matches!(first, AdmissionOutcome::Admitted(_)));
        control.finish_execution(1);
        assert_eq!(control.in_flight(), 0);
        let second = control
            .admit_probe(envelope_default(), &reg, T0 + 3)
            .unwrap();
        assert!(matches!(second, AdmissionOutcome::Admitted(_)));
    }

    #[test]
    fn canonical_idempotency_key_is_stable_for_schedule() {
        let k =
            canonical_idempotency_key(IngressSourceKind::Schedule, "wf-1", "node-1", Some(123456));
        assert_eq!(k, "sched:wf-1:node-1:123456");
    }
}
