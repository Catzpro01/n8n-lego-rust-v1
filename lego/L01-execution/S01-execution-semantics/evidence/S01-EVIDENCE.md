# Evidence: L01.S01 Execution Semantics

- **Sub-LEGO**: `L01.S01`
- **Owning LEGO**: `L01-execution`
- **State Ownership Domain**: `workflow-execution-frames`
- **Status**: TESTED
- **Physical Root**: `lego/L01-execution/S01-execution-semantics/`
- **Runtime Host**: `H03` (Execution Host)
- **Provided Ports**:
  - `port.execution.run.workflow.v1`
  - `port.execution.cancel.workflow.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
  - `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)
  - `port.node.execute.invoke.v1` (Provider: `L04.S03`)
  - `port.storage.wal.append.v1` (Provider: `L05.S02`)

## Invariants & Hardening Guarantees
1. **Frame Context Isolation**: Setiap eksekusi alur kerja dialokasikan frame independen dengan monotonic execution counter dan timestamp ms UNIX.
2. **Strict FSM State Transitions & Terminal Immutability**:
   - Status FSM mendukung siklus lengkap: `Created` -> `Running` -> `Waiting` -> `Running` -> `Completed` / `Failed` / `Cancelled`.
   - Transisi ilegal (misal `Created -> Completed`, `Waiting -> Completed`, atau mutasi apa pun dari terminal states) ditolak seketika (`InvalidStateTransition` / `FrameNotRunning`).
   - State terminal (`Completed`, `Failed`, `Cancelled`) absolut imutabel dan menolak mutasi lebih lanjut.
3. **Fail-Closed Durable WAL Journal (`port.storage.wal.append.v1`)**:
   - Seluruh mutasi frame mencatat entri WAL append dengan Log Sequence Number (LSN) meningkat secara monotonik.
   - Durability fail-closed terbukti secara mekanis: simulasi kegagalan disk/I/O WAL menolak operasi seketika dengan `WalAppendFailed` dan membatalkan mutasi in-memory (zero dirty commits).
4. **Resource Budget Enforcement (`port.runtime.budget.allocate.v1`)**:
   - Batas maksimum langkah (`max_steps`) dan batas durasi (`timeout_ms`) dipantau pada setiap langkah eksekusi; pelanggaran mentransisikan status frame ke `Failed` secara fail-closed.
5. **Node Execution Boundary (`port.node.execute.invoke.v1`)**:
   - `execute_node_step` meneruskan konteks eksekusi, memvalidasi status running, mencatat output, dan memastikan error node diteruskan tanpa ditelan.
6. **Fail-Closed Cancellation**:
   - Pembatalan mendukung frame berstatus `Created`, `Running`, maupun `Waiting`.
   - Pembatalan berulang pada frame yang sudah `Cancelled` bersifat idempoten (`Ok(())`).
   - Pembatalan pada frame terminal `Completed` atau `Failed` ditolak fail-closed.
7. **Typed Port Contract Dispatchers & Envelope Correlation**:
   - `handle_port_run_workflow`: Mendukung aksi `create`, `start`, `advance`, `suspend`, `resume`, `complete`, dan `fail` dengan propagasi `correlation_id` dan `tenant_id`.
   - `handle_port_cancel_workflow`: Mendukung pembatalan dengan metadata alasan dan correlation context.

## Unit Test Coverage
Suite pengujian pada `tests/execution_semantics_test.rs` memverifikasi 23 skenario kritis:
- `test_workflow_execution_frame_lifecycle`: Verifikasi alur dasar start -> advance -> complete.
- `test_extended_fsm_created_waiting_resumed_lifecycle`: Verifikasi transisi FSM lengkap Created -> Running -> Waiting -> Running -> Completed.
- `test_cancel_waiting_and_created_frames`: Verifikasi pembatalan frame berstatus Created dan Waiting.
- `test_workflow_cancellation`: Verifikasi pembatalan frame aktif Running.
- `test_cancellation_idempotency`: Verifikasi pembatalan berulang pada frame yang sudah Cancelled bersifat idempoten.
- `test_cannot_advance_non_running_frame`: Verifikasi penolakan advance pada frame yang tidak running.
- `test_fail_execution_marks_terminal`: Verifikasi status Failed bersifat terminal dan menolak advance.
- `test_cannot_cancel_completed_frame`: Penolakan transisi pembatalan pada frame yang telah Completed.
- `test_cannot_cancel_failed_frame`: Penolakan transisi pembatalan pada frame yang telah Failed.
- `test_frame_isolation_between_multiple_workflows`: Isolasi frame multi-workflow tanpa interferensi state.
- `test_port_run_workflow_dispatcher_lifecycle`: Verifikasi roundtrip dispatch port run workflow mencakup aksi create, start, advance, suspend, resume, complete.
- `test_port_run_workflow_dispatcher_fail_action`: Dispatch aksi fail melalui port dispatcher.
- `test_port_cancel_workflow_dispatcher_roundtrip`: Dispatch aksi cancel melalui port cancel dispatcher dengan correlation context.
- `test_invalid_port_payload_rejections`: Penolakan fail-closed terhadap payload tidak valid, aksi tidak dikenal, atau missing identifier.
- `test_duplicate_execution_id_rejected`: Penolakan deterministik terhadap duplikasi execution_id.
- `test_empty_workflow_and_execution_id_rejected`: Penolakan input kosong atau whitespace-only.
- `test_terminal_state_immutability_fail_and_advance`: Imutabilitas status Failed terhadap advance, complete, dan re-failing.
- `test_durable_wal_append_and_lsn_monotonicity`: Verifikasi pencatatan log WAL dan urutan monotonik LSN.
- `test_fail_closed_wal_durability_violation_rejection`: Pembuktian fail-closed WAL dan pencegahan dirty in-memory commit saat persistence gagal.
- `test_budget_step_limit_enforcement`: Penegakan batas maksimum langkah workflow.
- `test_budget_timeout_enforcement`: Penegakan batas timeout durasi eksekusi workflow.
- `test_node_execution_invoke_success_and_error_propagation`: Eksekusi node dan propagasi error node tanpa swallowing.
- `test_concurrent_frame_execution_thread_safety`: Thread safety eksekusi konkruen pada 8 worker threads paralel.

## Port Contract Verification
- Verified via `crates/n8n-port-contract/tests/execution_semantics_port_test.rs`:
  - `test_execution_semantics_run_port_roundtrip`: PASS
  - `test_execution_semantics_cancel_port_roundtrip`: PASS
  - `test_execution_semantics_ports_security_denied_for_unauthorized_invoker`: PASS

## Residual Risk
- Integrasi distributed durable storage WAL di lingkungan live cluster bergantung pada host storage `H05` (`L05.S02`). Dalam lingkup in-process `H03`, WAL engine menggunakan durable atomic journal.
