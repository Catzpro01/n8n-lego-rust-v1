#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_schedule_trigger_registration_and_dispatch() {
        let service = TriggerSlotManagerService::new();

        let slot = service
            .register_slot(
                "slot-cron-1",
                "tenant-alpha",
                "wf-daily-report",
                TriggerType::Schedule,
                Some("0 0 * * *"),
                None,
                Some(json!({ "tz": "UTC" })),
            )
            .expect("Registration should succeed");

        assert_eq!(slot.slot_id, "slot-cron-1");
        assert_eq!(slot.trigger_type, TriggerType::Schedule);
        assert!(slot.is_enabled);
        assert_eq!(slot.dispatch_count, 0);

        // Dispatch
        let res = service
            .dispatch("slot-cron-1", "tenant-alpha", json!({ "tick": 1 }), None)
            .expect("Dispatch should succeed");

        assert!(res.dispatched);
        assert_eq!(res.workflow_id, "wf-daily-report");
        assert_eq!(res.target_port, "port.execution.run.workflow.v1");
        assert_eq!(res.payload_for_execution["workflow_id"], "wf-daily-report");

        let updated_slot = service.get_slot("slot-cron-1").expect("Slot must exist");
        assert_eq!(updated_slot.dispatch_count, 1);
        assert!(updated_slot.last_dispatched_at_ms.is_some());
    }

    #[test]
    fn test_manual_trigger_dispatch() {
        let service = TriggerSlotManagerService::new();

        service
            .register_slot(
                "slot-manual-1",
                "tenant-alpha",
                "wf-manual-sync",
                TriggerType::Manual,
                None,
                None,
                None,
            )
            .expect("Registration should succeed");

        let res = service
            .dispatch(
                "slot-manual-1",
                "tenant-alpha",
                json!({ "run_mode": "manual_test" }),
                Some("user:alice"),
            )
            .expect("Manual dispatch should succeed");

        assert_eq!(res.trigger_type, TriggerType::Manual);
        assert_eq!(res.payload_for_execution["invoker"], "user:alice");
        assert_eq!(res.payload_for_execution["data"]["run_mode"], "manual_test");
    }

    #[test]
    fn test_event_trigger_with_payload() {
        let service = TriggerSlotManagerService::new();

        service
            .register_slot(
                "slot-event-kafka",
                "tenant-beta",
                "wf-order-processor",
                TriggerType::Event,
                None,
                None,
                Some(json!({ "topic": "orders.v1" })),
            )
            .expect("Registration should succeed");

        let payload = json!({
            "order_id": "ord-9988",
            "amount": 249.99,
            "currency": "USD"
        });

        let res = service
            .dispatch("slot-event-kafka", "tenant-beta", payload.clone(), Some("system:kafka-consumer"))
            .expect("Event dispatch should succeed");

        assert_eq!(res.trigger_type, TriggerType::Event);
        assert_eq!(res.payload_for_execution["data"]["order_id"], "ord-9988");
        assert_eq!(res.payload_for_execution["metadata"]["topic"], "orders.v1");
    }

    #[test]
    fn test_form_trigger_validation() {
        let service = TriggerSlotManagerService::new();

        service
            .register_slot(
                "slot-form-contact",
                "tenant-gamma",
                "wf-contact-form",
                TriggerType::Form,
                None,
                None,
                Some(json!({ "form_title": "Contact Us" })),
            )
            .expect("Registration should succeed");

        // Null payload rejected
        let err = service
            .dispatch("slot-form-contact", "tenant-gamma", serde_json::Value::Null, None)
            .unwrap_err();
        assert!(matches!(err, TriggerError::MissingPayload(_)));

        // Valid form payload succeeds
        let res = service
            .dispatch(
                "slot-form-contact",
                "tenant-gamma",
                json!({ "email": "test@example.com", "message": "Hello!" }),
                Some("guest:submitter"),
            )
            .expect("Form dispatch should succeed");

        assert_eq!(res.trigger_type, TriggerType::Form);
        assert_eq!(res.payload_for_execution["data"]["email"], "test@example.com");
    }

    #[test]
    fn test_disabled_slot_fail_closed() {
        let service = TriggerSlotManagerService::new();

        service
            .register_slot(
                "slot-disabled-1",
                "tenant-alpha",
                "wf-cron",
                TriggerType::Schedule,
                Some("*/5 * * * *"),
                None,
                None,
            )
            .expect("Registration should succeed");

        // Disable slot
        service
            .set_enabled("slot-disabled-1", "tenant-alpha", false)
            .expect("Set disabled should succeed");

        let err = service
            .dispatch("slot-disabled-1", "tenant-alpha", json!({}), None)
            .unwrap_err();

        assert_eq!(err, TriggerError::SlotDisabled("slot-disabled-1".to_string()));
    }

    #[test]
    fn test_tenant_boundary_enforcement() {
        let service = TriggerSlotManagerService::new();

        service
            .register_slot(
                "slot-tenant-isolation",
                "tenant-owner",
                "wf-secret",
                TriggerType::Manual,
                None,
                None,
                None,
            )
            .expect("Registration should succeed");

        // Wrong tenant dispatch rejected
        let err = service
            .dispatch("slot-tenant-isolation", "tenant-attacker", json!({}), None)
            .unwrap_err();

        assert!(matches!(err, TriggerError::TenantMismatch { .. }));

        // Wrong tenant toggle rejected
        let err_toggle = service
            .set_enabled("slot-tenant-isolation", "tenant-attacker", false)
            .unwrap_err();
        assert!(matches!(err_toggle, TriggerError::TenantMismatch { .. }));
    }

    #[test]
    fn test_port_trigger_dispatch_handler() {
        let service = TriggerSlotManagerService::new();

        service
            .register_slot(
                "slot-port-test",
                "tenant-port",
                "wf-port-target",
                TriggerType::Schedule,
                Some("0 * * * *"),
                None,
                None,
            )
            .expect("Registration should succeed");

        let dispatch_req = json!({
            "slot_id": "slot-port-test",
            "tenant_id": "tenant-port",
            "input_data": { "cron_tick": 42 },
            "invoker": "cron:scheduler"
        });

        let out = service
            .handle_port_dispatch(&dispatch_req)
            .expect("Port dispatch must succeed");

        assert_eq!(out["dispatched"], true);
        assert_eq!(out["workflow_id"], "wf-port-target");
        assert_eq!(out["target_port"], "port.execution.run.workflow.v1");
        assert_eq!(out["payload_for_execution"]["data"]["cron_tick"], 42);
    }
}
