//! Unit tests for L06.S05 Replay and causal diagnostics

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_trace_graph_retrieval() {
        let service = CausalDiagnosticsService::new();
        let trace = service.get_trace("trace-golden-1").unwrap();

        assert_eq!(trace.trace_id, "trace-golden-1");
        assert_eq!(trace.spans.len(), 2);
        assert_eq!(trace.spans[0].node_name, "Webhook");
        assert_eq!(trace.spans[1].node_name, "HTTP Request");
        assert_eq!(trace.spans[1].status, "Error");
    }

    #[test]
    fn test_causal_root_cause_path_tracing() {
        let service = CausalDiagnosticsService::new();
        let path = service.trace_root_cause_path("trace-golden-1", "span-node-1").unwrap();

        assert_eq!(path.len(), 2);
        // First in path is root, second is node-1
        assert_eq!(path[0].span_id, "span-root");
        assert_eq!(path[1].span_id, "span-node-1");
        assert_eq!(path[1].error_detail.as_deref(), Some("503 Service Unavailable"));
    }

    #[test]
    fn test_nonexistent_trace_returns_error() {
        let service = CausalDiagnosticsService::new();
        let err = service.trace_root_cause_path("unknown-trace", "span-any");

        assert!(matches!(err, Err(CausalError::TraceNotFound(_))));
    }

    #[test]
    fn test_port_handler_replay_trace() {
        let service = CausalDiagnosticsService::new();

        let req = serde_json::json!({
            "action": "get_trace",
            "trace_id": "trace-golden-1"
        });

        let resp = service.handle_port_replay_trace(&req).unwrap();
        assert_eq!(resp["success"], true);
        assert_eq!(resp["trace_id"], "trace-golden-1");
        assert_eq!(resp["spans_count"], 2);
    }
}
