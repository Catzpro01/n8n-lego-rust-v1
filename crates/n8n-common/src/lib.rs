use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub mod activation;
pub mod admission;
pub mod compat;
pub mod expression_contract;
pub mod ingress_contract;
pub mod ingress_modes;
pub mod innovation;
pub mod recovery;
pub mod schedule;
pub mod webhook;
pub use activation::{
    ActivateOutcome, ActivationRegistry, ActivationTransitionError, DeactivateOutcome,
    DeactivationKind, PendingUpdate, ReconcilePlan,
};
pub use admission::{
    AdmissionAccepted, AdmissionConfig, AdmissionControl, AdmissionError, AdmissionOutcome,
};
pub use compat::{
    default_compat_matrix, replay_admission, replay_resolution, AcceptResult, AcceptanceSuite,
    CompatCase, CompatMatrix, CompatVerdict, MatrixError, ReplayCapsule, ReplayMode,
    WireExpectation, MAX_COMPAT_CASES,
};
pub use expression_contract::{
    EvaluationContext, ExpressionError, ExpressionEvaluator, ExpressionRef, SimpleEvaluationContext,
};
pub use ingress_contract::{
    admission_reason, fence_generation, ActivationError, ActivationMode, ActivationRecord,
    ActivationState, AdmissionDecision, AdmissionState, CorrelationId, ExecutionMode,
    ExecutionRequest, Generation, HttpMethod, IdempotencyKey, IngressContractError,
    IngressEnvelope, IngressSource, IngressSourceKind, MetadataRef, PayloadRef, Priority,
    RequestId, ResponseDataKind, ResponseMode, ResponsePlan, RouteKind, RouteRecord,
    SecurityDecisionRef, SecurityOutcome, WebhookAuth, WorkflowIdentity, CANONICAL_TRANSITIONS,
    CONTRACT_VERSION, ENVELOPE_VERSION, MAX_HEADERS, MAX_HEADER_VALUE_BYTES, MAX_ID_LEN,
    MAX_INLINE_PAYLOAD_BYTES, MAX_QUERY_PARAMS, MAX_QUERY_VALUE_BYTES, MAX_REASON_CODE_LEN,
    MAX_ROUTE_PATH_LEN,
};
pub use ingress_modes::{
    classify_event, manual_first_emission, resolve_waiting_path, EventAction, EventName,
    ExecutionStatusTag, IngressIntent, IntentError, IntentResolver, ListenPool,
    ManualEmissionError, ManualTrigger, ModeDecision, TestListen, WaitingResolution,
    WaitingVerdict,
};
pub use innovation::{
    adapt_limits, coalesce_events, compare_shadow, next_brownout, predict_admission,
    pressure_score, qos_apply, qos_decide, run_shadow, AdaptiveLimits, AdmissionCeilings,
    AdmissionController, AdmissionPlan, AdmissionTargets, AdmissionTelemetry, AtlasError,
    AtlasSwap, BrownoutMode, BurstShape, CapabilityToken, CapsuleError, CoalescibleEvent,
    DeclaredSideEffect, FlightRecorder, FusionConfig, FusionOutput, HardLimits, IngressPlane,
    P4Profiler, PayloadCapsule, PlaneAdmission, PlaneConfig, PlaneKind, PlaneStats, PlaneTopology,
    ProfileConfig, ProfileSample, ProfilerBackend, QosAction, QosDecision, RouteAtlas,
    RouteProfile, ShadowMode, ShadowOutcome, ShadowReport, ShadowVerdict, TelemetrySample,
};
pub use recovery::{
    recovery_plan, Journal, JournalEntry, LeaderLease, LeaseError, LifecycleEvent, RecoveryAction,
    RecoveryPlan, MAX_JOURNAL_ENTRIES,
};
pub use schedule::{
    CivilDate, CivilTime, CronError, CronExpr, GapPolicy, MisfirePolicy, OverlapPolicy,
    ScheduleError, ScheduleExecution, ScheduleRecord, ScheduleRegistry, ScheduleSpec, TickDecision,
    TzResolver, UtcResolver,
};
pub use webhook::{
    build_response, normalize_request, process_webhook_request, NodeWebhookSpec, NormalizeError,
    NormalizeLimits, NormalizedRequest, RawWebhookRequest, ResolvedRoute, RouteResolution,
    ServingDenied, WebhookError, WebhookIngressOutcome, WebhookRecord, WebhookRegistry,
    WebhookResponse, SANITIZED_COOKIE_NAMES,
};

pub type IDataObject = serde_json::Map<String, serde_json::Value>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BinaryData {
    pub data: String,
    #[serde(rename = "mimeType")]
    pub mime_type: String,
    #[serde(rename = "fileName", skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(rename = "fileExtension", skip_serializing_if = "Option::is_none")]
    pub file_extension: Option<String>,
}

pub type BinaryDataMap = HashMap<String, BinaryData>;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct INodeExecutionData {
    pub json: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<BinaryDataMap>,
    #[serde(rename = "pairedItem", skip_serializing_if = "Option::is_none")]
    pub paired_item: Option<serde_json::Value>,
}

#[derive(Debug, thiserror::Error)]
pub enum CommonError {
    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),
    #[error("General error: {0}")]
    Message(String),
}
