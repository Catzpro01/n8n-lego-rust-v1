# Evidence: L00.S04 Health and Lifecycle

- **Status**: IMPLEMENTED / TESTED
- **Physical Root**: `lego/L00-foundation/S04-health-lifecycle/`
- **Provided Ports**:
  - `port.runtime.lifecycle.probe.v1`
  - `port.runtime.lifecycle.quarantine.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1`
- **State Ownership**: `lifecycle-state`
- **Fault Tolerance**: Automatic degradation upon consecutive heartbeat failures; fail-closed isolation upon quarantine.
- **Test Suite**: Passed (`test_lifecycle_heartbeat_and_quarantine`).
