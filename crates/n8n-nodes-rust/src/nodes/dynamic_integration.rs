use async_trait::async_trait;
use reqwest::{Client, Method};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

use crate::traits::{
    INodeExecutionData, N8nNode, NodeExecutionContext, NodeExecutionError, NodeTypeDescription,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthType {
    None,
    Bearer(String),
    ApiKey { header: String, value: String },
    Basic { user: String, pass: String },
    QueryParam { key: String, value: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IntegrationSpec {
    pub base_url: String,
    pub path: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub query: HashMap<String, String>,
    pub body: Option<Value>,
    pub auth: AuthType,
}

/// Tier 2 Declarative Integration IR
/// Sesuai audit ChatGPT:
/// - Tidak ada fallback 'httpbin.org'
/// - Network error diperlakukan sebagai ExecutionFailed, bukan sukses palsu
/// - Hanya menangani integrasi deklaratif eksplisit
pub struct DynamicIntegrationNode {
    pub client: Client,
}

impl DynamicIntegrationNode {
    pub fn new() -> Self {
        Self {
            client: Client::builder()
                .pool_max_idle_per_host(50)
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .unwrap_or_else(|_| Client::new()),
        }
    }

    /// Compile parameter dinamis n8n menjadi IntegrationSpec IR
    pub fn compile_spec(
        &self,
        node_type: &str,
        params: &HashMap<String, Value>,
    ) -> Result<IntegrationSpec, NodeExecutionError> {
        let mut spec = IntegrationSpec {
            base_url: String::new(),
            path: String::new(),
            method: "POST".to_string(),
            headers: HashMap::new(),
            query: HashMap::new(),
            body: None,
            auth: AuthType::None,
        };

        match node_type {
            // 1. Integrasi Telegram
            "n8n-nodes-base.telegram" | "telegram" => {
                let token = params
                    .get("botToken")
                    .or_else(|| params.get("accessToken"))
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        NodeExecutionError::MissingParameter("botToken is required for Telegram".into())
                    })?;
                let operation = params
                    .get("operation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("sendMessage");

                spec.base_url = format!("https://api.telegram.org/bot{}", token);
                spec.path = format!("/{}", operation);
                spec.method = "POST".to_string();

                let mut body_map = serde_json::Map::new();
                if let Some(chat_id) = params.get("chatId") {
                    body_map.insert("chat_id".to_string(), chat_id.clone());
                }
                if let Some(text) = params.get("text") {
                    body_map.insert("text".to_string(), text.clone());
                }
                spec.body = Some(Value::Object(body_map));
            }

            // 2. Integrasi Slack
            "n8n-nodes-base.slack" | "slack" => {
                let token = params
                    .get("accessToken")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        NodeExecutionError::MissingParameter("accessToken is required for Slack".into())
                    })?;
                let operation = params
                    .get("operation")
                    .and_then(|v| v.as_str())
                    .unwrap_or("postMessage");

                spec.base_url = "https://slack.com/api".to_string();
                spec.path = match operation {
                    "postMessage" => "/chat.postMessage".to_string(),
                    _ => format!("/{}", operation),
                };
                spec.method = "POST".to_string();
                spec.auth = AuthType::Bearer(token.to_string());
                spec.headers.insert(
                    "Content-Type".to_string(),
                    "application/json; charset=utf-8".to_string(),
                );

                let mut body_map = serde_json::Map::new();
                if let Some(channel) = params.get("channel") {
                    body_map.insert("channel".to_string(), channel.clone());
                }
                if let Some(text) = params.get("text") {
                    body_map.insert("text".to_string(), text.clone());
                }
                spec.body = Some(Value::Object(body_map));
            }

            // 3. Integrasi Discord Webhook
            "n8n-nodes-base.discord" | "discord" => {
                let webhook_url = params
                    .get("webhookUrl")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        NodeExecutionError::MissingParameter("webhookUrl is required for Discord".into())
                    })?;
                spec.base_url = webhook_url.to_string();
                spec.method = "POST".to_string();

                let mut body_map = serde_json::Map::new();
                if let Some(content) = params.get("content").or_else(|| params.get("text")) {
                    body_map.insert("content".to_string(), content.clone());
                }
                spec.body = Some(Value::Object(body_map));
            }

            // 4. HTTP Request Eksplisit
            "n8n-nodes-base.httpRequest" | "httpRequest" => {
                let target_url = params
                    .get("url")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| {
                        NodeExecutionError::MissingParameter("url parameter is required".into())
                    })?;
                spec.base_url = target_url.to_string();
                spec.method = params
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("GET")
                    .to_uppercase();

                if let Some(body_val) = params.get("body") {
                    spec.body = Some(body_val.clone());
                }
            }

            // PERBAIKAN AUDIT: Hapus fallback 'httpbin.org'. Jika node tidak didukung, laporkan error eksplisit!
            unsupported => {
                return Err(NodeExecutionError::InvalidParameter(format!(
                    "Node '{}' belum didukung oleh Declarative Integration IR (membutuhkan Node Compatibility Worker)",
                    unsupported
                )));
            }
        }

        Ok(spec)
    }
}

impl Default for DynamicIntegrationNode {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl N8nNode for DynamicIntegrationNode {
    fn description(&self) -> NodeTypeDescription {
        NodeTypeDescription {
            name: "n8n-nodes-base.dynamicProxy".to_string(),
            display_name: "Declarative Integration Proxy".to_string(),
            description: "High-throughput declarative REST integration execution via reqwest".to_string(),
            version: 1.0,
            inputs: vec!["main".to_string()],
            outputs: vec!["main".to_string()],
            translation: None,
        }
    }

    async fn execute(
        &self,
        context: &NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError> {
        let items = if input_data.is_empty() {
            vec![INodeExecutionData::from_json(json!({}))]
        } else {
            input_data
        };

        let original_node_type = context
            .parameters
            .get("originalNodeType")
            .and_then(|v| v.as_str())
            .unwrap_or("n8n-nodes-base.httpRequest");

        // Compile parameters into Declarative Spec IR (Gagal jika parameter tidak valid)
        let spec = self.compile_spec(original_node_type, &context.parameters)?;

        let mut output_items = Vec::new();

        for (idx, item) in items.into_iter().enumerate() {
            let mut url = if spec.path.is_empty() {
                spec.base_url.clone()
            } else {
                format!("{}{}", spec.base_url.trim_end_matches('/'), spec.path)
            };

            // Query parameter handling
            let mut query_params = spec.query.clone();
            if let AuthType::QueryParam { ref key, ref value } = spec.auth {
                query_params.insert(key.clone(), value.clone());
            }

            if !query_params.is_empty() {
                let qs: Vec<String> = query_params
                    .iter()
                    .map(|(k, v)| format!("{}={}", k, v))
                    .collect();
                let separator = if url.contains('?') { "&" } else { "?" };
                url = format!("{}{}{}", url, separator, qs.join("&"));
            }

            let method = match spec.method.as_str() {
                "POST" => Method::POST,
                "PUT" => Method::PUT,
                "DELETE" => Method::DELETE,
                "PATCH" => Method::PATCH,
                _ => Method::GET,
            };

            let mut req_builder = self.client.request(method, &url);

            for (k, v) in &spec.headers {
                req_builder = req_builder.header(k, v);
            }

            match &spec.auth {
                AuthType::Bearer(token) => {
                    req_builder = req_builder.bearer_auth(token);
                }
                AuthType::ApiKey { header, value } => {
                    req_builder = req_builder.header(header, value);
                }
                AuthType::Basic { user, pass } => {
                    req_builder = req_builder.basic_auth(user, Some(pass));
                }
                AuthType::None | AuthType::QueryParam { .. } => {}
            }

            if let Some(ref body) = spec.body {
                req_builder = req_builder.json(body);
            }

            // PERBAIKAN AUDIT: Network error dikembalikan sebagai error nyata, bukan fake success!
            let resp = req_builder.send().await.map_err(|e| {
                NodeExecutionError::ExecutionFailed(format!("Network request failed: {}", e))
            })?;

            let text = resp.text().await.unwrap_or_default();
            let parsed_json: Value = serde_json::from_str(&text).unwrap_or_else(|_| {
                json!({ "raw": text })
            });

            output_items.push(INodeExecutionData {
                json: parsed_json,
                paired_item: item.paired_item.or_else(|| Some(json!({ "item": idx }))),
                binary: None,
            });
        }

        Ok(vec![output_items])
    }
}
