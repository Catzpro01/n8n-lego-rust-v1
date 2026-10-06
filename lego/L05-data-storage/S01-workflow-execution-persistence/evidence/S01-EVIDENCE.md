# Evidence: L05.S01 Workflow and Execution Persistence

- **Sub-LEGO ID**: `L05.S01`
- **Name**: Workflow/execution persistence
- **Owning LEGO**: `L05-data-storage`
- **Runtime Host**: `H05` (Data Host)
- **Authoritative State Domain**: `workflow-metadata-store`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: no Sub-LEGO self-awarded production certification)
- **Physical Root**: `lego/L05-data-storage/S01-workflow-execution-persistence/`
- **Provided Ports**:
  - `port.storage.persistence.save.v1`
  - `port.storage.persistence.load.v1`
- **Required Ports**:
  - `port.security.context.validate.v1` (Provider: `L02.S01`)
- **Invariants Verified**:
  1. **Atomic Durability**: `WorkflowExecutionPersistenceStore` performs explicit fsync (`file.sync_all()`) on write paths for execution records and workflow metadata.
  2. **Crash-Recovery Parity**: Verified across isolated store instances (`test_durable_crash_recovery_across_instances`); dropped instances reload state from durable storage with 100% fidelity.
  3. **Strict Fail-Closed Persistence**: Unwritable or invalid storage paths unconditionally fail and return errors (`test_fail_closed_on_unwritable_path`); zero silent downgrade to volatile in-memory journal.
  4. **Transport-Neutral Port Contract**: Save and load dispatchers strictly serialize/deserialize `port.storage.persistence.save.v1` and `port.storage.persistence.load.v1` envelopes.
  5. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture checker.
- **Test Suite**:
  - `test_execution_save_load_and_list`: PASSED
  - `test_workflow_save_load_and_list`: PASSED
  - `test_port_save_and_load_dispatchers`: PASSED
  - `test_durable_crash_recovery_across_instances`: PASSED
  - `test_fail_closed_on_unwritable_path`: PASSED
