//! Unit tests for L09.S03 Realtime/browser compatibility

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_client_connect_and_disconnect() {
        let service = BrowserRealtimeService::new(100);
        let sess = service
            .register_client("client-1", "sess-1", Some("user-1"), 1000)
            .unwrap();

        assert_eq!(sess.client_id, "client-1");
        assert_eq!(service.get_client_count(), 1);

        let removed = service.unregister_client("client-1").unwrap();
        assert!(removed);
        assert_eq!(service.get_client_count(), 0);
    }

    #[test]
    fn test_subscribe_and_broadcast() {
        let service = BrowserRealtimeService::new(100);
        service.register_client("c1", "s1", None, 1000).unwrap();
        service.register_client("c2", "s2", None, 1000).unwrap();

        service.subscribe("c1", "execution:exec-101").unwrap();
        service.subscribe("c2", "execution:exec-101").unwrap();

        let count = service.broadcast("execution:exec-101", "node_start", json!({"node": "Node1"}), 1050);
        assert_eq!(count, 2);

        // Topic with no subscribers
        let count_empty = service.broadcast("execution:exec-999", "node_start", json!({}), 1050);
        assert_eq!(count_empty, 0);
    }

    #[test]
    fn test_unsubscribe_removes_client() {
        let service = BrowserRealtimeService::new(100);
        service.register_client("c1", "s1", None, 1000).unwrap();
        service.subscribe("c1", "topicA").unwrap();

        let before = service.broadcast("topicA", "ping", json!({}), 1000);
        assert_eq!(before, 1);

        service.unsubscribe("c1", "topicA").unwrap();
        let after = service.broadcast("topicA", "ping", json!({}), 1000);
        assert_eq!(after, 0);
    }

    #[test]
    fn test_heartbeat_updates_last_ping() {
        let service = BrowserRealtimeService::new(100);
        service.register_client("c1", "s1", None, 1000).unwrap();
        service.heartbeat("c1", 5000).unwrap();

        let lock = service.clients.read().unwrap();
        let client = lock.get("c1").unwrap();
        assert_eq!(client.last_ping_ms, 5000);
    }

    #[test]
    fn test_capacity_exceeded_error() {
        let service = BrowserRealtimeService::new(1);
        service.register_client("c1", "s1", None, 1000).unwrap();
        let err = service.register_client("c2", "s2", None, 1000);
        assert!(matches!(err, Err(RealtimeError::CapacityExceeded(_))));
    }

    #[test]
    fn test_port_stream_handler_flow() {
        let service = BrowserRealtimeService::new(100);

        // 1. Connect
        let conn_res = service
            .handle_port_stream(&json!({
                "action": "connect",
                "client_id": "c_port",
                "session_id": "s_port"
            }))
            .unwrap();
        assert_eq!(conn_res["success"], true);

        // 2. Subscribe
        let sub_res = service
            .handle_port_stream(&json!({
                "action": "subscribe",
                "client_id": "c_port",
                "topic": "workflow_live"
            }))
            .unwrap();
        assert_eq!(sub_res["success"], true);

        // 3. Broadcast
        let bcast_res = service
            .handle_port_stream(&json!({
                "action": "broadcast",
                "topic": "workflow_live",
                "event": "update",
                "data": {"status": "running"}
            }))
            .unwrap();
        assert_eq!(bcast_res["success"], true);
        assert_eq!(bcast_res["delivered_clients"], 1);

        // 4. Stats
        let stats_res = service
            .handle_port_stream(&json!({
                "action": "stats"
            }))
            .unwrap();
        assert_eq!(stats_res["success"], true);
        assert_eq!(stats_res["total_clients"], 1);

        // 5. Disconnect
        let disc_res = service
            .handle_port_stream(&json!({
                "action": "disconnect",
                "client_id": "c_port"
            }))
            .unwrap();
        assert_eq!(disc_res["success"], true);
        assert_eq!(service.get_client_count(), 0);
    }

    #[test]
    fn test_client_reconnect_cleans_old_subscriptions() {
        let service = BrowserRealtimeService::new(100);
        service.register_client("reconnect-c1", "s1", None, 1000).unwrap();
        service.subscribe("reconnect-c1", "wf:1").unwrap();

        // Broadcast reaches 1 subscriber
        assert_eq!(service.broadcast("wf:1", "e", json!({}), 1000), 1);

        // Reconnect client with same client_id (fresh session)
        service.register_client("reconnect-c1", "s2", None, 1050).unwrap();

        // Now client unregisters without subscribing again
        service.unregister_client("reconnect-c1").unwrap();

        // Broadcast must NOT deliver to orphaned subscription
        assert_eq!(service.broadcast("wf:1", "e", json!({}), 1050), 0);
    }

    #[test]
    fn test_evict_stale_clients_heartbeat_timeout() {
        let service = BrowserRealtimeService::new(100);
        service.register_client("stale-c1", "s1", None, 1000).unwrap();
        service.register_client("active-c2", "s2", None, 1000).unwrap();
        service.subscribe("stale-c1", "ch:1").unwrap();
        service.subscribe("active-c2", "ch:1").unwrap();

        // Active client sends heartbeat at t=50000
        service.heartbeat("active-c2", 50000).unwrap();

        // Evict with 30s timeout at t=55000 (stale-c1 last ping was t=1000, 54s ago > 30s)
        let evicted = service.evict_stale_clients(30000, 55000);
        assert_eq!(evicted, 1);
        assert_eq!(service.get_client_count(), 1);

        // Only active client remains subscribed
        assert_eq!(service.broadcast("ch:1", "msg", json!({}), 55000), 1);
    }
}
