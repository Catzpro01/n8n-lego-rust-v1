# Evidence: L04.S01 Node Registry and Admission

- **Sub-LEGO ID**: `L04.S01`
- **Name**: Node registry and admission
- **Owning LEGO**: `L04-node-ecosystem`
- **Runtime Host**: `H04` (Worker Host)
- **Authoritative State Domain**: `node-manifest-catalog`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L04-node-ecosystem/S01-node-registry-admission/`
- **Provided Ports**:
  - `port.node.registry.query.v1`
  - `port.node.registry.register.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
- **Invariants Verified**:
  1. **Fail-Closed Admission Policy**: Rejects manifests lacking mandatory node_type_name, display_name, valid category, or zero version (`test_node_registry_fail_closed_admission`).
  2. **Authoritative Catalog State Ownership**: Pre-populates and manages core node manifests in memory (`test_node_registry_initial_builtins`).
  3. **Admission & Registration**: Admits valid node manifests and updates existing versions without data corruption (`test_node_registry_register_and_query`).
  4. **Multi-Criteria Querying**: Filters catalog by node_type_name, category, or trigger semantics (`test_node_registry_query_filters`).
  5. **Transport-Neutral Port Contract**: In-process dispatchers handle `port.node.registry.register.v1` and `port.node.registry.query.v1` payloads cleanly (`test_node_registry_port_dispatchers`, `crates/n8n-port-contract/tests/node_registry_port_test.rs`).
  6. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_node_registry_initial_builtins`: PASSED
  - `test_node_registry_register_and_query`: PASSED
  - `test_node_registry_fail_closed_admission`: PASSED
  - `test_node_registry_query_filters`: PASSED
  - `test_node_registry_port_dispatchers`: PASSED
  - `crates/n8n-port-contract/tests/node_registry_port_test.rs`: PASSED (Roundtrip, Registration & Query, Security Boundaries)
