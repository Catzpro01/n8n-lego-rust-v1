# Evidence: L01.S04 Checkpoint and Crash Recovery

- **Sub-LEGO**: `L01.S04`
- **Owning LEGO**: `L01-execution`
- **State Ownership Domain**: `execution-checkpoint-index`
- **Status**: IMPLEMENTED / TESTED
- **Physical Root**: `lego/L01-execution/S04-checkpoint-recovery/`
- **Runtime Host**: `H03` (Execution Host)
- **Provided Ports**:
  - `port.execution.checkpoint.save.v1`
  - `port.execution.recovery.replay.v1`
- **Required Ports**:
  - `port.storage.wal.append.v1` (Provider: `L05.S02`)
  - `port.storage.wal.read.v1` (Provider: `L05.S02`)

## Invariants & Hardening Guarantees
1. **Monotonic Log Sequence Number (LSN)**: Setiap checkpoint menerima LSN atomik yang strictly monotonically increasing, menjamin urutan kausal yang absolut.
2. **Deterministic Crash Recovery Replay**: Query recovery replay memfilter frame berdasarkan `from_step` dan menyortir kembali step alur kerja strictly berdasarkan urutan LSN, menjamin reproduktifitas pemulihan.
3. **Step Regression Prevention**: Sistem menolak upaya penyimpanan titik checkpoint yang mengalami penurunan step_index secara ilegal untuk alur kerja yang sama (fail-closed integrity).
4. **Multi-Execution Isolation**: Checkpoints antar execution ID disimpan terpisah dan tidak dapat saling mencemari.
5. **Typed Port Contract Dispatchers**:
   - `handle_port_checkpoint_save`: Menyimpan titik checkpoint atomik dan mengembalikan LSN terdaftar.
   - `handle_port_recovery_replay`: Melakukan query replay checkpoint terurut lengkap dengan deteksi node sukses terakhir.

## Unit Test Coverage
Suite pengujian pada `tests/checkpoint_test.rs` memverifikasi 9 skenario kritis:
- `test_checkpoint_isolation_and_replay_sequence`
- `test_checkpoint_lsn_monotonicity`
- `test_checkpoint_replay_from_step_filter`
- `test_regressive_step_index_rejection`
- `test_multi_execution_isolation`
- `test_port_checkpoint_save_dispatcher_roundtrip`
- `test_port_recovery_replay_dispatcher_roundtrip`
- `test_fail_closed_on_invalid_checkpoint_payload`
- `test_empty_execution_recovery_returns_zero_steps`
