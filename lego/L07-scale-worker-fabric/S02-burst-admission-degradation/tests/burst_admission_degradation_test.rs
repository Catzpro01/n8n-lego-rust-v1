//! Unit tests for L07.S02 Burst admission and graceful degradation

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_nominal_tier_admits_all() {
        let service = BurstAdmissionService::new();
        assert_eq!(service.current_tier(), DegradationTier::Nominal);

        assert_eq!(service.evaluate_admission("background"), ThrottleDecision::Admitted);
        assert_eq!(service.evaluate_admission("standard"), ThrottleDecision::Admitted);
        assert_eq!(service.evaluate_admission("critical"), ThrottleDecision::Admitted);
    }

    #[test]
    fn test_shed_background_tier_throttles_background() {
        let service = BurstAdmissionService::new();
        // High CPU 75% -> ShedBackground
        let tier = service.update_metrics(PressureMetrics {
            cpu_pct: 75.0,
            mem_pct: 40.0,
            queue_depth: 200,
        });
        assert_eq!(tier, DegradationTier::ShedBackground);

        assert!(matches!(service.evaluate_admission("background"), ThrottleDecision::Throttled { .. }));
        assert_eq!(service.evaluate_admission("standard"), ThrottleDecision::Admitted);
    }

    #[test]
    fn test_critical_and_emergency_lockdown() {
        let service = BurstAdmissionService::new();

        // Critical CPU 90%
        service.update_metrics(PressureMetrics { cpu_pct: 90.0, mem_pct: 70.0, queue_depth: 1600 });
        assert_eq!(service.current_tier(), DegradationTier::CriticalShedding);
        assert!(matches!(service.evaluate_admission("standard"), ThrottleDecision::Throttled { .. }));
        assert_eq!(service.evaluate_admission("critical"), ThrottleDecision::Admitted);

        // Emergency CPU 98%
        service.update_metrics(PressureMetrics { cpu_pct: 98.0, mem_pct: 90.0, queue_depth: 3500 });
        assert_eq!(service.current_tier(), DegradationTier::EmergencyLockdown);
        assert!(matches!(service.evaluate_admission("standard"), ThrottleDecision::Rejected { .. }));
        assert_eq!(service.evaluate_admission("critical"), ThrottleDecision::Admitted);
    }

    #[test]
    fn test_port_handler_throttle_evaluation() {
        let service = BurstAdmissionService::new();

        let req = serde_json::json!({
            "action": "evaluate",
            "priority": "standard"
        });

        let resp = service.handle_port_admission_throttle(&req).unwrap();
        assert_eq!(resp["admitted"], true);
        assert_eq!(resp["status"], "admitted");
    }
}
