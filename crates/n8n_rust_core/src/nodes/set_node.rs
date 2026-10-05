use std::future::Future;
use std::pin::Pin;
use serde_json::Value;
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};

pub struct SetNode;

impl SetNode {
    pub fn new() -> Self {
        Self
    }
}

impl N8nNode for SetNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.set"
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        Box::pin(async move {
            let mut items = if input_data.is_empty() {
                vec![INodeExecutionData::from_json(serde_json::json!({}))]
            } else {
                input_data
            };

            // Sangat sederhana: ambil parameter values
            let values = ctx.parameters.get("values");

            if let Some(val_obj) = values.and_then(|v| v.as_object()) {
                let mut output_items = Vec::new();
                for mut item in items {
                    let mut json_obj = item.json.as_object().cloned().unwrap_or_default();
                    
                    // Iterate string types
                    if let Some(strings) = val_obj.get("string").and_then(|v| v.as_array()) {
                        for s in strings {
                            if let (Some(name), Some(val)) = (s.get("name").and_then(|n| n.as_str()), s.get("value").and_then(|v| v.as_str())) {
                                json_obj.insert(name.to_string(), Value::String(val.to_string()));
                            }
                        }
                    }
                    
                    // Iterate number types
                    if let Some(numbers) = val_obj.get("number").and_then(|v| v.as_array()) {
                        for n in numbers {
                            if let (Some(name), Some(val)) = (n.get("name").and_then(|name| name.as_str()), n.get("value")) {
                                json_obj.insert(name.to_string(), val.clone());
                            }
                        }
                    }
                    
                    item.json = Value::Object(json_obj);
                    output_items.push(item);
                }
                return Ok(vec![output_items]);
            }

            Ok(vec![items])
        })
    }
}
