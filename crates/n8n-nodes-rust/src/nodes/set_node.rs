use crate::traits::{
    INodeExecutionData, N8nNode, NodeExecutionContext, NodeExecutionError, NodeTypeDescription,
};
use async_trait::async_trait;
use serde_json::json;

pub struct SetNode;

#[async_trait]
impl N8nNode for SetNode {
    fn description(&self) -> NodeTypeDescription {
        NodeTypeDescription {
            name: "n8n-nodes-base.set".to_string(),
            display_name: "Edit Fields (Set) [Rust Native]".to_string(),
            description: "Set values on items in high-speed native Rust".to_string(),
            version: 1.0,
            inputs: vec!["main".to_string()],
            outputs: vec!["main".to_string()],
            translation: None,
        }
    }

    async fn execute(
        &self,
        context: &NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError> {
        let mut output_items = Vec::with_capacity(input_data.len());
        let include_other_fields = context
            .parameters
            .get("includeOtherFields")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        for item in input_data {
            let mut final_map = if include_other_fields {
                item.json.as_object().cloned().unwrap_or_default()
            } else {
                serde_json::Map::new()
            };

            // 1. Format legacy / values: { key: value } atau { string: [...], number: [...] }
            if let Some(values_val) = context.parameters.get("values") {
                if let Some(assign_obj) = values_val.as_object() {
                    if let Some(strings) = assign_obj.get("string").and_then(|v| v.as_array()) {
                        for s in strings {
                            if let (Some(name), Some(val)) = (s.get("name").and_then(|n| n.as_str()), s.get("value").and_then(|v| v.as_str())) {
                                final_map.insert(name.to_string(), serde_json::Value::String(val.to_string()));
                            }
                        }
                    }
                    if let Some(numbers) = assign_obj.get("number").and_then(|v| v.as_array()) {
                        for n in numbers {
                            if let (Some(name), Some(val)) = (n.get("name").and_then(|name| name.as_str()), n.get("value")) {
                                final_map.insert(name.to_string(), val.clone());
                            }
                        }
                    }
                    for (k, v) in assign_obj {
                        if k != "string" && k != "number" {
                            final_map.insert(k.clone(), v.clone());
                        }
                    }
                }
            }

            // 2. Format modern / assignments: { assignments: [{ name, value, ... }] }
            if let Some(assignments_val) = context.parameters.get("assignments") {
                let list = if let Some(inner) = assignments_val.get("assignments").and_then(|v| v.as_array()) {
                    Some(inner)
                } else {
                    assignments_val.as_array()
                };

                if let Some(arr) = list {
                    for assign in arr {
                        if let Some(name) = assign.get("name").and_then(|n| n.as_str()) {
                            let val = assign.get("value").cloned().unwrap_or(serde_json::Value::Null);
                            final_map.insert(name.to_string(), val);
                        }
                    }
                } else if let Some(obj) = assignments_val.as_object() {
                    for (k, v) in obj {
                        final_map.insert(k.clone(), v.clone());
                    }
                }
            }

            output_items.push(INodeExecutionData {
                json: serde_json::Value::Object(final_map),
                binary: item.binary,
                paired_item: item.paired_item,
            });
        }

        Ok(vec![output_items])
    }
}
