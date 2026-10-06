# Evidence: L04.S04 Compatibility Worker

- **Sub-LEGO ID**: `L04.S04`
- **Name**: Compatibility worker
- **Owning LEGO**: `L04-node-ecosystem`
- **Runtime Host**: `H07` (Compatibility Host)
- **Authoritative State Domain**: `worker-bridge-sessions`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L04-node-ecosystem/S04-compatibility-worker/`
- **Provided Ports**:
  - `port.node.compat.invoke_js.v1`
- **Required Ports**:
  - `port.node.execute.invoke.v1` (Provider: `L04.S03`)
  - `port.storage.binary.stream.v1` (Provider: `L05.S04`)
- **Invariants Verified**:
  1. **Bridge Sessions Lifecycle**: Manages creation, heartbeat keep-alive, active invocation counters, and termination in `worker-bridge-sessions` (`test_bridge_session_creation_and_heartbeat`, `test_compat_invoke_terminated_session_rejection`).
  2. **Multi-Tenant Session Isolation**: Enforces tenant boundaries strictly; cross-tenant session reuse and heartbeats fail closed (`test_compat_invoke_tenant_boundary_enforcement`).
  3. **Auto Session Provisioning**: Automatically provisions tenant-isolated bridge sessions when explicit session IDs are omitted (`test_compat_invoke_auto_session_provisioning`).
  4. **Legacy JS Compatibility Execution**: Transparently executes legacy node payloads across the bridge with structured output items (`test_compat_invoke_js_execution`).
  5. **Transport-Neutral Port Contract**: In-process dispatcher handles `port.node.compat.invoke_js.v1` payloads seamlessly (`test_port_compat_invoke_js_dispatcher`, `crates/n8n-port-contract/tests/compat_worker_port_test.rs`).
  6. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_bridge_session_creation_and_heartbeat`: PASSED
  - `test_compat_invoke_js_execution`: PASSED
  - `test_compat_invoke_auto_session_provisioning`: PASSED
  - `test_compat_invoke_terminated_session_rejection`: PASSED
  - `test_compat_invoke_tenant_boundary_enforcement`: PASSED
  - `test_port_compat_invoke_js_dispatcher`: PASSED
  - `crates/n8n-port-contract/tests/compat_worker_port_test.rs`: PASSED (Roundtrip, JS Compatibility Node Execution, Security Context Scopes)
