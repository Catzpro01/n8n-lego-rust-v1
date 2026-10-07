#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;
    use std::sync::Arc;
    use std::thread;

    #[test]
    fn test_webhook_route_registration_and_matching() {
        let table = WebhookRouteTable::new();
        table
            .register_route("tenant_acme", "POST", "/webhook/stripe-events", "wf_stripe_handler")
            .expect("Registration should succeed");

        // Match exact route
        let matched = table.match_route("tenant_acme", "POST", "/webhook/stripe-events");
        assert_eq!(matched.as_deref(), Some("wf_stripe_handler"));

        // Match case-insensitive HTTP method and normalized path
        let matched_lower = table.match_route("tenant_acme", "post", "/webhook/stripe-events/");
        assert_eq!(matched_lower.as_deref(), Some("wf_stripe_handler"));

        // Different HTTP method -> None (Method Not Allowed / Not Found)
        let get_attempt = table.match_route("tenant_acme", "GET", "/webhook/stripe-events");
        assert!(get_attempt.is_none());
    }

    #[test]
    fn test_webhook_tenant_isolation() {
        let table = WebhookRouteTable::new();
        table
            .register_route("tenant_a", "POST", "/webhook/lead", "wf_lead_tenant_a")
            .unwrap();

        // Cross-tenant access must return None
        let cross_tenant = table.match_route("tenant_b", "POST", "/webhook/lead");
        assert!(cross_tenant.is_none());
    }

    #[test]
    fn test_webhook_path_normalization_variations() {
        let table = WebhookRouteTable::new();
        // Path registered without leading slash or with extra trailing slashes
        table
            .register_route("tenant_x", "get", "api/v1/health/", "wf_health")
            .unwrap();

        assert_eq!(
            table.match_route("tenant_x", "GET", "/api/v1/health").as_deref(),
            Some("wf_health")
        );
        assert_eq!(
            table.match_route("tenant_x", "get", "api/v1/health/").as_deref(),
            Some("wf_health")
        );
    }

    #[test]
    fn test_webhook_deregister_and_count() {
        let table = WebhookRouteTable::new();
        assert_eq!(table.count(), 0);

        table.register_route("t1", "POST", "/hook1", "wf1").unwrap();
        table.register_route("t1", "POST", "/hook2", "wf2").unwrap();
        assert_eq!(table.count(), 2);

        let removed = table.deregister_route("t1", "POST", "/hook1");
        assert!(removed);
        assert_eq!(table.count(), 1);
        assert!(table.match_route("t1", "POST", "/hook1").is_none());

        // Deregister non-existent returns false
        assert!(!table.deregister_route("t1", "POST", "/hook_unknown"));
    }

    #[test]
    fn test_webhook_set_route_active() {
        let table = WebhookRouteTable::new();
        table.register_route("t1", "POST", "/hook_active", "wf_act").unwrap();

        assert_eq!(
            table.match_route("t1", "POST", "/hook_active").as_deref(),
            Some("wf_act")
        );

        // Deactivate route
        let updated = table.set_route_active("t1", "POST", "/hook_active", false).unwrap();
        assert!(updated);
        // Deactivated route returns None on match
        assert!(table.match_route("t1", "POST", "/hook_active").is_none());

        // Reactivate
        table.set_route_active("t1", "POST", "/hook_active", true).unwrap();
        assert_eq!(
            table.match_route("t1", "POST", "/hook_active").as_deref(),
            Some("wf_act")
        );
    }

    #[test]
    fn test_webhook_port_dispatch_receive_success() {
        let table = WebhookRouteTable::new();
        table.register_route("acme_corp", "POST", "/webhook/orders", "wf_order_processor").unwrap();

        let payload = json!({
            "tenant_id": "acme_corp",
            "http_method": "post",
            "path": "/webhook/orders/",
            "headers": { "content-type": "application/json" },
            "body": { "order_id": "12345" }
        });

        let res = table.handle_port_webhook_receive(&payload).expect("Dispatch should succeed");
        assert_eq!(res["accepted"], true);
        assert_eq!(res["workflow_id"], "wf_order_processor");
        assert!(res["execution_id"].as_str().unwrap().starts_with("exec-acme_corp-wf_order_processor-"));
    }

    #[test]
    fn test_webhook_port_dispatch_404_fast_reject() {
        let table = WebhookRouteTable::new();

        let payload = json!({
            "tenant_id": "acme_corp",
            "http_method": "POST",
            "path": "/unregistered/path"
        });

        let err = table.handle_port_webhook_receive(&payload);
        assert!(err.is_err());
        let msg = err.unwrap_err();
        assert!(msg.contains("NotFound: No active route"));
    }

    #[test]
    fn test_webhook_port_dispatch_fail_closed_validation() {
        let table = WebhookRouteTable::new();

        // Missing tenant_id
        let err_tenant = table.handle_port_webhook_receive(&json!({
            "http_method": "POST",
            "path": "/hook"
        }));
        assert!(err_tenant.is_err());
        assert!(err_tenant.unwrap_err().contains("Unauthorized"));

        // Missing http_method
        let err_method = table.handle_port_webhook_receive(&json!({
            "tenant_id": "t1",
            "path": "/hook"
        }));
        assert!(err_method.is_err());
        assert!(err_method.unwrap_err().contains("BadRequest: Missing or empty http_method"));

        // Missing path
        let err_path = table.handle_port_webhook_receive(&json!({
            "tenant_id": "t1",
            "http_method": "POST"
        }));
        assert!(err_path.is_err());
        assert!(err_path.unwrap_err().contains("BadRequest: Missing or empty path"));
    }

    #[test]
    fn test_webhook_concurrent_multithreaded_readers_and_writers() {
        let table = Arc::new(WebhookRouteTable::new());

        // Pre-populate some routes
        for i in 0..10 {
            table.register_route("tenant_shared", "POST", &format!("/hook/{i}"), &format!("wf_{i}")).unwrap();
        }

        let mut handles = Vec::new();

        // Spawn 4 reader threads
        for _ in 0..4 {
            let t = Arc::clone(&table);
            handles.push(thread::spawn(move || {
                for _ in 0..100 {
                    let matched = t.match_route("tenant_shared", "POST", "/hook/5");
                    assert_eq!(matched.as_deref(), Some("wf_5"));
                }
            }));
        }

        // Spawn 2 writer threads
        for w in 0..2 {
            let t = Arc::clone(&table);
            handles.push(thread::spawn(move || {
                for i in 100..120 {
                    t.register_route("tenant_shared", "POST", &format!("/dynamic/{w}_{i}"), "wf_dyn").unwrap();
                }
            }));
        }

        for h in handles {
            h.join().expect("Thread should not panic");
        }

        assert!(table.count() >= 50);
    }
}
