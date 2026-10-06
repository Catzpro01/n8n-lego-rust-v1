#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_realtime_event_publishing_and_tenant_isolation() {
        let hub = RealtimeEventHub::new();

        // Register 2 sockets for tenant_alpha, 1 for tenant_beta
        hub.subscribe("sock_1", "tenant_alpha", "execution_updates").unwrap();
        hub.subscribe("sock_2", "tenant_alpha", "execution_updates").unwrap();
        hub.subscribe("sock_3", "tenant_beta", "execution_updates").unwrap();

        assert_eq!(hub.subscriber_count("tenant_alpha", "execution_updates"), 2);
        assert_eq!(hub.subscriber_count("tenant_beta", "execution_updates"), 1);

        // Publish to tenant_alpha -> delivers to exactly 2
        let event_alpha = RealtimeEvent {
            tenant_id: "tenant_alpha".to_string(),
            channel: "execution_updates".to_string(),
            event_name: "node.finished".to_string(),
            payload: serde_json::json!({"status": "SUCCESS"}),
        };
        let delivered = hub.publish(&event_alpha).expect("Publish should succeed");
        assert_eq!(delivered, 2);

        // Unsubscribe sock_1
        hub.unsubscribe("sock_1");
        assert_eq!(hub.subscriber_count("tenant_alpha", "execution_updates"), 1);
    }
}
