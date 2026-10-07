#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_activation_toggle_activate_and_deactivate() {
        let service = ActivationStateMachineService::new();

        let activate_req = ActivationToggleRequest {
            workflow_id: "wf_101".to_string(),
            trigger_id: "trig_webhook_1".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            trigger_type: "webhook".to_string(),
            target_state: true,
        };

        let res = service.toggle(activate_req).expect("Activation should succeed");
        assert!(res.success);
        assert_eq!(res.current_state, ActivationState::Active);

        let list = service
            .list_triggers(ActivationListQuery {
                workflow_id: Some("wf_101".to_string()),
                ..Default::default()
            })
            .expect("Listing should succeed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, ActivationState::Active);

        // Deactivate
        let deactivate_req = ActivationToggleRequest {
            workflow_id: "wf_101".to_string(),
            trigger_id: "trig_webhook_1".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            trigger_type: "webhook".to_string(),
            target_state: false,
        };

        let deact_res = service.toggle(deactivate_req).expect("Deactivation should succeed");
        assert!(deact_res.success);
        assert_eq!(deact_res.current_state, ActivationState::Inactive);
    }

    #[test]
    fn test_activation_toggle_idempotency() {
        let service = ActivationStateMachineService::new();

        let req = ActivationToggleRequest {
            workflow_id: "wf_102".to_string(),
            trigger_id: "trig_sched_1".to_string(),
            tenant_id: "tenant_alpha".to_string(),
            trigger_type: "schedule".to_string(),
            target_state: true,
        };

        let res1 = service.toggle(req.clone()).expect("First toggle should succeed");
        assert_eq!(res1.current_state, ActivationState::Active);

        // Re-toggle same active state
        let res2 = service.toggle(req).expect("Second toggle should succeed idempotently");
        assert_eq!(res2.current_state, ActivationState::Active);
        assert!(res2.message.contains("already in state"));
    }

    #[test]
    fn test_activation_fail_closed_validation() {
        let service = ActivationStateMachineService::new();

        // Empty workflow_id
        let err1 = service.toggle(ActivationToggleRequest {
            workflow_id: "".to_string(),
            trigger_id: "trig_1".to_string(),
            tenant_id: "tenant_a".to_string(),
            trigger_type: "webhook".to_string(),
            target_state: true,
        });
        assert!(err1.is_err());
        assert!(err1.unwrap_err().contains("Missing workflow_id"));

        // Empty trigger_id
        let err2 = service.toggle(ActivationToggleRequest {
            workflow_id: "wf_1".to_string(),
            trigger_id: "".to_string(),
            tenant_id: "tenant_a".to_string(),
            trigger_type: "webhook".to_string(),
            target_state: true,
        });
        assert!(err2.is_err());
        assert!(err2.unwrap_err().contains("Missing trigger_id"));

        // Empty tenant_id
        let err3 = service.toggle(ActivationToggleRequest {
            workflow_id: "wf_1".to_string(),
            trigger_id: "trig_1".to_string(),
            tenant_id: " ".to_string(),
            trigger_type: "webhook".to_string(),
            target_state: true,
        });
        assert!(err3.is_err());
        assert!(err3.unwrap_err().contains("Missing tenant_id"));
    }

    #[test]
    fn test_activation_state_transitions_and_failure() {
        let service = ActivationStateMachineService::new();

        service
            .toggle(ActivationToggleRequest {
                workflow_id: "wf_error".to_string(),
                trigger_id: "trig_err_1".to_string(),
                tenant_id: "tenant_beta".to_string(),
                trigger_type: "poll".to_string(),
                target_state: true,
            })
            .expect("Activation should succeed");

        service
            .mark_failed("tenant_beta", "wf_error", "trig_err_1", "Connection timeout to webhook provider")
            .expect("Marking failed should succeed");

        let list = service
            .list_triggers(ActivationListQuery {
                workflow_id: Some("wf_error".to_string()),
                ..Default::default()
            })
            .expect("Listing should succeed");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].state, ActivationState::Failed);
        assert_eq!(
            list[0].error_message.as_deref(),
            Some("Connection timeout to webhook provider")
        );
    }

    #[test]
    fn test_activation_list_filtering() {
        let service = ActivationStateMachineService::new();

        service
            .toggle(ActivationToggleRequest {
                workflow_id: "wf_A".to_string(),
                trigger_id: "trig_1".to_string(),
                tenant_id: "tenant_1".to_string(),
                trigger_type: "webhook".to_string(),
                target_state: true,
            })
            .unwrap();

        service
            .toggle(ActivationToggleRequest {
                workflow_id: "wf_A".to_string(),
                trigger_id: "trig_2".to_string(),
                tenant_id: "tenant_1".to_string(),
                trigger_type: "schedule".to_string(),
                target_state: true,
            })
            .unwrap();

        service
            .toggle(ActivationToggleRequest {
                workflow_id: "wf_B".to_string(),
                trigger_id: "trig_3".to_string(),
                tenant_id: "tenant_2".to_string(),
                trigger_type: "webhook".to_string(),
                target_state: true,
            })
            .unwrap();

        // Filter by tenant
        let tenant1_list = service
            .list_triggers(ActivationListQuery {
                tenant_id: Some("tenant_1".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(tenant1_list.len(), 2);

        // Filter by trigger_type
        let webhook_list = service
            .list_triggers(ActivationListQuery {
                trigger_type: Some("webhook".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(webhook_list.len(), 2);

        // Filter by workflow_id
        let wf_b_list = service
            .list_triggers(ActivationListQuery {
                workflow_id: Some("wf_B".to_string()),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(wf_b_list.len(), 1);
    }

    #[test]
    fn test_activation_port_dispatchers() {
        let service = ActivationStateMachineService::new();

        // Dispatch toggle port
        let toggle_payload = json!({
            "workflow_id": "wf_port_1",
            "trigger_id": "trig_port_1",
            "tenant_id": "tenant_port",
            "trigger_type": "webhook",
            "target_state": true
        });

        let toggle_res = service
            .dispatch_toggle_port(&toggle_payload)
            .expect("Toggle dispatcher should succeed");
        assert_eq!(toggle_res["success"], true);
        assert_eq!(toggle_res["current_state"], "active");

        // Dispatch list port
        let list_payload = json!({
            "tenant_id": "tenant_port",
            "workflow_id": "wf_port_1"
        });

        let list_res = service
            .dispatch_list_port(&list_payload)
            .expect("List dispatcher should succeed");
        assert!(list_res.is_array());
        let arr = list_res.as_array().unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["trigger_id"], "trig_port_1");
    }

    #[test]
    fn test_activation_invalid_state_transition_fails_closed() {
        let service = ActivationStateMachineService::new();

        // 1. Activate
        service
            .toggle(ActivationToggleRequest {
                workflow_id: "wf_inv".to_string(),
                trigger_id: "trig_inv".to_string(),
                tenant_id: "tenant_inv".to_string(),
                trigger_type: "webhook".to_string(),
                target_state: true,
            })
            .unwrap();

        // 2. Mark as Failed
        service
            .mark_failed("tenant_inv", "wf_inv", "trig_inv", "Out of memory error")
            .unwrap();

        // 3. Attempt direct reactivation from Failed to Active without recovery -> should fail
        let direct_activate_res = service.toggle(ActivationToggleRequest {
            workflow_id: "wf_inv".to_string(),
            trigger_id: "trig_inv".to_string(),
            tenant_id: "tenant_inv".to_string(),
            trigger_type: "webhook".to_string(),
            target_state: true,
        });

        assert!(direct_activate_res.is_err());
        assert!(direct_activate_res.unwrap_err().contains("Invalid state transition"));
    }

    #[test]
    fn test_activation_multithreaded_concurrent_toggles() {
        use std::sync::Arc;
        use std::thread;

        let service = Arc::new(ActivationStateMachineService::new());
        let mut handles = Vec::new();

        for i in 0..8 {
            let s = Arc::clone(&service);
            handles.push(thread::spawn(move || {
                for iter in 0..20 {
                    let req = ActivationToggleRequest {
                        workflow_id: format!("wf_thread_{i}"),
                        trigger_id: format!("trig_thread_{i}_{iter}"),
                        tenant_id: format!("tenant_c_{i}"),
                        trigger_type: "schedule".to_string(),
                        target_state: true,
                    };
                    let res = s.toggle(req).expect("Toggle should succeed concurrently");
                    assert!(res.success);
                }
            }));
        }

        for h in handles {
            h.join().expect("Thread should not panic");
        }

        let all_triggers = service.list_triggers(ActivationListQuery::default()).unwrap();
        assert_eq!(all_triggers.len(), 160);
    }

    #[test]
    fn test_activation_mark_failed_empty_args_fail_closed() {
        let service = ActivationStateMachineService::new();

        assert!(service.mark_failed("", "wf_1", "trig_1", "err").is_err());
        assert!(service.mark_failed("tenant_1", "", "trig_1", "err").is_err());
        assert!(service.mark_failed("tenant_1", "wf_1", "", "err").is_err());
    }

    #[test]
    fn test_activation_batch_toggle_and_abort_transitions() {
        let service = ActivationStateMachineService::new();

        let reqs = vec![
            ActivationToggleRequest {
                workflow_id: "wf_batch_1".to_string(),
                trigger_id: "trig_b_1".to_string(),
                tenant_id: "tenant_batch".to_string(),
                trigger_type: "webhook".to_string(),
                target_state: true,
            },
            ActivationToggleRequest {
                workflow_id: "wf_batch_2".to_string(),
                trigger_id: "trig_b_2".to_string(),
                tenant_id: "tenant_batch".to_string(),
                trigger_type: "schedule".to_string(),
                target_state: true,
            },
            ActivationToggleRequest {
                workflow_id: "".to_string(), // Invalid
                trigger_id: "trig_b_3".to_string(),
                tenant_id: "tenant_batch".to_string(),
                trigger_type: "webhook".to_string(),
                target_state: true,
            },
        ];

        let results = service.batch_toggle(reqs);
        assert_eq!(results.len(), 3);
        assert!(results[0].is_ok());
        assert!(results[1].is_ok());
        assert!(results[2].is_err());

        // Verify state machine can abort an activating trigger directly to inactive
        assert!(ActivationState::Activating.can_transition_to(ActivationState::Inactive));
        assert!(ActivationState::Activating.can_transition_to(ActivationState::Deactivating));
    }
}

