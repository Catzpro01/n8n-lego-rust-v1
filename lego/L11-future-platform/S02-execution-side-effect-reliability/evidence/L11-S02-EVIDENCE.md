# Architecture Evidence Ledger: L11.S02 Execution side-effect reliability

## 1. Sub-LEGO Identity
- **ID**: `L11.S02`
- **Name**: Execution side-effect reliability
- **Owning LEGO**: `L11-future-platform`
- **Runtime Host**: `H03` (Execution Host)
- **State Ownership**: `side-effect-outbox`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Side-Effect Outbox State Domain**:
   - Manages state domain `side-effect-outbox` capturing durable intent prior to side-effect execution.
   - Enforces idempotent side-effect execution with cryptographic/payload hash conflict detection. Submissions with conflicting payload hashes for an existing idempotency key are rejected fail-closed.
2. **Failure Classification & Bounded Retries**:
   - Distinguishes `Transient` vs `Permanent` failure categories. Transient failures trigger bounded retries with exponential backoff; permanent failures halt retries immediately.
   - Enforces retry storm protection by validating minimum exponential backoff intervals between attempts.
3. **Compensation & Replay Safety**:
   - Implements automated compensation action execution upon permanent side-effect failure (`Compensated`).
   - Supports durable replay of uncompleted outbox records (`recover_pending_outbox`) across process restarts without duplicate side-effect emissions.
   - Preserves complete attempt audit trails.
4. **Transport-Neutral Port Contract**:
   - Implements provided port `port.future.side_effect.record.v1`.
   - Requires durable WAL persistence via `port.storage.wal.append.v1`.
5. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly routed via public typed ports.

## 3. Verification Commands & Results
- Unit & negative test verification:
  - Happy path record and execute: PASS.
  - Idempotent duplicate returns cached response: PASS.
  - Conflicting idempotency payload hash rejected fail-closed: PASS.
  - Retry storm prevention with exponential backoff: PASS.
  - Permanent failure halts retries and executes compensation: PASS.
  - Expired deadline rejection fail-closed: PASS.
  - Replay of pending outbox after restart: PASS.
  - Port invocation handler: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
