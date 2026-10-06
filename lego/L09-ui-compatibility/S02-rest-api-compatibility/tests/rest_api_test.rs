//! Unit tests for L09.S02 REST/API compatibility

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_match_known_route_workflows() {
        let service = RestApiDispatchService::new();
        let (route, params) = service.match_route("GET", "/rest/workflows").unwrap();

        assert_eq!(route.route_id, "workflows_list");
        assert_eq!(route.method, "GET");
        assert!(params.is_empty());
    }

    #[test]
    fn test_param_extraction_workflow_get() {
        let service = RestApiDispatchService::new();
        let (route, params) = service.match_route("GET", "/rest/workflows/wf-999").unwrap();

        assert_eq!(route.route_id, "workflow_get");
        assert_eq!(params.get("id").unwrap(), "wf-999");
    }

    #[test]
    fn test_dispatch_authenticated_workflow_run() {
        let service = RestApiDispatchService::new();
        let res = service
            .dispatch("POST", "/rest/workflows/wf-123/run", Some("valid-token-abc"), &json!({}))
            .expect("dispatch should succeed");

        assert_eq!(res.status, 200);
        assert_eq!(res.body["data"]["executionId"], "exec_wf-123_001");
        assert_eq!(res.body["data"]["finished"], false);
    }

    #[test]
    fn test_dispatch_unauthenticated_request_rejected() {
        let service = RestApiDispatchService::new();
        let err = service.dispatch("POST", "/rest/workflows/wf-123/run", None, &json!({}));
        assert!(matches!(err, Err(RestApiError::Unauthorized(_))));
    }

    #[test]
    fn test_route_not_found() {
        let service = RestApiDispatchService::new();
        let err = service.match_route("GET", "/rest/unknown/endpoint");
        assert!(matches!(err, Err(RestApiError::RouteNotFound(_))));
    }

    #[test]
    fn test_method_not_allowed() {
        let service = RestApiDispatchService::new();
        let err = service.match_route("DELETE", "/rest/workflows");
        assert!(matches!(err, Err(RestApiError::MethodNotAllowed(_))));
    }

    #[test]
    fn test_port_dispatch_roundtrip() {
        let service = RestApiDispatchService::new();

        let payload = json!({
            "method": "GET",
            "path": "/rest/workflows/42",
            "session_token": "secret_token_123",
            "body": {}
        });

        let port_res = service.handle_port_dispatch(&payload).unwrap();
        assert_eq!(port_res["success"], true);
        assert_eq!(port_res["status"], 200);
        assert_eq!(port_res["body"]["data"]["id"], "42");
        assert_eq!(port_res["body"]["data"]["name"], "Workflow 42");
    }

    #[test]
    fn test_match_route_with_query_string() {
        let service = RestApiDispatchService::new();
        let (route, params) = service.match_route("GET", "/rest/workflows?active=true&limit=50").unwrap();

        assert_eq!(route.route_id, "workflows_list");
        assert_eq!(route.method, "GET");
        assert!(params.is_empty());
    }

    #[test]
    fn test_param_extraction_with_query_string() {
        let service = RestApiDispatchService::new();
        let (route, params) = service.match_route("GET", "/rest/workflows/wf-888?include=tags").unwrap();

        assert_eq!(route.route_id, "workflow_get");
        assert_eq!(params.get("id").unwrap(), "wf-888");
    }
}
