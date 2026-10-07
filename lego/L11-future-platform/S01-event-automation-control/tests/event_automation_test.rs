//! Unit & Domain Tests for L11.S01 Event / Automation Plane

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_test_event(id: &str, topic: &str, tenant: &str) -> ControlEvent {
        ControlEvent {
            event_id: id.to_string(),
            topic: topic.to_string(),
            source: "workflow-runner-1".to_string(),
            tenant_id: tenant.to_string(),
            correlation_id: "corr-100".to_string(),
            idempotency_key: Some(format!("key-{}", id)),
            timestamp_ms: 1000,
            deadline_ms: Some(5000),
            max_retries: 2,
            retry_count: 0,
            payload_handle: Some("data://blobs/payload-1".to_string()),
            inline_payload: Some(serde_json::json!({ "meta": "info" })),
            state: DeliveryState::Pending,
        }
    }

    #[test]
    fn test_publish_and_subscribe_topic_routing() {
        let bus = EventControlBus::new(100);
        bus.subscribe("sub-1", "tenant-alpha", "workflow.execution.*").unwrap();
        bus.subscribe("sub-2", "tenant-alpha", "system.alert").unwrap();

        let ev1 = create_test_event("ev-1", "workflow.execution.completed", "tenant-alpha");
        let receipt1 = bus.publish(ev1, 2000).unwrap();
        assert_eq!(receipt1.queued_subscribers, 1);

        let events_sub1 = bus.poll_events("sub-1", "tenant-alpha", 10).unwrap();
        assert_eq!(events_sub1.len(), 1);
        assert_eq!(events_sub1[0].event_id, "ev-1");
        assert_eq!(events_sub1[0].state, DeliveryState::Delivered);

        // sub-2 should have 0 events
        let events_sub2 = bus.poll_events("sub-2", "tenant-alpha", 10).unwrap();
        assert!(events_sub2.is_empty());
    }

    #[test]
    fn test_idempotency_key_deduplication() {
        let bus = EventControlBus::new(100);
        bus.subscribe("sub-1", "tenant-alpha", "*").unwrap();

        let mut ev1 = create_test_event("ev-1", "workflow.trigger", "tenant-alpha");
        ev1.idempotency_key = Some("unique-idempotency-123".to_string());

        let mut ev2 = create_test_event("ev-2", "workflow.trigger", "tenant-alpha");
        ev2.idempotency_key = Some("unique-idempotency-123".to_string());

        assert!(bus.publish(ev1, 2000).is_ok());

        let err = bus.publish(ev2, 2000).unwrap_err();
        assert!(matches!(err, EventBusError::DuplicateIdempotencyKey(_)));
    }

    #[test]
    fn test_deadline_expired_fails_closed() {
        let bus = EventControlBus::new(100);
        let mut ev = create_test_event("ev-dl", "order.created", "tenant-alpha");
        ev.deadline_ms = Some(1500);

        // Publishing at 2000 ms when deadline was 1500 ms
        let err = bus.publish(ev, 2000).unwrap_err();
        assert_eq!(err, EventBusError::DeadlineExpired(1500));
    }

    #[test]
    fn test_tenant_boundary_isolation() {
        let bus = EventControlBus::new(100);
        bus.subscribe("sub-alpha", "tenant-alpha", "*").unwrap();
        bus.subscribe("sub-beta", "tenant-beta", "*").unwrap();

        let ev_alpha = create_test_event("ev-a", "notice", "tenant-alpha");
        bus.publish(ev_alpha, 1000).unwrap();

        // sub-beta caller asking for sub-alpha's queue fails with tenant mismatch
        let err = bus.poll_events("sub-alpha", "tenant-beta", 10).unwrap_err();
        assert!(matches!(err, EventBusError::TenantMismatch { .. }));

        // sub-beta gets 0 events
        let beta_events = bus.poll_events("sub-beta", "tenant-beta", 10).unwrap();
        assert!(beta_events.is_empty());
    }

    #[test]
    fn test_backpressure_queue_limit_rejection() {
        let bus = EventControlBus::new(2);
        bus.subscribe("sub-tight", "tenant-alpha", "*").unwrap();

        let ev1 = create_test_event("ev-1", "tick", "tenant-alpha");
        let ev2 = create_test_event("ev-2", "tick", "tenant-alpha");
        let ev3 = create_test_event("ev-3", "tick", "tenant-alpha");

        assert!(bus.publish(ev1, 1000).is_ok());
        assert!(bus.publish(ev2, 1000).is_ok());

        let err = bus.publish(ev3, 1000).unwrap_err();
        assert_eq!(err, EventBusError::BackpressureLimitExceeded(2));
    }

    #[test]
    fn test_nack_retry_and_dead_letter_escalation() {
        let bus = EventControlBus::new(100);
        bus.subscribe("worker-1", "tenant-alpha", "task.process").unwrap();

        let ev = create_test_event("ev-fail", "task.process", "tenant-alpha");
        bus.publish(ev.clone(), 1000).unwrap();

        let polled = bus.poll_events("worker-1", "tenant-alpha", 1).unwrap();
        let ev_polled = polled[0].clone();

        // Retry 1
        let state1 = bus.nack_or_retry("worker-1", ev_polled.clone(), "network timeout", 1100).unwrap();
        assert_eq!(state1, DeliveryState::Retrying);

        // Retry 2
        let polled2 = bus.poll_events("worker-1", "tenant-alpha", 1).unwrap();
        let state2 = bus.nack_or_retry("worker-1", polled2[0].clone(), "timeout again", 1200).unwrap();
        assert_eq!(state2, DeliveryState::Retrying);

        // Retry 3 (exceeds max_retries = 2) -> DeadLettered
        let polled3 = bus.poll_events("worker-1", "tenant-alpha", 1).unwrap();
        let state3 = bus.nack_or_retry("worker-1", polled3[0].clone(), "permanent crash", 1300).unwrap();
        assert_eq!(state3, DeliveryState::DeadLettered);

        let dead_letters = bus.get_dead_letters("tenant-alpha");
        assert_eq!(dead_letters.len(), 1);
        assert_eq!(dead_letters[0].event.event_id, "ev-fail");
        assert_eq!(dead_letters[0].reason, "permanent crash");
    }

    #[test]
    fn test_large_inline_payload_rejected_for_data_handle() {
        let bus = EventControlBus::new(100);
        let mut ev = create_test_event("ev-huge", "blob.ingest", "tenant-alpha");
        let huge_string = "x".repeat(MAX_INLINE_PAYLOAD_BYTES + 10);
        ev.inline_payload = Some(serde_json::json!({ "huge": huge_string }));

        let err = bus.publish(ev, 1000).unwrap_err();
        assert!(matches!(err, EventBusError::PayloadTooLarge { .. }));
    }

    #[test]
    fn test_port_invocation_handler() {
        let bus = EventControlBus::new(100);
        let sub_payload = serde_json::json!({
            "action": "subscribe",
            "subscriber_id": "port-sub",
            "tenant_id": "tenant-corp",
            "topic_pattern": "order.*"
        });
        let sub_res = bus.handle_port_invocation(&sub_payload).unwrap();
        assert_eq!(sub_res["subscribed"], true);

        let pub_payload = serde_json::json!({
            "action": "publish",
            "now_ms": 1000,
            "event": {
                "event_id": "ord-99",
                "topic": "order.created",
                "source": "api-gateway",
                "tenant_id": "tenant-corp",
                "correlation_id": "corr-corp-1",
                "idempotency_key": "ord-key-99",
                "timestamp_ms": 1000,
                "deadline_ms": 10000,
                "max_retries": 3,
                "retry_count": 0,
                "payload_handle": null,
                "inline_payload": { "order_id": 99 },
                "state": "Pending"
            }
        });
        let pub_res = bus.handle_port_invocation(&pub_payload).unwrap();
        assert_eq!(pub_res["event_id"], "ord-99");
        assert_eq!(pub_res["queued_subscribers"], 1);
    }

    #[test]
    fn test_topic_pattern_wildcard_boundary() {
        assert!(EventControlBus::matches_pattern("workflow.started", "workflow.*"));
        assert!(EventControlBus::matches_pattern("workflow.step.one", "workflow.*"));
        assert!(!EventControlBus::matches_pattern("workflow", "workflow.*"));
        assert!(!EventControlBus::matches_pattern("workflow_deleted", "workflow.*"));
        assert!(!EventControlBus::matches_pattern("workflower", "workflow.*"));
        assert!(!EventControlBus::matches_pattern("workflow.", "workflow.*"));
        assert!(EventControlBus::matches_pattern("workflow", "*"));
        assert!(EventControlBus::matches_pattern("workflow.started", "*"));
        assert!(EventControlBus::matches_pattern("exact.match", "exact.match"));
        assert!(!EventControlBus::matches_pattern("exact.other", "exact.match"));
    }
}
