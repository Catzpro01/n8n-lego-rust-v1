use std::future::Future;
use std::pin::Pin;
use serde_json::Value;
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct IfNode;

impl IfNode {
    pub fn new() -> Self {
        Self
    }
}

impl N8nNode for IfNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.if"
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        Box::pin(async move {
            let items = if input_data.is_empty() {
                vec![INodeExecutionData::from_json(serde_json::json!({}))]
            } else {
                input_data
            };

            let mut true_items = Vec::new();
            let mut false_items = Vec::new();

            for item in items {
                let mut pass = false;

                if let Some(conds) = ctx.parameters.get("conditions").and_then(|c| c.as_object()) {
                    if let Some(booleans) = conds.get("boolean").and_then(|b| b.as_array()) {
                        for b in booleans {
                            let v1 = b.get("value1").and_then(|v| v.as_bool()).unwrap_or(false);
                            let v2 = b.get("value2").and_then(|v| v.as_bool()).unwrap_or(false);
                            if v1 == v2 {
                                pass = true;
                            }
                        }
                    }
                    if let Some(strings) = conds.get("string").and_then(|s| s.as_array()) {
                        for s in strings {
                            let v1 = s.get("value1").and_then(|v| v.as_str()).unwrap_or("");
                            let v2 = s.get("value2").and_then(|v| v.as_str()).unwrap_or("");
                            let op = s.get("operation").and_then(|v| v.as_str()).unwrap_or("equal");
                            
                            match op {
                                "equal" => if v1 == v2 { pass = true; },
                                "notEqual" => if v1 != v2 { pass = true; },
                                _ => ()
                            }
                        }
                    }
                } else {
                    // Default to true if no conditions exist to mirror basic bypass
                    pass = true;
                }

                if pass {
                    true_items.push(item);
                } else {
                    false_items.push(item);
                }
            }

            Ok(vec![true_items, false_items])
        })
    }
}
