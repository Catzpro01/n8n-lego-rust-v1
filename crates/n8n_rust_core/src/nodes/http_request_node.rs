use std::future::Future;
use std::pin::Pin;
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct HttpRequestNode;

impl HttpRequestNode {
    pub fn new() -> Self {
        Self
    }
}

impl N8nNode for HttpRequestNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.httpRequest"
    }

    fn execute<'a>(
        &'a self,
        _ctx: &'a NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        Box::pin(async move {
            let items = if input_data.is_empty() {
                vec![INodeExecutionData::from_json(serde_json::json!({}))]
            } else {
                input_data
            };
            Ok(vec![items])
        })
    }
}
