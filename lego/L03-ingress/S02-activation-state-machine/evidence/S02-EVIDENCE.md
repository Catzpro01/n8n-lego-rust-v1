# Evidence: L03.S02 Activation State Machine

- **Sub-LEGO ID**: `L03.S02`
- **Name**: Activation state machine
- **Owning LEGO**: `L03-ingress`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `active-triggers-registry`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L03-ingress/S02-activation-state-machine/`
- **Provided Ports**:
  - `port.ingress.activation.toggle.v1`
  - `port.ingress.activation.list.v1`
- **Required Ports**:
  - `port.security.authz.authorize.v1` (Provider: `L02.S03`)
- **Invariants Verified**:
  1. **Fail-Closed Validation**: Rejects toggle requests lacking valid `workflow_id`, `trigger_id`, or `tenant_id` (`test_activation_fail_closed_validation`).
  2. **State Transition Lifecycle**: Manages deterministic transitions between `Inactive`, `Activating`, `Active`, `Deactivating`, and `Failed` (`test_activation_state_transitions_and_failure`, `test_activation_toggle_activate_and_deactivate`).
  3. **Idempotent Toggles**: Repeated activation or deactivation requests on unchanged states succeed deterministically without corrupting registry state (`test_activation_toggle_idempotency`).
  4. **Active Triggers Registry State Ownership**: Authoritative in-memory registry isolates trigger status by tenant, workflow, and trigger type (`test_activation_list_filtering`).
  5. **Transport-Neutral Port Contract**: In-process dispatchers handle `port.ingress.activation.toggle.v1` and `port.ingress.activation.list.v1` payloads cleanly (`test_activation_port_dispatchers`, `crates/n8n-port-contract/tests/activation_port_test.rs`).
  6. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_activation_toggle_activate_and_deactivate`: PASSED
  - `test_activation_toggle_idempotency`: PASSED
  - `test_activation_fail_closed_validation`: PASSED
  - `test_activation_state_transitions_and_failure`: PASSED
  - `test_activation_list_filtering`: PASSED
  - `test_activation_port_dispatchers`: PASSED
  - `test_activation_invalid_state_transition_fails_closed`: PASSED
  - `test_activation_multithreaded_concurrent_toggles`: PASSED
  - `crates/n8n-port-contract/tests/activation_port_test.rs`: PASSED (Roundtrip, Activation Toggle & List, Security Scopes)
