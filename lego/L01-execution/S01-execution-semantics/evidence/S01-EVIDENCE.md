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
1. **Frame Context Isolation & Boundary Ownership**:
   - Setiap run alur kerja memiliki frame independen dengan monotonic execution counter dan timestamp UNIX ms.
   - Penegakan isolasi workflow dan multi-tenant: permintaan port dispatch wajib memverifikasi `frame.workflow_id` dan `envelope.tenant_id` sesuai kepemilikan; mismatch ditolak fail-closed tanpa kontaminasi silang.
2. **Strict FSM State Transitions & Terminal Immutability**:
   - Status FSM mendukung siklus lengkap: `Created` -> `Running` -> `Waiting` -> `Running` -> `Completed` / `Failed` / `Cancelled`.
   - Transisi ilegal ditolak seketika (`InvalidStateTransition` / `FrameNotRunning`).
   - State terminal (`Completed`, `Failed`, `Cancelled`) absolut imutabel dan menolak mutasi lebih lanjut.
3. **Fail-Closed Durable WAL Journal (`port.storage.wal.append.v1`) & Zero Dirty Commits**:
   - Seluruh mutasi frame mencatat entri WAL append dengan Log Sequence Number (LSN) meningkat monotonik.
   - Penulisan WAL dilakukan sebelum mutasi in-memory (`execute_node_step`, `advance_step`, `fail_execution`). Jika penulisan WAL gagal, mutasi state in-memory tidak dieksekusi (zero dirty commits).
   - Tidak ada error swallowing: pola `let _ =` dihilangkan pada seluruh operasi authoritative.
4. **Resource Budget Enforcement (`port.runtime.budget.allocate.v1`)**:
   - Batas maksimum langkah (`max_steps`), batas durasi (`timeout_ms`), dan estimasi alokasi payload memori (`max_memory_bytes`) ditegakkan secara fail-closed pada setiap langkah eksekusi.
   - Pelanggaran budget mentransisikan frame ke status `Failed` secara persisten via WAL.
5. **Node Execution Boundary & Cancellation Propagation (`port.node.execute.invoke.v1`)**:
   - `execute_node_step` meneruskan konteks, menghormati cancellation seketika dengan mengembalikan varian `ExecutionCancelled`, dan meneruskan error node fail-closed ke WAL dan caller.
6. **Replay Semantics & Mathematical Recovery Consistency**:
   - Seluruh siklus eksekusi dapat direkonstruksi secara deterministik dari urutan log WAL via `recover_frame_from_wal`.
   - `verify_recovery_consistency` membuktikan kesesuaian 100% antara state authoritative in-memory dan rekonsiliasi log WAL.
7. **Fail-Closed Cancellation & Wait Token Integrity**:
   - Pembatalan mendukung frame berstatus `Created`, `Running`, maupun `Waiting`, serta bersifat idempoten pada frame `Cancelled`.
   - Token penundaan (`wait_token`) divalidasi non-empty pada penangguhan dan dicocokkan secara fail-closed pada pemanggilan `resume`.
8. **Typed Port Contract Dispatchers & Envelope Correlation**:
   - `handle_port_run_workflow`: Mendukung aksi `create`, `start`, `advance`, `suspend`, `resume`, `complete`, dan `fail` dengan alokasi budget payload, preservasi envelope `correlation_id` / `tenant_id`, serta format respons selaras `CONTRACT.md` (termasuk `steps_executed`).
   - `handle_port_cancel_workflow`: Mendukung pembatalan dengan alasan asli dan preservasi trace correlation.

## Unit Test Coverage
Suite pengujian pada `tests/execution_semantics_test.rs` memverifikasi 32 skenario kritis:
- `test_workflow_execution_frame_lifecycle`: Alur dasar start -> advance -> complete.
- `test_extended_fsm_created_waiting_resumed_lifecycle`: Transisi FSM lengkap Created -> Running -> Waiting -> Running -> Completed.
- `test_cancel_waiting_and_created_frames`: Pembatalan frame berstatus Created dan Waiting.
- `test_workflow_cancellation`: Pembatalan frame aktif Running.
- `test_cancellation_idempotency`: Pembatalan berulang pada frame yang sudah Cancelled bersifat idempoten.
- `test_cannot_advance_non_running_frame`: Penolakan advance pada frame non-running.
- `test_fail_execution_marks_terminal`: Status Failed bersifat terminal dan menolak advance.
- `test_cannot_cancel_completed_frame`: Penolakan transisi pembatalan pada frame yang telah Completed.
- `test_cannot_cancel_failed_frame`: Penolakan transisi pembatalan pada frame yang telah Failed.
- `test_frame_isolation_between_multiple_workflows`: Isolasi frame multi-workflow tanpa interferensi state.
- `test_port_run_workflow_dispatcher_lifecycle`: Roundtrip dispatch port run workflow (create, start, advance, suspend, resume, complete).
- `test_port_run_workflow_dispatcher_fail_action`: Dispatch aksi fail melalui port dispatcher.
- `test_port_cancel_workflow_dispatcher_roundtrip`: Dispatch aksi cancel melalui port cancel dispatcher.
- `test_invalid_port_payload_rejections`: Penolakan fail-closed terhadap payload tidak valid.
- `test_duplicate_execution_id_rejected`: Penolakan deterministik terhadap duplikasi execution_id.
- `test_empty_workflow_and_execution_id_rejected`: Penolakan identifier kosong atau whitespace-only.
- `test_terminal_state_immutability_fail_and_advance`: Imutabilitas status Failed terhadap advance, complete, dan re-failing.
- `test_durable_wal_append_and_lsn_monotonicity`: Verifikasi pencatatan log WAL dan urutan monotonik LSN.
- `test_fail_closed_wal_durability_violation_rejection`: Pembuktian fail-closed WAL dan zero dirty commit.
- `test_budget_step_limit_enforcement`: Penegakan batas maksimum langkah workflow.
- `test_budget_timeout_enforcement`: Penegakan batas timeout durasi eksekusi workflow.
- `test_node_execution_invoke_success_and_error_propagation`: Eksekusi node dan propagasi error node.
- `test_concurrent_frame_execution_thread_safety`: Thread safety eksekusi konkruen pada 8 worker threads paralel.
- `test_node_execution_cancelled_frame_returns_execution_cancelled`: Deteksi frame cancelled pada step node mengembalikan ExecutionCancelled.
- `test_node_execution_wal_failure_prevents_dirty_mutation`: Kegagalan WAL saat node step mencegah mutasi in-memory kotor.
- `test_budget_memory_limit_enforcement`: Penegakan batas alokasi memori payload (max_memory_bytes).
- `test_wal_replay_and_recovery_consistency`: Rekonstruksi frame dari WAL dan pembuktian konsistensi pemulihan.
- `test_port_run_workflow_workflow_mismatch_rejected`: Penolakan mutasi frame jika workflow_id tidak cocok.
- `test_port_run_workflow_tenant_mismatch_rejected`: Isolasi multi-tenant mencegah pembajakan frame antar tenant.
- `test_suspend_with_empty_wait_token_rejected`: Penolakan token penangguhan kosong atau whitespace.
- `test_resume_with_matching_and_mismatched_token`: Penegakan kecocokan token pada saat resume frame.
- `test_port_run_workflow_payload_budget_applied`: Preservasi dan penegakan budget dari payload pemanggilan port.

## Port Contract Verification
- Verified via `crates/n8n-port-contract/tests/execution_semantics_port_test.rs`:
  - `test_execution_semantics_run_port_roundtrip`: PASS
  - `test_execution_semantics_cancel_port_roundtrip`: PASS
  - `test_execution_semantics_ports_security_denied_for_unauthorized_invoker`: PASS

## Residual Risk
- Integrasi distributed durable storage WAL di lingkungan live cluster bergantung pada host storage `H05` (`L05.S02`). Dalam lingkup in-process `H03`, WAL engine menggunakan durable atomic journal.
