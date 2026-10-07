# Evidence: L01.S03 Sub-workflows

- **Sub-LEGO ID**: `L01.S03`
- **Name**: Sub-workflows
- **Owning LEGO**: `L01-execution`
- **Runtime Host**: `H03` (Execution Host)
- **Authoritative State Domain**: `subworkflow-call-hierarchy`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L01-execution/S03-subworkflows/`
- **Provided Ports**:
  - `port.execution.subworkflow.invoke.v1`
- **Required Ports**:
  - `port.execution.run.workflow.v1` (Provider: `L01.S01`)
  - `port.runtime.budget.allocate.v1` (Provider: `L00.S03`)
- **Invariants Verified**:
  1. **Recursion Depth Bounding**: Subworkflow invocations exceeding the configured max recursion depth are rejected immediately with `DepthExceeded` error (`test_subworkflow_depth_limit_enforced`).
  2. **Cyclic Recursion Prevention**: Call stack chain tracing detects recursive self-invocations or cyclic loops (e.g. `A -> B -> C -> A`) and rejects them cleanly with `CyclicRecursion` error (`test_subworkflow_cyclic_recursion_prevented`).
  3. **Call Hierarchy State Tracking**: All parent-child invocations are registered in the authoritative `subworkflow-call-hierarchy` state domain, tracking call ID, parent execution ID, child execution ID, status, and invocation timestamp (`test_subworkflow_call_hierarchy_state`).
  4. **Fail-Closed Parent Cancellation**: When a parent execution has been cancelled, child invocations are refused immediately without executing any node logic (`test_subworkflow_parent_cancelled_refusal`).
  5. **Flexible Input Data Mapping**: Supports `PassThrough`, `InjectParameters`, and `WrapKey` mapping strategies for transparent data propagation into child workflow triggers (`test_subworkflow_input_mapping_modes`).
  6. **Transport-Neutral Port Contract**: Typed dispatchers handle `port.execution.subworkflow.invoke.v1` invocations with full error reporting and security boundary validation (`test_subworkflow_port_dispatcher_success`, `test_subworkflow_port_dispatcher_error_cycle`, `crates/n8n-port-contract/tests/subworkflow_port_test.rs`).
  7. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_subworkflow_normal_execution`: PASSED
  - `test_subworkflow_call_hierarchy_state`: PASSED
  - `test_subworkflow_input_mapping_modes`: PASSED
  - `test_subworkflow_depth_limit_enforced`: PASSED
  - `test_subworkflow_cyclic_recursion_prevented`: PASSED
  - `test_subworkflow_parent_cancelled_refusal`: PASSED
  - `test_subworkflow_registered_handler_custom_logic`: PASSED
  - `test_subworkflow_port_dispatcher_success`: PASSED
  - `test_subworkflow_port_dispatcher_error_cycle`: PASSED
  - `test_subworkflow_port_dispatcher_missing_child_wf`: PASSED
  - `test_nested_multi_level_invocation_hierarchy`: PASSED
  - `test_wrap_key_mapping_mode_complex_objects`: PASSED
  - `crates/n8n-port-contract/tests/subworkflow_port_test.rs`: PASSED (Roundtrip, Security Boundary, Recursion Guards)
