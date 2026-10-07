//! Unit tests for L03.S07 Startup Reconciliation and Recovery

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_reconciliation_clean_state() {
        let service = StartupReconciliationService::new();

        let persisted = vec![PersistedTriggerEntry {
            trigger_id: "trig_1".to_string(),
            workflow_id: "wf_1".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            trigger_type: "webhook".to_string(),
            is_active: true,
            path_or_pattern: "/webhook/wf_1".to_string(),
        }];

        let live = vec![LiveEndpointEntry {
            endpoint_id: "ep_1".to_string(),
            workflow_id: "wf_1".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            path: "/webhook/wf_1".to_string(),
        }];

        let (report, actions) = service.reconcile_endpoints(&persisted, &live, 1000).unwrap();
        assert_eq!(report.synchronized_count, 1);
        assert_eq!(report.orphaned_count, 0);
        assert_eq!(report.zombie_count, 0);
        assert_eq!(actions.len(), 1);
        assert!(matches!(actions[0], ReconciliationAction::NoopSynchronized { .. }));
    }

    #[test]
    fn test_reconciliation_orphaned_trigger_detected() {
        let service = StartupReconciliationService::new();

        let persisted = vec![PersistedTriggerEntry {
            trigger_id: "trig_orph".to_string(),
            workflow_id: "wf_orph".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            trigger_type: "webhook".to_string(),
            is_active: true,
            path_or_pattern: "/webhook/missing".to_string(),
        }];

        let live = vec![]; // Nothing in gateway yet

        let (report, actions) = service.reconcile_endpoints(&persisted, &live, 1000).unwrap();
        assert_eq!(report.synchronized_count, 0);
        assert_eq!(report.orphaned_count, 1);
        assert_eq!(report.zombie_count, 0);
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            actions[0],
            ReconciliationAction::RegisterMissingEndpoint { .. }
        ));

        // Ledger has 1 pending marker
        let markers = service.list_markers(None);
        assert_eq!(markers.len(), 1);
        assert_eq!(markers[0].status, MarkerStatus::Pending);
    }

    #[test]
    fn test_reconciliation_zombie_endpoint_detected() {
        let service = StartupReconciliationService::new();

        let persisted = vec![]; // No active triggers

        let live = vec![LiveEndpointEntry {
            endpoint_id: "ep_zombie".to_string(),
            workflow_id: "wf_deleted".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            path: "/webhook/stale".to_string(),
        }];

        let (report, actions) = service.reconcile_endpoints(&persisted, &live, 1000).unwrap();
        assert_eq!(report.synchronized_count, 0);
        assert_eq!(report.orphaned_count, 0);
        assert_eq!(report.zombie_count, 1);
        assert_eq!(actions.len(), 1);
        assert!(matches!(
            actions[0],
            ReconciliationAction::EvictZombieEndpoint { .. }
        ));
    }

    #[test]
    fn test_update_marker_status_in_ledger() {
        let service = StartupReconciliationService::new();

        let persisted = vec![PersistedTriggerEntry {
            trigger_id: "t1".to_string(),
            workflow_id: "w1".to_string(),
            tenant_id: "tenant_x".to_string(),
            trigger_type: "webhook".to_string(),
            is_active: true,
            path_or_pattern: "/webhook/t1".to_string(),
        }];

        let (report, _) = service.reconcile_endpoints(&persisted, &[], 1000).unwrap();
        let marker_id = &report.markers_generated[0];

        // Mark applied
        service
            .update_marker_status(marker_id, MarkerStatus::Applied, None)
            .unwrap();
        let markers = service.list_markers(Some("tenant_x"));
        assert_eq!(markers[0].status, MarkerStatus::Applied);

        // Mark failed with error
        service
            .update_marker_status(marker_id, MarkerStatus::Failed, Some("Route port unreachable".to_string()))
            .unwrap();
        let markers2 = service.list_markers(Some("tenant_x"));
        assert_eq!(markers2[0].status, MarkerStatus::Failed);
        assert_eq!(markers2[0].error_detail.as_deref(), Some("Route port unreachable"));
    }

    #[test]
    fn test_port_handler_reconciliation_roundtrip() {
        let service = StartupReconciliationService::new();

        let payload = json!({
            "action": "reconcile",
            "now_ms": 5000,
            "persisted_triggers": [
                {
                    "trigger_id": "trig_p1",
                    "workflow_id": "wf_p1",
                    "tenant_id": "tenant_1",
                    "trigger_type": "webhook",
                    "is_active": true,
                    "path_or_pattern": "/webhook/p1"
                }
            ],
            "live_endpoints": []
        });

        let res = service.handle_port_reconciliation(&payload).unwrap();
        assert_eq!(res["report"]["orphaned_count"], 1);
        assert_eq!(res["planned_actions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn test_reconciliation_mismatched_workflow_route_conflict() {
        let service = StartupReconciliationService::new();
        let persisted = vec![PersistedTriggerEntry {
            trigger_id: "trig_new".to_string(),
            workflow_id: "wf_new".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            trigger_type: "webhook".to_string(),
            is_active: true,
            path_or_pattern: "/webhook/shared".to_string(),
        }];
        let live = vec![LiveEndpointEntry {
            endpoint_id: "ep_old".to_string(),
            workflow_id: "wf_old".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            path: "/webhook/shared".to_string(),
        }];

        let (report, actions) = service.reconcile_endpoints(&persisted, &live, 1000).unwrap();
        assert_eq!(report.zombie_count, 1);
        assert_eq!(report.orphaned_count, 1);
        assert_eq!(report.markers_generated.len(), 2);
        assert_eq!(actions.len(), 2);

        // Verify both markers exist in recovery ledger
        let markers = service.list_markers(Some("tenant_alpha"));
        assert_eq!(markers.len(), 2);
        assert!(markers.iter().any(|m| matches!(m.action, ReconciliationAction::EvictZombieEndpoint { .. })));
        assert!(markers.iter().any(|m| matches!(m.action, ReconciliationAction::RegisterMissingEndpoint { .. })));
    }
}
