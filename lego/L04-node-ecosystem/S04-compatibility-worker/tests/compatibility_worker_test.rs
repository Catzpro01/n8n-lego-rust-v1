#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_bridge_session_creation_and_heartbeat() {
        let service = CompatibilityWorkerService::new(60_000);

        let session = service
            .create_session("sess-1", "worker-node-1", "tenant-alpha", "1.0.0")
            .expect("Session creation should succeed");

        assert_eq!(session.session_id, "sess-1");
        assert_eq!(session.status, BridgeSessionStatus::Active);
        assert_eq!(session.protocol_version, "1.0.0");

        service.heartbeat("sess-1", "tenant-alpha").expect("Heartbeat should succeed");

        // Wrong tenant heartbeat fails
        let err = service.heartbeat("sess-1", "tenant-intruder").unwrap_err();
        assert!(matches!(err, CompatWorkerError::TenantMismatch { .. }));
    }

    #[test]
    fn test_compat_invoke_js_execution() {
        let service = CompatibilityWorkerService::new(60_000);

        service
            .create_session("sess-node", "worker-js-1", "tenant-beta", "1.0.0")
            .expect("Session should be created");

        let req = CompatInvokeRequest {
            session_id: Some("sess-node".to_string()),
            tenant_id: "tenant-beta".to_string(),
            node_type: "n8n-nodes-base.customJsNode".to_string(),
            node_name: "Legacy JS Node".to_string(),
            parameters: json!({ "custom_param": "foo" }),
            input_items: vec![
                json!({ "id": 100, "data": "item1" }),
                json!({ "id": 101, "data": "item2" }),
            ],
            js_code: Some("return items;".to_string()),
        };

        let res = service.invoke_js(&req).expect("JS invoke should succeed");
        assert!(res.success);
        assert_eq!(res.session_id, "sess-node");
        assert_eq!(res.items_processed, 2);
        assert_eq!(res.outputs[0].len(), 2);
        assert_eq!(res.outputs[0][0]["_js_compat_bridged"], true);
        assert_eq!(res.outputs[0][0]["_bridge_session"], "sess-node");
    }

    #[test]
    fn test_compat_invoke_auto_session_provisioning() {
        let service = CompatibilityWorkerService::new(60_000);

        let req = CompatInvokeRequest {
            session_id: None,
            tenant_id: "tenant-auto".to_string(),
            node_type: "n8n-nodes-base.communityNode".to_string(),
            node_name: "Community Node".to_string(),
            parameters: json!({}),
            input_items: vec![json!({ "key": "val" })],
            js_code: None,
        };

        let res = service.invoke_js(&req).expect("Auto-provisioned invoke should succeed");
        assert!(res.success);
        assert_eq!(res.session_id, "bridge-auto-tenant-auto");
        assert_eq!(res.outputs[0][0]["_js_compat_bridged"], true);
    }

    #[test]
    fn test_compat_invoke_terminated_session_rejection() {
        let service = CompatibilityWorkerService::new(60_000);

        service
            .create_session("sess-term", "worker-1", "tenant-gamma", "1.0.0")
            .expect("Session created");

        service.terminate_session("sess-term", "tenant-gamma").expect("Session terminated");

        let req = CompatInvokeRequest {
            session_id: Some("sess-term".to_string()),
            tenant_id: "tenant-gamma".to_string(),
            node_type: "n8n-nodes-base.legacy".to_string(),
            node_name: "Terminated Node".to_string(),
            parameters: json!({}),
            input_items: vec![json!({ "x": 1 })],
            js_code: None,
        };

        let err = service.invoke_js(&req).unwrap_err();
        assert_eq!(err, CompatWorkerError::SessionTerminated("sess-term".to_string()));
    }

    #[test]
    fn test_compat_invoke_tenant_boundary_enforcement() {
        let service = CompatibilityWorkerService::new(60_000);

        service
            .create_session("sess-tenant", "worker-1", "tenant-alpha", "1.0.0")
            .expect("Session created");

        let req = CompatInvokeRequest {
            session_id: Some("sess-tenant".to_string()),
            tenant_id: "tenant-other".to_string(),
            node_type: "n8n-nodes-base.legacy".to_string(),
            node_name: "Other Node".to_string(),
            parameters: json!({}),
            input_items: vec![],
            js_code: None,
        };

        let err = service.invoke_js(&req).unwrap_err();
        assert!(matches!(err, CompatWorkerError::TenantMismatch { .. }));
    }

    #[test]
    fn test_port_compat_invoke_js_dispatcher() {
        let service = CompatibilityWorkerService::new(60_000);

        let payload = json!({
            "tenant_id": "tenant-dispatch",
            "node_type": "n8n-nodes-base.customJsNode",
            "node_name": "Port JS Node",
            "parameters": { "mode": "compat" },
            "input_items": [
                { "item": "alpha" }
            ],
            "js_code": "return items;"
        });

        let out = service.handle_port_invoke_js(&payload).expect("Port invocation should succeed");
        assert_eq!(out["success"], true);
        assert_eq!(out["node_name"], "Port JS Node");
        assert_eq!(out["outputs"][0][0]["_js_compat_bridged"], true);
    }
}
