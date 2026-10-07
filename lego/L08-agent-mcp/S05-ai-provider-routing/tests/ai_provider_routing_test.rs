//! Unit tests for L08.S05 AI provider routing

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_primary_provider_route_resolution() {
        let service = ProviderRoutingTableService::new();
        let (provider, route) = service.resolve_route("gpt-4o").unwrap();

        assert_eq!(provider, AiProvider::OpenAi);
        assert_eq!(route.model_alias, "gpt-4o");
        assert_eq!(route.credential_id, "cred-openai-prod");
    }

    #[test]
    fn test_fallback_provider_routing_on_primary_outage() {
        let service = ProviderRoutingTableService::new();

        // Simulate OpenAI outage
        service.set_provider_health(AiProvider::OpenAi, false).unwrap();

        // Route resolution for gpt-4o should now fallback to Anthropic
        let (provider, _) = service.resolve_route("gpt-4o").unwrap();
        assert_eq!(provider, AiProvider::Anthropic);

        // Simulate Anthropic outage as well
        service.set_provider_health(AiProvider::Anthropic, false).unwrap();

        // Route resolution for gpt-4o should now fallback to GoogleGemini
        let (provider_third, _) = service.resolve_route("gpt-4o").unwrap();
        assert_eq!(provider_third, AiProvider::GoogleGemini);
    }

    #[test]
    fn test_all_providers_unhealthy_fails_closed() {
        let service = ProviderRoutingTableService::new();

        service.set_provider_health(AiProvider::OpenAi, false).unwrap();
        service.set_provider_health(AiProvider::Anthropic, false).unwrap();
        service.set_provider_health(AiProvider::GoogleGemini, false).unwrap();

        let err = service.resolve_route("gpt-4o");
        assert!(matches!(err, Err(ProviderRoutingError::AllProvidersUnavailable(_))));
    }

    #[test]
    fn test_unknown_model_fails_closed() {
        let service = ProviderRoutingTableService::new();
        let err = service.resolve_route("unsupported-llm-v9");
        assert!(matches!(err, Err(ProviderRoutingError::ModelNotRegistered(_))));
    }

    #[test]
    fn test_budget_exceeded_fails_closed() {
        let service = ProviderRoutingTableService::new();
        let req = ChatCompletionRequest {
            model: "gpt-4o".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: "Summarize this massive 100-page document...".to_string(),
            }],
            temperature: 0.7,
            max_tokens: Some(4096),
        };

        // Pass an tiny budget of $0.0000001
        let err = service.dispatch_chat(req, 0.0000001);
        assert!(matches!(err, Err(ProviderRoutingError::BudgetExceeded { .. })));
    }

    #[test]
    fn test_chat_dispatch_token_and_cost_accounting() {
        let service = ProviderRoutingTableService::new();
        let req = ChatCompletionRequest {
            model: "claude-3-5-sonnet".to_string(),
            messages: vec![
                ChatMessage { role: "system".to_string(), content: "You are an assistant".to_string() },
                ChatMessage { role: "user".to_string(), content: "Write a short poem".to_string() },
            ],
            temperature: 0.5,
            max_tokens: Some(100),
        };

        let resp = service.dispatch_chat(req, 5.0).unwrap();
        assert_eq!(resp.model, "claude-3-5-sonnet");
        assert_eq!(resp.provider_used, AiProvider::Anthropic);
        assert!(resp.prompt_tokens > 0);
        assert!(resp.total_tokens > resp.prompt_tokens);
        assert!(resp.estimated_cost_usd > 0.0);
    }

    #[test]
    fn test_port_handler_route_and_chat() {
        let service = ProviderRoutingTableService::new();
        let route_payload = json!({
            "action": "route",
            "model": "gpt-4o"
        });
        let route_res = service.handle_port_invocation(&route_payload).unwrap();
        assert_eq!(route_res["model"], "gpt-4o");
        assert_eq!(route_res["selected_provider"], "OpenAi");

        let chat_payload = json!({
            "action": "chat",
            "model": "gpt-4o",
            "budget_usd": 10.0,
            "messages": [
                { "role": "user", "content": "Ping" }
            ]
        });
        let chat_res = service.handle_port_invocation(&chat_payload).unwrap();
        assert_eq!(chat_res["model"], "gpt-4o");
        assert_eq!(chat_res["provider_used"], "OpenAi");
    }
}
