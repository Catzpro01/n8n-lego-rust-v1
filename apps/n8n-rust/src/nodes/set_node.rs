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
            let items = if input_data.is_empty() {
                vec![INodeExecutionData::from_json(serde_json::json!({}))]
            } else {
                input_data
            };

            let mut output_items = Vec::new();
            for item in items {
                let mut json_obj = item.json.as_object().cloned().unwrap_or_default();

                // 1. Tangani jika ada values
                if let Some(val_obj) = ctx.parameters.get("values").and_then(|v| v.as_object()) {
                    if let Some(strings) = val_obj.get("string").and_then(|v| v.as_array()) {
                        for s in strings {
                            if let (Some(name), Some(val)) = (s.get("name").and_then(|n| n.as_str()), s.get("value").and_then(|v| v.as_str())) {
                                json_obj.insert(name.to_string(), Value::String(val.to_string()));
                            }
                        }
                    }
                    if let Some(numbers) = val_obj.get("number").and_then(|v| v.as_array()) {
                        for n in numbers {
                            if let (Some(name), Some(val)) = (n.get("name").and_then(|name| name.as_str()), n.get("value")) {
                                json_obj.insert(name.to_string(), val.clone());
                            }
                        }
                    }
                    for (k, v) in val_obj {
                        if k != "string" && k != "number" {
                            let evaluated = if let Some(s) = v.as_str() {
                                if s.starts_with('=') {
                                    let expr = &s[1..];
                                    let eval_ctx = serde_json::json!([item.clone()]);
                                    crate::evaluator::JsEvaluator::evaluate_expression(expr, &eval_ctx).unwrap_or(v.clone())
                                } else {
                                    v.clone()
                                }
                            } else {
                                v.clone()
                            };
                            json_obj.insert(k.clone(), evaluated);
                        }
                    }
                }

                // 2. Tangani direct parameters
                for (k, v) in &ctx.parameters {
                    if k != "values" {
                        let evaluated = if let Some(s) = v.as_str() {
                            if s.starts_with('=') {
                                let expr = &s[1..];
                                let eval_ctx = serde_json::json!([item.clone()]);
                                crate::evaluator::JsEvaluator::evaluate_expression(expr, &eval_ctx).unwrap_or(v.clone())
                            } else {
                                v.clone()
                            }
                        } else {
                            v.clone()
                        };
                        json_obj.insert(k.clone(), evaluated);
                    }
                }

                output_items.push(INodeExecutionData::from_json(Value::Object(json_obj)));
            }

            Ok(vec![output_items])
        })
    }
}
