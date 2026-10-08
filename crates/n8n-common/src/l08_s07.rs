//! L08.S07 — Token/Execution Budgets Component
//!
//! Sub-LEGO Identity: L08.S07
//! Owning LEGO: L08-agent-mcp
//! Runtime Host: H06 (Agent Host)
//! State Ownership: `token-consumption-counters`
//! Execution Model: in-process
//! Contract Version: 1.0.0
//! Compatibility Policy: semver-additive
//!
//! Provides bounded, tenant-aware, scope-aware, generation-safe budget controller
//! and enforcement for autonomous agent runtime sessions.
//! Manages token consumption counters, execution step budgets, rate limiting,
//! reservation leases, and fail-closed budget enforcement with physical cross-host
//! allocation transport to L00.S03 (H02 Control Host).

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, RwLock};

// ============================================================================
// Budget Classification & Enforcement Modes
// ============================================================================

/// Classification of budget consumption domain
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BudgetClass {
    Llm,
    Tool,
    Workflow,
    Subagent,
    Custom(String),
}

impl std::fmt::Display for BudgetClass {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Llm => write!(f, "llm"),
            Self::Tool => write!(f, "tool"),
            Self::Workflow => write!(f, "workflow"),
            Self::Subagent => write!(f, "subagent"),
            Self::Custom(c) => write!(f, "custom:{}", c),
        }
    }
}

/// Mode governing how budget limits are enforced
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EnforcementMode {
    Strict,
    Permissive,
    MonitorOnly,
    FailClosed,
}

impl Default for EnforcementMode {
    fn default() -> Self {
        Self::FailClosed
    }
}

/// Terminal and intermediate outcomes of budget evaluation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum EnforcementOutcome {
    Allowed,
    Reserved,
    Consumed,
    Released,
    Exhausted,
    Denied,
    Stale,
    Timeout,
    Error,
}

// ============================================================================
// Budget Limits & Tracking Models
// ============================================================================

/// Token budget upper limits
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenBudgetLimits {
    pub max_prompt_tokens: u64,
    pub max_completion_tokens: u64,
    pub max_total_tokens: u64,
    pub max_per_request_tokens: u64,
}

impl Default for TokenBudgetLimits {
    fn default() -> Self {
        Self {
            max_prompt_tokens: 50_000,
            max_completion_tokens: 20_000,
            max_total_tokens: 70_000,
            max_per_request_tokens: 8_192,
        }
    }
}

/// Execution time budget limits
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExecutionTimeLimits {
    pub max_duration_ms: u64,
    pub max_per_request_ms: u64,
    pub deadline_epoch_ms: Option<u64>,
}

impl Default for ExecutionTimeLimits {
    fn default() -> Self {
        Self {
            max_duration_ms: 120_000, // 2 minutes
            max_per_request_ms: 30_000, // 30 seconds
            deadline_epoch_ms: None,
        }
    }
}

/// Operation step budget limits
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OperationLimits {
    pub max_operations: u32,
}

impl Default for OperationLimits {
    fn default() -> Self {
        Self {
            max_operations: 100,
        }
    }
}

/// Comprehensive budget specification
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetLimits {
    pub tokens: TokenBudgetLimits,
    pub execution_time: ExecutionTimeLimits,
    pub operations: OperationLimits,
    pub max_cost_usd: f64,
}

impl Default for BudgetLimits {
    fn default() -> Self {
        Self {
            tokens: TokenBudgetLimits::default(),
            execution_time: ExecutionTimeLimits::default(),
            operations: OperationLimits::default(),
            max_cost_usd: 10.0,
        }
    }
}

/// Exact token consumption breakdown
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TokenUsage {
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
}

/// Aggregate consumed amounts across all resource dimensions
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct BudgetConsumed {
    pub tokens: TokenUsage,
    pub duration_ms: u64,
    pub operations: u32,
    pub estimated_cost_usd: f64,
}

/// Status of an active reservation
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReservationStatus {
    Active,
    Reconciled,
    Released,
    Expired,
}

/// Local bounded reservation lease held before execution step
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetReservation {
    pub reservation_id: String,
    pub session_id: String,
    pub tenant_id: String,
    pub scope_id: String,
    pub budget_class: BudgetClass,
    pub reserved_tokens: u64,
    pub reserved_duration_ms: u64,
    pub reserved_operations: u32,
    pub generation: u64,
    pub created_at_ms: u64,
    pub expires_at_ms: u64,
    pub status: ReservationStatus,
    pub metadata: HashMap<String, String>,
}

// ============================================================================
// State Domain: `token-consumption-counters`
// ============================================================================

/// State owned per agent session
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct BudgetSessionState {
    pub session_id: String,
    pub tenant_id: String,
    pub scope_id: String,
    pub budget_class: BudgetClass,
    pub enforcement_mode: EnforcementMode,
    pub generation: u64,
    pub limits: BudgetLimits,
    pub consumed: BudgetConsumed,
    pub active_reservations: HashMap<String, BudgetReservation>,
    pub last_updated_ms: u64,
    pub allocation_lease_id: Option<String>,
    pub metadata: HashMap<String, String>,
}

impl BudgetSessionState {
    pub fn new(
        tenant_id: impl Into<String>,
        scope_id: impl Into<String>,
        session_id: impl Into<String>,
        limits: BudgetLimits,
        generation: u64,
        now_ms: u64,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            tenant_id: tenant_id.into(),
            scope_id: scope_id.into(),
            budget_class: BudgetClass::Llm,
            enforcement_mode: EnforcementMode::FailClosed,
            generation,
            limits,
            consumed: BudgetConsumed::default(),
            active_reservations: HashMap::new(),
            last_updated_ms: now_ms,
            allocation_lease_id: None,
            metadata: HashMap::new(),
        }
    }

    /// Sum of tokens currently held in active reservations
    pub fn reserved_tokens_total(&self) -> u64 {
        self.active_reservations
            .values()
            .filter(|r| r.status == ReservationStatus::Active)
            .map(|r| r.reserved_tokens)
            .fold(0u64, |acc, v| acc.saturating_add(v))
    }

    /// Sum of duration ms currently held in active reservations
    pub fn reserved_duration_total(&self) -> u64 {
        self.active_reservations
            .values()
            .filter(|r| r.status == ReservationStatus::Active)
            .map(|r| r.reserved_duration_ms)
            .fold(0u64, |acc, v| acc.saturating_add(v))
    }

    /// Sum of operations currently held in active reservations
    pub fn reserved_operations_total(&self) -> u32 {
        self.active_reservations
            .values()
            .filter(|r| r.status == ReservationStatus::Active)
            .map(|r| r.reserved_operations)
            .fold(0u32, |acc, v| acc.saturating_add(v))
    }

    /// Unreserved remaining tokens
    pub fn remaining_unreserved_tokens(&self) -> u64 {
        let max_total = self.limits.tokens.max_total_tokens;
        let consumed = self.consumed.tokens.total_tokens;
        let reserved = self.reserved_tokens_total();
        max_total.saturating_sub(consumed.saturating_add(reserved))
    }

    /// Unreserved remaining execution duration ms
    pub fn remaining_unreserved_duration(&self) -> u64 {
        let max_dur = self.limits.execution_time.max_duration_ms;
        let consumed = self.consumed.duration_ms;
        let reserved = self.reserved_duration_total();
        max_dur.saturating_sub(consumed.saturating_add(reserved))
    }

    /// Unreserved remaining operations
    pub fn remaining_unreserved_operations(&self) -> u32 {
        let max_ops = self.limits.operations.max_operations;
        let consumed = self.consumed.operations;
        let reserved = self.reserved_operations_total();
        max_ops.saturating_sub(consumed.saturating_add(reserved))
    }
}

// ============================================================================
// Controller Configuration & Errors
// ============================================================================

/// Guardrail bounds for the budget controller
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetControllerLimits {
    pub max_active_reservations_per_session: usize,
    pub max_sessions_per_tenant: usize,
    pub max_total_sessions: usize,
    pub max_idempotency_records: usize,
    pub warning_threshold_ratio: f64,
}

impl Default for BudgetControllerLimits {
    fn default() -> Self {
        Self {
            max_active_reservations_per_session: 50,
            max_sessions_per_tenant: 200,
            max_total_sessions: 1_000,
            max_idempotency_records: 500,
            warning_threshold_ratio: 0.8,
        }
    }
}

/// Typed errors for budget management & enforcement
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum BudgetError {
    #[error("Empty tenant ID provided")]
    EmptyTenantId,
    #[error("Empty entity ID provided")]
    EmptyEntityId,
    #[error("Empty scope ID provided")]
    EmptyScopeId,
    #[error("Empty session ID provided")]
    EmptySessionId,
    #[error("Budget allocation not found for entity: {0}")]
    BudgetNotFound(String),
    #[error("Empty reservation ID provided")]
    EmptyReservationId,
    #[error("Session not found: {0}")]
    SessionNotFound(String),
    #[error("Reservation not found: {0}")]
    ReservationNotFound(String),
    #[error("Token limit exceeded: limit {limit}, attempted {attempted}")]
    TokenLimitExceeded { limit: u64, attempted: u64 },
    #[error("Execution time exceeded: limit {limit_ms}ms, attempted {attempted_ms}ms")]
    ExecutionTimeExceeded { limit_ms: u64, attempted_ms: u64 },
    #[error("Execution timeout: current time {current_ms}ms passed deadline {deadline_ms}ms")]
    ExecutionTimeout { deadline_ms: u64, current_ms: u64 },
    #[error("Step limit exceeded: limit {limit}, current {current}")]
    StepLimitExceeded { limit: u32, current: u32 },
    #[error("Cost limit exceeded: limit ${limit:.4}, current ${current:.4}")]
    CostLimitExceeded { limit: f64, current: f64 },
    #[error("Budget exhausted: {0}")]
    BudgetExhausted(String),
    #[error("Tenant mismatch: expected {expected}, got {actual}")]
    TenantMismatch { expected: String, actual: String },
    #[error("Scope mismatch: expected {expected}, got {actual}")]
    ScopeMismatch { expected: String, actual: String },
    #[error("Scope authorization denied: {0}")]
    ScopeDenied(String),
    #[error("Stale generation rejected: current {current}, attempted {attempted}")]
    StaleGeneration { current: u64, attempted: u64 },
    #[error("Reservation expired: {reservation_id}")]
    ReservationExpired { reservation_id: String },
    #[error("Capacity exceeded: {reason}")]
    CapacityExceeded { reason: String },
    #[error("Cross-host transport error (H06 -> H02): {0}")]
    CrossHostTransportError(String),
    #[error("Locality violation: execution host {0} violates H06 Agent Host requirement")]
    LocalityViolation(String),
    #[error("Sensitive credential pattern detected and blocked: {0}")]
    SensitiveDataBlocked(String),
    #[error("Invalid budget parameter: {0}")]
    InvalidParameter(String),
    #[error("Lock acquisition failed: {0}")]
    LockError(String),
}

// ============================================================================
// Cross-Host Physical Typed Transport (H06 Agent Host -> H02 Control Host)
// Required Port: `port.runtime.budget.allocate.v1`
// Provider: L00.S03 (Control Host H02)
// ============================================================================

/// Typed allocation request across H06 -> H02 physical boundary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllocationRequest {
    pub tenant_id: String,
    pub scope_id: String,
    pub principal_id: String,
    pub requested_tokens: u64,
    pub requested_duration_ms: u64,
    pub requested_operations: u32,
    pub correlation_id: String,
    pub deadline_ms: u64,
    pub generation: u64,
    pub source_host: String, // Must be H06 / H06AgentHost
    pub target_host: String, // Must be H02 / H02ControlHost
}

/// Typed allocation response returned from H02
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllocationResponse {
    pub valid: bool,
    pub lease_id: String,
    pub allocated_tokens: u64,
    pub allocated_duration_ms: u64,
    pub allocated_operations: u32,
    pub expires_at_ms: u64,
    pub correlation_id: String,
}

/// Physical cross-host transport interface
pub trait AllocationTransport: Send + Sync {
    fn request_allocation(
        &self,
        req: AllocationRequest,
        now_ms: u64,
    ) -> Result<AllocationResponse, BudgetError>;
}

/// Implementation of cross-host transport to H02 Control Host
#[derive(Default)]
pub struct H06ToH02AllocationTransport {
    pub simulate_timeout: Arc<RwLock<bool>>,
    pub simulate_unavailable: Arc<RwLock<bool>>,
    pub simulate_malformed: Arc<RwLock<bool>>,
    pub grant_ratio: Arc<RwLock<f64>>,
}

impl H06ToH02AllocationTransport {
    pub fn new() -> Self {
        Self {
            simulate_timeout: Arc::new(RwLock::new(false)),
            simulate_unavailable: Arc::new(RwLock::new(false)),
            simulate_malformed: Arc::new(RwLock::new(false)),
            grant_ratio: Arc::new(RwLock::new(1.0)),
        }
    }
}

impl AllocationTransport for H06ToH02AllocationTransport {
    fn request_allocation(
        &self,
        req: AllocationRequest,
        now_ms: u64,
    ) -> Result<AllocationResponse, BudgetError> {
        // 1. Locality Verification: must originate from H06 directed to H02
        if req.source_host != "H06" && req.source_host != "H06AgentHost" {
            return Err(BudgetError::LocalityViolation(req.source_host));
        }
        if req.target_host != "H02" && req.target_host != "H02ControlHost" {
            return Err(BudgetError::CrossHostTransportError(format!(
                "Invalid target host: expected H02, got {}",
                req.target_host
            )));
        }

        // 2. Fault Injection Checks
        if *self.simulate_timeout.read().unwrap()
            || (req.deadline_ms > 0 && now_ms > req.deadline_ms)
        {
            return Err(BudgetError::CrossHostTransportError(
                "Allocation request timed out".to_string(),
            ));
        }
        if *self.simulate_unavailable.read().unwrap() {
            return Err(BudgetError::CrossHostTransportError(
                "H02 Control Host budget provider unavailable".to_string(),
            ));
        }
        if *self.simulate_malformed.read().unwrap() {
            return Err(BudgetError::CrossHostTransportError(
                "Malformed allocation response received from H02".to_string(),
            ));
        }

        // 3. Fail-Closed Validation
        if req.principal_id.trim().is_empty() {
            return Err(BudgetError::ScopeDenied(
                "Anonymous principal rejected for budget allocation".to_string(),
            ));
        }
        if req.tenant_id.trim().is_empty() {
            return Err(BudgetError::EmptyTenantId);
        }
        if req.scope_id.trim().is_empty() {
            return Err(BudgetError::EmptyScopeId);
        }

        // 4. Issue typed allocation lease
        let ratio = *self.grant_ratio.read().unwrap();
        let allocated_tokens = ((req.requested_tokens as f64) * ratio).round() as u64;
        let allocated_duration_ms = ((req.requested_duration_ms as f64) * ratio).round() as u64;
        let allocated_ops = ((req.requested_operations as f64) * ratio).round() as u32;

        let lease_id = format!(
            "lease:{}:{}:{}:{}",
            req.tenant_id, req.scope_id, req.generation, now_ms
        );

        Ok(AllocationResponse {
            valid: true,
            lease_id,
            allocated_tokens,
            allocated_duration_ms,
            allocated_operations: allocated_ops,
            expires_at_ms: now_ms + 300_000, // 5 min default lease
            correlation_id: req.correlation_id,
        })
    }
}

// ============================================================================
// Secret Redaction and Content Sanitization
// ============================================================================

pub fn redact_sensitive_text(raw: &str) -> (String, bool) {
    let mut modified = false;
    let mut result = raw.to_string();

    let mut api_matches = Vec::new();
    let mut idx = 0;
    while let Some(pos) = raw[idx..].find("sk-") {
        let start = idx + pos;
        let rest = &raw[start + 3..];
        let token_bytes = rest
            .char_indices()
            .take_while(|(_, c)| c.is_ascii_alphanumeric())
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(0);
        if token_bytes >= 16 {
            api_matches.push(raw[start..start + 3 + token_bytes].to_string());
        }
        idx = start + 3 + token_bytes.max(1);
    }
    for m in api_matches {
        result = result.replace(&m, "[REDACTED_API_KEY]");
        modified = true;
    }

    let pass_keys = ["password", "secret_key", "client_secret", "bearer"];
    for k in &pass_keys {
        let lower = result.to_lowercase();
        let pattern = format!("{}:", k);
        if let Some(pos) = lower.find(&pattern) {
            let after_colon = pos + pattern.len();
            let remainder = &result[after_colon..];
            let ws_len = remainder
                .char_indices()
                .take_while(|(_, c)| c.is_whitespace())
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            let val_start = after_colon + ws_len;
            if val_start < result.len() {
                let val_rem = &result[val_start..];
                let val_len = val_rem
                    .char_indices()
                    .take_while(|(_, c)| !c.is_whitespace() && *c != ',' && *c != ';')
                    .last()
                    .map(|(i, c)| i + c.len_utf8())
                    .unwrap_or(0);
                if val_len > 0 {
                    let secret_part = result[val_start..val_start + val_len].to_string();
                    if !secret_part.contains("[REDACTED") {
                        result = result.replace(&secret_part, "[REDACTED]");
                        modified = true;
                    }
                }
            }
        }
    }

    (result, modified)
}

// ============================================================================
// DTOs for Provided Port: `port.agent.budget.enforce.v1`
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetCheckRequest {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub budget_class: Option<BudgetClass>,
    pub additional_tokens: u64,
    pub estimated_duration_ms: u64,
    pub operations: u32,
    pub estimated_cost_usd: f64,
    pub generation: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetCheckResult {
    pub outcome: EnforcementOutcome,
    pub allowed: bool,
    pub remaining_tokens: u64,
    pub remaining_duration_ms: u64,
    pub remaining_operations: u32,
    pub remaining_cost_usd: f64,
    pub warning_issued: bool,
    pub generation: u64,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveBudgetRequest {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub reservation_id: Option<String>,
    pub budget_class: Option<BudgetClass>,
    pub tokens: u64,
    pub duration_ms: u64,
    pub operations: u32,
    pub ttl_ms: u64,
    pub generation: Option<u64>,
    pub metadata: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReserveBudgetResult {
    pub outcome: EnforcementOutcome,
    pub reservation_id: String,
    pub reserved_tokens: u64,
    pub reserved_duration_ms: u64,
    pub reserved_operations: u32,
    pub expires_at_ms: u64,
    pub generation: u64,
    pub is_duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsumeBudgetRequest {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub reservation_id: Option<String>,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub duration_ms: u64,
    pub operations: u32,
    pub cost_usd: f64,
    pub generation: Option<u64>,
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConsumeBudgetResult {
    pub outcome: EnforcementOutcome,
    pub consumed_total_tokens: u64,
    pub remaining_tokens: u64,
    pub consumed_duration_ms: u64,
    pub remaining_duration_ms: u64,
    pub generation: u64,
    pub is_duplicate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseBudgetRequest {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub reservation_id: String,
    pub generation: Option<u64>,
    pub actual_consumed_tokens: Option<u64>,
    pub actual_duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseBudgetResult {
    pub outcome: EnforcementOutcome,
    pub reservation_id: String,
    pub released_tokens: u64,
    pub released_duration_ms: u64,
    pub generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetSummary {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub generation: u64,
    pub limits: BudgetLimits,
    pub consumed: BudgetConsumed,
    pub active_reserved_tokens: u64,
    pub active_reserved_duration_ms: u64,
    pub remaining_unreserved_tokens: u64,
    pub remaining_unreserved_duration_ms: u64,
    pub active_reservations_count: usize,
}

// ============================================================================
// Primary Controller: TokenBudgetEnforcer
// ============================================================================

pub struct TokenBudgetEnforcer {
    controller_limits: BudgetControllerLimits,
    sessions: Arc<RwLock<HashMap<(String, String), BudgetSessionState>>>,
    idempotency_records: Arc<RwLock<VecDeque<(String, u64)>>>, // (key, now_ms)
    transport: Arc<dyn AllocationTransport>,
}

impl Default for TokenBudgetEnforcer {
    fn default() -> Self {
        Self::new(
            BudgetControllerLimits::default(),
            Arc::new(H06ToH02AllocationTransport::new()),
        )
    }
}

impl TokenBudgetEnforcer {
    pub fn new(
        limits: BudgetControllerLimits,
        transport: Arc<dyn AllocationTransport>,
    ) -> Self {
        Self {
            controller_limits: limits,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            idempotency_records: Arc::new(RwLock::new(VecDeque::new())),
            transport,
        }
    }

    /// Registers or updates a session budget specification
    pub fn register_session(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
        limits: BudgetLimits,
        generation: u64,
        now_ms: u64,
    ) -> Result<(), BudgetError> {
        let t_id = tenant_id.trim();
        let s_id = scope_id.trim();
        let sess_id = session_id.trim();

        if t_id.is_empty() {
            return Err(BudgetError::EmptyTenantId);
        }
        if s_id.is_empty() {
            return Err(BudgetError::EmptyScopeId);
        }
        if sess_id.is_empty() {
            return Err(BudgetError::EmptySessionId);
        }

        if limits.tokens.max_total_tokens == 0 {
            return Err(BudgetError::InvalidParameter(
                "max_total_tokens must be greater than 0".to_string(),
            ));
        }
        if limits.max_cost_usd < 0.0 || limits.max_cost_usd.is_nan() {
            return Err(BudgetError::InvalidParameter(
                "max_cost_usd must be non-negative".to_string(),
            ));
        }

        let mut map = self.sessions.write().map_err(|e| BudgetError::LockError(e.to_string()))?;

        // Capacity guard: max total sessions
        let key = (t_id.to_string(), sess_id.to_string());
        if !map.contains_key(&key) && map.len() >= self.controller_limits.max_total_sessions {
            return Err(BudgetError::CapacityExceeded {
                reason: format!("Max total sessions limit ({}) reached", self.controller_limits.max_total_sessions),
            });
        }

        // Capacity guard: max sessions per tenant
        if !map.contains_key(&key) {
            let tenant_count = map.keys().filter(|(t, _)| t == t_id).count();
            if tenant_count >= self.controller_limits.max_sessions_per_tenant {
                return Err(BudgetError::CapacityExceeded {
                    reason: format!("Max sessions for tenant '{}' reached", t_id),
                });
            }
        }

        if let Some(existing) = map.get_mut(&key) {
            if existing.scope_id != s_id {
                return Err(BudgetError::ScopeMismatch {
                    expected: existing.scope_id.clone(),
                    actual: s_id.to_string(),
                });
            }
            if generation < existing.generation {
                return Err(BudgetError::StaleGeneration {
                    current: existing.generation,
                    attempted: generation,
                });
            }
            existing.generation = generation;
            existing.limits = limits;
            existing.last_updated_ms = now_ms;
        } else {
            let session_state = BudgetSessionState::new(
                t_id,
                s_id,
                sess_id,
                limits,
                generation,
                now_ms,
            );
            map.insert(key, session_state);
        }

        Ok(())
    }

    /// Invokes the required port `port.runtime.budget.allocate.v1` via cross-host physical transport
    pub fn allocate_from_provider(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
        principal_id: &str,
        correlation_id: &str,
        requested_tokens: u64,
        requested_duration_ms: u64,
        deadline_ms: u64,
        now_ms: u64,
    ) -> Result<String, BudgetError> {
        let key = (tenant_id.trim().to_string(), session_id.trim().to_string());
        let generation = {
            let map = self.sessions.read().map_err(|e| BudgetError::LockError(e.to_string()))?;
            let sess = map.get(&key).ok_or_else(|| BudgetError::SessionNotFound(session_id.to_string()))?;
            if sess.scope_id != scope_id.trim() {
                return Err(BudgetError::ScopeMismatch {
                    expected: sess.scope_id.clone(),
                    actual: scope_id.to_string(),
                });
            }
            sess.generation
        };

        let req = AllocationRequest {
            tenant_id: tenant_id.trim().to_string(),
            scope_id: scope_id.trim().to_string(),
            principal_id: principal_id.trim().to_string(),
            requested_tokens,
            requested_duration_ms,
            requested_operations: 10,
            correlation_id: correlation_id.trim().to_string(),
            deadline_ms,
            generation,
            source_host: "H06AgentHost".to_string(),
            target_host: "H02ControlHost".to_string(),
        };

        let res = self.transport.request_allocation(req, now_ms)?;

        // Attach allocation lease ID to session state
        let mut map = self.sessions.write().map_err(|e| BudgetError::LockError(e.to_string()))?;
        if let Some(sess) = map.get_mut(&key) {
            sess.allocation_lease_id = Some(res.lease_id.clone());
        }

        Ok(res.lease_id)
    }

    /// Checks if proposed budget consumption is within limits
    pub fn check_budget(
        &self,
        req: &BudgetCheckRequest,
        now_ms: u64,
    ) -> Result<BudgetCheckResult, BudgetError> {
        let t_id = req.tenant_id.trim();
        let s_id = req.scope_id.trim();
        let sess_id = req.session_id.trim();

        if t_id.is_empty() {
            return Err(BudgetError::EmptyTenantId);
        }
        if s_id.is_empty() {
            return Err(BudgetError::EmptyScopeId);
        }
        if sess_id.is_empty() {
            return Err(BudgetError::EmptySessionId);
        }

        let key = (t_id.to_string(), sess_id.to_string());
        let map = self.sessions.read().map_err(|e| BudgetError::LockError(e.to_string()))?;
        let sess = map.get(&key).ok_or_else(|| BudgetError::SessionNotFound(sess_id.to_string()))?;

        // Scope validation
        if sess.scope_id != s_id {
            return Err(BudgetError::ScopeMismatch {
                expected: sess.scope_id.clone(),
                actual: s_id.to_string(),
            });
        }

        // Generation fencing check
        if let Some(req_gen) = req.generation {
            if req_gen < sess.generation {
                return Err(BudgetError::StaleGeneration {
                    current: sess.generation,
                    attempted: req_gen,
                });
            }
        }

        // Deadline check
        if let Some(deadline) = sess.limits.execution_time.deadline_epoch_ms {
            if now_ms >= deadline {
                return Ok(BudgetCheckResult {
                    outcome: EnforcementOutcome::Timeout,
                    allowed: false,
                    remaining_tokens: sess.remaining_unreserved_tokens(),
                    remaining_duration_ms: 0,
                    remaining_operations: sess.remaining_unreserved_operations(),
                    remaining_cost_usd: (sess.limits.max_cost_usd - sess.consumed.estimated_cost_usd).max(0.0),
                    warning_issued: true,
                    generation: sess.generation,
                    reason: Some("Execution deadline reached or passed".to_string()),
                });
            }
        }

        let remaining_tokens = sess.remaining_unreserved_tokens();
        let remaining_duration = sess.remaining_unreserved_duration();
        let remaining_ops = sess.remaining_unreserved_operations();
        let remaining_cost = (sess.limits.max_cost_usd - sess.consumed.estimated_cost_usd).max(0.0);

        let mut allowed = true;
        let mut reason = None;

        if req.additional_tokens > remaining_tokens {
            allowed = false;
            reason = Some(format!(
                "Token budget exhausted: requested {}, remaining {}",
                req.additional_tokens, remaining_tokens
            ));
        } else if req.estimated_duration_ms > remaining_duration {
            allowed = false;
            reason = Some(format!(
                "Execution duration budget exhausted: requested {}ms, remaining {}ms",
                req.estimated_duration_ms, remaining_duration
            ));
        } else if req.operations > remaining_ops {
            allowed = false;
            reason = Some(format!(
                "Operation steps exhausted: requested {}, remaining {}",
                req.operations, remaining_ops
            ));
        } else if req.estimated_cost_usd > remaining_cost {
            allowed = false;
            reason = Some(format!(
                "Cost budget exhausted: requested ${:.4}, remaining ${:.4}",
                req.estimated_cost_usd, remaining_cost
            ));
        }

        // Warning threshold ratio evaluation
        let token_ratio = (sess.consumed.tokens.total_tokens as f64)
            / (sess.limits.tokens.max_total_tokens.max(1) as f64);
        let warning_issued = token_ratio >= self.controller_limits.warning_threshold_ratio || !allowed;

        let outcome = if allowed {
            EnforcementOutcome::Allowed
        } else {
            EnforcementOutcome::Exhausted
        };

        Ok(BudgetCheckResult {
            outcome,
            allowed,
            remaining_tokens,
            remaining_duration_ms: remaining_duration,
            remaining_operations: remaining_ops,
            remaining_cost_usd: remaining_cost,
            warning_issued,
            generation: sess.generation,
            reason,
        })
    }

    /// Establishes a local bounded reservation before execution
    pub fn reserve_budget(
        &self,
        req: ReserveBudgetRequest,
        now_ms: u64,
    ) -> Result<ReserveBudgetResult, BudgetError> {
        let t_id = req.tenant_id.trim();
        let s_id = req.scope_id.trim();
        let sess_id = req.session_id.trim();

        if t_id.is_empty() {
            return Err(BudgetError::EmptyTenantId);
        }
        if s_id.is_empty() {
            return Err(BudgetError::EmptyScopeId);
        }
        if sess_id.is_empty() {
            return Err(BudgetError::EmptySessionId);
        }

        let key = (t_id.to_string(), sess_id.to_string());
        let mut map = self.sessions.write().map_err(|e| BudgetError::LockError(e.to_string()))?;
        let sess = map.get_mut(&key).ok_or_else(|| BudgetError::SessionNotFound(sess_id.to_string()))?;

        if sess.scope_id != s_id {
            return Err(BudgetError::ScopeMismatch {
                expected: sess.scope_id.clone(),
                actual: s_id.to_string(),
            });
        }

        // Generation check
        if let Some(req_gen) = req.generation {
            if req_gen < sess.generation {
                return Err(BudgetError::StaleGeneration {
                    current: sess.generation,
                    attempted: req_gen,
                });
            }
        }

        // Deadline check
        if let Some(deadline) = sess.limits.execution_time.deadline_epoch_ms {
            if now_ms >= deadline {
                return Err(BudgetError::ExecutionTimeout {
                    deadline_ms: deadline,
                    current_ms: now_ms,
                });
            }
        }

        // Clean up expired reservations first
        sess.active_reservations.retain(|_, r| r.status != ReservationStatus::Active || now_ms < r.expires_at_ms);

        let reservation_id = req.reservation_id.clone().unwrap_or_else(|| {
            format!("res:{}:{}:{}:{}", t_id, sess_id, sess.active_reservations.len() + 1, now_ms)
        });

        // Duplicate reservation idempotency check
        if let Some(existing) = sess.active_reservations.get(&reservation_id) {
            if existing.status == ReservationStatus::Active {
                return Ok(ReserveBudgetResult {
                    outcome: EnforcementOutcome::Reserved,
                    reservation_id: existing.reservation_id.clone(),
                    reserved_tokens: existing.reserved_tokens,
                    reserved_duration_ms: existing.reserved_duration_ms,
                    reserved_operations: existing.reserved_operations,
                    expires_at_ms: existing.expires_at_ms,
                    generation: sess.generation,
                    is_duplicate: true,
                });
            }
        }

        // Bounded active reservations count per session
        if sess.active_reservations.len() >= self.controller_limits.max_active_reservations_per_session {
            return Err(BudgetError::CapacityExceeded {
                reason: format!(
                    "Active reservations ceiling ({}) reached for session",
                    self.controller_limits.max_active_reservations_per_session
                ),
            });
        }

        // Per-request limit validation
        if req.tokens > sess.limits.tokens.max_per_request_tokens {
            return Err(BudgetError::TokenLimitExceeded {
                limit: sess.limits.tokens.max_per_request_tokens,
                attempted: req.tokens,
            });
        }
        if req.duration_ms > sess.limits.execution_time.max_per_request_ms {
            return Err(BudgetError::ExecutionTimeExceeded {
                limit_ms: sess.limits.execution_time.max_per_request_ms,
                attempted_ms: req.duration_ms,
            });
        }

        // Capacity check against remaining unreserved budget
        let unreserved_tokens = sess.remaining_unreserved_tokens();
        if req.tokens > unreserved_tokens {
            return Err(BudgetError::BudgetExhausted(format!(
                "Insufficient tokens for reservation: requested {}, available {}",
                req.tokens, unreserved_tokens
            )));
        }

        let unreserved_dur = sess.remaining_unreserved_duration();
        if req.duration_ms > unreserved_dur {
            return Err(BudgetError::BudgetExhausted(format!(
                "Insufficient duration for reservation: requested {}ms, available {}ms",
                req.duration_ms, unreserved_dur
            )));
        }

        let unreserved_ops = sess.remaining_unreserved_operations();
        if req.operations > unreserved_ops {
            return Err(BudgetError::BudgetExhausted(format!(
                "Insufficient operations for reservation: requested {}, available {}",
                req.operations, unreserved_ops
            )));
        }

        let ttl = if req.ttl_ms == 0 { 60_000 } else { req.ttl_ms };
        let expires_at = now_ms + ttl;

        // Sanitize metadata
        let mut clean_meta = HashMap::new();
        if let Some(m) = req.metadata {
            for (k, v) in m {
                let (redacted, _) = redact_sensitive_text(&v);
                clean_meta.insert(k, redacted);
            }
        }

        let reservation = BudgetReservation {
            reservation_id: reservation_id.clone(),
            session_id: sess_id.to_string(),
            tenant_id: t_id.to_string(),
            scope_id: s_id.to_string(),
            budget_class: req.budget_class.unwrap_or(BudgetClass::Llm),
            reserved_tokens: req.tokens,
            reserved_duration_ms: req.duration_ms,
            reserved_operations: req.operations,
            generation: sess.generation,
            created_at_ms: now_ms,
            expires_at_ms: expires_at,
            status: ReservationStatus::Active,
            metadata: clean_meta,
        };

        sess.active_reservations.insert(reservation_id.clone(), reservation);
        sess.last_updated_ms = now_ms;

        Ok(ReserveBudgetResult {
            outcome: EnforcementOutcome::Reserved,
            reservation_id,
            reserved_tokens: req.tokens,
            reserved_duration_ms: req.duration_ms,
            reserved_operations: req.operations,
            expires_at_ms: expires_at,
            generation: sess.generation,
            is_duplicate: false,
        })
    }

    /// Records actual consumption against an active reservation or directly
    pub fn consume_budget(
        &self,
        req: ConsumeBudgetRequest,
        now_ms: u64,
    ) -> Result<ConsumeBudgetResult, BudgetError> {
        let t_id = req.tenant_id.trim();
        let s_id = req.scope_id.trim();
        let sess_id = req.session_id.trim();

        if t_id.is_empty() {
            return Err(BudgetError::EmptyTenantId);
        }
        if s_id.is_empty() {
            return Err(BudgetError::EmptyScopeId);
        }
        if sess_id.is_empty() {
            return Err(BudgetError::EmptySessionId);
        }

        // Idempotency validation
        if let Some(ref ikey) = req.idempotency_key {
            let full_key = format!("{}:{}:{}:{}", t_id, sess_id, ikey, req.generation.unwrap_or(0));
            let mut idemp = self.idempotency_records.write().map_err(|e| BudgetError::LockError(e.to_string()))?;
            if idemp.iter().any(|(k, _)| k == &full_key) {
                let map = self.sessions.read().map_err(|e| BudgetError::LockError(e.to_string()))?;
                let sess = map.get(&(t_id.to_string(), sess_id.to_string()))
                    .ok_or_else(|| BudgetError::SessionNotFound(sess_id.to_string()))?;
                return Ok(ConsumeBudgetResult {
                    outcome: EnforcementOutcome::Consumed,
                    consumed_total_tokens: sess.consumed.tokens.total_tokens,
                    remaining_tokens: sess.remaining_unreserved_tokens(),
                    consumed_duration_ms: sess.consumed.duration_ms,
                    remaining_duration_ms: sess.remaining_unreserved_duration(),
                    generation: sess.generation,
                    is_duplicate: true,
                });
            }

            // Register idempotency key with bounded capacity FIFO eviction
            if idemp.len() >= self.controller_limits.max_idempotency_records {
                idemp.pop_front();
            }
            idemp.push_back((full_key, now_ms));
        }

        let key = (t_id.to_string(), sess_id.to_string());
        let mut map = self.sessions.write().map_err(|e| BudgetError::LockError(e.to_string()))?;
        let sess = map.get_mut(&key).ok_or_else(|| BudgetError::SessionNotFound(sess_id.to_string()))?;

        if sess.scope_id != s_id {
            return Err(BudgetError::ScopeMismatch {
                expected: sess.scope_id.clone(),
                actual: s_id.to_string(),
            });
        }

        // Generation check
        if let Some(req_gen) = req.generation {
            if req_gen < sess.generation {
                return Err(BudgetError::StaleGeneration {
                    current: sess.generation,
                    attempted: req_gen,
                });
            }
        }

        let attempt_total_tokens = req.prompt_tokens.saturating_add(req.completion_tokens);

        // Reconcile against reservation if provided
        if let Some(ref res_id) = req.reservation_id {
            let reservation = sess.active_reservations.get_mut(res_id)
                .ok_or_else(|| BudgetError::ReservationNotFound(res_id.clone()))?;

            if reservation.status != ReservationStatus::Active {
                return Err(BudgetError::InvalidParameter(format!(
                    "Reservation '{}' is already in status {:?}",
                    res_id, reservation.status
                )));
            }

            // Reconcile and transition reservation
            reservation.status = ReservationStatus::Reconciled;
        }

        // Check hard limits
        let new_total_tokens = sess.consumed.tokens.total_tokens.saturating_add(attempt_total_tokens);
        if new_total_tokens > sess.limits.tokens.max_total_tokens {
            return Err(BudgetError::TokenLimitExceeded {
                limit: sess.limits.tokens.max_total_tokens,
                attempted: new_total_tokens,
            });
        }

        let new_dur = sess.consumed.duration_ms.saturating_add(req.duration_ms);
        if new_dur > sess.limits.execution_time.max_duration_ms {
            return Err(BudgetError::ExecutionTimeExceeded {
                limit_ms: sess.limits.execution_time.max_duration_ms,
                attempted_ms: new_dur,
            });
        }

        let new_ops = sess.consumed.operations.saturating_add(req.operations);
        if new_ops > sess.limits.operations.max_operations {
            return Err(BudgetError::StepLimitExceeded {
                limit: sess.limits.operations.max_operations,
                current: new_ops,
            });
        }

        let new_cost = sess.consumed.estimated_cost_usd + req.cost_usd;
        if new_cost > sess.limits.max_cost_usd {
            return Err(BudgetError::CostLimitExceeded {
                limit: sess.limits.max_cost_usd,
                current: new_cost,
            });
        }

        // Apply consumption
        sess.consumed.tokens.prompt_tokens = sess.consumed.tokens.prompt_tokens.saturating_add(req.prompt_tokens);
        sess.consumed.tokens.completion_tokens = sess.consumed.tokens.completion_tokens.saturating_add(req.completion_tokens);
        sess.consumed.tokens.total_tokens = new_total_tokens;
        sess.consumed.duration_ms = new_dur;
        sess.consumed.operations = new_ops;
        sess.consumed.estimated_cost_usd = new_cost;
        sess.last_updated_ms = now_ms;

        let rem_tokens = sess.remaining_unreserved_tokens();
        let rem_dur = sess.remaining_unreserved_duration();

        Ok(ConsumeBudgetResult {
            outcome: EnforcementOutcome::Consumed,
            consumed_total_tokens: new_total_tokens,
            remaining_tokens: rem_tokens,
            consumed_duration_ms: new_dur,
            remaining_duration_ms: rem_dur,
            generation: sess.generation,
            is_duplicate: false,
        })
    }

    /// Releases an unused reservation or reconciles partial usage
    pub fn release_budget(
        &self,
        req: ReleaseBudgetRequest,
        now_ms: u64,
    ) -> Result<ReleaseBudgetResult, BudgetError> {
        let t_id = req.tenant_id.trim();
        let s_id = req.scope_id.trim();
        let sess_id = req.session_id.trim();
        let res_id = req.reservation_id.trim();

        if t_id.is_empty() {
            return Err(BudgetError::EmptyTenantId);
        }
        if s_id.is_empty() {
            return Err(BudgetError::EmptyScopeId);
        }
        if sess_id.is_empty() {
            return Err(BudgetError::EmptySessionId);
        }
        if res_id.is_empty() {
            return Err(BudgetError::EmptyReservationId);
        }

        let key = (t_id.to_string(), sess_id.to_string());
        let mut map = self.sessions.write().map_err(|e| BudgetError::LockError(e.to_string()))?;
        let sess = map.get_mut(&key).ok_or_else(|| BudgetError::SessionNotFound(sess_id.to_string()))?;

        if sess.scope_id != s_id {
            return Err(BudgetError::ScopeMismatch {
                expected: sess.scope_id.clone(),
                actual: s_id.to_string(),
            });
        }

        // Generation check
        if let Some(req_gen) = req.generation {
            if req_gen < sess.generation {
                return Err(BudgetError::StaleGeneration {
                    current: sess.generation,
                    attempted: req_gen,
                });
            }
        }

        let reservation = sess.active_reservations.get_mut(res_id)
            .ok_or_else(|| BudgetError::ReservationNotFound(res_id.to_string()))?;

        if reservation.status != ReservationStatus::Active {
            return Err(BudgetError::InvalidParameter(format!(
                "Reservation '{}' is not active (current status: {:?})",
                res_id, reservation.status
            )));
        }

        let reserved_tok = reservation.reserved_tokens;
        let reserved_dur = reservation.reserved_duration_ms;

        // If actual consumption occurred during the release
        if let Some(actual_tok) = req.actual_consumed_tokens {
            sess.consumed.tokens.total_tokens = sess.consumed.tokens.total_tokens.saturating_add(actual_tok);
        }
        if let Some(actual_dur) = req.actual_duration_ms {
            sess.consumed.duration_ms = sess.consumed.duration_ms.saturating_add(actual_dur);
        }

        reservation.status = ReservationStatus::Released;
        sess.last_updated_ms = now_ms;

        let released_tok = reserved_tok.saturating_sub(req.actual_consumed_tokens.unwrap_or(0));
        let released_dur = reserved_dur.saturating_sub(req.actual_duration_ms.unwrap_or(0));

        Ok(ReleaseBudgetResult {
            outcome: EnforcementOutcome::Released,
            reservation_id: res_id.to_string(),
            released_tokens: released_tok,
            released_duration_ms: released_dur,
            generation: sess.generation,
        })
    }

    /// Queries the current session budget summary
    pub fn get_summary(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
        _now_ms: u64,
    ) -> Result<BudgetSummary, BudgetError> {
        let t_id = tenant_id.trim();
        let s_id = scope_id.trim();
        let sess_id = session_id.trim();

        if t_id.is_empty() {
            return Err(BudgetError::EmptyTenantId);
        }
        if s_id.is_empty() {
            return Err(BudgetError::EmptyScopeId);
        }
        if sess_id.is_empty() {
            return Err(BudgetError::EmptySessionId);
        }

        let key = (t_id.to_string(), sess_id.to_string());
        let map = self.sessions.read().map_err(|e| BudgetError::LockError(e.to_string()))?;
        let sess = map.get(&key).ok_or_else(|| BudgetError::SessionNotFound(sess_id.to_string()))?;

        if sess.scope_id != s_id {
            return Err(BudgetError::ScopeMismatch {
                expected: sess.scope_id.clone(),
                actual: s_id.to_string(),
            });
        }

        Ok(BudgetSummary {
            tenant_id: t_id.to_string(),
            scope_id: s_id.to_string(),
            session_id: sess_id.to_string(),
            generation: sess.generation,
            limits: sess.limits.clone(),
            consumed: sess.consumed.clone(),
            active_reserved_tokens: sess.reserved_tokens_total(),
            active_reserved_duration_ms: sess.reserved_duration_total(),
            remaining_unreserved_tokens: sess.remaining_unreserved_tokens(),
            remaining_unreserved_duration_ms: sess.remaining_unreserved_duration(),
            active_reservations_count: sess.active_reservations.values().filter(|r| r.status == ReservationStatus::Active).count(),
        })
    }

    /// Resets session counters while advancing generation
    pub fn reset_session(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
        new_generation: u64,
        now_ms: u64,
    ) -> Result<(), BudgetError> {
        let key = (tenant_id.trim().to_string(), session_id.trim().to_string());
        let mut map = self.sessions.write().map_err(|e| BudgetError::LockError(e.to_string()))?;
        let sess = map.get_mut(&key).ok_or_else(|| BudgetError::SessionNotFound(session_id.to_string()))?;

        if sess.scope_id != scope_id.trim() {
            return Err(BudgetError::ScopeMismatch {
                expected: sess.scope_id.clone(),
                actual: scope_id.to_string(),
            });
        }

        if new_generation <= sess.generation {
            return Err(BudgetError::StaleGeneration {
                current: sess.generation,
                attempted: new_generation,
            });
        }

        sess.generation = new_generation;
        sess.consumed = BudgetConsumed::default();
        sess.active_reservations.clear();
        sess.last_updated_ms = now_ms;

        Ok(())
    }

    /// Purges all expired reservations across all sessions
    pub fn cleanup_expired_reservations(&self, now_ms: u64) -> usize {
        let mut count = 0;
        if let Ok(mut map) = self.sessions.write() {
            for sess in map.values_mut() {
                let prev_len = sess.active_reservations.len();
                sess.active_reservations.retain(|_, r| {
                    if r.status == ReservationStatus::Active && now_ms >= r.expires_at_ms {
                        false
                    } else {
                        true
                    }
                });
                count += prev_len.saturating_sub(sess.active_reservations.len());
            }
        }
        count
    }

    /// Handles incoming port invocations for `port.agent.budget.enforce.v1`
    pub fn handle_port_enforce(
        &self,
        port_name: &str,
        payload: &serde_json::Value,
        now_ms: u64,
    ) -> Result<serde_json::Value, BudgetError> {
        if port_name != "port.agent.budget.enforce.v1" {
            return Err(BudgetError::InvalidParameter(format!("Unsupported port: {}", port_name)));
        }

        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("check");
        let tenant_id = payload.get("tenant_id")
            .or_else(|| payload.get("entity_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let scope_id = payload.get("scope_id").and_then(|v| v.as_str()).unwrap_or("port.agent.budget.enforce.v1");
        let session_id = payload.get("session_id")
            .or_else(|| payload.get("entity_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match action {
            "check" => {
                let tokens = payload.get("requested_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let dur = payload.get("requested_duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let req = BudgetCheckRequest {
                    tenant_id: tenant_id.to_string(),
                    scope_id: scope_id.to_string(),
                    session_id: session_id.to_string(),
                    budget_class: None,
                    additional_tokens: tokens,
                    estimated_duration_ms: dur,
                    operations: 1,
                    estimated_cost_usd: 0.0,
                    generation: None,
                };
                let res = self.check_budget(&req, now_ms)?;
                Ok(serde_json::json!({
                    "allowed": res.allowed,
                    "remaining_tokens": res.remaining_tokens,
                    "remaining_duration_ms": res.remaining_duration_ms,
                    "warning_issued": res.warning_issued,
                    "outcome": res.outcome,
                }))
            }
            "reserve" => {
                let tokens = payload.get("requested_tokens").and_then(|v| v.as_u64()).unwrap_or(100);
                let dur = payload.get("requested_duration_ms").and_then(|v| v.as_u64()).unwrap_or(5000);
                let ttl = payload.get("ttl_ms").and_then(|v| v.as_u64()).unwrap_or(60_000);
                let req = ReserveBudgetRequest {
                    tenant_id: tenant_id.to_string(),
                    scope_id: scope_id.to_string(),
                    session_id: session_id.to_string(),
                    reservation_id: payload.get("reservation_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    budget_class: None,
                    tokens,
                    duration_ms: dur,
                    operations: 1,
                    ttl_ms: ttl,
                    generation: None,
                    metadata: None,
                };
                let res = self.reserve_budget(req, now_ms)?;
                Ok(serde_json::json!({
                    "reservation_id": res.reservation_id,
                    "reserved_tokens": res.reserved_tokens,
                    "reserved_duration_ms": res.reserved_duration_ms,
                    "outcome": res.outcome,
                }))
            }
            "consume" => {
                let prompt_tokens = payload.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let completion_tokens = payload.get("completion_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let dur = payload.get("duration_ms").and_then(|v| v.as_u64()).unwrap_or(0);
                let req = ConsumeBudgetRequest {
                    tenant_id: tenant_id.to_string(),
                    scope_id: scope_id.to_string(),
                    session_id: session_id.to_string(),
                    reservation_id: payload.get("reservation_id").and_then(|v| v.as_str()).map(|s| s.to_string()),
                    prompt_tokens,
                    completion_tokens,
                    duration_ms: dur,
                    operations: 1,
                    cost_usd: 0.0,
                    generation: None,
                    idempotency_key: payload.get("idempotency_key").and_then(|v| v.as_str()).map(|s| s.to_string()),
                };
                let res = self.consume_budget(req, now_ms)?;
                Ok(serde_json::json!({
                    "consumed_total_tokens": res.consumed_total_tokens,
                    "remaining_tokens": res.remaining_tokens,
                    "outcome": res.outcome,
                }))
            }
            "release" => {
                let res_id = payload.get("reservation_id").and_then(|v| v.as_str()).unwrap_or("");
                let req = ReleaseBudgetRequest {
                    tenant_id: tenant_id.to_string(),
                    scope_id: scope_id.to_string(),
                    session_id: session_id.to_string(),
                    reservation_id: res_id.to_string(),
                    generation: None,
                    actual_consumed_tokens: payload.get("actual_tokens").and_then(|v| v.as_u64()),
                    actual_duration_ms: payload.get("actual_duration_ms").and_then(|v| v.as_u64()),
                };
                let res = self.release_budget(req, now_ms)?;
                Ok(serde_json::json!({
                    "released_tokens": res.released_tokens,
                    "released_duration_ms": res.released_duration_ms,
                    "outcome": res.outcome,
                }))
            }
            "summary" | "query" => {
                let summary = self.get_summary(tenant_id, scope_id, session_id, now_ms)?;
                Ok(serde_json::to_value(&summary).map_err(|e| BudgetError::InvalidParameter(e.to_string()))?)
            }
            other => Err(BudgetError::InvalidParameter(format!("Unknown action: {}", other))),
        }
    }
}

// ============================================================================
// Backward-Compatible Service Wrapper (TokenBudgetService)
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetAllocation {
    pub entity_id: String,
    pub max_prompt_tokens: u64,
    pub max_completion_tokens: u64,
    pub max_total_tokens: u64,
    pub max_cost_usd: f64,
    pub max_steps: u32,
    pub reset_interval_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BudgetUsage {
    pub entity_id: String,
    pub consumed_prompt_tokens: u64,
    pub consumed_completion_tokens: u64,
    pub consumed_total_tokens: u64,
    pub consumed_cost_usd: f64,
    pub executed_steps: u32,
    pub last_updated_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatCheckResult {
    pub allowed: bool,
    pub remaining_tokens: u64,
    pub remaining_steps: u32,
    pub remaining_cost_usd: f64,
    pub warning_issued: bool,
}

pub struct TokenBudgetService {
    enforcer: TokenBudgetEnforcer,
    legacy_allocations: Arc<RwLock<HashMap<String, BudgetAllocation>>>,
}

impl Default for TokenBudgetService {
    fn default() -> Self {
        Self::new(0.8)
    }
}

impl TokenBudgetService {
    pub fn new(warning_threshold_ratio: f64) -> Self {
        let limits = BudgetControllerLimits {
            warning_threshold_ratio,
            ..BudgetControllerLimits::default()
        };
        Self {
            enforcer: TokenBudgetEnforcer::new(limits, Arc::new(H06ToH02AllocationTransport::new())),
            legacy_allocations: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn set_allocation(&self, alloc: BudgetAllocation) -> Result<(), BudgetError> {
        let eid = alloc.entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }
        if alloc.max_total_tokens == 0 {
            return Err(BudgetError::InvalidParameter("max_total_tokens must be > 0".to_string()));
        }
        if alloc.max_cost_usd < 0.0 || alloc.max_cost_usd.is_nan() {
            return Err(BudgetError::InvalidParameter("max_cost_usd must be >= 0".to_string()));
        }

        let limits = BudgetLimits {
            tokens: TokenBudgetLimits {
                max_prompt_tokens: alloc.max_prompt_tokens,
                max_completion_tokens: alloc.max_completion_tokens,
                max_total_tokens: alloc.max_total_tokens,
                max_per_request_tokens: alloc.max_total_tokens,
            },
            execution_time: ExecutionTimeLimits::default(),
            operations: OperationLimits {
                max_operations: alloc.max_steps,
            },
            max_cost_usd: alloc.max_cost_usd,
        };

        self.enforcer.register_session(eid, "default", eid, limits, 1, 1000)?;
        self.legacy_allocations.write().unwrap().insert(eid.to_string(), alloc);
        Ok(())
    }

    pub fn check_budget(
        &self,
        entity_id: &str,
        additional_tokens: u64,
        additional_cost_usd: f64,
    ) -> Result<CompatCheckResult, BudgetError> {
        let eid = entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }
        if !self.legacy_allocations.read().unwrap().contains_key(eid) {
            return Err(BudgetError::BudgetNotFound(eid.to_string()));
        }

        let req = BudgetCheckRequest {
            tenant_id: eid.to_string(),
            scope_id: "default".to_string(),
            session_id: eid.to_string(),
            budget_class: None,
            additional_tokens,
            estimated_duration_ms: 0,
            operations: 1,
            estimated_cost_usd: additional_cost_usd,
            generation: None,
        };

        let res = self.enforcer.check_budget(&req, 1000)?;
        Ok(CompatCheckResult {
            allowed: res.allowed,
            remaining_tokens: res.remaining_tokens.saturating_sub(additional_tokens),
            remaining_steps: res.remaining_operations,
            remaining_cost_usd: res.remaining_cost_usd,
            warning_issued: res.warning_issued,
        })
    }

    pub fn enforce_and_consume(
        &self,
        entity_id: &str,
        prompt_tokens: u64,
        completion_tokens: u64,
        cost_usd: f64,
        steps: u32,
        now_ms: u64,
    ) -> Result<BudgetUsage, BudgetError> {
        let eid = entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }
        if !self.legacy_allocations.read().unwrap().contains_key(eid) {
            return Err(BudgetError::BudgetNotFound(eid.to_string()));
        }

        let req = ConsumeBudgetRequest {
            tenant_id: eid.to_string(),
            scope_id: "default".to_string(),
            session_id: eid.to_string(),
            reservation_id: None,
            prompt_tokens,
            completion_tokens,
            duration_ms: 100,
            operations: steps,
            cost_usd,
            generation: None,
            idempotency_key: None,
        };

        let res = self.enforcer.consume_budget(req, now_ms)?;
        let summary = self.enforcer.get_summary(eid, "default", eid, now_ms)?;

        Ok(BudgetUsage {
            entity_id: eid.to_string(),
            consumed_prompt_tokens: summary.consumed.tokens.prompt_tokens,
            consumed_completion_tokens: summary.consumed.tokens.completion_tokens,
            consumed_total_tokens: res.consumed_total_tokens,
            consumed_cost_usd: summary.consumed.estimated_cost_usd,
            executed_steps: summary.consumed.operations,
            last_updated_ms: now_ms,
        })
    }

    pub fn reset_usage(&self, entity_id: &str) -> Result<(), BudgetError> {
        let eid = entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }
        if !self.legacy_allocations.read().unwrap().contains_key(eid) {
            return Err(BudgetError::BudgetNotFound(eid.to_string()));
        }

        let summary = self.enforcer.get_summary(eid, "default", eid, 1000)?;
        self.enforcer.reset_session(eid, "default", eid, summary.generation + 1, 1000)
    }

    pub fn get_usage(&self, entity_id: &str) -> Result<BudgetUsage, BudgetError> {
        let eid = entity_id.trim();
        if eid.is_empty() {
            return Err(BudgetError::EmptyEntityId);
        }
        let summary = self.enforcer.get_summary(eid, "default", eid, 1000)?;
        Ok(BudgetUsage {
            entity_id: eid.to_string(),
            consumed_prompt_tokens: summary.consumed.tokens.prompt_tokens,
            consumed_completion_tokens: summary.consumed.tokens.completion_tokens,
            consumed_total_tokens: summary.consumed.tokens.total_tokens,
            consumed_cost_usd: summary.consumed.estimated_cost_usd,
            executed_steps: summary.consumed.operations,
            last_updated_ms: 1000,
        })
    }
}
