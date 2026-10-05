use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

/// Structured execution error adhering to n8n standard runtime error schema.
#[derive(Debug, Error, Clone, PartialEq, Serialize, Deserialize)]
pub enum ExecutionError {
    #[error("Node not found: {0}")]
    NodeNotFound(String),

    #[error("Executor not found for node type: {0}")]
    ExecutorNotFound(String),

    #[error("Invalid port: node '{node}', port {port}")]
    InvalidPort { node: String, port: usize },

    #[error("Cycle detected in execution graph")]
    CycleDetected,

    #[error("Execution was cancelled")]
    Cancelled,

    #[error("Memory budget exceeded: limit {limit} bytes, attempted {attempted} bytes")]
    MemoryBudgetExceeded { limit: usize, attempted: usize },

    #[error("Node execution failed: {0}")]
    NodeExecutionFailed(String),

    #[error("Internal runtime error: {0}")]
    Internal(String),
}

/// Standardized error output schema matching n8n error routing specifications.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StandardErrorOutput {
    pub message: String,
    pub description: Option<String>,
    pub error_code: String,
    pub timestamp: String,
    pub details: Value,
}

/// Mirrors the n8n `onError` node setting.
///
/// Wire strings are the exact values allowed by the reference schema
/// (`reference/n8n/packages/workflow/src/schemas.ts`, `OnErrorSchema`):
/// `stopWorkflow` | `continueRegularOutput` | `continueErrorOutput`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NodeOnError {
    /// Default: a node error stops the workflow execution.
    StopWorkflow,
    /// Emit the error on the node's regular output and keep executing.
    ContinueRegularOutput,
    /// Emit the error on the node's dedicated error output branch
    /// (the branch consumed by downstream `onError` connections).
    ContinueErrorOutput,
}

impl NodeOnError {
    /// Returns the exact n8n wire representation of this setting.
    pub fn as_n8n_str(&self) -> &'static str {
        match self {
            NodeOnError::StopWorkflow => "stopWorkflow",
            NodeOnError::ContinueRegularOutput => "continueRegularOutput",
            NodeOnError::ContinueErrorOutput => "continueErrorOutput",
        }
    }

    /// Parses an n8n wire value. Unknown values map to `None`, which callers
    /// treat as the `stopWorkflow` default (matching n8n's schema rejection
    /// of anything outside [`NodeOnError`]).
    pub fn from_n8n_str(value: &str) -> Option<Self> {
        match value {
            "stopWorkflow" => Some(NodeOnError::StopWorkflow),
            "continueRegularOutput" => Some(NodeOnError::ContinueRegularOutput),
            "continueErrorOutput" => Some(NodeOnError::ContinueErrorOutput),
            _ => None,
        }
    }
}

/// Routing decision produced for a failed node execution.
///
/// Precedence (n8n semantics):
/// 1. A manual cancellation (`ExecutionError::Cancelled`) always fails the
///    execution and never fires the workflow error trigger (n8n does not run
///    error workflows on user-initiated stops).
/// 2. `onError: continue*` on the failing node wins over the workflow-level
///    error workflow — the workflow did not fail, so nothing is triggered.
/// 3. With `onError: stopWorkflow` (default): if `errorWorkflow` is
///    configured, the workflow error trigger is activated (the original
///    execution still ends in error; the error workflow runs as its own
///    execution), otherwise the execution simply fails.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum ErrorRoute {
    /// Halt the execution; the error surfaces through the normal `Result`
    /// channel of the runner.
    FailExecution,
    /// Continue on the failing node's regular output with the structured
    /// error attached by the caller.
    ContinueRegularOutput,
    /// Hand the structured error to the node's error output branch
    /// (downstream `onError` connections).
    ContinueErrorOutput,
    /// Activate the workflow-level error trigger (`errorWorkflow` setting);
    /// the error workflow receives the structured payload as its input.
    TriggerErrorWorkflow { error_workflow_id: String },
}

/// Policy inputs consulted when routing a node error.
///
/// Callers assemble this from the failing node's `onError` setting and the
/// workflow's `errorWorkflow` setting
/// (`reference/n8n/packages/workflow/src/interfaces.ts`,
/// `WorkflowSettings.errorWorkflow: 'DEFAULT' | string`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ErrorPolicy {
    /// `onError` of the node that failed; `None` = `stopWorkflow`.
    pub node_on_error: Option<NodeOnError>,
    /// ID of the workflow configured as this workflow's error workflow;
    /// `None` = no error trigger available.
    pub error_workflow_id: Option<String>,
}

impl ErrorPolicy {
    /// Builds the default policy: stop on error, no error workflow.
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets the failing node's `onError` mode.
    pub fn with_node_on_error(mut self, mode: NodeOnError) -> Self {
        self.node_on_error = Some(mode);
        self
    }

    /// Configures the workflow-level error workflow (error trigger target).
    pub fn with_error_workflow(mut self, workflow_id: impl Into<String>) -> Self {
        self.error_workflow_id = Some(workflow_id.into());
        self
    }
}

/// The full result of routing one node error: the decision plus the
/// sanitized, stacktrace-free structured error to hand to the user-facing
/// output or to the activated error workflow payload.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ErrorRoutingOutcome {
    pub route: ErrorRoute,
    pub output: StandardErrorOutput,
}

impl ErrorRoutingOutcome {
    /// `true` when the workflow-level error trigger must be activated for
    /// this error.
    pub fn activates_error_workflow(&self) -> bool {
        matches!(self.route, ErrorRoute::TriggerErrorWorkflow { .. })
    }
}

impl ExecutionError {
    /// Returns the standard alphanumeric error code string.
    pub fn error_code(&self) -> &'static str {
        match self {
            ExecutionError::NodeNotFound(_) => "ERR_NODE_NOT_FOUND",
            ExecutionError::ExecutorNotFound(_) => "ERR_EXECUTOR_NOT_FOUND",
            ExecutionError::InvalidPort { .. } => "ERR_INVALID_PORT",
            ExecutionError::CycleDetected => "ERR_CYCLE_DETECTED",
            ExecutionError::Cancelled => "ERR_EXECUTION_CANCELLED",
            ExecutionError::MemoryBudgetExceeded { .. } => "ERR_MEMORY_BUDGET_EXCEEDED",
            ExecutionError::NodeExecutionFailed(_) => "ERR_NODE_EXECUTION_FAILED",
            ExecutionError::Internal(_) => "ERR_INTERNAL_RUNTIME",
        }
    }

    /// Formats the error into standard n8n error workflow schema.
    ///
    /// `message` and `description` are passed through
    /// [`sanitize_user_text`] first, so stacktraces and source locations can
    /// never reach the user-facing output; `timestamp` is the real UTC
    /// emission time.
    pub fn to_standard_output(&self) -> StandardErrorOutput {
        let description = match self {
            ExecutionError::NodeNotFound(name) => Some(format!(
                "Referenced node '{}' does not exist in workflow definition",
                name
            )),
            ExecutionError::ExecutorNotFound(typ) => {
                Some(format!("No node executor registered for type '{}'", typ))
            }
            ExecutionError::InvalidPort { node, port } => Some(format!(
                "Port index {} out of range for node '{}'",
                port, node
            )),
            ExecutionError::CycleDetected => {
                Some("Workflow topology contains a circular dependency".to_string())
            }
            ExecutionError::Cancelled => {
                Some("Workflow execution was explicitly aborted by user or timeout".to_string())
            }
            ExecutionError::MemoryBudgetExceeded { limit, attempted } => Some(format!(
                "Exceeded memory ceiling: attempted {} bytes, limit was {} bytes",
                attempted, limit
            )),
            ExecutionError::NodeExecutionFailed(msg) => {
                Some(format!("Execution failed during node processing: {}", msg))
            }
            ExecutionError::Internal(msg) => Some(format!("Runtime internal failure: {}", msg)),
        };
        StandardErrorOutput {
            message: sanitize_user_text(&self.to_string()),
            description: description.map(|text| sanitize_user_text(&text)),
            error_code: self.error_code().to_string(),
            timestamp: now_rfc3339_utc(),
            details: match self {
                ExecutionError::InvalidPort { node, port } => json!({ "node": node, "port": port }),
                ExecutionError::MemoryBudgetExceeded { limit, attempted } => {
                    json!({ "limit": limit, "attempted": attempted })
                }
                ExecutionError::NodeNotFound(node) => json!({ "node": node }),
                ExecutionError::ExecutorNotFound(typ) => json!({ "node_type": typ }),
                _ => json!({}),
            },
        }
    }

    /// Routes this error according to the node `onError` mode and the
    /// workflow-level error workflow configuration.
    ///
    /// See [`ErrorRoute`] for the precedence rules. The returned
    /// [`ErrorRoutingOutcome`] always carries the sanitized structured
    /// error, whether the route continues, fails, or fires the error trigger.
    pub fn route(&self, policy: &ErrorPolicy) -> ErrorRoutingOutcome {
        let route = if matches!(self, ExecutionError::Cancelled) {
            // Manual stop/timeout abort: never the error workflow's business.
            ErrorRoute::FailExecution
        } else {
            match policy.node_on_error.unwrap_or(NodeOnError::StopWorkflow) {
                NodeOnError::ContinueRegularOutput => ErrorRoute::ContinueRegularOutput,
                NodeOnError::ContinueErrorOutput => ErrorRoute::ContinueErrorOutput,
                NodeOnError::StopWorkflow => match &policy.error_workflow_id {
                    Some(error_workflow_id) => ErrorRoute::TriggerErrorWorkflow {
                        error_workflow_id: error_workflow_id.clone(),
                    },
                    None => ErrorRoute::FailExecution,
                },
            }
        };
        ErrorRoutingOutcome {
            route,
            output: self.to_standard_output(),
        }
    }
}

/// Strips stacktraces, source locations, and ANSI escape sequences from text
/// that is about to be handed to the user or serialized into an execution
/// payload.
///
/// - Everything from a `stack backtrace:` header onward is dropped.
/// - Source locations such as `src/runtime/executor.rs:214:9` are replaced
///   with `<source-redacted>`.
/// - ANSI CSI escape sequences are removed.
pub fn sanitize_user_text(raw: &str) -> String {
    let without_backtrace = match raw.find("stack backtrace:") {
        Some(index) => &raw[..index],
        None => raw,
    };
    let without_ansi = strip_ansi(without_backtrace);
    redact_source_locations(&without_ansi)
}

/// Removes ANSI CSI escape sequences (`ESC [ ... final-byte`).
fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(ch) = chars.next() {
        if ch == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                // Consume until the CSI final byte (`0x40..=0x7E`).
                while let Some(&final_byte) = chars.peek() {
                    chars.next();
                    if ('\u{40}'..='\u{7e}').contains(&final_byte) {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(ch);
    }
    out
}

/// Replaces `path/file.rs:<line>[:<col>]` occurrences with
/// `<source-redacted>` so panic locations never leak to output users.
fn redact_source_locations(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(marker) = rest.find(".rs:") {
        let head = &rest[..marker];
        // Walk back over the path characters preceding `.rs:`.
        let path_start = head
            .char_indices()
            .rev()
            .take_while(|(_, ch)| {
                ch.is_ascii_alphanumeric() || matches!(ch, '_' | '.' | '/' | '\\' | '-')
            })
            .map(|(index, _)| index)
            .last()
            .unwrap_or(0);
        let tail = &rest[marker + 4..];
        let line_digits = tail.chars().take_while(|ch| ch.is_ascii_digit()).count();
        if line_digits == 0 {
            // Not a source location (e.g. literal `.rs:` text); keep looking
            // past it to guarantee progress.
            out.push_str(&rest[..marker + 4]);
            rest = tail;
            continue;
        }
        let after_line = &tail[line_digits..];
        let column_digits = if let Some(stripped) = after_line.strip_prefix(':') {
            let count = stripped
                .chars()
                .take_while(|ch| ch.is_ascii_digit())
                .count();
            if count > 0 {
                1 + count
            } else {
                0
            }
        } else {
            0
        };
        out.push_str(&rest[..path_start]);
        out.push_str("<source-redacted>");
        rest = &tail[line_digits + column_digits..];
    }
    out.push_str(rest);
    out
}

/// Current UTC timestamp as RFC 3339 (`YYYY-MM-DDTHH:MM:SSZ`), std-only.
fn now_rfc3339_utc() -> String {
    let total_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0);
    let days = total_secs.div_euclid(86_400);
    let second_of_day = total_secs.rem_euclid(86_400);

    // Howard Hinnant's civil_from_days algorithm.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = if month_prime < 10 {
        month_prime + 3
    } else {
        month_prime - 9
    };
    let year = if month <= 2 { year + 1 } else { year };

    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        year, month, day, hour, minute, second
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_code_mapping() {
        let err = ExecutionError::NodeNotFound("HTTP Request".to_string());
        assert_eq!(err.error_code(), "ERR_NODE_NOT_FOUND");
        assert_eq!(err.to_string(), "Node not found: HTTP Request");

        let err_cycle = ExecutionError::CycleDetected;
        assert_eq!(err_cycle.error_code(), "ERR_CYCLE_DETECTED");
    }

    #[test]
    fn test_standard_error_output_formatting() {
        let err = ExecutionError::MemoryBudgetExceeded {
            limit: 1024,
            attempted: 2048,
        };
        let out = err.to_standard_output();
        assert_eq!(out.error_code, "ERR_MEMORY_BUDGET_EXCEEDED");
        assert!(out.message.contains("1024 bytes"));
        assert_eq!(out.details["limit"], 1024);
        assert_eq!(out.details["attempted"], 2048);
    }

    #[test]
    fn test_route_default_policy_fails_execution_without_error_workflow() {
        let err = ExecutionError::NodeExecutionFailed("boom".to_string());
        let outcome = err.route(&ErrorPolicy::new());
        assert_eq!(outcome.route, ErrorRoute::FailExecution);
        assert!(!outcome.activates_error_workflow());
        assert_eq!(outcome.output.error_code, "ERR_NODE_EXECUTION_FAILED");
        assert!(outcome.output.message.contains("boom"));
    }

    #[test]
    fn test_route_continue_regular_output_wins_over_error_workflow() {
        let err = ExecutionError::NodeExecutionFailed("boom".to_string());
        let policy = ErrorPolicy::new()
            .with_node_on_error(NodeOnError::ContinueRegularOutput)
            .with_error_workflow("wf-error");
        let outcome = err.route(&policy);
        assert_eq!(outcome.route, ErrorRoute::ContinueRegularOutput);
        // The workflow did not fail, so the error trigger stays untouched.
        assert!(!outcome.activates_error_workflow());
    }

    #[test]
    fn test_route_continue_error_output_uses_downstream_on_error_branch() {
        let err = ExecutionError::NodeExecutionFailed("boom".to_string());
        let policy = ErrorPolicy::new().with_node_on_error(NodeOnError::ContinueErrorOutput);
        let outcome = err.route(&policy);
        assert_eq!(outcome.route, ErrorRoute::ContinueErrorOutput);
        assert!(!outcome.activates_error_workflow());
    }

    #[test]
    fn test_route_triggers_error_workflow_when_configured() {
        let err = ExecutionError::NodeExecutionFailed("boom".to_string());
        let policy = ErrorPolicy::new().with_error_workflow("wf-error-42");
        let outcome = err.route(&policy);
        assert_eq!(
            outcome.route,
            ErrorRoute::TriggerErrorWorkflow {
                error_workflow_id: "wf-error-42".to_string()
            }
        );
        assert!(outcome.activates_error_workflow());
        assert_eq!(outcome.output.error_code, "ERR_NODE_EXECUTION_FAILED");
    }

    #[test]
    fn test_route_cancelled_never_triggers_error_workflow() {
        let policy = ErrorPolicy::new().with_error_workflow("wf-error");
        let outcome = ExecutionError::Cancelled.route(&policy);
        assert_eq!(outcome.route, ErrorRoute::FailExecution);
        assert!(!outcome.activates_error_workflow());
    }

    #[test]
    fn test_stacktrace_never_leaks_to_standard_output() {
        let err = ExecutionError::Internal(
            "db write failed\nstack backtrace:\n   0: core::panicking::panic\n   1: runtime::exec"
                .to_string(),
        );
        let out = err.to_standard_output();
        assert!(out.message.contains("db write failed"));
        assert!(!out.message.contains("stack backtrace"));
        assert!(!out.message.contains("core::panicking"));
        let description = out
            .description
            .clone()
            .expect("internal errors carry a description");
        assert!(!description.contains("stack backtrace"));
        let serialized = serde_json::to_string(&out).expect("output serializes");
        assert!(!serialized.contains("stack backtrace"));
        assert!(!serialized.contains("core::panicking"));
    }

    #[test]
    fn test_panic_source_location_is_redacted() {
        let err = ExecutionError::Internal(
            "panicked at 'unwrap failed', src/runtime/executor.rs:214:9".to_string(),
        );
        let out = err.to_standard_output();
        assert!(out.message.contains("panicked at 'unwrap failed'"));
        assert!(!out.message.contains("src/runtime/executor.rs:214:9"));
        assert!(out.message.contains("<source-redacted>"));
        let description = out.description.expect("description present");
        assert!(!description.contains("executor.rs"));
    }

    #[test]
    fn test_node_on_error_wire_strings_match_n8n() {
        assert_eq!(
            serde_json::to_string(&NodeOnError::StopWorkflow).unwrap(),
            "\"stopWorkflow\""
        );
        assert_eq!(
            serde_json::to_string(&NodeOnError::ContinueRegularOutput).unwrap(),
            "\"continueRegularOutput\""
        );
        assert_eq!(
            serde_json::to_string(&NodeOnError::ContinueErrorOutput).unwrap(),
            "\"continueErrorOutput\""
        );
        assert_eq!(
            NodeOnError::from_n8n_str("continueErrorOutput"),
            Some(NodeOnError::ContinueErrorOutput)
        );
        assert_eq!(NodeOnError::from_n8n_str("stopError"), None);
        assert_eq!(
            NodeOnError::ContinueErrorOutput.as_n8n_str(),
            "continueErrorOutput"
        );
    }

    #[test]
    fn test_timestamp_is_structured_utc() {
        let out = ExecutionError::Cancelled.to_standard_output();
        let ts = &out.timestamp;
        assert_eq!(
            ts.len(),
            20,
            "RFC 3339 UTC must be YYYY-MM-DDTHH:MM:SSZ: {ts}"
        );
        assert!(ts.ends_with('Z') && ts.contains('T'));
        assert_eq!(&ts[4..5], "-", "year-month separator");
        assert_eq!(&ts[7..8], "-", "month-day separator");
        assert_eq!(&ts[10..11], "T", "date-time separator");
        assert!(ts[..4].chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn test_outcome_serialization_carries_route_and_error_code() {
        let err = ExecutionError::NodeNotFound("Start".to_string());
        let outcome = err.route(&ErrorPolicy::new().with_error_workflow("wf-error"));
        let value = serde_json::to_value(&outcome).expect("outcome serializes");
        assert_eq!(value["output"]["error_code"], "ERR_NODE_NOT_FOUND");
        assert_eq!(value["output"]["details"]["node"], "Start");
        assert!(value.get("route").is_some());
    }
}
