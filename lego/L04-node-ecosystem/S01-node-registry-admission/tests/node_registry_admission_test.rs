#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_node_registry_initial_builtins() {
        let service = NodeRegistryAdmissionService::new();
        let res = service
            .query_nodes(NodeQueryRequest::default())
            .expect("Querying initial builtins should succeed");

        assert!(res.total >= 3);
        let http_node = res
            .nodes
            .iter()
            .find(|n| n.node_type_name == "n8n-nodes-base.httpRequest");
        assert!(http_node.is_some());
        assert_eq!(http_node.unwrap().display_name, "HTTP Request");
    }

    #[test]
    fn test_node_registry_register_and_query() {
        let service = NodeRegistryAdmissionService::new();

        let req = NodeRegisterRequest {
            node_type_name: "custom-nodes.transformData".to_string(),
            display_name: "Transform Data".to_string(),
            version: 1,
            category: "transform".to_string(),
            description: Some("Transforms incoming JSON records".to_string()),
            is_trigger: Some(false),
            inputs: Some(vec!["main".to_string()]),
            outputs: Some(vec!["main".to_string()]),
        };

        let reg_res = service.register_node(req).expect("Registration should succeed");
        assert!(reg_res.success);
        assert_eq!(reg_res.node_type_name, "custom-nodes.transformData");

        // Query by node_type_name
        let query_res = service
            .query_nodes(NodeQueryRequest {
                node_type_name: Some("custom-nodes.transformData".to_string()),
                ..Default::default()
            })
            .expect("Query should succeed");

        assert_eq!(query_res.total, 1);
        assert_eq!(query_res.nodes[0].display_name, "Transform Data");
        assert_eq!(query_res.nodes[0].category, "transform");
    }

    #[test]
    fn test_node_registry_fail_closed_admission() {
        let service = NodeRegistryAdmissionService::new();

        // Empty node_type_name
        let err1 = service.register_node(NodeRegisterRequest {
            node_type_name: "".to_string(),
            display_name: "Test Node".to_string(),
            version: 1,
            category: "utility".to_string(),
            description: None,
            is_trigger: None,
            inputs: None,
            outputs: None,
        });
        assert!(err1.is_err());
        assert!(err1.unwrap_err().contains("missing node_type_name"));

        // Zero version
        let err2 = service.register_node(NodeRegisterRequest {
            node_type_name: "test.zeroVersion".to_string(),
            display_name: "Test Node".to_string(),
            version: 0,
            category: "utility".to_string(),
            description: None,
            is_trigger: None,
            inputs: None,
            outputs: None,
        });
        assert!(err2.is_err());
        assert!(err2.unwrap_err().contains("version must be greater than 0"));

        // Empty category
        let err3 = service.register_node(NodeRegisterRequest {
            node_type_name: "test.noCategory".to_string(),
            display_name: "Test Node".to_string(),
            version: 1,
            category: "   ".to_string(),
            description: None,
            is_trigger: None,
            inputs: None,
            outputs: None,
        });
        assert!(err3.is_err());
        assert!(err3.unwrap_err().contains("missing category"));
    }

    #[test]
    fn test_node_registry_query_filters() {
        let service = NodeRegistryAdmissionService::new();

        // Filter trigger nodes
        let triggers = service
            .query_nodes(NodeQueryRequest {
                is_trigger: Some(true),
                ..Default::default()
            })
            .expect("Query trigger nodes should succeed");

        assert!(triggers.nodes.iter().all(|n| n.is_trigger));
        assert!(triggers.nodes.iter().any(|n| n.node_type_name == "n8n-nodes-base.webhook"));

        // Filter non-trigger nodes
        let non_triggers = service
            .query_nodes(NodeQueryRequest {
                is_trigger: Some(false),
                ..Default::default()
            })
            .expect("Query non-trigger nodes should succeed");

        assert!(non_triggers.nodes.iter().all(|n| !n.is_trigger));
    }

    #[test]
    fn test_node_registry_port_dispatchers() {
        let service = NodeRegistryAdmissionService::new();

        // Dispatch register port
        let reg_payload = json!({
            "node_type_name": "custom.slackNotifier",
            "display_name": "Slack Notifier",
            "version": 2,
            "category": "communication",
            "is_trigger": false
        });

        let reg_res = service
            .dispatch_register_port(&reg_payload)
            .expect("Register dispatcher should succeed");
        assert_eq!(reg_res["success"], true);
        assert_eq!(reg_res["node_type_name"], "custom.slackNotifier");
        assert_eq!(reg_res["version"], 2);

        // Dispatch query port
        let query_payload = json!({
            "node_type_name": "custom.slackNotifier"
        });

        let query_res = service
            .dispatch_query_port(&query_payload)
            .expect("Query dispatcher should succeed");
        assert_eq!(query_res["total"], 1);
        assert_eq!(query_res["nodes"][0]["display_name"], "Slack Notifier");
    }
}
