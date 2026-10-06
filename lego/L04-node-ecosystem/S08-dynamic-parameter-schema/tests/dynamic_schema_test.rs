#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_resolve_options_cache_miss_and_hit() {
        let service = DynamicSchemaService::new(60_000);

        let res1 = service
            .resolve_options(
                "tenant-alpha",
                "n8n-nodes-base.postgres",
                "database",
                "getDatabases",
                &json!({}),
                false,
            )
            .expect("First resolution should succeed");

        assert!(res1.success);
        assert!(!res1.cache_hit);
        assert_eq!(res1.options.len(), 2);
        assert_eq!(res1.options[0].value, "default_db");

        // Second call with same parameters hits dynamic-schema-cache
        let res2 = service
            .resolve_options(
                "tenant-alpha",
                "n8n-nodes-base.postgres",
                "database",
                "getDatabases",
                &json!({}),
                false,
            )
            .expect("Second resolution should succeed");

        assert!(res2.success);
        assert!(res2.cache_hit);
        assert_eq!(res2.options.len(), 2);
    }

    #[test]
    fn test_resolve_options_bypass_cache() {
        let service = DynamicSchemaService::new(60_000);

        // Populate cache
        service
            .resolve_options("tenant-a", "n8n-nodes-base.postgres", "db", "getDatabases", &json!({}), false)
            .expect("Initial call succeeds");

        // Bypass cache
        let res = service
            .resolve_options("tenant-a", "n8n-nodes-base.postgres", "db", "getDatabases", &json!({}), true)
            .expect("Bypass call succeeds");

        assert!(!res.cache_hit);
    }

    #[test]
    fn test_resolve_tables_with_parameter_context() {
        let service = DynamicSchemaService::new(60_000);

        let res = service
            .resolve_options(
                "tenant-alpha",
                "n8n-nodes-base.mysql",
                "table",
                "getTables",
                &json!({ "database": "billing" }),
                false,
            )
            .expect("Table resolution succeeds");

        assert_eq!(res.options.len(), 3);
        assert_eq!(res.options[0].name, "billing.users");
        assert_eq!(res.options[1].name, "billing.orders");
    }

    #[test]
    fn test_unsupported_method_fail_closed() {
        let service = DynamicSchemaService::new(60_000);

        let err = service
            .resolve_options(
                "tenant-alpha",
                "n8n-nodes-base.postgres",
                "secret",
                "getNonExistentMethod",
                &json!({}),
                false,
            )
            .unwrap_err();

        assert!(matches!(err, SchemaResolveError::UnsupportedMethod(_)));
    }

    #[test]
    fn test_invalid_request_validation() {
        let service = DynamicSchemaService::new(60_000);

        let err = service
            .resolve_options("", "node_type", "prop", "getDatabases", &json!({}), false)
            .unwrap_err();

        assert!(matches!(err, SchemaResolveError::InvalidRequest(_)));
    }

    #[test]
    fn test_port_resolve_options_dispatcher() {
        let service = DynamicSchemaService::new(60_000);

        let payload = json!({
            "tenant_id": "tenant-port",
            "node_type": "n8n-nodes-base.schedule",
            "property_name": "timezone",
            "method_name": "getTimezones",
            "current_parameters": {},
            "bypass_cache": false
        });

        let out = service
            .handle_port_resolve_options(&payload)
            .expect("Port resolve options succeeds");

        assert_eq!(out["success"], true);
        assert_eq!(out["method_name"], "getTimezones");
        assert_eq!(out["options"][0]["value"], "UTC");
    }
}
