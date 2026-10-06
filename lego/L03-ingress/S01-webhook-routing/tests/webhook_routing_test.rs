#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_webhook_route_registration_and_matching() {
        let table = WebhookRouteTable::new();
        table
            .register_route("tenant_acme", "POST", "/webhook/stripe-events", "wf_stripe_handler")
            .expect("Registration should succeed");

        // Match exact route
        let matched = table.match_route("tenant_acme", "POST", "/webhook/stripe-events");
        assert_eq!(matched.as_deref(), Some("wf_stripe_handler"));

        // Match case-insensitive HTTP method
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
}
