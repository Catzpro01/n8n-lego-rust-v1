//! LEGO V2 public facade.
//!
//! This crate is deliberately small. Internal crates remain modular, but a user of LEGO
//! should not need to understand the entire crate graph just to inspect the runtime.

use n8n_node_model::NodeTypeDescription;
use n8n_nodes_rust::NodeRegistry;
use serde::{Deserialize, Serialize};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum RuntimeMode {
    Workflow,
    Agent,
    Hybrid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeConfig {
    pub mode: RuntimeMode,
    pub max_concurrency: usize,
    pub max_payload_bytes: usize,
}

impl Default for RuntimeConfig {
    fn default() -> Self {
        Self {
            mode: RuntimeMode::Hybrid,
            max_concurrency: 32,
            max_payload_bytes: 5 * 1024 * 1024,
        }
    }
}

#[derive(Clone)]
pub struct LegoRuntime {
    config: RuntimeConfig,
    registry: Arc<NodeRegistry>,
}

impl LegoRuntime {
    /// Creates the beginner-friendly runtime facade with the built-in node registry.
    pub fn new() -> Self {
        Self {
            config: RuntimeConfig::default(),
            registry: Arc::new(NodeRegistry::with_builtins()),
        }
    }

    pub fn with_config(config: RuntimeConfig) -> Self {
        Self {
            config,
            registry: Arc::new(NodeRegistry::with_builtins()),
        }
    }

    pub fn config(&self) -> &RuntimeConfig {
        &self.config
    }

    pub fn node_count(&self) -> usize {
        self.registry.count()
    }

    pub fn has_node(&self, name: &str) -> bool {
        self.registry.get(name).is_some()
    }

    pub fn node_descriptions(&self) -> Vec<NodeTypeDescription> {
        self.registry.get_all_descriptions()
    }
}

impl Default for LegoRuntime {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_runtime_is_beginner_safe() {
        let runtime = LegoRuntime::new();
        assert_eq!(runtime.config().mode, RuntimeMode::Hybrid);
        assert!(runtime.config().max_concurrency > 0);
        assert!(runtime.node_count() >= 4);
        assert!(runtime.has_node("n8n-nodes-base.if"));
    }

    #[test]
    fn runtime_config_is_serializable() {
        let config = RuntimeConfig::default();
        let json = serde_json::to_string(&config).expect("config should serialize");
        assert!(json.contains("Hybrid"));
    }
}
