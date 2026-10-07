# Evidence: L01.S01 Execution Semantics

- **Sub-LEGO**: `L01.S01`
- **Owning LEGO**: `L01-execution`
- **State Ownership Domain**: `workflow-execution-frames`
- **Status**: IMPLEMENTED / TESTED
- **Physical Root**: `lego/L01-execution/S01-execution-semantics/`
- **Runtime Host**: `H03` (Execution Host)
- **Provided Ports**:
  - `port.execution.run.workflow.v1`
  - `port.execution.cancel.workflow.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
  - `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)
  - `port.node.execute.invoke.v1` (Provider: `L04.S02`)
  - `port.storage.wal.append.v1` (Provider: `L05.S02`)

## Invariants & Hardening Guarantees
1. **Frame Context Isolation**: Setiap eksekusi alur kerja dialokasikan frame independen dengan monotonic execution counter dan waktu ms UNIX.
2. **Strict FSM State Transitions**: State terminal (`Completed`, `Failed`, `Cancelled`) bersifat absolut imutabel dan menolak `advance_step`. Transisi status ilegal menghasilkan error fail-closed.
3. **Fail-Closed Cancellation**: Operasi pembatalan workflow mendistribusikan status `Cancelled` seketika serta mendukung pembatalan berulang yang bersifat idempoten.
4. **Typed Port Contract Dispatchers**:
   - `handle_port_run_workflow`: Mendukung aksi `start`, `advance`, `complete`, dan `fail` dengan payload response terstandarisasi.
   - `handle_port_cancel_workflow`: Mendukung pembatalan frame dengan audit alasan pembatalan.

## Unit Test Coverage
Suite pengujian pada `tests/execution_semantics_test.rs` memverifikasi 11 skenario kritis:
- `test_workflow_execution_frame_lifecycle`
- `test_workflow_cancellation`
- `test_cancellation_idempotency`
- `test_cannot_advance_non_running_frame`
- `test_fail_execution_marks_terminal`
- `test_cannot_cancel_completed_frame`
- `test_frame_isolation_between_multiple_workflows`
- `test_port_run_workflow_dispatcher_lifecycle`
- `test_port_run_workflow_dispatcher_fail_action`
- `test_port_cancel_workflow_dispatcher_roundtrip`
- `test_invalid_port_payload_rejections`
