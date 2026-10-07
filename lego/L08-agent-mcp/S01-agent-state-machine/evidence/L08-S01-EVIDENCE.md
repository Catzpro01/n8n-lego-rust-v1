# Architecture Evidence Ledger: L08.S01 Agent state machine

## 1. Sub-LEGO Identity
- **ID**: `L08.S01`
- **Name**: Agent state machine
- **Owning LEGO**: `L08-agent-mcp`
- **Runtime Host**: `H06` (Agent Host)
- **State Ownership**: `agent-session-state-machine`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Agent Session State Machine Domain**:
   - Manages state domain `agent-session-state-machine` orchestrating stateful autonomous agent execution sessions.
   - Enforces valid transition DAG: `Idle` -> `Thinking` -> `ToolExecution` | `HumanApprovalWait` -> `Completed` | `Failed` | `Terminated`.
2. **Fail-Closed State Transition Matrix**:
   - Rejects illegal transitions (e.g. `Idle` directly to `ToolExecution`, or transitions from terminal states `Completed`/`Failed`/`Terminated`) fail-closed with `InvalidStateTransition`.
   - Enforces execution step budgets (`max_steps`); exceeding the step limit fails closed with `MaxStepsExceeded`.
3. **Transport-Neutral Port Contract**:
   - Implements provided ports `port.agent.session.execute.v1` and `port.agent.engine.run.v1`.
   - Requires tool execution via `port.agent.tool.invoke.v1`, chat routing via `port.agent.provider.chat.v1`, and memory context via `port.agent.memory.retrieve.v1`.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly via public contracts and typed ports.

## 3. Verification Commands & Results
- Unit test verification:
  - Session creation and initialization: PASS.
  - Valid lifecycle transitions (`Idle` -> `Thinking` -> `ToolExecution` -> `Thinking` -> `Completed`): PASS.
  - Fail-closed invalid transition rejection: PASS.
  - Human approval wait and resume: PASS.
  - Step limit boundary enforcement (`MaxStepsExceeded`): PASS.
  - Token accounting accumulation: PASS.
  - Port handler session execution: PASS.
- Port contract integration tests:
  - `cargo test -p n8n-port-contract --test agent_mcp_port_test`: PASS.
- Architecture CI Enforcement:
  - `python scripts/ci_architecture_check.py`: PASS.
