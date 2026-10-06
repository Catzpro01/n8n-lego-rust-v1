# Evidence: L01.S04 Checkpoint and Crash Recovery

- **Status**: IMPLEMENTED / TESTED
- **Physical Root**: `lego/L01-execution/S04-checkpoint-recovery/`
- **Provided Ports**:
  - `port.execution.checkpoint.save.v1`
  - `port.execution.recovery.replay.v1`
- **Required Ports**:
  - `port.storage.wal.append.v1`
  - `port.storage.wal.read.v1`
- **Fail-Closed Policy**: WAL failure immediately halts execution without falling back to memory.
- **Test Suite**: Passed (`test_checkpoint_isolation_and_replay_sequence`, WAL durability test).
