//! Unit tests for L06.S02 Execution telemetry service

#[cfg(test)]
mod tests {
    use crate::*;
    use std::collections::HashMap;

    #[test]
    fn test_record_metric_and_query_roundtrip() {
        let service = ExecutionTelemetryService::new(100);
        let mut labels = HashMap::new();
        labels.insert("node".into(), "HTTPRequest".into());

        let res = service
            .record_metric(
                "tenant-1",
                "exec-101",
                "node_duration_ms",
                MetricType::Histogram,
                125.5,
                labels.clone(),
            )
            .expect("should record metric");

        assert_eq!(res.buffer_len, 1);
        assert_eq!(res.total_recorded, 1);
        assert!(res.metric_id.starts_with("tel_tenant-1_"));

        // Record another metric for same execution
        service
            .record_metric(
                "tenant-1",
                "exec-101",
                "node_item_count",
                MetricType::Counter,
                42.0,
                HashMap::new(),
            )
            .expect("should record metric");

        // Query all for tenant
        let all = service
            .query_metrics("tenant-1", None, None, 10)
            .expect("should query metrics");
        assert_eq!(all.len(), 2);

        // Filter by metric_name
        let filtered = service
            .query_metrics("tenant-1", None, Some("node_duration_ms"), 10)
            .expect("should filter metrics");
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].value, 125.5);
        assert_eq!(filtered[0].labels.get("node").unwrap(), "HTTPRequest");
    }

    #[test]
    fn test_bounded_ring_buffer_eviction() {
        let mut ring = TelemetryRingBuffer::new(3);
        assert!(ring.is_empty());

        for i in 1..=5 {
            ring.record(MetricRecord {
                metric_id: format!("m_{i}"),
                tenant_id: "tenant-a".into(),
                execution_id: "exec-1".into(),
                metric_name: "test_metric".into(),
                metric_type: MetricType::Counter,
                value: i as f64,
                labels: HashMap::new(),
                timestamp_ms: 1000 + i as u64,
            });
        }

        assert_eq!(ring.len(), 3);
        assert_eq!(ring.total_recorded(), 5);

        // Oldest items (1 and 2) should have been evicted; remaining should be 3, 4, 5
        let items = ring.items();
        assert_eq!(items[0].value, 3.0);
        assert_eq!(items[1].value, 4.0);
        assert_eq!(items[2].value, 5.0);
    }

    #[test]
    fn test_statistical_summarize() {
        let service = ExecutionTelemetryService::new(50);
        let values = [10.0, 20.0, 30.0, 40.0];

        for val in values {
            service
                .record_metric(
                    "tenant-stats",
                    "exec-200",
                    "latency",
                    MetricType::Histogram,
                    val,
                    HashMap::new(),
                )
                .unwrap();
        }

        let summary = service
            .summarize("tenant-stats", "latency")
            .expect("summary query ok")
            .expect("summary exists");

        assert_eq!(summary.metric_name, "latency");
        assert_eq!(summary.count, 4);
        assert_eq!(summary.sum, 100.0);
        assert_eq!(summary.min, 10.0);
        assert_eq!(summary.max, 40.0);
        assert_eq!(summary.avg, 25.0);

        // Non-existent metric returns None
        let none_summary = service
            .summarize("tenant-stats", "unknown_metric")
            .expect("query ok");
        assert!(none_summary.is_none());
    }

    #[test]
    fn test_tenant_isolation_boundary() {
        let service = ExecutionTelemetryService::new(50);

        service
            .record_metric(
                "tenant-alpha",
                "exec-alpha-1",
                "cpu_usage",
                MetricType::Gauge,
                75.0,
                HashMap::new(),
            )
            .unwrap();

        // Query for tenant-beta must return empty vec
        let beta_metrics = service
            .query_metrics("tenant-beta", None, None, 10)
            .expect("query beta ok");
        assert!(beta_metrics.is_empty());

        let beta_summary = service
            .summarize("tenant-beta", "cpu_usage")
            .expect("summarize beta ok");
        assert!(beta_summary.is_none());
    }

    #[test]
    fn test_validation_rejections() {
        let service = ExecutionTelemetryService::new(50);

        // Empty tenant
        let err = service
            .record_metric("", "exec-1", "test", MetricType::Counter, 1.0, HashMap::new())
            .unwrap_err();
        assert!(matches!(err, TelemetryError::InvalidRequest(_)));

        // Empty execution_id
        let err = service
            .record_metric("tenant-1", "", "test", MetricType::Counter, 1.0, HashMap::new())
            .unwrap_err();
        assert!(matches!(err, TelemetryError::InvalidRequest(_)));

        // Empty metric_name
        let err = service
            .record_metric("tenant-1", "exec-1", "  ", MetricType::Counter, 1.0, HashMap::new())
            .unwrap_err();
        assert!(matches!(err, TelemetryError::InvalidRequest(_)));
    }

    #[test]
    fn test_port_record_dispatcher() {
        let service = ExecutionTelemetryService::new(50);

        let payload = serde_json::json!({
            "tenant_id": "tenant-dispatch",
            "execution_id": "exec-disp-1",
            "metric_name": "execution_time_ms",
            "metric_type": "histogram",
            "value": 350.5,
            "labels": { "mode": "manual", "status": "success" }
        });

        let resp = service
            .handle_port_record(&payload)
            .expect("port record handler must succeed");

        assert_eq!(resp.get("success").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(resp.get("total_recorded").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(resp.get("buffer_len").and_then(|v| v.as_u64()), Some(1));

        // Summary should be populated
        let summary = resp.get("summary").unwrap();
        assert_eq!(summary.get("count").and_then(|v| v.as_u64()), Some(1));
        assert_eq!(summary.get("avg").and_then(|v| v.as_f64()), Some(350.5));

        // Reject unknown metric_type
        let bad_payload = serde_json::json!({
            "tenant_id": "tenant-dispatch",
            "execution_id": "exec-disp-1",
            "metric_name": "unknown_metric",
            "metric_type": "invalid_type",
            "value": 1.0
        });
        let err = service.handle_port_record(&bad_payload).unwrap_err();
        assert!(matches!(err, TelemetryError::InvalidRequest(_)));
    }
}
