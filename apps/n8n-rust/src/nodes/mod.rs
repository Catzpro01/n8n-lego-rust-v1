use std::sync::Arc;

pub mod traits;
pub mod sqlite_node;
pub mod postgres_node;
pub mod redis_node;
pub mod crypto_node;
pub mod noop_node;
pub mod manual_trigger_node;
pub mod set_node;
pub mod code_node;
pub mod if_node;
pub mod switch_node;
pub mod merge_node;
pub mod split_node;
pub mod webhook_node;
pub mod respond_webhook_node;
pub mod http_request_node;
pub mod execute_workflow_node;
pub mod wait_node;
pub mod function_item_node;
pub mod schedule_trigger_node;
pub mod cron_node;
pub mod dynamic_integration_node;

pub use traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode, NodeRegistry};
pub use sqlite_node::SqliteNode;
pub use postgres_node::PostgresNode;
pub use redis_node::RedisNode;
pub use crypto_node::CryptoNode;
pub use noop_node::NoOpNode;
pub use manual_trigger_node::ManualTriggerNode;
pub use set_node::SetNode;
pub use code_node::PolyglotCodeNode;
pub use if_node::IfNode;
pub use switch_node::SwitchNode;
pub use merge_node::MergeNode;
pub use split_node::SplitInBatchesNode;
pub use webhook_node::WebhookNode;
pub use respond_webhook_node::RespondToWebhookNode;
pub use http_request_node::HttpRequestNode;
pub use execute_workflow_node::ExecuteWorkflowNode;
pub use wait_node::WaitNode;
pub use function_item_node::FunctionItemNode;
pub use schedule_trigger_node::ScheduleTriggerNode;
pub use cron_node::CronNode;
pub use dynamic_integration_node::DynamicIntegrationNode;

pub fn create_default_registry() -> NodeRegistry {
    let mut registry = NodeRegistry::new();

    // Register Database Nodes
    registry.register(SqliteNode::new());
    registry.register_alias("sqlite", "n8n-nodes-base.sqlite");

    registry.register(PostgresNode::new());
    registry.register_alias("postgres", "n8n-nodes-base.postgres");

    registry.register(RedisNode::new());
    registry.register_alias("redis", "n8n-nodes-base.redis");

    // Register Crypto Node
    registry.register(CryptoNode::new());
    registry.register_alias("crypto", "n8n-nodes-base.crypto");

    // Register basic flow nodes
    registry.register(NoOpNode::new());
    registry.register_alias("noOp", "n8n-nodes-base.noOp");

    registry.register(ManualTriggerNode::new());
    registry.register_alias("manualTrigger", "n8n-nodes-base.manualTrigger");

    registry.register(SetNode::new());
    registry.register_alias("set", "n8n-nodes-base.set");

    // Register Polyglot Code Node (Piped IPC + Mise Runtime Registry)
    let runtime_reg = Arc::new(crate::runtime_registry::RuntimeRegistry::new());
    registry.register(PolyglotCodeNode::new(runtime_reg));
    registry.register_alias("code", "n8n-nodes-base.code");

    registry.register(IfNode::new());
    registry.register_alias("if", "n8n-nodes-base.if");

    registry.register(SwitchNode::new());
    registry.register_alias("switch", "n8n-nodes-base.switch");

    registry.register(MergeNode::new());
    registry.register_alias("merge", "n8n-nodes-base.merge");

    registry.register(SplitInBatchesNode::new());
    registry.register_alias("splitInBatches", "n8n-nodes-base.splitInBatches");

    registry.register(WebhookNode::new());
    registry.register_alias("webhook", "n8n-nodes-base.webhook");

    registry.register(RespondToWebhookNode::new());
    registry.register_alias("respondToWebhook", "n8n-nodes-base.respondToWebhook");

    registry.register(HttpRequestNode::new());
    registry.register_alias("httpRequest", "n8n-nodes-base.httpRequest");

    registry.register(ExecuteWorkflowNode::new());
    registry.register_alias("executeWorkflow", "n8n-nodes-base.executeWorkflow");

    registry.register(WaitNode::new());
    registry.register_alias("wait", "n8n-nodes-base.wait");

    registry.register(FunctionItemNode::new());
    registry.register_alias("functionItem", "n8n-nodes-base.functionItem");

    registry.register(ScheduleTriggerNode::new());
    registry.register_alias("scheduleTrigger", "n8n-nodes-base.scheduleTrigger");

    registry.register(CronNode::new());
    registry.register_alias("cron", "n8n-nodes-base.cron");

    // Register Tier 2 Declarative Integration Proxy Node (Mencakup ratusan node: Telegram, Slack, Discord, dll)
    registry.register(DynamicIntegrationNode::new());
    registry.register_alias("dynamicProxy", "n8n-nodes-base.dynamicProxy");
    registry.register_alias("telegram", "n8n-nodes-base.telegram");
    registry.register_alias("slack", "n8n-nodes-base.slack");
    registry.register_alias("discord", "n8n-nodes-base.discord");

    registry
}
