//! L11.S07 — Ecosystem interoperability
//!
//! Provides bidirectional schema mapping, protocol negotiation,
//! error taxonomy transformation, and external connector adapters (OpenAPI, Zapier, Webhook),
//! maintaining strict transport neutrality at the contract layer.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExternalProtocol {
    OpenApiV3,
    ZapierWebhookV2,
    GenericRestV1,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CanonicalErrorCode {
    Success,
    RateLimited,
    Unauthorized,
    BadRequest,
    Timeout,
    InternalError,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectorProfile {
    pub connector_id: String,
    pub supported_protocols: Vec<ExternalProtocol>,
    pub supported_auth_types: Vec<String>,
    pub rate_limit_rps: u32,
    pub schema_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionRequest {
    pub source_protocol: ExternalProtocol,
    pub source_payload: serde_json::Value,
    pub target_schema_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConversionResponse {
    pub success: bool,
    pub transformed_payload: serde_json::Value,
    pub schema_version: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum InteropError {
    #[error("Empty connector ID or unsupported schema")]
    EmptyField(String),
    #[error("Unsupported protocol version: {0:?}")]
    UnsupportedProtocol(ExternalProtocol),
    #[error("Schema transformation failed: {0}")]
    TransformationFailed(String),
    #[error("Connector not found: {0}")]
    ConnectorNotFound(String),
}

#[derive(Default)]
pub struct EcosystemInteroperabilityService {
    connectors: HashMap<String, ConnectorProfile>,
}

impl EcosystemInteroperabilityService {
    pub fn new() -> Self {
        let mut svc = Self {
            connectors: HashMap::new(),
        };
        // Register default known connectors
        svc.register_connector(ConnectorProfile {
            connector_id: "openapi-standard".to_string(),
            supported_protocols: vec![ExternalProtocol::OpenApiV3, ExternalProtocol::GenericRestV1],
            supported_auth_types: vec!["bearer".to_string(), "api_key".to_string()],
            rate_limit_rps: 50,
            schema_version: "1.0.0".to_string(),
        })
        .unwrap();

        svc.register_connector(ConnectorProfile {
            connector_id: "zapier-webhook".to_string(),
            supported_protocols: vec![ExternalProtocol::ZapierWebhookV2],
            supported_auth_types: vec!["webhook_signature".to_string()],
            rate_limit_rps: 100,
            schema_version: "2.0.0".to_string(),
        })
        .unwrap();

        svc
    }

    /// Registers an external connector profile
    pub fn register_connector(&mut self, profile: ConnectorProfile) -> Result<(), InteropError> {
        let cid = profile.connector_id.trim();
        if cid.is_empty() {
            return Err(InteropError::EmptyField("connector_id".to_string()));
        }
        self.connectors.insert(cid.to_string(), profile);
        Ok(())
    }

    /// Negotiates protocol compatibility between caller and connector
    pub fn negotiate_protocol(
        &self,
        connector_id: &str,
        requested_protocol: ExternalProtocol,
    ) -> Result<ExternalProtocol, InteropError> {
        let profile = self
            .connectors
            .get(connector_id.trim())
            .ok_or_else(|| InteropError::ConnectorNotFound(connector_id.to_string()))?;

        if profile.supported_protocols.contains(&requested_protocol) {
            Ok(requested_protocol)
        } else {
            Err(InteropError::UnsupportedProtocol(requested_protocol))
        }
    }

    /// Converts external payload into canonical n8n format
    pub fn convert_to_canonical(
        &self,
        req: &ConversionRequest,
    ) -> Result<ConversionResponse, InteropError> {
        let payload_ref = match req.source_protocol {
            ExternalProtocol::ZapierWebhookV2 => {
                req.source_payload.get("data").unwrap_or(&req.source_payload)
            }
            ExternalProtocol::OpenApiV3 | ExternalProtocol::GenericRestV1 => {
                &req.source_payload
            }
        };

        let items: Vec<serde_json::Value> = match payload_ref {
            serde_json::Value::Array(arr) => arr
                .iter()
                .enumerate()
                .map(|(idx, val)| {
                    serde_json::json!({
                        "json": val,
                        "pairedItem": { "item": idx }
                    })
                })
                .collect(),
            single => vec![serde_json::json!({
                "json": single,
                "pairedItem": { "item": 0 }
            })],
        };

        Ok(ConversionResponse {
            success: true,
            transformed_payload: serde_json::Value::Array(items),
            schema_version: "n8n-canonical-v1".to_string(),
        })
    }

    /// Maps external HTTP / connector status codes to canonical error codes
    pub fn map_external_error(status_code: u16) -> CanonicalErrorCode {
        match status_code {
            200..=299 => CanonicalErrorCode::Success,
            400 => CanonicalErrorCode::BadRequest,
            401 | 403 => CanonicalErrorCode::Unauthorized,
            429 => CanonicalErrorCode::RateLimited,
            408 | 504 => CanonicalErrorCode::Timeout,
            _ => CanonicalErrorCode::InternalError,
        }
    }

    /// Handles typed port invocations
    pub fn handle_port_invocation(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, InteropError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("convert");
        match action {
            "negotiate" => {
                let cid = payload.get("connector_id").and_then(|v| v.as_str()).unwrap_or("openapi-standard");
                let proto_str = payload.get("protocol").and_then(|v| v.as_str()).unwrap_or("OpenApiV3");
                let proto = match proto_str {
                    "ZapierWebhookV2" => ExternalProtocol::ZapierWebhookV2,
                    _ => ExternalProtocol::OpenApiV3,
                };
                let negotiated = self.negotiate_protocol(cid, proto)?;
                Ok(serde_json::json!({ "negotiated_protocol": format!("{:?}", negotiated) }))
            }
            "convert" => {
                let proto_str = payload.get("protocol").and_then(|v| v.as_str()).unwrap_or("OpenApiV3");
                let proto = match proto_str {
                    "ZapierWebhookV2" => ExternalProtocol::ZapierWebhookV2,
                    _ => ExternalProtocol::OpenApiV3,
                };
                let src_data = payload.get("data").cloned().unwrap_or(serde_json::json!({}));
                let req = ConversionRequest {
                    source_protocol: proto,
                    source_payload: src_data,
                    target_schema_version: "n8n-canonical-v1".to_string(),
                };
                let resp = self.convert_to_canonical(&req)?;
                Ok(serde_json::to_value(resp).unwrap())
            }
            "map_error" => {
                let code = payload.get("http_status").and_then(|v| v.as_u64()).unwrap_or(200) as u16;
                let mapped = Self::map_external_error(code);
                Ok(serde_json::json!({ "canonical_error": format!("{:?}", mapped) }))
            }
            _ => Err(InteropError::EmptyField(format!("unknown action: {}", action))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/ecosystem_interop_test.rs"]
mod tests;
