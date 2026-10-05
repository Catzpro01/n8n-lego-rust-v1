pub mod origin;
pub mod serializer;
pub mod session;
pub mod types;

pub use origin::{validate_origin_headers, OriginInfo, OriginValidationResult};
pub use serializer::{
    format_sse_frame, format_sse_handshake, format_sse_ping, is_oversized_payload,
    serialize_push_message, SerializerError,
};
pub use session::{PushSender, Session, SessionRegistry};
pub use types::{
    is_heartbeat_message, HeartbeatMessage, PushBackend, PushMessage, DEFAULT_PUSH_BACKEND,
    MAX_PAYLOAD_SIZE_BYTES, PING_INTERVAL_MS,
};

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    #[test]
    fn test_r1_constants() {
        assert_eq!(DEFAULT_PUSH_BACKEND, "websocket");
        assert_eq!(MAX_PAYLOAD_SIZE_BYTES, 5 * 1024 * 1024);
        assert_eq!(PING_INTERVAL_MS, 60_000);
    }

    #[tokio::test]
    async fn test_r3_r4_r5_session_registry() {
        let registry = SessionRegistry::new();
        let (tx1, mut rx1) = mpsc::unbounded_channel();

        registry.register("push-1".to_string(), "user-1".to_string(), tx1).await;
        assert!(registry.has_push_ref("push-1").await);
        assert_eq!(registry.connection_count().await, 1);

        let msg = PushMessage::execution_started("exec-101", "wf-202");
        assert!(registry.send_to_one("push-1", &msg).await);

        let received = rx1.recv().await.expect("message received");
        assert!(received.contains("executionStarted"));
        assert!(received.contains("exec-101"));

        // R5: Re-registering push-1 terminates previous connection
        let (tx2, _rx2) = mpsc::unbounded_channel();
        registry.register("push-1".to_string(), "user-1".to_string(), tx2).await;
        assert_eq!(registry.connection_count().await, 1);
        // Old rx1 sender was dropped
        assert!(rx1.recv().await.is_none());
    }

    #[test]
    fn test_r6_r7_sse_formatting() {
        assert_eq!(format_sse_handshake(), ":ok\n\n");
        assert_eq!(format_sse_ping(), ":ping\n\n");

        let msg = PushMessage::execution_finished("exec-1", "wf-1", "success");
        let frame = format_sse_frame(&msg).expect("sse frame");
        assert!(frame.starts_with("data: "));
        assert!(frame.ends_with("\n\n"));
    }

    #[tokio::test]
    async fn test_r9_r10_liveness_and_heartbeat() {
        let registry = SessionRegistry::new();
        let (tx, _rx) = mpsc::unbounded_channel();

        registry.register("ws-1".to_string(), "user-1".to_string(), tx).await;

        // R10: Client heartbeat frame is swallowed
        let hb_json = serde_json::json!({ "type": "heartbeat" }).to_string();
        assert!(registry.handle_client_message(&hb_json).is_none());

        // Normal message is passed through
        let custom_json = serde_json::json!({ "type": "documentVisibilityChange", "data": { "visible": true } }).to_string();
        let handled = registry.handle_client_message(&custom_json);
        assert!(handled.is_some());

        // R9: Ping sweep marks connection dead unless pong is received
        let evicted = registry.ping_sweep().await;
        assert!(evicted.is_empty(), "First sweep just marks alive=false");

        // Client sends pong
        registry.on_pong("ws-1").await;
        let evicted2 = registry.ping_sweep().await;
        assert!(evicted2.is_empty(), "Pong revived connection");

        // Now without pong: second sweep evicts stale connection
        let evicted3 = registry.ping_sweep().await;
        assert_eq!(evicted3, vec!["ws-1"]);
        assert!(!registry.has_push_ref("ws-1").await);
    }

    #[test]
    fn test_r11_origin_validation_matrix() {
        // Valid origin matching host
        let res = validate_origin_headers(
            Some("https://n8n.example.com"),
            Some("n8n.example.com"),
            None,
            None,
            None,
        );
        assert!(res.is_valid);
        assert_eq!(res.raw_expected_host.as_deref(), Some("n8n.example.com"));

        // Default port stripped
        let res_port = validate_origin_headers(
            Some("https://n8n.example.com:443"),
            Some("n8n.example.com:443"),
            None,
            None,
            None,
        );
        assert!(res_port.is_valid);

        // Mismatched port
        let res_diff = validate_origin_headers(
            Some("http://localhost:5678"),
            Some("localhost:5679"),
            None,
            None,
            None,
        );
        assert!(!res_diff.is_valid);

        // X-Forwarded-Host precedence over Host
        let res_xf = validate_origin_headers(
            Some("https://public.example.com"),
            Some("internal:5678"),
            Some("public.example.com"),
            Some("https"),
            None,
        );
        assert!(res_xf.is_valid);

        // Forwarded header precedence over X-Forwarded-Host
        let res_fwd = validate_origin_headers(
            Some("https://rfc.example.com"),
            Some("internal"),
            Some("other.example.com"),
            None,
            Some("for=192.0.2.60;proto=https;host=\"rfc.example.com\""),
        );
        assert!(res_fwd.is_valid);
        assert_eq!(res_fwd.raw_expected_host.as_deref(), Some("rfc.example.com"));

        // Malformed origin
        let res_mal = validate_origin_headers(Some("not-a-url"), Some("n8n.example.com"), None, None, None);
        assert!(!res_mal.is_valid);
        assert_eq!(res_mal.error.as_deref(), Some("Origin header is missing or malformed"));
    }

    #[test]
    fn test_r13_payload_ceiling() {
        let normal_msg = PushMessage::node_execute_before("exec-1", "HTTP Request");
        assert!(serialize_push_message(&normal_msg).is_ok());

        let oversized_data = serde_json::json!({
            "blob": "x".repeat(MAX_PAYLOAD_SIZE_BYTES + 100)
        });
        let oversized_msg = PushMessage::node_execute_after_data(oversized_data);
        let err = serialize_push_message(&oversized_msg);
        assert!(err.is_err());
        match err.unwrap_err() {
            SerializerError::PayloadTooLarge(size, max) => {
                assert!(size > max);
            }
            _ => panic!("Expected PayloadTooLarge error"),
        }
    }
}
