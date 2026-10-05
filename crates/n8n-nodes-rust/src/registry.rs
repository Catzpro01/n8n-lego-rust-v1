use crate::traits::{N8nNode, NodeTypeDescription};
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Default)]
pub struct NodeRegistry {
    nodes: HashMap<String, Arc<dyn N8nNode>>,
}

impl NodeRegistry {
    pub fn new() -> Self {
        Self {
            nodes: HashMap::new(),
        }
    }

    pub fn with_builtins() -> Self {
        let mut reg = Self::new();
        reg.register(crate::nodes::IfNode);
        reg.register(crate::nodes::SetNode);
        reg.register(crate::nodes::CodePolyglotNode::default());
        reg.register(crate::nodes::DynamicIntegrationNode::default());
        reg
    }

    pub fn register<N: N8nNode + 'static>(&mut self, node: N) {
        let desc = node.description();
        self.nodes.insert(desc.name.clone(), Arc::new(node));
    }

    pub fn get(&self, name: &str) -> Option<Arc<dyn N8nNode>> {
        self.nodes.get(name).cloned()
    }

    pub fn get_all_descriptions(&self) -> Vec<NodeTypeDescription> {
        self.nodes.values().map(|n| n.description()).collect()
    }

    pub fn count(&self) -> usize {
        self.nodes.len()
    }
}
