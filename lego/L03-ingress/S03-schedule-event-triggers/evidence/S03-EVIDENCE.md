# Evidence: L03.S03 Schedule/Event/Manual/Form Triggers

- **Sub-LEGO ID**: `L03.S03`
- **Name**: Schedule/event/manual/form triggers
- **Owning LEGO**: `L03-ingress`
- **Runtime Host**: `H01` (Gateway Host)
- **Authoritative State Domain**: `cron-timer-slots`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L03-ingress/S03-schedule-event-triggers/`
- **Provided Ports**:
  - `port.ingress.trigger.dispatch.v1`
- **Required Ports**:
  - `port.execution.run.workflow.v1` (Provider: `L01.S01`)
- **Invariants Verified**:
  1. **Multi-Modal Trigger Support**: Supports deterministic registration and dispatch for Schedule (cron/interval), Event, Manual, and Form triggers (`test_schedule_trigger_registration_and_dispatch`, `test_manual_trigger_dispatch`, `test_event_trigger_with_payload`, `test_form_trigger_validation`).
  2. **Fail-Closed Validation**: Disabled or non-existent trigger slots reject dispatch requests (`test_disabled_slot_fail_closed`).
  3. **Multi-Tenant Isolation**: Enforces tenant boundaries on both slot registration, state modification, and trigger execution dispatching (`test_tenant_boundary_enforcement`).
  4. **Cron Timer Slots State Domain**: Authoritative in-memory slot registry manages active slots, dispatch counts, and execution timestamps.
  5. **Transport-Neutral Port Contract**: In-process dispatcher handles `port.ingress.trigger.dispatch.v1` payloads and prepares execution dispatch envelopes for `port.execution.run.workflow.v1` (`test_port_trigger_dispatch_handler`, `crates/n8n-port-contract/tests/trigger_dispatch_port_test.rs`).
  6. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_schedule_trigger_registration_and_dispatch`: PASSED
  - `test_manual_trigger_dispatch`: PASSED
  - `test_event_trigger_with_payload`: PASSED
  - `test_form_trigger_validation`: PASSED
  - `test_disabled_slot_fail_closed`: PASSED
  - `test_tenant_boundary_enforcement`: PASSED
  - `test_port_trigger_dispatch_handler`: PASSED
  - `test_slot_deregistration_and_filtering`: PASSED
  - `test_concurrent_multithreaded_slot_dispatches`: PASSED
  - `crates/n8n-port-contract/tests/trigger_dispatch_port_test.rs`: PASSED (Roundtrip, Trigger Dispatch, Security Context Scopes)
