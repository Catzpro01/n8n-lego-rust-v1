//! Unit tests for L06.S04 Health/readiness service

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_default_components_initialization() {
        let service = SystemReadinessService::default();
        let report = service.check_readiness(None).expect("should check readiness");

        assert!(report.is_ready);
        assert_eq!(report.overall_state, ReadinessState::Ready);
        assert_eq!(report.status_code, 200);
        assert_eq!(report.total_components, 4);
        assert_eq!(report.ready_count, 4);
        assert_eq!(report.not_ready_count, 0);
        assert!(report.components.contains_key("storage"));
        assert!(report.components.contains_key("execution"));
        assert!(report.components.contains_key("queue"));
        assert!(report.components.contains_key("wal"));
    }

    #[test]
    fn test_readiness_aggregation_fail_closed_on_not_ready() {
        let service = SystemReadinessService::new();
        service
            .register_component("db", ReadinessState::Ready, Some("Postgres connected".into()))
            .unwrap();
        service
            .register_component("redis", ReadinessState::NotReady, Some("Redis connection timeout".into()))
            .unwrap();
        service
            .register_component("worker", ReadinessState::Ready, Some("Workers healthy".into()))
            .unwrap();

        let report = service.check_readiness(None).expect("should evaluate report");
        assert!(!report.is_ready);
        assert_eq!(report.overall_state, ReadinessState::NotReady);
        assert_eq!(report.status_code, 503);
        assert_eq!(report.total_components, 3);
        assert_eq!(report.not_ready_count, 1);
        assert_eq!(report.ready_count, 2);
    }

    #[test]
    fn test_readiness_aggregation_degraded() {
        let service = SystemReadinessService::new();
        service
            .register_component("primary_db", ReadinessState::Ready, None)
            .unwrap();
        service
            .register_component("replica_db", ReadinessState::Degraded, Some("Replication lag high".into()))
            .unwrap();

        let report = service.check_readiness(None).expect("should evaluate report");
        assert!(report.is_ready);
        assert_eq!(report.overall_state, ReadinessState::Degraded);
        assert_eq!(report.status_code, 200);
        assert_eq!(report.degraded_count, 1);
        assert_eq!(report.ready_count, 1);
        assert_eq!(report.not_ready_count, 0);
    }

    #[test]
    fn test_single_component_lookup() {
        let service = SystemReadinessService::new();
        service
            .register_component("gateway", ReadinessState::Ready, Some("HTTP ingress up".into()))
            .unwrap();

        let report = service.check_readiness(Some("gateway")).expect("should find gateway");
        assert_eq!(report.overall_state, ReadinessState::Ready);
        assert_eq!(report.status_code, 200);

        let not_found = service.check_readiness(Some("non_existent"));
        assert!(matches!(not_found, Err(ReadinessError::ComponentNotFound(_))));
    }

    #[test]
    fn test_update_readiness_transition() {
        let service = SystemReadinessService::new();
        service
            .register_component("service_x", ReadinessState::Initializing, None)
            .unwrap();

        let initial = service.get_component("service_x").unwrap();
        assert_eq!(initial.state, ReadinessState::Initializing);

        // Update to Ready
        let updated = service
            .update_readiness(
                "service_x",
                ReadinessState::Ready,
                Some("Warmed up".into()),
                Some(json!({"latency_ms": 12})),
            )
            .unwrap();

        assert_eq!(updated.state, ReadinessState::Ready);
        assert_eq!(updated.message, Some("Warmed up".into()));
        assert_eq!(updated.consecutive_failures, 0);

        // Update to NotReady increases failure count
        let failed = service
            .update_readiness("service_x", ReadinessState::NotReady, Some("Out of memory".into()), None)
            .unwrap();
        assert_eq!(failed.state, ReadinessState::NotReady);
        assert_eq!(failed.consecutive_failures, 1);
    }

    #[test]
    fn test_port_handler_dispatch() {
        let service = SystemReadinessService::default();

        // Check action
        let check_req = json!({
            "action": "check"
        });
        let res = service.handle_port_health_check(&check_req).expect("port check should succeed");
        assert_eq!(res["success"], true);
        assert_eq!(res["status_code"], 200);
        assert_eq!(res["overall_state"], "ready");

        // Update action
        let update_req = json!({
            "action": "update",
            "component": "storage",
            "state": "not_ready",
            "message": "Disk full"
        });
        let update_res = service.handle_port_health_check(&update_req).expect("port update should succeed");
        assert_eq!(update_res["success"], true);
        assert_eq!(update_res["updated_record"]["state"], "not_ready");

        // Subsequent check shows not_ready
        let recheck_res = service.handle_port_health_check(&check_req).expect("subsequent check should succeed");
        assert_eq!(recheck_res["success"], false);
        assert_eq!(recheck_res["status_code"], 503);
        assert_eq!(recheck_res["overall_state"], "not_ready");
    }

    #[test]
    fn test_fail_closed_validation() {
        let service = SystemReadinessService::new();

        assert!(matches!(
            service.register_component("", ReadinessState::Ready, None),
            Err(ReadinessError::InvalidRequest(_))
        ));

        let invalid_update = json!({
            "action": "update",
            "state": "ready"
        });
        assert!(matches!(
            service.handle_port_health_check(&invalid_update),
            Err(ReadinessError::InvalidRequest(_))
        ));

        let bad_action = json!({
            "action": "unknown_action"
        });
        assert!(matches!(
            service.handle_port_health_check(&bad_action),
            Err(ReadinessError::InvalidRequest(_))
        ));
    }
}
