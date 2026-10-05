pub mod bus;
pub mod ledger;
pub mod redaction;
pub mod types;

pub use bus::*;
pub use ledger::*;
pub use redaction::*;
pub use types::*;

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn test_broadcast_single_subscriber() {
        let bus = EventBus::new(16);
        let mut sub = bus.subscribe();

        let event = EventEnvelope::workflow_started(
            "wf-123",
            json!({
                "mode": "manual",
                "active": true
            }),
        );

        let receiver_count = bus.publish(event.clone()).expect("publish failed");
        assert_eq!(receiver_count, 1);

        let received = sub.recv().await.expect("recv failed");
        assert_eq!(received.id, event.id);
        assert_eq!(received.event_type, EventType::WorkflowStarted);
        assert_eq!(received.payload["workflowId"], "wf-123");
        assert_eq!(received.payload["mode"], "manual");
    }

    #[tokio::test]
    async fn test_multi_subscribers() {
        let bus = EventBus::new(32);
        let mut sub1 = bus.subscribe();
        let mut sub2 = bus.subscribe();
        let mut sub3 = bus.subscribe();

        assert_eq!(bus.receiver_count(), 3);

        let event1 = EventEnvelope::new(EventType::NodeExecuted, json!({"node": "Http"}));
        let event2 = EventEnvelope::new(EventType::UserLogin, json!({"user": "alice"}));

        bus.publish(event1.clone()).unwrap();
        bus.publish(event2.clone()).unwrap();

        for sub in [&mut sub1, &mut sub2, &mut sub3] {
            let msg1 = sub.recv().await.unwrap();
            assert_eq!(msg1.event_type, EventType::NodeExecuted);
            let msg2 = sub.recv().await.unwrap();
            assert_eq!(msg2.event_type, EventType::UserLogin);
        }
    }

    #[tokio::test]
    async fn test_filtered_subscriber() {
        let bus = EventBus::new(32);
        let mut sub_wf = bus.subscribe_type(EventType::WorkflowStarted);
        let mut sub_exec = bus.subscribe_type(EventType::ExecutionFailed);

        bus.publish(EventEnvelope::new(EventType::NodeExecuted, json!({"node": "A"})))
            .unwrap();
        bus.publish(EventEnvelope::new(
            EventType::WorkflowStarted,
            json!({"workflowId": "w1"}),
        ))
        .unwrap();
        bus.publish(EventEnvelope::execution_failed("e-99", "Fatal error"))
            .unwrap();

        let wf_msg = sub_wf.recv().await.unwrap();
        assert_eq!(wf_msg.event_type, EventType::WorkflowStarted);
        assert_eq!(wf_msg.payload["workflowId"], "w1");

        let exec_msg = sub_exec.recv().await.unwrap();
        assert_eq!(exec_msg.event_type, EventType::ExecutionFailed);
        assert_eq!(exec_msg.payload["executionId"], "e-99");
    }

    #[tokio::test]
    async fn test_category_and_prefix_filters() {
        let bus = EventBus::new(32);
        let mut sub_category = bus.subscribe_category(EventCategory::Workflow);
        let mut sub_prefix = bus.subscribe_prefix("webhook.");

        bus.publish(EventEnvelope::workflow_started("wf-1", json!({}))).unwrap();
        bus.publish(EventEnvelope::webhook_received("wh-99", json!({}))).unwrap();

        let cat_msg = sub_category.recv().await.unwrap();
        assert_eq!(cat_msg.event_type, EventType::WorkflowStarted);

        let prefix_msg = sub_prefix.recv().await.unwrap();
        assert_eq!(prefix_msg.event_type, EventType::WebhookReceived);
    }

    #[tokio::test]
    async fn test_custom_predicate_filter() {
        let bus = EventBus::new(32);
        let mut high_priority_sub = bus.subscribe_predicate(|e| {
            e.payload
                .get("priority")
                .and_then(|v| v.as_str())
                == Some("high")
        });

        bus.publish(EventEnvelope::new(
            EventType::SystemAudit,
            json!({"priority": "low"}),
        ))
        .unwrap();
        bus.publish(EventEnvelope::new(
            EventType::SystemAudit,
            json!({"priority": "high", "alert": "cpu_spike"}),
        ))
        .unwrap();

        let msg = high_priority_sub.recv().await.unwrap();
        assert_eq!(msg.payload["alert"], "cpu_spike");
    }

    #[test]
    fn test_pii_masking_deep_json() {
        let redactor = Redactor::new();

        let mut payload = json!({
            "username": "superadmin",
            "password": "VerySecretPassword123!",
            "credentials": {
                "apiKey": "12345-abcde",
                "secret": "top-secret-value",
                "oauth": {
                    "access_token": "token-xyz",
                    "refresh_token": "refresh-123",
                    "client_secret": "client-abc"
                }
            },
            "headers": {
                "authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.t-IDcSemACt8x4iTMCda8Yhe3iZaWbvV5XKSTbuAn0M",
                "user-agent": "n8n/0.1"
            },
            "safe_items": ["item1", "item2"]
        });

        redactor.redact_value(&mut payload);

        assert_eq!(payload["username"], "superadmin");
        assert_eq!(payload["password"], "[REDACTED]");
        assert_eq!(payload["credentials"]["apiKey"], "[REDACTED]");
        assert_eq!(payload["credentials"]["secret"], "[REDACTED]");
        assert_eq!(payload["credentials"]["oauth"]["access_token"], "[REDACTED]");
        assert_eq!(payload["credentials"]["oauth"]["refresh_token"], "[REDACTED]");
        assert_eq!(payload["credentials"]["oauth"]["client_secret"], "[REDACTED]");
        assert_eq!(payload["headers"]["authorization"], "[REDACTED]");
        assert_eq!(payload["headers"]["user-agent"], "n8n/0.1");
        assert_eq!(payload["safe_items"][0], "item1");
    }

    #[test]
    fn test_pii_masking_patterns() {
        let redactor = Redactor::new();

        // 1. Bearer token in freeform string
        let bearer_text = "Sending request with Bearer secret-auth-token-456 towards host";
        let masked_bearer = redactor.redact_string(bearer_text);
        assert_eq!(
            masked_bearer,
            "Sending request with Bearer [REDACTED] towards host"
        );

        // 2. Private Key block
        let key_text = "cert: -----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY----- valid";
        let masked_key = redactor.redact_string(key_text);
        assert!(masked_key.contains("[REDACTED_PRIVATE_KEY]"));
        assert!(!masked_key.contains("MIIEowIBAAKCAQEA"));

        // 3. API key prefixes (ghp_ and sk-)
        let ghp_text = "token ghp_1234567890abcdefghijklmnopqrstuv";
        let masked_ghp = redactor.redact_string(ghp_text);
        assert!(masked_ghp.contains("ghp_[REDACTED]"));

        let sk_text = "openai key sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
        let masked_sk = redactor.redact_string(sk_text);
        assert!(masked_sk.contains("sk-[REDACTED]"));

        // 4. Basic Auth URL
        let url_text = "Connect to http://admin:super_secret_pw@db.internal:5432/db";
        let masked_url = redactor.redact_string(url_text);
        assert_eq!(
            masked_url,
            "Connect to http://admin:[REDACTED]@db.internal:5432/db"
        );
    }

    #[test]
    fn test_bounded_buffer_eviction() {
        let ledger = AuditLedger::new(3);
        assert_eq!(ledger.capacity(), 3);
        assert_eq!(ledger.len(), 0);

        for i in 1..=5 {
            let event = EventEnvelope::system_audit(
                format!("action-{}", i),
                json!({"index": i}),
            );
            ledger.record(event);
        }

        // Capacity was 3, recorded 5 events
        assert_eq!(ledger.len(), 3);
        assert_eq!(ledger.total_recorded(), 5);
        assert_eq!(ledger.evicted_count(), 2);

        let recent = ledger.query_recent(10);
        assert_eq!(recent.len(), 3);
        // Newest first: action-5, action-4, action-3
        assert_eq!(recent[0].payload["action"], "action-5");
        assert_eq!(recent[1].payload["action"], "action-4");
        assert_eq!(recent[2].payload["action"], "action-3");

        // Oldest (action-1, action-2) were evicted
        let actions: Vec<&str> = recent
            .iter()
            .map(|e| e.payload["action"].as_str().unwrap())
            .collect();
        assert!(!actions.contains(&"action-1"));
        assert!(!actions.contains(&"action-2"));
    }

    #[test]
    fn test_audit_ledger_queries() {
        let ledger = AuditLedger::new(10);

        ledger.record(EventEnvelope::user_login("user-1", json!({"ip": "1.1.1.1"})));
        ledger.record(EventEnvelope::workflow_started("wf-1", json!({})));
        ledger.record(EventEnvelope::user_login("user-2", json!({"ip": "2.2.2.2"})));
        ledger.record(EventEnvelope::execution_failed("e-1", "crash"));
        ledger.record(EventEnvelope::system_audit("backup", json!({})));

        let user_logins = ledger.query_by_type(&EventType::UserLogin, 10);
        assert_eq!(user_logins.len(), 2);
        assert_eq!(user_logins[0].payload["userId"], "user-2");
        assert_eq!(user_logins[1].payload["userId"], "user-1");

        let audit_records = ledger.query_by_category(EventCategory::Audit, 10);
        assert_eq!(audit_records.len(), 1);
        assert_eq!(audit_records[0].payload["action"], "backup");

        // Filter predicate
        let ip_query = ledger.query_by_predicate(
            |e| e.payload.get("ip").and_then(|v| v.as_str()) == Some("2.2.2.2"),
            10,
        );
        assert_eq!(ip_query.len(), 1);
        assert_eq!(ip_query[0].payload["userId"], "user-2");
    }

    #[tokio::test]
    async fn test_unbuffered_lagged_consumer() {
        // Channel with capacity of 2
        let bus = EventBus::new(2);
        let mut sub = bus.subscribe();

        // Publish 5 events without subscriber consuming
        for i in 1..=5 {
            bus.publish(EventEnvelope::new(
                EventType::NodeExecuted,
                json!({"seq": i}),
            ))
            .unwrap();
        }

        // Subscriber should encounter Lagged error
        match sub.recv().await {
            Err(EventBusRecvError::Lagged(skipped)) => {
                assert!(skipped >= 2);
            }
            other => panic!("Expected Lagged error, got {:?}", other),
        }

        // recv_lossy recovers and fetches remaining available messages
        let next_msg = sub.recv_lossy().await.unwrap();
        assert_eq!(next_msg.event_type, EventType::NodeExecuted);
    }

    #[tokio::test]
    async fn test_publish_with_redaction() {
        let bus = EventBus::new(16);
        let redactor = Redactor::new();
        let mut sub = bus.subscribe();

        let event = EventEnvelope::new(
            EventType::UserLogin,
            json!({
                "username": "bob",
                "password": "secretPassword!",
                "api_key": "key-999"
            }),
        );

        bus.publish_with_redaction(event, &redactor).unwrap();

        let received = sub.recv().await.unwrap();
        assert_eq!(received.payload["username"], "bob");
        assert_eq!(received.payload["password"], "[REDACTED]");
        assert_eq!(received.payload["api_key"], "[REDACTED]");
    }

    #[tokio::test]
    async fn test_bus_with_audit_ledger() {
        let ledger = AuditLedger::new(50);
        let bus = EventBus::new(16).with_ledger(ledger.clone());

        // Publish regular event vs audit event
        bus.publish(EventEnvelope::workflow_started("wf-1", json!({}))).unwrap();
        bus.publish(EventEnvelope::user_login("u-admin", json!({}))).unwrap();
        bus.publish(EventEnvelope::system_audit("rotate_keys", json!({}))).unwrap();

        // Only audit events should be recorded in ledger (user.login and system.audit)
        assert_eq!(ledger.len(), 2);
        let recent = ledger.query_recent(10);
        assert_eq!(recent[0].event_type, EventType::SystemAudit);
        assert_eq!(recent[1].event_type, EventType::UserLogin);
    }

    #[test]
    fn test_event_contract_format() {
        let event = EventEnvelope::workflow_started("wf-007", json!({"status": "running"}));
        let contract_json = event.to_contract_format();

        assert_eq!(contract_json["__type"], "workflow");
        assert_eq!(contract_json["eventName"], "workflow.started");
        assert_eq!(contract_json["payload"]["__type"], "workflow.started");
        assert_eq!(contract_json["payload"]["workflowId"], "wf-007");
        assert_eq!(contract_json["id"], event.id);
        assert!(contract_json.get("ts").is_some());
    }

    #[test]
    fn test_event_type_serde_roundtrip() {
        let types = [
            EventType::WorkflowStarted,
            EventType::NodeExecuted,
            EventType::UserLogin,
            EventType::ExecutionFailed,
            EventType::WebhookReceived,
            EventType::SystemAudit,
            EventType::Custom("custom.trigger".to_string()),
        ];

        for t in types {
            let serialized = serde_json::to_string(&t).unwrap();
            let deserialized: EventType = serde_json::from_str(&serialized).unwrap();
            assert_eq!(t, deserialized);
        }
    }
}
