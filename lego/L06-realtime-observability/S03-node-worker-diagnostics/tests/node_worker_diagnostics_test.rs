//! Unit tests for L06.S03 Node/plugin/worker diagnostics

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_capture_and_query_diagnostics() {
        let service = DiagnosticsRingBufferService::new();
        let id = service.capture(
            "worker-1",
            DiagnosticLevel::Info,
            "lifecycle",
            "Worker spawned successfully",
            serde_json::json!({ "pid": 1234 }),
            1000,
        );

        assert_eq!(id, 1);
        assert_eq!(service.count(), 1);

        let results = service.query(Some("worker-1"), None, 10);
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].message, "Worker spawned successfully");
        assert_eq!(results[0].level, DiagnosticLevel::Info);
    }

    #[test]
    fn test_ring_buffer_overwrites_oldest_when_full() {
        let service = DiagnosticsRingBufferService::with_capacity(3);

        service.capture("w1", DiagnosticLevel::Debug, "cat", "msg1", serde_json::json!({}), 100);
        service.capture("w1", DiagnosticLevel::Debug, "cat", "msg2", serde_json::json!({}), 200);
        service.capture("w1", DiagnosticLevel::Debug, "cat", "msg3", serde_json::json!({}), 300);

        assert_eq!(service.count(), 3);

        // Fourth event evicts msg1
        service.capture("w1", DiagnosticLevel::Debug, "cat", "msg4", serde_json::json!({}), 400);
        assert_eq!(service.count(), 3);

        let results = service.query(None, None, 10);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].message, "msg4");
        assert_eq!(results[1].message, "msg3");
        assert_eq!(results[2].message, "msg2");
    }

    #[test]
    fn test_filter_by_level() {
        let service = DiagnosticsRingBufferService::new();

        service.capture("node-http", DiagnosticLevel::Debug, "net", "dbg", serde_json::json!({}), 10);
        service.capture("node-http", DiagnosticLevel::Warn, "net", "slow response", serde_json::json!({}), 20);
        service.capture("node-http", DiagnosticLevel::Error, "net", "timeout", serde_json::json!({}), 30);

        let warn_and_up = service.query(Some("node-http"), Some(DiagnosticLevel::Warn), 10);
        assert_eq!(warn_and_up.len(), 2);
        assert_eq!(warn_and_up[0].level, DiagnosticLevel::Error);
        assert_eq!(warn_and_up[1].level, DiagnosticLevel::Warn);
    }

    #[test]
    fn test_port_handler_diagnostics_capture() {
        let service = DiagnosticsRingBufferService::new();

        let req = serde_json::json!({
            "action": "capture",
            "source": "worker-pool-mgr",
            "level": "warn",
            "category": "capacity",
            "message": "high memory usage alert",
            "details": { "mem_mb": 1900 },
            "now_ms": 12000
        });

        let resp = service.handle_port_diagnostics_capture(&req).unwrap();
        assert_eq!(resp["success"], true);
        assert_eq!(resp["buffer_count"], 1);
    }
}
