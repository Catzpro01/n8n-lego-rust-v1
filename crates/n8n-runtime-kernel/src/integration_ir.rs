//! Integration IR — Declarative Integration Intermediate Representation for SaaS & HTTP APIs.
//!
//! Replaces legacy JavaScript compatibility workers with high-performance,
//! declarative execution of HTTP requests, authentication resolution,
//! automatic pagination, rate-limiting backoff, and JSON response extraction.

use base64::Engine;
use n8n_common::INodeExecutionData;
use n8n_node_model::INode;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::RwLock;

/// Errors produced during integration specification compilation or execution.
#[derive(Debug, thiserror::Error)]
pub enum IntegrationError {
    #[error("HTTP client error: {0}")]
    RequestError(#[from] reqwest::Error),

    #[error("HTTP error response {status}: {body}")]
    HttpError { status: u16, body: String },

    #[error("Authentication error: {0}")]
    AuthError(String),

    #[error("Serialization error: {0}")]
    Serialization(#[from] serde_json::Error),

    #[error("Invalid integration specification: {0}")]
    InvalidSpec(String),

    #[error("Rate limit exceeded after {0} attempts")]
    RateLimitExceeded(u32),

    #[error("Pagination error: {0}")]
    PaginationError(String),
}

/// Authentication specification for declarative integrations.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AuthSpec {
    None,
    Bearer {
        token_template: String,
    },
    ApiKey {
        header_name: String,
        key_template: String,
    },
    QueryApiKey {
        param_name: String,
        key_template: String,
    },
    BasicAuth {
        user_template: String,
        pass_template: String,
    },
    CredentialRef {
        credential_id: String,
        credential_type: Option<String>,
    },
}

impl Default for AuthSpec {
    fn default() -> Self {
        Self::None
    }
}

/// Automatic pagination policies for paginated REST APIs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PaginationPolicy {
    /// No pagination (single request only).
    None,
    /// Offset-based pagination with offset and limit parameters.
    Offset {
        offset_param: String,
        limit_param: String,
        limit: usize,
        max_pages: usize,
    },
    /// Cursor-based pagination extracting a token from response body.
    Cursor {
        cursor_path: String,
        param_name: String,
        max_pages: usize,
    },
    /// Next-page URL pagination reading the direct next link from response body.
    NextPageUrl {
        url_path: String,
        max_pages: usize,
    },
}

impl Default for PaginationPolicy {
    fn default() -> Self {
        Self::None
    }
}

impl PaginationPolicy {
    pub fn offset(limit: usize, max_pages: usize) -> Self {
        Self::Offset {
            offset_param: "offset".to_string(),
            limit_param: "limit".to_string(),
            limit,
            max_pages,
        }
    }

    pub fn cursor(cursor_path: impl Into<String>, param_name: impl Into<String>, max_pages: usize) -> Self {
        Self::Cursor {
            cursor_path: cursor_path.into(),
            param_name: param_name.into(),
            max_pages,
        }
    }

    pub fn next_page_url(url_path: impl Into<String>, max_pages: usize) -> Self {
        Self::NextPageUrl {
            url_path: url_path.into(),
            max_pages,
        }
    }
}

/// Rate limiting and exponential backoff retry policy.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RateLimitPolicy {
    /// Maximum retry attempts on 429 or 503 responses.
    pub max_retries: u32,
    /// Initial backoff delay in milliseconds.
    pub initial_delay_ms: u64,
    /// Exponential backoff multiplier.
    pub backoff_multiplier: f64,
    /// Maximum backoff ceiling in milliseconds.
    pub max_delay_ms: u64,
    /// Whether to honor `Retry-After` header when provided by upstream.
    pub honor_retry_after: bool,
}

impl Default for RateLimitPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_delay_ms: 200,
            backoff_multiplier: 2.0,
            max_delay_ms: 10_000,
            honor_retry_after: true,
        }
    }
}

impl RateLimitPolicy {
    pub fn compute_backoff(&self, attempt: u32, retry_after_header: Option<&str>) -> Duration {
        if self.honor_retry_after {
            if let Some(header) = retry_after_header {
                if let Ok(secs) = header.trim().parse::<u64>() {
                    let ms = (secs * 1000).min(self.max_delay_ms);
                    return Duration::from_millis(ms);
                }
            }
        }

        if attempt == 0 || self.max_retries <= 1 {
            return Duration::ZERO;
        }

        let exponent = (attempt.saturating_sub(1)) as f64;
        let factor = self.backoff_multiplier.powf(exponent);
        let delay_ms = (self.initial_delay_ms as f64 * factor) as u64;
        Duration::from_millis(delay_ms.min(self.max_delay_ms))
    }

    pub fn should_retry(&self, status: u16, attempt: u32) -> bool {
        attempt < self.max_retries && (status == 429 || status == 503 || status == 502 || status == 504)
    }
}

/// JSON path and selector extractor converting API responses to `INodeExecutionData`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ResponseExtractor {
    /// JSON Pointer (e.g. "/data" or "/items") or dot notation ("data.items").
    pub root_path: Option<String>,
    /// If target value is an array, whether to split into discrete items.
    pub split_into_items: bool,
}

impl Default for ResponseExtractor {
    fn default() -> Self {
        Self {
            root_path: None,
            split_into_items: true,
        }
    }
}

impl ResponseExtractor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_root_path(mut self, path: impl Into<String>) -> Self {
        self.root_path = Some(path.into());
        self
    }

    pub fn extract(&self, body: &serde_json::Value) -> Vec<INodeExecutionData> {
        let target = if let Some(ref path) = self.root_path {
            extract_path(body, path).unwrap_or(body)
        } else {
            body
        };

        if self.split_into_items {
            if let serde_json::Value::Array(arr) = target {
                return arr
                    .iter()
                    .map(|elem| INodeExecutionData {
                        json: elem.clone(),
                        binary: None,
                        paired_item: None,
                    })
                    .collect();
            }
        }

        vec![INodeExecutionData {
            json: target.clone(),
            binary: None,
            paired_item: None,
        }]
    }
}

/// Declarative specification of an external HTTP/SaaS integration request.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IntegrationSpec {
    /// HTTP method (GET, POST, PUT, DELETE, PATCH, etc.).
    pub method: String,
    /// URL template with interpolation placeholders.
    pub url_template: String,
    /// Headers with interpolation placeholders.
    pub headers: HashMap<String, String>,
    /// Query parameters with interpolation placeholders.
    pub query_params: HashMap<String, String>,
    /// Optional JSON body template.
    pub body_template: Option<serde_json::Value>,
    /// Authentication specification.
    pub auth: AuthSpec,
    /// Automatic pagination policy.
    pub pagination: PaginationPolicy,
    /// Rate limit and backoff policy.
    pub rate_limit: RateLimitPolicy,
    /// Response extractor policy.
    pub response_extractor: ResponseExtractor,
}

impl IntegrationSpec {
    pub fn new(method: impl Into<String>, url_template: impl Into<String>) -> Self {
        Self {
            method: method.into().to_uppercase(),
            url_template: url_template.into(),
            headers: HashMap::new(),
            query_params: HashMap::new(),
            body_template: None,
            auth: AuthSpec::None,
            pagination: PaginationPolicy::None,
            rate_limit: RateLimitPolicy::default(),
            response_extractor: ResponseExtractor::default(),
        }
    }

    pub fn with_header(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(key.into(), value.into());
        self
    }

    pub fn with_query_param(mut self, key: impl Into<String>, value: impl Into<String>) -> Self {
        self.query_params.insert(key.into(), value.into());
        self
    }

    pub fn with_body_template(mut self, body: serde_json::Value) -> Self {
        self.body_template = Some(body);
        self
    }

    pub fn with_auth(mut self, auth: AuthSpec) -> Self {
        self.auth = auth;
        self
    }

    pub fn with_pagination(mut self, pagination: PaginationPolicy) -> Self {
        self.pagination = pagination;
        self
    }

    pub fn with_rate_limit(mut self, rate_limit: RateLimitPolicy) -> Self {
        self.rate_limit = rate_limit;
        self
    }

    pub fn with_response_extractor(mut self, extractor: ResponseExtractor) -> Self {
        self.response_extractor = extractor;
        self
    }

    /// Compiles an `INode` configuration into a declarative `IntegrationSpec` if supported.
    pub fn from_node(node: &INode) -> Option<Self> {
        // 1. Direct explicit integrationSpec in parameters
        if let Some(val) = node.parameters.0.get("integrationSpec") {
            if let Ok(spec) = serde_json::from_value::<IntegrationSpec>(val.clone()) {
                return Some(spec);
            }
        }

        // 2. Direct explicit integrationSpec in extra fields
        if let Some(val) = node.extra.get("integrationSpec") {
            if let Ok(spec) = serde_json::from_value::<IntegrationSpec>(val.clone()) {
                return Some(spec);
            }
        }

        let ntype = node.node_type.as_str();

        // 3. Official n8n HTTP Request node
        if ntype == "n8n-nodes-base.httpRequest" || ntype == "httpRequest" {
            let url = node.parameters.0.get("url").and_then(|v| v.as_str())?;
            let method = node
                .parameters
                .0
                .get("method")
                .or_else(|| node.parameters.0.get("requestMethod"))
                .and_then(|v| v.as_str())
                .unwrap_or("GET");

            let mut spec = IntegrationSpec::new(method, url);

            if let Some(headers_obj) = node.parameters.0.get("headers").and_then(|v| v.as_object()) {
                for (k, v) in headers_obj {
                    if let Some(s) = v.as_str() {
                        spec = spec.with_header(k, s);
                    }
                }
            }

            if let Some(query_obj) = node
                .parameters
                .0
                .get("query")
                .or_else(|| node.parameters.0.get("queryParameters"))
                .and_then(|v| v.as_object())
            {
                for (k, v) in query_obj {
                    if let Some(s) = v.as_str() {
                        spec = spec.with_query_param(k, s);
                    }
                }
            }

            if let Some(body_val) = node.parameters.0.get("body") {
                spec = spec.with_body_template(body_val.clone());
            }

            // Extract credentials from node.extra or node.parameters
            if let Some(creds) = node.extra.get("credentials").and_then(|v| v.as_object()) {
                for (cred_type, cred_obj) in creds {
                    if let Some(id) = cred_obj.get("id").and_then(|v| v.as_str()) {
                        spec = spec.with_auth(AuthSpec::CredentialRef {
                            credential_id: id.to_string(),
                            credential_type: Some(cred_type.clone()),
                        });
                        break;
                    }
                }
            }

            return Some(spec);
        }

        // 4. Slack API Declarative mapping
        if ntype == "n8n-nodes-base.slack" || ntype == "slack" {
            let operation = node
                .parameters
                .0
                .get("operation")
                .and_then(|v| v.as_str())
                .unwrap_or("postMessage");

            let path = match operation {
                "postMessage" => "/chat.postMessage",
                other => other,
            };

            let mut spec = IntegrationSpec::new("POST", format!("https://slack.com/api{}", path))
                .with_header("Content-Type", "application/json; charset=utf-8");

            if let Some(token) = node.parameters.0.get("accessToken").and_then(|v| v.as_str()) {
                spec = spec.with_auth(AuthSpec::Bearer {
                    token_template: token.to_string(),
                });
            }

            let mut body_map = serde_json::Map::new();
            if let Some(channel) = node.parameters.0.get("channel") {
                body_map.insert("channel".to_string(), channel.clone());
            }
            if let Some(text) = node.parameters.0.get("text") {
                body_map.insert("text".to_string(), text.clone());
            }
            spec = spec.with_body_template(serde_json::Value::Object(body_map));
            return Some(spec);
        }

        // 5. Telegram API Declarative mapping
        if ntype == "n8n-nodes-base.telegram" || ntype == "telegram" {
            let token = node
                .parameters
                .0
                .get("botToken")
                .or_else(|| node.parameters.0.get("accessToken"))
                .and_then(|v| v.as_str())
                .unwrap_or("{{botToken}}");

            let op = node
                .parameters
                .0
                .get("operation")
                .and_then(|v| v.as_str())
                .unwrap_or("sendMessage");

            let url = format!("https://api.telegram.org/bot{}/{}", token, op);
            let mut spec = IntegrationSpec::new("POST", url)
                .with_header("Content-Type", "application/json");

            let mut body_map = serde_json::Map::new();
            if let Some(chat_id) = node.parameters.0.get("chatId") {
                body_map.insert("chat_id".to_string(), chat_id.clone());
            }
            if let Some(text) = node.parameters.0.get("text") {
                body_map.insert("text".to_string(), text.clone());
            }
            spec = spec.with_body_template(serde_json::Value::Object(body_map));
            return Some(spec);
        }

        // 6. Discord Webhook mapping
        if ntype == "n8n-nodes-base.discord" || ntype == "discord" {
            if let Some(webhook_url) = node.parameters.0.get("webhookUrl").and_then(|v| v.as_str()) {
                let mut spec = IntegrationSpec::new("POST", webhook_url)
                    .with_header("Content-Type", "application/json");

                let mut body_map = serde_json::Map::new();
                if let Some(content) = node
                    .parameters
                    .0
                    .get("content")
                    .or_else(|| node.parameters.0.get("text"))
                {
                    body_map.insert("content".to_string(), content.clone());
                }
                spec = spec.with_body_template(serde_json::Value::Object(body_map));
                return Some(spec);
            }
        }

        None
    }
}

/// Resolved headers and query parameters from an `AuthSpec`.
#[derive(Debug, Default, Clone)]
pub struct ResolvedAuth {
    pub headers: Vec<(String, String)>,
    pub query_params: Vec<(String, String)>,
}

/// Resolves authentication credentials from `n8n-credentials` vault and in-memory stores.
#[derive(Debug, Default)]
pub struct AuthResolver {
    credentials: Arc<RwLock<HashMap<String, serde_json::Value>>>,
}

impl AuthResolver {
    pub fn new() -> Self {
        Self {
            credentials: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Registers a plaintext credential JSON value into the resolver cache.
    pub async fn register_credential(&self, id: impl Into<String>, data: serde_json::Value) {
        let mut lock = self.credentials.write().await;
        lock.insert(id.into(), data);
    }

    /// Registers a decrypted credential from `n8n_credentials::DecryptedCredential`.
    pub async fn register_decrypted(&self, cred: &n8n_credentials::DecryptedCredential) {
        let mut lock = self.credentials.write().await;
        lock.insert(cred.id.clone(), cred.data.clone());
        lock.insert(cred.name.clone(), cred.data.clone());
    }

    /// Resolves an `AuthSpec` against input item and runtime context.
    pub async fn resolve(
        &self,
        auth_spec: &AuthSpec,
        item: &INodeExecutionData,
        context_params: &HashMap<String, serde_json::Value>,
    ) -> Result<ResolvedAuth, IntegrationError> {
        match auth_spec {
            AuthSpec::None => Ok(ResolvedAuth::default()),

            AuthSpec::Bearer { token_template } => {
                let token = interpolate_str(token_template, &item.json, context_params);
                Ok(ResolvedAuth {
                    headers: vec![("Authorization".to_string(), format!("Bearer {}", token))],
                    query_params: vec![],
                })
            }

            AuthSpec::ApiKey {
                header_name,
                key_template,
            } => {
                let key = interpolate_str(key_template, &item.json, context_params);
                Ok(ResolvedAuth {
                    headers: vec![(header_name.clone(), key)],
                    query_params: vec![],
                })
            }

            AuthSpec::QueryApiKey {
                param_name,
                key_template,
            } => {
                let key = interpolate_str(key_template, &item.json, context_params);
                Ok(ResolvedAuth {
                    headers: vec![],
                    query_params: vec![(param_name.clone(), key)],
                })
            }

            AuthSpec::BasicAuth {
                user_template,
                pass_template,
            } => {
                let user = interpolate_str(user_template, &item.json, context_params);
                let pass = interpolate_str(pass_template, &item.json, context_params);
                let raw = format!("{}:{}", user, pass);
                let encoded = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
                Ok(ResolvedAuth {
                    headers: vec![("Authorization".to_string(), format!("Basic {}", encoded))],
                    query_params: vec![],
                })
            }

            AuthSpec::CredentialRef {
                credential_id,
                credential_type: _,
            } => {
                let lock = self.credentials.read().await;
                let cred_val = lock.get(credential_id).cloned().ok_or_else(|| {
                    IntegrationError::AuthError(format!(
                        "Credential with ID '{}' not found in credentials store",
                        credential_id
                    ))
                })?;

                let mut headers = Vec::new();
                let mut query = Vec::new();

                if let Some(token) = cred_val
                    .get("token")
                    .or_else(|| cred_val.get("accessToken"))
                    .and_then(|v| v.as_str())
                {
                    headers.push(("Authorization".to_string(), format!("Bearer {}", token)));
                } else if let Some(api_key) = cred_val
                    .get("apiKey")
                    .or_else(|| cred_val.get("api_key"))
                    .and_then(|v| v.as_str())
                {
                    let header_name = cred_val
                        .get("headerName")
                        .and_then(|v| v.as_str())
                        .unwrap_or("X-API-Key");
                    headers.push((header_name.to_string(), api_key.to_string()));
                } else if let (Some(user), Some(pass)) = (
                    cred_val
                        .get("user")
                        .or_else(|| cred_val.get("username"))
                        .and_then(|v| v.as_str()),
                    cred_val
                        .get("password")
                        .or_else(|| cred_val.get("pass"))
                        .and_then(|v| v.as_str()),
                ) {
                    let raw = format!("{}:{}", user, pass);
                    let encoded = base64::engine::general_purpose::STANDARD.encode(raw.as_bytes());
                    headers.push(("Authorization".to_string(), format!("Basic {}", encoded)));
                } else if let Some(key_param) = cred_val.get("queryParam").and_then(|v| v.as_str()) {
                    if let Some(val) = cred_val.get("value").and_then(|v| v.as_str()) {
                        query.push((key_param.to_string(), val.to_string()));
                    }
                }

                Ok(ResolvedAuth {
                    headers,
                    query_params: query,
                })
            }
        }
    }
}

/// High-throughput declarative HTTP integration executor without JavaScript overhead.
pub struct IntegrationExecutor {
    client: reqwest::Client,
    auth_resolver: Arc<AuthResolver>,
}

impl Default for IntegrationExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl IntegrationExecutor {
    /// Creates a new IntegrationExecutor with standard connection pooling.
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .pool_max_idle_per_host(50)
            .timeout(Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            client,
            auth_resolver: Arc::new(AuthResolver::new()),
        }
    }

    /// Sets explicit AuthResolver.
    pub fn with_auth_resolver(mut self, resolver: Arc<AuthResolver>) -> Self {
        self.auth_resolver = resolver;
        self
    }

    /// Sets custom reqwest Client.
    pub fn with_client(mut self, client: reqwest::Client) -> Self {
        self.client = client;
        self
    }

    /// Access underlying AuthResolver.
    pub fn auth_resolver(&self) -> &Arc<AuthResolver> {
        &self.auth_resolver
    }

    /// Executes a declarative `IntegrationSpec` against an input data item.
    pub async fn execute_spec(
        &self,
        spec: &IntegrationSpec,
        item: &INodeExecutionData,
        context_params: &HashMap<String, serde_json::Value>,
    ) -> Result<Vec<INodeExecutionData>, IntegrationError> {
        let base_url = interpolate_str(&spec.url_template, &item.json, context_params);
        let method = parse_http_method(&spec.method);

        // Resolve Auth
        let resolved_auth = self
            .auth_resolver
            .resolve(&spec.auth, item, context_params)
            .await?;

        // Base Headers
        let mut headers = HashMap::new();
        for (k, v) in &spec.headers {
            let ik = interpolate_str(k, &item.json, context_params);
            let iv = interpolate_str(v, &item.json, context_params);
            headers.insert(ik, iv);
        }
        for (k, v) in resolved_auth.headers {
            headers.insert(k, v);
        }

        // Base Query Params
        let mut query_params = HashMap::new();
        for (k, v) in &spec.query_params {
            let ik = interpolate_str(k, &item.json, context_params);
            let iv = interpolate_str(v, &item.json, context_params);
            query_params.insert(ik, iv);
        }
        for (k, v) in resolved_auth.query_params {
            query_params.insert(k, v);
        }

        // Base Body
        let resolved_body = spec
            .body_template
            .as_ref()
            .map(|b| interpolate_json(b, &item.json, context_params));

        let mut accumulated_items = Vec::new();
        let mut page_idx = 0;
        let mut current_url = base_url;
        let mut current_query = query_params;

        loop {
            let mut attempt = 0;
            let resp_text = loop {
                attempt += 1;
                let mut req = self.client.request(method.clone(), &current_url);

                for (hk, hv) in &headers {
                    req = req.header(hk, hv);
                }
                for (qk, qv) in &current_query {
                    req = req.query(&[(qk, qv)]);
                }
                if let Some(ref body) = resolved_body {
                    req = req.json(body);
                }

                match req.send().await {
                    Ok(resp) => {
                        let status = resp.status().as_u16();
                        if spec.rate_limit.should_retry(status, attempt) {
                            let retry_header = resp
                                .headers()
                                .get("retry-after")
                                .and_then(|v| v.to_str().ok());
                            let backoff = spec.rate_limit.compute_backoff(attempt, retry_header);
                            tokio::time::sleep(backoff).await;
                            continue;
                        }

                        if !resp.status().is_success() {
                            let err_text = resp.text().await.unwrap_or_default();
                            return Err(IntegrationError::HttpError {
                                status,
                                body: err_text,
                            });
                        }

                        let text = resp.text().await?;
                        break text;
                    }
                    Err(err) => {
                        if attempt < spec.rate_limit.max_retries {
                            let backoff = spec.rate_limit.compute_backoff(attempt, None);
                            tokio::time::sleep(backoff).await;
                            continue;
                        }
                        return Err(IntegrationError::RequestError(err));
                    }
                }
            };

            // Parse response body to JSON
            let resp_json: serde_json::Value = serde_json::from_str(&resp_text)
                .unwrap_or_else(|_| serde_json::json!({ "text": resp_text }));

            // Extract items
            let page_items = spec.response_extractor.extract(&resp_json);
            let items_count = page_items.len();
            accumulated_items.extend(page_items);

            page_idx += 1;

            // Handle Pagination
            match &spec.pagination {
                PaginationPolicy::None => break,

                PaginationPolicy::Offset {
                    offset_param,
                    limit_param,
                    limit,
                    max_pages,
                } => {
                    if page_idx >= *max_pages || items_count < *limit {
                        break;
                    }
                    let next_offset = page_idx * limit;
                    current_query.insert(offset_param.clone(), next_offset.to_string());
                    current_query.insert(limit_param.clone(), limit.to_string());
                }

                PaginationPolicy::Cursor {
                    cursor_path,
                    param_name,
                    max_pages,
                } => {
                    if page_idx >= *max_pages {
                        break;
                    }
                    let cursor_val = extract_path(&resp_json, cursor_path);
                    match cursor_val {
                        Some(serde_json::Value::String(c)) if !c.is_empty() => {
                            current_query.insert(param_name.clone(), c.clone());
                        }
                        _ => break,
                    }
                }

                PaginationPolicy::NextPageUrl { url_path, max_pages } => {
                    if page_idx >= *max_pages {
                        break;
                    }
                    let next_url = extract_path(&resp_json, url_path);
                    match next_url {
                        Some(serde_json::Value::String(u)) if !u.is_empty() => {
                            current_url = u.clone();
                        }
                        _ => break,
                    }
                }
            }
        }

        Ok(accumulated_items)
    }
}

/// Helper extracting value via JSON pointer or dot notation.
fn extract_path<'a>(value: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Some(value);
    }

    if trimmed.starts_with('/') {
        if let Some(v) = value.pointer(trimmed) {
            return Some(v);
        }
    }

    let mut current = value;
    for part in trimmed.split('.').filter(|s| !s.is_empty()) {
        match current {
            serde_json::Value::Object(map) => {
                if let Some(next) = map.get(part) {
                    current = next;
                } else {
                    return None;
                }
            }
            serde_json::Value::Array(arr) => {
                if let Ok(idx) = part.parse::<usize>() {
                    if let Some(next) = arr.get(idx) {
                        current = next;
                    } else {
                        return None;
                    }
                } else {
                    return None;
                }
            }
            _ => return None,
        }
    }

    Some(current)
}

/// Replaces placeholders like `{{key}}`, `{key}`, `{{json.key}}`, `{{$json.key}}`
/// with values from item json and parameters.
pub fn interpolate_str(
    template: &str,
    item_json: &serde_json::Value,
    extra_params: &HashMap<String, serde_json::Value>,
) -> String {
    let mut result = template.to_string();

    // 1. Process double curly braces `{{...}}`
    while let Some(start) = result.find("{{") {
        if let Some(end_offset) = result[start + 2..].find("}}") {
            let end = start + 2 + end_offset;
            let raw_key = result[start + 2..end].trim();
            let key = raw_key
                .strip_prefix("$json.")
                .or_else(|| raw_key.strip_prefix("json."))
                .unwrap_or(raw_key);

            let val_str = resolve_key_value(key, item_json, extra_params);
            result.replace_range(start..end + 2, &val_str);
        } else {
            break;
        }
    }

    // 2. Process single curly braces `{...}` for URI path templates
    let mut idx = 0;
    while let Some(start) = result[idx..].find('{') {
        let abs_start = idx + start;
        if let Some(end_offset) = result[abs_start + 1..].find('}') {
            let abs_end = abs_start + 1 + end_offset;
            let key = result[abs_start + 1..abs_end].trim();
            if !key.contains('{') && !key.contains('}') && !key.is_empty() {
                let val_str = resolve_key_value(key, item_json, extra_params);
                result.replace_range(abs_start..abs_end + 1, &val_str);
                idx = abs_start + val_str.len();
            } else {
                idx = abs_start + 1;
            }
        } else {
            break;
        }
    }

    result
}

fn resolve_key_value(
    key: &str,
    item_json: &serde_json::Value,
    extra_params: &HashMap<String, serde_json::Value>,
) -> String {
    if let Some(v) = extract_path(item_json, key) {
        return value_to_string(v);
    }
    if let Some(v) = extra_params.get(key) {
        return value_to_string(v);
    }
    String::new()
}

fn value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// Recursively interpolates string templates inside arbitrary JSON objects/arrays.
pub fn interpolate_json(
    template: &serde_json::Value,
    item_json: &serde_json::Value,
    extra_params: &HashMap<String, serde_json::Value>,
) -> serde_json::Value {
    match template {
        serde_json::Value::String(s) => {
            let interp = interpolate_str(s, item_json, extra_params);
            if (s.starts_with("{{") && s.ends_with("}}")) || (s.starts_with('{') && s.ends_with('}')) {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&interp) {
                    return parsed;
                }
            }
            serde_json::Value::String(interp)
        }
        serde_json::Value::Array(arr) => serde_json::Value::Array(
            arr.iter()
                .map(|elem| interpolate_json(elem, item_json, extra_params))
                .collect(),
        ),
        serde_json::Value::Object(map) => {
            let mut new_map = serde_json::Map::new();
            for (k, v) in map {
                let ik = interpolate_str(k, item_json, extra_params);
                let iv = interpolate_json(v, item_json, extra_params);
                new_map.insert(ik, iv);
            }
            serde_json::Value::Object(new_map)
        }
        other => other.clone(),
    }
}

fn parse_http_method(m: &str) -> reqwest::Method {
    match m.to_uppercase().as_str() {
        "POST" => reqwest::Method::POST,
        "PUT" => reqwest::Method::PUT,
        "DELETE" => reqwest::Method::DELETE,
        "PATCH" => reqwest::Method::PATCH,
        "HEAD" => reqwest::Method::HEAD,
        "OPTIONS" => reqwest::Method::OPTIONS,
        _ => reqwest::Method::GET,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn test_interpolation_str_and_json() {
        let item = json!({
            "user": {
                "id": 42,
                "name": "Alice"
            },
            "category": "engineering"
        });

        let mut params = HashMap::new();
        params.insert("env".to_string(), json!("prod"));

        let template_url = "https://api.example.com/{user.id}/items?env={{env}}&cat={{category}}";
        let resolved = interpolate_str(template_url, &item, &params);
        assert_eq!(resolved, "https://api.example.com/42/items?env=prod&cat=engineering");

        let body_tmpl = json!({
            "target": "{{user.name}}",
            "userId": "{{user.id}}",
            "active": true
        });
        let resolved_body = interpolate_json(&body_tmpl, &item, &params);
        assert_eq!(resolved_body["target"], "Alice");
        assert_eq!(resolved_body["userId"], 42);
        assert_eq!(resolved_body["active"], true);
    }

    #[test]
    fn test_response_extractor_path_and_array_split() {
        let extractor = ResponseExtractor::new().with_root_path("/data/users");
        let body = json!({
            "status": "success",
            "data": {
                "users": [
                    { "id": 1, "name": "Bob" },
                    { "id": 2, "name": "Charlie" }
                ]
            }
        });

        let items = extractor.extract(&body);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].json["name"], "Bob");
        assert_eq!(items[1].json["name"], "Charlie");
    }

    #[tokio::test]
    async fn test_auth_resolver_bearer_and_credentials() {
        let resolver = AuthResolver::new();
        resolver
            .register_credential("cred-slack", json!({ "accessToken": "xoxb-test-token" }))
            .await;

        let item = INodeExecutionData {
            json: json!({ "apiKey": "sk-live-999" }),
            binary: None,
            paired_item: None,
        };

        let params = HashMap::new();

        // 1. Direct Bearer
        let bearer_spec = AuthSpec::Bearer {
            token_template: "{{apiKey}}".to_string(),
        };
        let auth1 = resolver.resolve(&bearer_spec, &item, &params).await.unwrap();
        assert_eq!(auth1.headers[0], ("Authorization".to_string(), "Bearer sk-live-999".to_string()));

        // 2. Credential Reference
        let cred_spec = AuthSpec::CredentialRef {
            credential_id: "cred-slack".to_string(),
            credential_type: Some("slackOAuth2Api".to_string()),
        };
        let auth2 = resolver.resolve(&cred_spec, &item, &params).await.unwrap();
        assert_eq!(auth2.headers[0], ("Authorization".to_string(), "Bearer xoxb-test-token".to_string()));
    }

    #[tokio::test]
    async fn test_rate_limit_policy_computation() {
        let policy = RateLimitPolicy {
            max_retries: 3,
            initial_delay_ms: 100,
            backoff_multiplier: 2.0,
            max_delay_ms: 5000,
            honor_retry_after: true,
        };

        // Header Retry-After
        let delay_header = policy.compute_backoff(1, Some("3"));
        assert_eq!(delay_header, Duration::from_secs(3));

        // Exponential backoff
        assert_eq!(policy.compute_backoff(1, None), Duration::from_millis(100));
        assert_eq!(policy.compute_backoff(2, None), Duration::from_millis(200));
        assert_eq!(policy.compute_backoff(3, None), Duration::from_millis(400));

        assert!(policy.should_retry(429, 1));
        assert!(policy.should_retry(503, 2));
        assert!(!policy.should_retry(429, 3));
        assert!(!policy.should_retry(200, 1));
    }

    #[tokio::test]
    async fn test_integration_executor_with_mock_server() {
        // Spin up lightweight local mock HTTP server
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await.unwrap();

            let response_body = serde_json::to_string(&json!({
                "items": [
                    { "id": 101, "title": "Issue 1" },
                    { "id": 102, "title": "Issue 2" }
                ]
            }))
            .unwrap();

            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        });

        let spec = IntegrationSpec::new("GET", format!("http://127.0.0.1:{}/api/issues", port))
            .with_response_extractor(ResponseExtractor::new().with_root_path("items"));

        let executor = IntegrationExecutor::new();
        let item = INodeExecutionData {
            json: json!({}),
            binary: None,
            paired_item: None,
        };

        let results = executor.execute_spec(&spec, &item, &HashMap::new()).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].json["id"], 101);
        assert_eq!(results[1].json["id"], 102);
    }

    #[tokio::test]
    async fn test_pagination_offset_multi_page() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            // First page request
            let (mut socket1, _) = listener.accept().await.unwrap();
            let mut buf1 = [0u8; 1024];
            let n1 = socket1.read(&mut buf1).await.unwrap();
            let req1 = String::from_utf8_lossy(&buf1[..n1]);
            assert!(req1.contains("offset=0") || !req1.contains("offset="));

            let page1 = serde_json::to_string(&json!({
                "items": [{ "id": 1 }, { "id": 2 }]
            }))
            .unwrap();
            let resp1 = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                page1.len(),
                page1
            );
            socket1.write_all(resp1.as_bytes()).await.unwrap();

            // Second page request
            let (mut socket2, _) = listener.accept().await.unwrap();
            let mut buf2 = [0u8; 1024];
            let n2 = socket2.read(&mut buf2).await.unwrap();
            let req2 = String::from_utf8_lossy(&buf2[..n2]);
            assert!(req2.contains("offset=2"));

            let page2 = serde_json::to_string(&json!({
                "items": [{ "id": 3 }]
            }))
            .unwrap();
            let resp2 = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                page2.len(),
                page2
            );
            socket2.write_all(resp2.as_bytes()).await.unwrap();
        });

        let spec = IntegrationSpec::new("GET", format!("http://127.0.0.1:{}/api/records", port))
            .with_response_extractor(ResponseExtractor::new().with_root_path("items"))
            .with_pagination(PaginationPolicy::Offset {
                offset_param: "offset".to_string(),
                limit_param: "limit".to_string(),
                limit: 2,
                max_pages: 5,
            });

        let executor = IntegrationExecutor::new();
        let item = INodeExecutionData {
            json: json!({}),
            binary: None,
            paired_item: None,
        };

        let results = executor.execute_spec(&spec, &item, &HashMap::new()).await.unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].json["id"], 1);
        assert_eq!(results[1].json["id"], 2);
        assert_eq!(results[2].json["id"], 3);
    }

    #[tokio::test]
    async fn test_pagination_cursor_based() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            // First page request
            let (mut socket1, _) = listener.accept().await.unwrap();
            let mut buf1 = [0u8; 1024];
            let _ = socket1.read(&mut buf1).await.unwrap();

            let page1 = serde_json::to_string(&json!({
                "data": [{ "name": "first" }],
                "next_cursor": "cursor_page_2"
            }))
            .unwrap();
            let resp1 = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                page1.len(),
                page1
            );
            socket1.write_all(resp1.as_bytes()).await.unwrap();

            // Second page request with cursor
            let (mut socket2, _) = listener.accept().await.unwrap();
            let mut buf2 = [0u8; 1024];
            let n2 = socket2.read(&mut buf2).await.unwrap();
            let req2 = String::from_utf8_lossy(&buf2[..n2]);
            assert!(req2.contains("cursor=cursor_page_2"));

            let page2 = serde_json::to_string(&json!({
                "data": [{ "name": "second" }],
                "next_cursor": ""
            }))
            .unwrap();
            let resp2 = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                page2.len(),
                page2
            );
            socket2.write_all(resp2.as_bytes()).await.unwrap();
        });

        let spec = IntegrationSpec::new("GET", format!("http://127.0.0.1:{}/api/cursor-records", port))
            .with_response_extractor(ResponseExtractor::new().with_root_path("data"))
            .with_pagination(PaginationPolicy::Cursor {
                cursor_path: "next_cursor".to_string(),
                param_name: "cursor".to_string(),
                max_pages: 5,
            });

        let executor = IntegrationExecutor::new();
        let item = INodeExecutionData {
            json: json!({}),
            binary: None,
            paired_item: None,
        };

        let results = executor.execute_spec(&spec, &item, &HashMap::new()).await.unwrap();
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].json["name"], "first");
        assert_eq!(results[1].json["name"], "second");
    }
}
