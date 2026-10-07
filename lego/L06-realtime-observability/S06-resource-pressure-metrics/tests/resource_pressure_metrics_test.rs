//! Unit tests for L06.S06 Resource pressure and queue metrics

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_baseline_metrics_sample() {
        let sampler = PressureTelemetrySampler::new();
        let report = sampler.current_report().unwrap();

        assert_eq!(report.current_level, PressureLevel::Normal);
        assert!(!report.throttling_recommended);
        assert_eq!(report.sample_count, 1);
        assert_eq!(report.queue_depth, 2);
    }

    #[test]
    fn test_warning_threshold_transition() {
        let sampler = PressureTelemetrySampler::new();
        // Moderate pressure: 72% CPU, 60% memory, 55 queued jobs
        sampler.record_sample(2000, 72.0, 60.0, 55, 10, 85);
        let report = sampler.current_report().unwrap();

        assert_eq!(report.current_level, PressureLevel::Warning);
        assert!(report.throttling_recommended);
        assert_eq!(report.sample_count, 2);
    }

    #[test]
    fn test_critical_threshold_transition() {
        let sampler = PressureTelemetrySampler::new();
        // Extreme pressure: 95% CPU, 92% memory, 200 queue depth
        sampler.record_sample(3000, 95.0, 92.0, 200, 25, 450);
        let report = sampler.current_report().unwrap();

        assert_eq!(report.current_level, PressureLevel::Critical);
        assert!(report.throttling_recommended);
        assert!(report.pressure_score >= 0.8);
    }

    #[test]
    fn test_history_bounding_and_eviction() {
        let sampler = PressureTelemetrySampler::with_capacity(3);
        sampler.record_sample(10, 10.0, 10.0, 1, 1, 5);
        sampler.record_sample(20, 20.0, 20.0, 2, 2, 10);
        sampler.record_sample(30, 30.0, 30.0, 3, 3, 15);
        sampler.record_sample(40, 40.0, 40.0, 4, 4, 20);

        let report = sampler.current_report().unwrap();
        assert_eq!(report.sample_count, 3);
        assert_eq!(report.queue_depth, 4);
    }

    #[test]
    fn test_port_metrics_pressure_handler() {
        let sampler = PressureTelemetrySampler::new();
        let poll_req = serde_json::json!({
            "action": "poll_pressure"
        });
        let resp = sampler.handle_port_metrics_pressure(&poll_req).unwrap();
        assert_eq!(resp["success"], true);
        assert_eq!(resp["level"], "Normal");
        assert_eq!(resp["throttling_recommended"], false);

        let record_req = serde_json::json!({
            "action": "record_sample",
            "timestamp_ms": 5000,
            "cpu_pct": 98.0,
            "mem_pct": 95.0,
            "queue_depth": 300,
            "active_jobs": 40,
            "latency_ms": 600
        });
        let rec_resp = sampler.handle_port_metrics_pressure(&record_req).unwrap();
        assert_eq!(rec_resp["success"], true);

        let post_report = sampler.current_report().unwrap();
        assert_eq!(post_report.current_level, PressureLevel::Critical);
        assert!(post_report.throttling_recommended);
    }

    #[test]
    fn test_invalid_action_returns_error() {
        let sampler = PressureTelemetrySampler::new();
        let bad_req = serde_json::json!({ "action": "unknown_action_xyz" });
        let res = sampler.handle_port_metrics_pressure(&bad_req);
        assert!(res.is_err());
    }
}
