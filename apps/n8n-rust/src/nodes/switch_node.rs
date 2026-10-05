use std::future::Future;
use std::pin::Pin;
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct SwitchNode;

impl SwitchNode {
    pub fn new() -> Self {
        Self
    }
}

impl N8nNode for SwitchNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.switch"
    }

    fn execute<'a>(
        &'a self,
        _ctx: &'a NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        Box::pin(async move {
            let items = if input_data.is_empty() {
                vec![]
            } else {
                input_data
            };
            // Default behaviour: route all to output index 0, others empty
            Ok(vec![items, vec![], vec![], vec![]])
        })
    }
}
