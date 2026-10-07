//! L08.S05 — AI provider routing
//!
//! Provides the model routing table, provider failover/fallback resolution,
//! token accounting, and remote LLM request dispatching.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AiProvider {
    OpenAi,
    Anthropic,
    GoogleGemini,
    LocalOllama,
    CustomEndpoint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RouteConfig {
    pub model_alias: String,
    pub primary_provider: AiProvider,
    pub fallback_providers: Vec<AiProvider>,
    pub credential_id: String,
    pub max_tokens: u32,
    pub cost_per_1k_input_usd: f64,
    pub cost_per_1k_output_usd: f64,
    pub is_healthy: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCompletionRequest {
    pub model: String,
    pub messages: Vec<ChatMessage>,
    pub temperature: f32,
    pub max_tokens: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatCompletionResponse {
    pub model: String,
    pub provider_used: AiProvider,
    pub content: String,
    pub prompt_tokens: u32,
    pub completion_tokens: u32,
    pub total_tokens: u32,
    pub estimated_cost_usd: f64,
}

#[derive(Debug)]
pub enum ProviderRoutingError {
    ModelNotRegistered(String),
    AllProvidersUnavailable(String),
    BudgetExceeded { required_usd: f64, available_usd: f64 },
    InvalidPayload(String),
    LockError(String),
}

impl std::fmt::Display for ProviderRoutingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ModelNotRegistered(m) => write!(f, "Model not registered in routing table: {m}"),
            Self::AllProvidersUnavailable(m) => {
                write!(f, "All primary and fallback providers unavailable for model: {m}")
            }
            Self::BudgetExceeded { required_usd, available_usd } => {
                write!(
                    f,
                    "Execution budget exceeded: required {required_usd} USD, available {available_usd} USD"
                )
            }
            Self::InvalidPayload(m) => write!(f, "Invalid payload: {m}"),
            Self::LockError(m) => write!(f, "Lock acquisition error: {m}"),
        }
    }
}

impl std::error::Error for ProviderRoutingError {}

#[derive(Debug, Clone)]
pub struct ProviderRoutingTableService {
    // State domain: provider-routing-table
    routes: Arc<RwLock<HashMap<String, RouteConfig>>>,
    provider_health: Arc<RwLock<HashMap<AiProvider, bool>>>,
}

impl Default for ProviderRoutingTableService {
    fn default() -> Self {
        Self::new()
    }
}

impl ProviderRoutingTableService {
    pub fn new() -> Self {
        let service = Self {
            routes: Arc::new(RwLock::new(HashMap::new())),
            provider_health: Arc::new(RwLock::new(HashMap::new())),
        };

        // Mark all standard providers as healthy initially
        let _ = service.set_provider_health(AiProvider::OpenAi, true);
        let _ = service.set_provider_health(AiProvider::Anthropic, true);
        let _ = service.set_provider_health(AiProvider::GoogleGemini, true);
        let _ = service.set_provider_health(AiProvider::LocalOllama, true);

        // Pre-register standard production models
        let _ = service.register_route(RouteConfig {
            model_alias: "gpt-4o".to_string(),
            primary_provider: AiProvider::OpenAi,
            fallback_providers: vec![AiProvider::Anthropic, AiProvider::GoogleGemini],
            credential_id: "cred-openai-prod".to_string(),
            max_tokens: 4096,
            cost_per_1k_input_usd: 0.005,
            cost_per_1k_output_usd: 0.015,
            is_healthy: true,
        });

        let _ = service.register_route(RouteConfig {
            model_alias: "claude-3-5-sonnet".to_string(),
            primary_provider: AiProvider::Anthropic,
            fallback_providers: vec![AiProvider::OpenAi],
            credential_id: "cred-anthropic-prod".to_string(),
            max_tokens: 8192,
            cost_per_1k_input_usd: 0.003,
            cost_per_1k_output_usd: 0.015,
            is_healthy: true,
        });

        service
    }

    pub fn set_provider_health(&self, provider: AiProvider, healthy: bool) -> Result<(), ProviderRoutingError> {
        let mut map = self.provider_health.write().map_err(|_| {
            ProviderRoutingError::LockError("Failed to acquire write lock".to_string())
        })?;
        map.insert(provider, healthy);
        Ok(())
    }

    pub fn is_provider_healthy(&self, provider: AiProvider) -> bool {
        let map = match self.provider_health.read() {
            Ok(m) => m,
            Err(_) => return false,
        };
        map.get(&provider).copied().unwrap_or(true)
    }

    pub fn register_route(&self, config: RouteConfig) -> Result<(), ProviderRoutingError> {
        let mut map = self.routes.write().map_err(|_| {
            ProviderRoutingError::LockError("Failed to acquire write lock".to_string())
        })?;
        map.insert(config.model_alias.clone(), config);
        Ok(())
    }

    pub fn resolve_route(&self, model: &str) -> Result<(AiProvider, RouteConfig), ProviderRoutingError> {
        let map = self.routes.read().map_err(|_| {
            ProviderRoutingError::LockError("Failed to acquire read lock".to_string())
        })?;

        let route = map
            .get(model)
            .ok_or_else(|| ProviderRoutingError::ModelNotRegistered(model.to_string()))?;

        // 1. Try primary provider if healthy
        if self.is_provider_healthy(route.primary_provider) {
            return Ok((route.primary_provider, route.clone()));
        }

        // 2. Try fallbacks in order
        for fallback in &route.fallback_providers {
            if self.is_provider_healthy(*fallback) {
                return Ok((*fallback, route.clone()));
            }
        }

        // 3. Fail-closed: all providers down
        Err(ProviderRoutingError::AllProvidersUnavailable(model.to_string()))
    }

    pub fn dispatch_chat(
        &self,
        request: ChatCompletionRequest,
        budget_available_usd: f64,
    ) -> Result<ChatCompletionResponse, ProviderRoutingError> {
        let (provider, route) = self.resolve_route(&request.model)?;

        // Approximate token estimation
        let mut total_chars = 0;
        for msg in &request.messages {
            total_chars += msg.content.len();
        }
        let est_prompt_tokens = ((total_chars / 4) + 10) as u32;
        let est_completion_tokens = 50;
        let total_tokens = est_prompt_tokens + est_completion_tokens;

        let estimated_cost = (est_prompt_tokens as f64 / 1000.0) * route.cost_per_1k_input_usd
            + (est_completion_tokens as f64 / 1000.0) * route.cost_per_1k_output_usd;

        if budget_available_usd > 0.0 && estimated_cost > budget_available_usd {
            return Err(ProviderRoutingError::BudgetExceeded {
                required_usd: estimated_cost,
                available_usd: budget_available_usd,
            });
        }

        // Simulate provider output
        let content = format!(
            "Response from [{:?}] for model [{}]: processed {} input tokens.",
            provider, request.model, est_prompt_tokens
        );

        Ok(ChatCompletionResponse {
            model: request.model,
            provider_used: provider,
            content,
            prompt_tokens: est_prompt_tokens,
            completion_tokens: est_completion_tokens,
            total_tokens,
            estimated_cost_usd: estimated_cost,
        })
    }

    /// Handles port invocation payloads for port.agent.provider.route.v1 and port.agent.provider.chat.v1
    pub fn handle_port_invocation(&self, payload: &serde_json::Value) -> Result<serde_json::Value, ProviderRoutingError> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("route");

        match action {
            "register" => {
                let config: RouteConfig = serde_json::from_value(
                    payload.get("route").cloned().unwrap_or(serde_json::Value::Null)
                ).map_err(|e| ProviderRoutingError::InvalidPayload(e.to_string()))?;
                let alias = config.model_alias.clone();
                self.register_route(config)?;
                Ok(serde_json::json!({ "registered": alias, "success": true }))
            }
            "route" => {
                let model = payload.get("model").and_then(|v| v.as_str()).unwrap_or("gpt-4o");
                let (provider, route) = self.resolve_route(model)?;
                Ok(serde_json::json!({
                    "model": model,
                    "selected_provider": format!("{:?}", provider),
                    "credential_id": route.credential_id,
                    "max_tokens": route.max_tokens
                }))
            }
            "set_health" => {
                let prov_str = payload.get("provider").and_then(|v| v.as_str()).unwrap_or("OpenAi");
                let healthy = payload.get("healthy").and_then(|v| v.as_bool()).unwrap_or(true);
                let prov = match prov_str {
                    "OpenAi" => AiProvider::OpenAi,
                    "Anthropic" => AiProvider::Anthropic,
                    "GoogleGemini" => AiProvider::GoogleGemini,
                    "LocalOllama" => AiProvider::LocalOllama,
                    _ => AiProvider::CustomEndpoint,
                };
                self.set_provider_health(prov, healthy)?;
                Ok(serde_json::json!({ "provider": prov_str, "healthy": healthy }))
            }
            "chat" | "dispatch" => {
                let model = payload.get("model").and_then(|v| v.as_str()).unwrap_or("gpt-4o");
                let budget = payload.get("budget_usd").and_then(|v| v.as_f64()).unwrap_or(10.0);
                let msgs_val = payload.get("messages").cloned().unwrap_or(serde_json::json!([
                    {"role": "user", "content": "Hello agent"}
                ]));
                let messages: Vec<ChatMessage> = serde_json::from_value(msgs_val)
                    .map_err(|e| ProviderRoutingError::InvalidPayload(e.to_string()))?;

                let req = ChatCompletionRequest {
                    model: model.to_string(),
                    messages,
                    temperature: 0.7,
                    max_tokens: Some(1024),
                };
                let resp = self.dispatch_chat(req, budget)?;
                Ok(serde_json::to_value(&resp).map_err(|e| ProviderRoutingError::InvalidPayload(e.to_string()))?)
            }
            other => Err(ProviderRoutingError::InvalidPayload(format!("Unsupported action: {other}"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/ai_provider_routing_test.rs"]
mod tests;
