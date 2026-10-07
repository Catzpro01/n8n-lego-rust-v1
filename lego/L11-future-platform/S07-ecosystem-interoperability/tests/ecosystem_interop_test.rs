//! Unit, Schema Conversion, & Protocol Negotiation Tests for L11.S07

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_protocol_negotiation_success_and_rejection() {
        let service = EcosystemInteroperabilityService::new();

        // 1. Supported OpenApiV3 on openapi-standard succeeds
        let neg = service.negotiate_protocol("openapi-standard", ExternalProtocol::OpenApiV3).unwrap();
        assert_eq!(neg, ExternalProtocol::OpenApiV3);

        // 2. Unsupported Zapier on openapi-standard is rejected
        let err = service.negotiate_protocol("openapi-standard", ExternalProtocol::ZapierWebhookV2).unwrap_err();
        assert_eq!(err, InteropError::UnsupportedProtocol(ExternalProtocol::ZapierWebhookV2));

        // 3. Unknown connector ID fails
        let err_unk = service.negotiate_protocol("unknown-connector", ExternalProtocol::OpenApiV3).unwrap_err();
        assert!(matches!(err_unk, InteropError::ConnectorNotFound(_)));
    }

    #[test]
    fn test_schema_conversion_to_canonical_n8n() {
        let service = EcosystemInteroperabilityService::new();

        let req = ConversionRequest {
            source_protocol: ExternalProtocol::ZapierWebhookV2,
            source_payload: serde_json::json!({ "event": "lead.created", "email": "alice@example.com" }),
            target_schema_version: "n8n-canonical-v1".to_string(),
        };

        let resp = service.convert_to_canonical(&req).unwrap();
        assert!(resp.success);
        assert_eq!(resp.schema_version, "n8n-canonical-v1");

        let items = resp.transformed_payload.as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["json"]["email"], "alice@example.com");
        assert_eq!(items[0]["pairedItem"]["item"], 0);
    }

    #[test]
    fn test_external_error_code_mapping() {
        assert_eq!(EcosystemInteroperabilityService::map_external_error(200), CanonicalErrorCode::Success);
        assert_eq!(EcosystemInteroperabilityService::map_external_error(400), CanonicalErrorCode::BadRequest);
        assert_eq!(EcosystemInteroperabilityService::map_external_error(401), CanonicalErrorCode::Unauthorized);
        assert_eq!(EcosystemInteroperabilityService::map_external_error(403), CanonicalErrorCode::Unauthorized);
        assert_eq!(EcosystemInteroperabilityService::map_external_error(429), CanonicalErrorCode::RateLimited);
        assert_eq!(EcosystemInteroperabilityService::map_external_error(504), CanonicalErrorCode::Timeout);
        assert_eq!(EcosystemInteroperabilityService::map_external_error(500), CanonicalErrorCode::InternalError);
    }

    #[test]
    fn test_port_invocation_convert_and_map_error() {
        let service = EcosystemInteroperabilityService::new();

        let conv_payload = serde_json::json!({
            "action": "convert",
            "protocol": "OpenApiV3",
            "data": { "userId": 42, "role": "admin" }
        });

        let conv_res = service.handle_port_invocation(&conv_payload).unwrap();
        assert_eq!(conv_res["success"], true);
        assert_eq!(conv_res["transformed_payload"][0]["json"]["userId"], 42);

        let err_payload = serde_json::json!({
            "action": "map_error",
            "http_status": 429
        });
        let err_res = service.handle_port_invocation(&err_payload).unwrap();
        assert_eq!(err_res["canonical_error"], "RateLimited");
    }

    #[test]
    fn test_array_batch_conversion_to_canonical_n8n() {
        let service = EcosystemInteroperabilityService::new();

        let req = ConversionRequest {
            source_protocol: ExternalProtocol::GenericRestV1,
            source_payload: serde_json::json!([
                { "name": "Item 1", "score": 90 },
                { "name": "Item 2", "score": 85 },
                { "name": "Item 3", "score": 95 }
            ]),
            target_schema_version: "n8n-canonical-v1".to_string(),
        };

        let resp = service.convert_to_canonical(&req).unwrap();
        assert!(resp.success);
        let items = resp.transformed_payload.as_array().unwrap();
        assert_eq!(items.len(), 3);
        assert_eq!(items[0]["json"]["name"], "Item 1");
        assert_eq!(items[0]["pairedItem"]["item"], 0);
        assert_eq!(items[1]["json"]["name"], "Item 2");
        assert_eq!(items[1]["pairedItem"]["item"], 1);
        assert_eq!(items[2]["json"]["name"], "Item 3");
        assert_eq!(items[2]["pairedItem"]["item"], 2);
    }
}
