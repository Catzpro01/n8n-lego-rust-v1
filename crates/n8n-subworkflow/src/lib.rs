//! LEGO `subworkflow` crate — Full Rust implementation.
//! Provides subworkflow invocation, recursion depth guard, cyclic recursion prevention,
//! context propagation, and credential encryption stubs.
//!
//! Contract: `contracts/subworkflow.contract.md`.

pub mod executor;
pub mod recursion_guard;
pub mod types;

pub use executor::{
    map_input_data, BoxFuture, FnSubworkflowHandler, InputMappingMode, SubworkflowExecutor,
    SubworkflowHandler, SubworkflowInvocation,
};
pub use recursion_guard::RecursionDepthGuard;
pub use types::{
    create_execution_context, create_subworkflow_context, decrypt_credentials, encrypt_credentials,
    get_subworkflow_id_from_node_params, is_node_with_workflow_selector, is_resource_locator_value,
    propagate_to_subworkflow, safe_parse_credential_context, safe_parse_execution_context,
    ICredentialContext, IExecutionContext, PlaintextExecutionContext, SubworkflowConfig,
    SubworkflowContextData, SubworkflowError, SubworkflowResult, TriggerNodeInfo,
    WorkflowExecuteMode, EXECUTE_WORKFLOW_NODE_TYPE, WORKFLOW_TOOL_LANGCHAIN_NODE_TYPE,
};

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    #[tokio::test]
    async fn test_normal_subworkflow_execution() {
        let config = SubworkflowConfig::default();
        let executor = SubworkflowExecutor::new(config);

        // Register echo handler for child workflow
        let handler = Arc::new(FnSubworkflowHandler::new(|_id, input, _ctx| {
            Box::pin(async move {
                let processed: Vec<serde_json::Value> = input
                    .into_iter()
                    .map(|item| json!({ "status": "processed", "original": item }))
                    .collect();
                Ok(processed)
            })
        }));
        executor.register_handler("child-wf-1", handler).await;

        let parent_ctx = create_subworkflow_context("exec-parent-100", "wf-parent", "ExecuteWorkflowNode");
        let parent_exec_ctx = create_execution_context(WorkflowExecuteMode::Manual, None, None);

        let input_data = vec![json!({"item_id": 1}), json!({"item_id": 2})];

        let invocation = SubworkflowInvocation::new("child-wf-1", parent_ctx.clone())
            .with_input(input_data)
            .with_parent_execution_context(parent_exec_ctx);

        let result = executor.execute(invocation).await.expect("execution succeeded");

        assert_eq!(result.subworkflow_id, "child-wf-1");
        assert_eq!(result.depth, 1);
        assert!(result.success);
        assert_eq!(result.output_data.len(), 2);
        assert_eq!(result.output_data[0]["status"], "processed");
        assert_eq!(result.output_data[0]["original"]["item_id"], 1);

        // Parent-child context propagation assertions
        assert!(result.child_execution_id.starts_with("exec-parent-100/sub/"));
        assert_eq!(
            result.execution_context.parent_execution_id,
            Some("exec-parent-100".to_string())
        );
        assert_eq!(result.execution_context.source, WorkflowExecuteMode::Internal);
        assert_eq!(result.execution_context.version, 1);
        assert!(result.execution_context.established_at > 0);
    }

    #[tokio::test]
    async fn test_parameter_passing_and_mapping() {
        let config = SubworkflowConfig::default();
        let executor = SubworkflowExecutor::new(config);

        let handler = Arc::new(FnSubworkflowHandler::new(|_id, input, _ctx| {
            Box::pin(async move { Ok(input) })
        }));
        executor.register_handler("child-wf-calc", handler).await;

        let parent_ctx = create_subworkflow_context("exec-p2", "wf-p2", "CalcNode");
        let mut params = HashMap::new();
        params.insert("multiplier".to_string(), json!(10));
        params.insert("tenant".to_string(), json!("acme"));

        let input_data = vec![json!({"amount": 50}), json!({"amount": 100})];

        let invocation = SubworkflowInvocation::new("child-wf-calc", parent_ctx)
            .with_input(input_data)
            .with_parameters(params)
            .with_mapping_mode(InputMappingMode::InjectParameters);

        let result = executor.execute(invocation).await.expect("mapped execution ok");

        assert_eq!(result.output_data.len(), 2);
        assert_eq!(result.output_data[0]["amount"], 50);
        assert_eq!(result.output_data[0]["multiplier"], 10);
        assert_eq!(result.output_data[0]["tenant"], "acme");
        assert_eq!(result.output_data[1]["amount"], 100);
        assert_eq!(result.output_data[1]["multiplier"], 10);
    }

    #[tokio::test]
    async fn test_max_depth_rejection() {
        let max_depth = 3;
        let config = SubworkflowConfig::new(max_depth);
        let executor = SubworkflowExecutor::new(config);

        let handler = Arc::new(FnSubworkflowHandler::new(|_id, input, _ctx| {
            Box::pin(async move { Ok(input) })
        }));
        executor.register_handler("child-deep", handler).await;

        let parent_ctx = create_subworkflow_context("exec-p3", "wf-p3", "CallDeep");

        // Simulate nested guard at depth 3
        let mut guard = RecursionDepthGuard::new(max_depth);
        guard = guard.enter("level-1").unwrap();
        guard = guard.enter("level-2").unwrap();
        guard = guard.enter("level-3").unwrap();
        assert_eq!(guard.current_depth(), 3);

        // Attempting to execute child-deep at depth 3 -> next depth 4 exceeds max 3
        let invocation = SubworkflowInvocation::new("child-deep", parent_ctx).with_guard(guard);

        let err = executor.execute(invocation).await.unwrap_err();
        match err {
            SubworkflowError::DepthExceeded { depth, max } => {
                assert_eq!(depth, 4);
                assert_eq!(max, 3);
            }
            other => panic!("expected DepthExceeded, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_cyclic_recursion_rejection() {
        let config = SubworkflowConfig::default();
        let executor = SubworkflowExecutor::new(config);

        let parent_ctx = create_subworkflow_context("exec-p4", "wf-root", "CallerNode");

        let mut guard = RecursionDepthGuard::default();
        guard = guard.enter("wf-alpha").unwrap();
        guard = guard.enter("wf-beta").unwrap();

        // Attempting to invoke wf-alpha again from wf-beta
        let invocation = SubworkflowInvocation::new("wf-alpha", parent_ctx).with_guard(guard);

        let err = executor.execute(invocation).await.unwrap_err();
        match err {
            SubworkflowError::CyclicRecursion { workflow_id, call_chain } => {
                assert_eq!(workflow_id, "wf-alpha");
                assert_eq!(call_chain, vec!["wf-alpha", "wf-beta", "wf-alpha"]);
            }
            other => panic!("expected CyclicRecursion, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_parent_cancelled_refusal() {
        let config = SubworkflowConfig::default();
        let executor = SubworkflowExecutor::new(config);

        let parent_ctx = create_subworkflow_context("exec-p5", "wf-p5", "CallerNode");
        let token = Arc::new(AtomicBool::new(true)); // cancelled

        let invocation = SubworkflowInvocation::new("wf-some-child", parent_ctx)
            .with_cancellation_token(token);

        let err = executor.execute(invocation).await.unwrap_err();
        match err {
            SubworkflowError::ParentCancelled { parent_execution_id } => {
                assert_eq!(parent_execution_id, "exec-p5");
            }
            other => panic!("expected ParentCancelled, got {:?}", other),
        }
    }

    #[test]
    fn test_subworkflow_id_extraction_resource_locator() {
        // Valid resourceLocator with __rl: true
        let params_rl = json!({
            "workflowId": {
                "__rl": true,
                "value": "wf-extracted-999",
                "mode": "id"
            }
        });
        assert_eq!(
            get_subworkflow_id_from_node_params(&params_rl, Some(EXECUTE_WORKFLOW_NODE_TYPE)),
            Some("wf-extracted-999".to_string())
        );

        // LangChain workflow tool
        assert_eq!(
            get_subworkflow_id_from_node_params(&params_rl, Some(WORKFLOW_TOOL_LANGCHAIN_NODE_TYPE)),
            Some("wf-extracted-999".to_string())
        );

        // Plain string (non-resource locator) -> returns None per contract invariant §5
        let params_plain = json!({
            "workflowId": "wf-direct-string"
        });
        assert_eq!(
            get_subworkflow_id_from_node_params(&params_plain, Some(EXECUTE_WORKFLOW_NODE_TYPE)),
            None
        );

        // Unsupported node type -> returns None
        assert_eq!(
            get_subworkflow_id_from_node_params(&params_rl, Some("n8n-nodes-base.httpRequest")),
            None
        );
    }

    #[test]
    fn test_credential_encryption_decryption_roundtrip() {
        let mut meta = HashMap::new();
        meta.insert("realm".to_string(), json!("prod"));
        let cred = ICredentialContext::new_v1("jwt-token-xyz-123", Some(meta));

        let encrypted = encrypt_credentials(&cred, Some("custom-secret")).expect("encryption ok");
        assert!(encrypted.starts_with("enc:v1:"));

        let decrypted = decrypt_credentials(&encrypted, Some("custom-secret")).expect("decryption ok");
        assert_eq!(decrypted.version, 1);
        assert_eq!(decrypted.identity, "jwt-token-xyz-123");
        assert_eq!(decrypted.metadata.unwrap()["realm"], "prod");

        // Wrong secret results in corrupted json / parse failure
        let failed_dec = decrypt_credentials(&encrypted, Some("wrong-secret"));
        assert!(failed_dec.is_err());
    }

    #[test]
    fn test_safe_parse_contexts() {
        let json_exec = json!({
            "version": 1,
            "establishedAt": 1700000000000i64,
            "source": "trigger",
            "parentExecutionId": "parent-1"
        });
        let parsed_exec = safe_parse_execution_context(&json_exec).expect("safe parse exec ok");
        assert_eq!(parsed_exec.version, 1);
        assert_eq!(parsed_exec.source, WorkflowExecuteMode::Trigger);

        let json_cred = json!({
            "version": 1,
            "identity": "api_key_456"
        });
        let parsed_cred = safe_parse_credential_context(&json_cred).expect("safe parse cred ok");
        assert_eq!(parsed_cred.identity, "api_key_456");

        // Unsupported version
        let json_bad = json!({
            "version": 2,
            "identity": "foo"
        });
        assert!(safe_parse_credential_context(&json_bad).is_err());
    }

    #[test]
    fn test_wrap_key_mapping() {
        let input = vec![json!({"id": 1}), json!({"id": 2})];
        let params = HashMap::new();
        let mapped = map_input_data(&input, &params, &InputMappingMode::WrapKey("records".into()));
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0]["records"].as_array().unwrap().len(), 2);
    }
}
