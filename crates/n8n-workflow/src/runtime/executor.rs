//! Node execution trait and the node execution state machine.
//!
//! State machine scope: `execution-engine/m2-01-state-machine` (Milestone M2,
//! acceptance criteria: *no invalid state transitions*, *status immutable once a
//! terminal state is reached*). The scheduler (`m2-02`) and the retry policy engine
//! (`m2-04`) are the designated downstream consumers; `WorkflowRunner` is unchanged
//! by this task on purpose (it belongs to the M1 `runtime-kernel` boundary).

use crate::runtime::context::ExecutionContext;
use crate::runtime::error::ExecutionError;
use crate::runtime::frame::ExecutionFrame;
use crate::runtime::ir::NodeIndex;
use async_trait::async_trait;
use n8n_node_model::NodeTypeDescription;
use serde::{Deserialize, Serialize};

#[async_trait]
pub trait NodeExecutor: Send + Sync {
    fn name(&self) -> &str;
    fn description(&self) -> NodeTypeDescription;
    async fn execute(
        &self,
        ctx: &ExecutionContext,
        frame: &mut ExecutionFrame<'_>,
    ) -> Result<(), ExecutionError>;
}

// ---------------------------------------------------------------------------
// M2-01: Node execution state machine (FSM)
// ---------------------------------------------------------------------------

/// Authoritative per-node execution status for one workflow run.
///
/// The status set mirrors the M2 decomposition contract: `Pending`, `Running`,
/// `Succeeded`, `Failed`, `Skipped`, `Waiting`.
///
/// Transition rules (exhaustive; every other pair is invalid):
///
/// ```text
/// Pending  -> Running | Skipped | Failed
/// Running  -> Succeeded | Failed | Waiting
/// Waiting  -> Running | Failed
/// Succeeded / Failed / Skipped  -> (terminal, immutable)
/// ```
///
/// * `Waiting` models await-resume nodes (webhook-resume, sub-workflow child
///   completion). It is *not* terminal: a wait can resume into `Running` or time
///   out / be aborted into `Failed`.
/// * `Failed` is reachable from every non-terminal state so that a pre-dispatch
///   lookup failure (e.g. missing executor) or a cancelled wait is representable.
/// * Terminal states accept no outgoing transition at all — including
///   self-transitions — which makes post-terminal status immutable.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NodeExecutionStatus {
    /// Enqueued in the ready queue, not yet dispatched to an executor.
    Pending,
    /// An executor owns the frame right now.
    Running,
    /// Finished normally; outputs were committed to the data plane.
    Succeeded,
    /// Finished with an error; the error reason is carried by the transition call site.
    Failed,
    /// Never executed by design (disabled node, dead branch, upstream without data).
    Skipped,
    /// Suspended mid-execution, awaiting an external resume event.
    Waiting,
}

impl NodeExecutionStatus {
    /// Every status the machine can hold, in canonical order.
    pub const ALL: [NodeExecutionStatus; 6] = [
        NodeExecutionStatus::Pending,
        NodeExecutionStatus::Running,
        NodeExecutionStatus::Succeeded,
        NodeExecutionStatus::Failed,
        NodeExecutionStatus::Skipped,
        NodeExecutionStatus::Waiting,
    ];

    /// Stable, machine-readable name (snake_case, matches the serde encoding).
    pub fn name(self) -> &'static str {
        match self {
            NodeExecutionStatus::Pending => "pending",
            NodeExecutionStatus::Running => "running",
            NodeExecutionStatus::Succeeded => "succeeded",
            NodeExecutionStatus::Failed => "failed",
            NodeExecutionStatus::Skipped => "skipped",
            NodeExecutionStatus::Waiting => "waiting",
        }
    }

    /// A terminal state is final: no outgoing transition is legal from it.
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            NodeExecutionStatus::Succeeded
                | NodeExecutionStatus::Failed
                | NodeExecutionStatus::Skipped
        )
    }

    /// The single source of truth for legality: `true` iff `self -> to` is a
    /// legal transition. Self-transitions are invalid by construction.
    pub fn can_transition_to(self, to: NodeExecutionStatus) -> bool {
        use NodeExecutionStatus::*;
        match self {
            Pending => matches!(to, Running | Skipped | Failed),
            Running => matches!(to, Succeeded | Failed | Waiting),
            Waiting => matches!(to, Running | Failed),
            Succeeded | Failed | Skipped => false,
        }
    }
}

impl std::fmt::Display for NodeExecutionStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.name())
    }
}

/// Rejection returned when a transition is not part of the legal transition
/// table. It is intentionally *not* an [`ExecutionError`] variant: the
/// `runtime/error.rs` module is outside the `m2-01` file boundary, and a
/// malformed transition is a scheduler/programming bug, not a node failure.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid node execution state transition: {from} -> {to}")]
pub struct InvalidStateTransition {
    /// Status at the moment of the rejected attempt.
    pub from: NodeExecutionStatus,
    /// Status the caller attempted to move to.
    pub to: NodeExecutionStatus,
    /// Whether `from` was terminal (the immutability case).
    pub terminal: bool,
}

/// Guarded, single-node state machine. All mutation flows through
/// [`NodeStateMachine::transition`]; every rejection leaves the machine
/// completely untouched (no partial mutation, no status change, no attempt
/// increment).
#[derive(Debug, Clone, PartialEq)]
pub struct NodeStateMachine {
    node_idx: NodeIndex,
    status: NodeExecutionStatus,
    attempts: u32,
    last_error: Option<String>,
}

impl NodeStateMachine {
    /// Fresh machine for the node at `node_idx`, starting in `Pending`.
    pub fn new(node_idx: NodeIndex) -> Self {
        Self {
            node_idx,
            status: NodeExecutionStatus::Pending,
            attempts: 0,
            last_error: None,
        }
    }

    pub fn node_idx(&self) -> NodeIndex {
        self.node_idx
    }

    /// Current (and after any terminal transition, forever-unchanging) status.
    pub fn status(&self) -> NodeExecutionStatus {
        self.status
    }

    /// Number of times the node has entered `Running` (dispatch/retry count).
    pub fn attempts(&self) -> u32 {
        self.attempts
    }

    /// Reason recorded by the most recent `fail*` transition, if any.
    pub fn last_error(&self) -> Option<&str> {
        self.last_error.as_deref()
    }

    /// Attempt `from -> to`. On an illegal pair returns
    /// [`InvalidStateTransition`] and mutates nothing.
    pub fn transition(&mut self, to: NodeExecutionStatus) -> Result<(), InvalidStateTransition> {
        let from = self.status;
        if !from.can_transition_to(to) {
            return Err(InvalidStateTransition {
                from,
                to,
                terminal: from.is_terminal(),
            });
        }
        if to == NodeExecutionStatus::Running {
            self.attempts = self.attempts.saturating_add(1);
        }
        self.status = to;
        Ok(())
    }

    /// `Pending | Waiting -> Running` (dispatch or resume).
    pub fn start(&mut self) -> Result<(), InvalidStateTransition> {
        self.transition(NodeExecutionStatus::Running)
    }

    /// `Running -> Succeeded`.
    pub fn succeed(&mut self) -> Result<(), InvalidStateTransition> {
        self.transition(NodeExecutionStatus::Succeeded)
    }

    /// `Running | Waiting -> Failed` with the node-level failure reason.
    pub fn fail(&mut self, reason: impl Into<String>) -> Result<(), InvalidStateTransition> {
        let result = self.transition(NodeExecutionStatus::Failed);
        if result.is_ok() {
            self.last_error = Some(reason.into());
        }
        result
    }

    /// `Pending -> Skipped` (disabled node, dead branch, pruned input).
    pub fn skip(&mut self) -> Result<(), InvalidStateTransition> {
        self.transition(NodeExecutionStatus::Skipped)
    }

    /// `Running -> Waiting` (await-resume).
    pub fn wait(&mut self) -> Result<(), InvalidStateTransition> {
        self.transition(NodeExecutionStatus::Waiting)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Expected legal transition table, written independently of
    /// `can_transition_to` so the matrix test is a real cross-check.
    fn expected_allowed(from: NodeExecutionStatus) -> &'static [NodeExecutionStatus] {
        use NodeExecutionStatus::*;
        match from {
            Pending => &[Running, Skipped, Failed],
            Running => &[Succeeded, Failed, Waiting],
            Waiting => &[Running, Failed],
            Succeeded | Failed | Skipped => &[],
        }
    }

    fn to_terminal(status: NodeExecutionStatus) {
        assert!(status.is_terminal(), "{status} must be terminal");
    }

    #[test]
    fn exhaustive_transition_matrix_matches_contract() {
        for &from in &NodeExecutionStatus::ALL {
            for &to in &NodeExecutionStatus::ALL {
                let expected = expected_allowed(from).contains(&to);
                assert_eq!(
                    from.can_transition_to(to),
                    expected,
                    "wrong legality for {from} -> {to}"
                );
            }
        }
    }

    #[test]
    fn self_transitions_are_always_invalid() {
        for &status in &NodeExecutionStatus::ALL {
            assert!(
                !status.can_transition_to(status),
                "{status} -> {status} must be rejected"
            );
        }
    }

    #[test]
    fn happy_path_pending_running_succeeded() {
        let mut m = NodeStateMachine::new(0);
        assert_eq!(m.status(), NodeExecutionStatus::Pending);
        assert_eq!(m.attempts(), 0);

        assert_eq!(m.start(), Ok(()));
        assert_eq!(m.status(), NodeExecutionStatus::Running);
        assert_eq!(m.attempts(), 1);

        assert_eq!(m.succeed(), Ok(()));
        assert_eq!(m.status(), NodeExecutionStatus::Succeeded);
        assert_eq!(m.last_error(), None);
    }

    #[test]
    fn pending_can_be_skipped_or_failed_before_dispatch() {
        let mut m = NodeStateMachine::new(1);
        assert_eq!(m.skip(), Ok(()));
        assert_eq!(m.status(), NodeExecutionStatus::Skipped);
        assert_eq!(m.attempts(), 0, "a skipped node was never dispatched");

        let mut m = NodeStateMachine::new(2);
        assert_eq!(m.fail("executor not found: n8n-nodes-base.missing"), Ok(()));
        assert_eq!(m.status(), NodeExecutionStatus::Failed);
        assert_eq!(
            m.last_error(),
            Some("executor not found: n8n-nodes-base.missing")
        );
    }

    #[test]
    fn waiting_round_trip_and_timeout_to_failed() {
        let mut m = NodeStateMachine::new(3);
        m.start().unwrap();
        assert_eq!(m.wait(), Ok(()));
        assert_eq!(m.status(), NodeExecutionStatus::Waiting);
        assert!(!m.status().is_terminal(), "Waiting must not be terminal");

        // Resume: Waiting -> Running counts as another attempt.
        assert_eq!(m.start(), Ok(()));
        assert_eq!(m.status(), NodeExecutionStatus::Running);
        assert_eq!(m.attempts(), 2);
        assert_eq!(m.succeed(), Ok(()));

        // Wait timeout / abort path.
        let mut m = NodeStateMachine::new(4);
        m.start().unwrap();
        m.wait().unwrap();
        assert_eq!(m.fail("webhook resume timeout"), Ok(()));
        assert_eq!(m.status(), NodeExecutionStatus::Failed);
        assert_eq!(m.last_error(), Some("webhook resume timeout"));
    }

    #[test]
    fn rejected_transition_never_mutates() {
        let mut m = NodeStateMachine::new(5);
        let before = m.clone();

        let err = m.transition(NodeExecutionStatus::Succeeded).unwrap_err();
        assert_eq!(
            err,
            InvalidStateTransition {
                from: NodeExecutionStatus::Pending,
                to: NodeExecutionStatus::Succeeded,
                terminal: false,
            }
        );
        assert_eq!(m, before, "rejected transition must not mutate the machine");

        // Direct Pending -> Waiting is also invalid.
        assert!(m.transition(NodeExecutionStatus::Waiting).is_err());
        assert_eq!(m, before);
    }

    #[test]
    fn terminal_states_are_immutable_from_every_status() {
        use NodeExecutionStatus::*;
        to_terminal(Succeeded);
        to_terminal(Failed);
        to_terminal(Skipped);

        for &terminal in &[Succeeded, Failed, Skipped] {
            let mut m = NodeStateMachine::new(6);
            // Reach each terminal state through only-legal transitions.
            match terminal {
                Succeeded => {
                    m.start().unwrap();
                    m.succeed().unwrap();
                }
                Failed => {
                    m.fail("boom").unwrap();
                }
                Skipped => {
                    m.skip().unwrap();
                }
                other => unreachable!("{other:?} is not terminal"),
            }
            let frozen = m.clone();
            for &to in &NodeExecutionStatus::ALL {
                let err = m
                    .transition(to)
                    .expect_err(&format!("{terminal} -> {to} must stay rejected"));
                assert!(err.terminal, "flag must report immutability source");
                assert_eq!(err.from, terminal);
                assert_eq!(m, frozen, "terminal state must be immutable");
            }
        }
    }

    #[test]
    fn waiting_cannot_skip_and_pending_cannot_succeed_directly() {
        let mut m = NodeStateMachine::new(7);
        m.start().unwrap();
        m.wait().unwrap();
        assert!(m.transition(NodeExecutionStatus::Skipped).is_err());
        assert_eq!(m.status(), NodeExecutionStatus::Waiting);

        let mut m = NodeStateMachine::new(8);
        assert!(m.succeed().is_err(), "dispatch must precede success");
    }

    #[test]
    fn fail_records_reason_only_on_success() {
        let mut m = NodeStateMachine::new(9);
        m.start().unwrap();
        m.succeed().unwrap();
        // Terminal: fail rejected, no reason recorded, status unchanged.
        assert!(m.fail("too late").is_err());
        assert_eq!(m.status(), NodeExecutionStatus::Succeeded);
        assert_eq!(m.last_error(), None);
    }

    #[test]
    fn status_names_are_stable_snake_case() {
        let names: Vec<&str> = NodeExecutionStatus::ALL.iter().map(|s| s.name()).collect();
        assert_eq!(
            names,
            vec![
                "pending",
                "running",
                "succeeded",
                "failed",
                "skipped",
                "waiting"
            ]
        );
        assert_eq!(NodeExecutionStatus::Waiting.to_string(), "waiting");
    }

    #[test]
    fn serde_round_trip_snake_case() {
        for &status in &NodeExecutionStatus::ALL {
            let encoded = serde_json::to_string(&status).unwrap();
            assert_eq!(encoded, format!("\"{}\"", status.name()));
            let decoded: NodeExecutionStatus = serde_json::from_str(&encoded).unwrap();
            assert_eq!(decoded, status);
        }
    }

    #[test]
    fn machine_is_send_sync_static() {
        fn assert_send_sync_static<T: Send + Sync + 'static>() {}
        assert_send_sync_static::<NodeExecutionStatus>();
        assert_send_sync_static::<InvalidStateTransition>();
        assert_send_sync_static::<NodeStateMachine>();
    }
}
