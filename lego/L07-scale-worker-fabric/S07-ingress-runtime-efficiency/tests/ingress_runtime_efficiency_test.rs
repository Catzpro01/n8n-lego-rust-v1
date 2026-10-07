//! Unit tests for L07.S07 Ingress/runtime efficiency

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_buffer_pool_acquire_and_release() {
        let service = RuntimeEfficiencyService::new();
        let initial_available = service.get_tuning_state().buffer_pool_available;
        assert_eq!(initial_available, 16);

        let buf = service.acquire_buffer();
        assert_eq!(buf.len(), 64 * 1024);
        assert_eq!(service.get_tuning_state().buffer_pool_available, 15);

        service.release_buffer(buf);
        assert_eq!(service.get_tuning_state().buffer_pool_available, 16);
    }

    #[test]
    fn test_backpressure_scaling_down_on_high_latency() {
        let service = RuntimeEfficiencyService::new();
        let initial_concurrency = service.get_tuning_state().current_concurrency;
        assert_eq!(initial_concurrency, 64);

        // Inject high latency spikes (target is 50ms)
        for _ in 0..5 {
            service.tune_backpressure(200);
        }

        let new_concurrency = service.get_tuning_state().current_concurrency;
        assert!(new_concurrency < initial_concurrency);
    }

    #[test]
    fn test_backpressure_scaling_up_on_low_latency() {
        let service = RuntimeEfficiencyService::new();
        let initial_concurrency = service.get_tuning_state().current_concurrency;
        assert_eq!(initial_concurrency, 64);

        // Inject ultra-low latency (10ms)
        for _ in 0..5 {
            service.tune_backpressure(10);
        }

        let new_concurrency = service.get_tuning_state().current_concurrency;
        assert!(new_concurrency > initial_concurrency);
    }

    #[test]
    fn test_port_runtime_tune_handler() {
        let service = RuntimeEfficiencyService::new();
        let get_req = serde_json::json!({
            "action": "get_state"
        });
        let res = service.handle_port_runtime_tune(&get_req).unwrap();
        assert_eq!(res["success"], true);
        assert_eq!(res["current_concurrency"], 64);

        let tune_req = serde_json::json!({
            "action": "tune",
            "observed_latency_ms": 15
        });
        let t_res = service.handle_port_runtime_tune(&tune_req).unwrap();
        assert_eq!(t_res["success"], true);

        let acq_req = serde_json::json!({
            "action": "acquire_buffer"
        });
        let a_res = service.handle_port_runtime_tune(&acq_req).unwrap();
        assert_eq!(a_res["success"], true);
    }
}
