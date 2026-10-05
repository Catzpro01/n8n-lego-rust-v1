use std::future::Future;
use std::pin::Pin;
use base64::prelude::*;
use sha2::{Digest, Sha256, Sha512};
use serde_json::{json, Value};
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct CryptoNode;

impl CryptoNode {
    pub fn new() -> Self {
        Self
    }
}

impl N8nNode for CryptoNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.crypto"
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        Box::pin(async move {
            let action = ctx.parameters.get("action")
                .or_else(|| ctx.parameters.get("operation"))
                .and_then(|v| v.as_str())
                .unwrap_or("hash")
                .to_string();

            let target_field = ctx.parameters.get("dataPropertyName")
                .or_else(|| ctx.parameters.get("targetField"))
                .and_then(|v| v.as_str())
                .unwrap_or("data")
                .to_string();

            let algorithm = ctx.parameters.get("type")
                .or_else(|| ctx.parameters.get("algorithm"))
                .and_then(|v| v.as_str())
                .unwrap_or("SHA256")
                .to_uppercase();

            let items = if input_data.is_empty() {
                vec![INodeExecutionData::from_json(json!({}))]
            } else {
                input_data
            };

            let mut output_items = Vec::new();

            for mut item in items {
                let current_val = item.json.get(&target_field)
                    .map(|v| if v.is_string() { v.as_str().unwrap().to_string() } else { v.to_string() })
                    .unwrap_or_default();

                let mut out_obj = item.json.as_object().cloned().unwrap_or_default();

                match action.as_str() {
                    "uuid" | "generateUuid" => {
                        let id = uuid::Uuid::new_v4().to_string();
                        out_obj.insert(target_field.clone(), Value::String(id));
                    }
                    "hash" => {
                        let hashed = match algorithm.as_str() {
                            "SHA512" => {
                                let mut hasher = Sha512::new();
                                hasher.update(current_val.as_bytes());
                                format!("{:x}", hasher.finalize())
                            }
                            _ => {
                                let mut hasher = Sha256::new();
                                hasher.update(current_val.as_bytes());
                                format!("{:x}", hasher.finalize())
                            }
                        };
                        out_obj.insert(target_field.clone(), Value::String(hashed));
                    }
                    "base64_encode" | "encodeBase64" => {
                        let encoded = BASE64_STANDARD.encode(current_val.as_bytes());
                        out_obj.insert(target_field.clone(), Value::String(encoded));
                    }
                    "base64_decode" | "decodeBase64" => {
                        let decoded = BASE64_STANDARD.decode(current_val.as_bytes())
                            .map(|b| String::from_utf8_lossy(&b).to_string())
                            .unwrap_or_default();
                        out_obj.insert(target_field.clone(), Value::String(decoded));
                    }
                    _ => {
                        let id = uuid::Uuid::new_v4().to_string();
                        out_obj.insert(target_field.clone(), Value::String(id));
                    }
                }

                item.json = Value::Object(out_obj);
                output_items.push(item);
            }

            Ok(vec![output_items])
        })
    }
}
