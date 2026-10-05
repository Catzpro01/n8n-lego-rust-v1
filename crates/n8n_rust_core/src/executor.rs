use petgraph::visit::EdgeRef;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use tokio::sync::broadcast;
use tokio::time::Duration;
use base64::prelude::*;
use sha2::{Digest, Sha256};
use chrono::{DateTime, Utc};
use serde_json::Value;

use crate::evaluator::JsEvaluator;
use crate::events::ExecutionEvent;
use crate::parser::WorkflowGraph;
use crate::workflow::Node;

pub struct WorkflowExecutor {
    workflow_graph: WorkflowGraph,
    event_sender: Option<broadcast::Sender<ExecutionEvent>>,
    workflow_id: String,
    execution_id: String,
    initial_trigger_data: Option<Value>,
    http_client: reqwest::Client,
    node_registry: Arc<crate::nodes::NodeRegistry>,
}

impl WorkflowExecutor {
    pub fn new(workflow_graph: WorkflowGraph) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .pool_idle_timeout(Duration::from_secs(90))
            .tcp_keepalive(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());

        Self {
            workflow_graph,
            event_sender: None,
            workflow_id: "default_wf".to_string(),
            execution_id: uuid::Uuid::new_v4().to_string(),
            initial_trigger_data: None,
            http_client: client,
            node_registry: Arc::new(crate::nodes::create_default_registry()),
        }
    }

    pub fn with_node_registry(mut self, registry: Arc<crate::nodes::NodeRegistry>) -> Self {
        self.node_registry = registry;
        self
    }

    pub fn with_events(
        mut self,
        sender: broadcast::Sender<ExecutionEvent>,
        workflow_id: String,
        execution_id: String,
    ) -> Self {
        self.event_sender = Some(sender);
        self.workflow_id = workflow_id;
        self.execution_id = execution_id;
        self
    }

    pub fn with_trigger_data(mut self, data: Value) -> Self {
        self.initial_trigger_data = Some(data);
        self
    }

    /// Asynchronous, high-performance DAG execution engine
    pub async fn execute(&self) -> Result<HashMap<String, Value>, String> {
        let graph = &self.workflow_graph.graph;

        // Hitung in-degree (jumlah ketergantungan masuk) untuk setiap node
        let mut in_degrees = HashMap::new();
        for node_idx in graph.node_indices() {
            let in_degree = graph.edges_directed(node_idx, petgraph::Direction::Incoming).count();
            in_degrees.insert(node_idx, in_degree);
        }

        let mut node_outputs_by_idx: HashMap<petgraph::graph::NodeIndex, Value> = HashMap::new();
        let mut final_results = HashMap::new();

        // Kumpulkan node yang siap dieksekusi pertama kali (in-degree == 0, biasanya Trigger nodes)
        let mut ready_queue = VecDeque::new();
        for (&node_idx, &deg) in &in_degrees {
            if deg == 0 {
                ready_queue.push_back(node_idx);
            }
        }

        if ready_queue.is_empty() && graph.node_count() > 0 {
            return Err("Workflow contains a cycle or has no root trigger node.".to_string());
        }

        println!("🚀 [DAG Engine] Memulai eksekusi paralel alur kerja (Rust High-Efficiency Core)");

        // Eksekusi topological wavefront
        while let Some(node_idx) = ready_queue.pop_front() {
            let node = &graph[node_idx];
            println!("⚙️ Executing Node: {} (Type: {})", node.name, node.node_type);

            // Broadcast NodeStarted
            if let Some(ref sender) = self.event_sender {
                let _ = sender.send(ExecutionEvent::NodeStarted {
                    workflow_id: self.workflow_id.clone(),
                    execution_id: self.execution_id.clone(),
                    node_name: node.name.clone(),
                });
            }

            // Kumpulkan input dari semua node induk (incoming edges)
            let mut inputs = vec![];
            for edge in graph.edges_directed(node_idx, petgraph::Direction::Incoming) {
                let source_idx = edge.source();
                if let Some(source_data) = node_outputs_by_idx.get(&source_idx) {
                    inputs.push(source_data);
                }
            }

            // Jika node adalah root dan ada trigger data eksternal (misal Webhook payload)
            let trigger_override;
            let final_inputs = if inputs.is_empty() && self.initial_trigger_data.is_some() {
                trigger_override = self.initial_trigger_data.as_ref().unwrap();
                vec![trigger_override]
            } else {
                inputs
            };

            // Jalankan node dengan driver Rust spesifik
            let output = self.execute_node(node, final_inputs).await?;

            // Broadcast NodeCompleted
            if let Some(ref sender) = self.event_sender {
                let _ = sender.send(ExecutionEvent::NodeCompleted {
                    workflow_id: self.workflow_id.clone(),
                    execution_id: self.execution_id.clone(),
                    node_name: node.name.clone(),
                    output: output.clone(),
                });
            }

            node_outputs_by_idx.insert(node_idx, output.clone());
            final_results.insert(node.name.clone(), output.clone());
            println!("✅ Node {} finished. Output preview: {}", node.name, output);

            // Kurangi in-degree untuk semua node target (outgoing edges)
            for edge in graph.edges_directed(node_idx, petgraph::Direction::Outgoing) {
                let target_idx = edge.target();
                if let Some(deg) = in_degrees.get_mut(&target_idx) {
                    if *deg > 0 {
                        *deg -= 1;
                        if *deg == 0 {
                            ready_queue.push_back(target_idx);
                        }
                    }
                }
            }
        }

        println!("✨ [DAG Engine] Alur kerja selesai dieksekusi dengan sukses.");
        Ok(final_results)
    }

    fn resolve_value(raw: &Value, context: &Value) -> Value {
        if let Some(s) = raw.as_str() {
            if s.starts_with('=') {
                let expr = &s[1..];
                match JsEvaluator::evaluate_expression(expr, context) {
                    Ok(val) => val,
                    Err(err) => serde_json::json!({ "_eval_error": err }),
                }
            } else {
                Value::String(s.to_string())
            }
        } else {
            raw.clone()
        }
    }

    /// Driver Eksekusi Node Lengkap (Pure Rust)
    async fn execute_node(&self, node: &Node, inputs: Vec<&Value>) -> Result<Value, String> {
        let empty_obj = serde_json::json!({});
        let context = if inputs.is_empty() {
            &empty_obj
        } else {
            inputs[0]
        };

        let node_type = node.node_type.as_str();

        // 0. Cek apakah node terdaftar di modular NodeRegistry
        if let Some(registered_node) = self.node_registry.get(node_type) {
            let mut input_items = Vec::new();
            for input_val in &inputs {
                if let Some(arr) = input_val.as_array() {
                    for it in arr {
                        if it.get("json").is_some() {
                            if let Ok(item_data) = serde_json::from_value::<crate::nodes::INodeExecutionData>(it.clone()) {
                                input_items.push(item_data);
                            } else {
                                input_items.push(crate::nodes::INodeExecutionData::from_json(it.clone()));
                            }
                        } else {
                            input_items.push(crate::nodes::INodeExecutionData::from_json(it.clone()));
                        }
                    }
                } else if input_val.get("json").is_some() {
                    if let Ok(item_data) = serde_json::from_value::<crate::nodes::INodeExecutionData>((*input_val).clone()) {
                        input_items.push(item_data);
                    } else {
                        input_items.push(crate::nodes::INodeExecutionData::from_json((*input_val).clone()));
                    }
                } else if !input_val.is_null() && !input_val.as_object().map(|o| o.is_empty()).unwrap_or(false) {
                    input_items.push(crate::nodes::INodeExecutionData::from_json((*input_val).clone()));
                }
            }

            let ctx = crate::nodes::NodeExecutionContext {
                workflow_id: self.workflow_id.clone(),
                execution_id: self.execution_id.clone(),
                node_name: node.name.clone(),
                parameters: node.parameters.as_object().cloned().unwrap_or_default(),
            };

            let output_branches = registered_node.execute(&ctx, input_items).await
                .map_err(|e| e.to_string())?;

            if output_branches.is_empty() {
                return Ok(serde_json::json!([]));
            } else if output_branches.len() == 1 {
                return Ok(serde_json::to_value(&output_branches[0]).unwrap_or_else(|_| serde_json::json!([])));
            } else {
                return Ok(serde_json::to_value(&output_branches).unwrap_or_else(|_| serde_json::json!([])));
            }
        }

        match node_type {
            // =====================================
            // 1. TRIGGER NODES
            // =====================================
            "n8n-nodes-base.webhook" | "n8n-nodes-base.manualTrigger" | "n8n-nodes-base.scheduleTrigger" => {
                if !inputs.is_empty() {
                    Ok((*inputs[0]).clone())
                } else {
                    Ok(serde_json::json!([{
                        "json": {
                            "trigger": "executed",
                            "timestamp": Utc::now().to_rfc3339()
                        }
                    }]))
                }
            }

            // =====================================
            // 2. CODE & EXPRESSION RUNNER (Pure-Rust JS Sandbox)
            // =====================================
            "n8n-nodes-base.code" => {
                let code = node.parameters.get("jsCode")
                    .or_else(|| node.parameters.get("code"))
                    .or_else(|| node.parameters.get("pythonCode"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("return $input.all();");

                let items_input = if !inputs.is_empty() {
                    (*inputs[0]).clone()
                } else {
                    serde_json::json!([])
                };

                let res = JsEvaluator::evaluate_code(code, &items_input)?;
                Ok(res)
            }

            // =====================================
            // 3. SET / EDIT FIELDS (Data Mutation)
            // =====================================
            "n8n-nodes-base.set" | "n8n-nodes-base.editFields" => {
                let mut resolved_output = serde_json::Map::new();

                if let Some(obj) = node.parameters.as_object() {
                    for (k, v) in obj {
                        if k == "assignments" {
                            if let Some(assignments) = v.get("assignments").and_then(|a| a.as_array()) {
                                for assign in assignments {
                                    if let (Some(name), Some(val)) = (assign.get("name").and_then(|n| n.as_str()), assign.get("value")) {
                                        let res = Self::resolve_value(val, context);
                                        resolved_output.insert(name.to_string(), res);
                                    }
                                }
                            }
                        } else {
                            let resolved = Self::resolve_value(v, context);
                            resolved_output.insert(k.clone(), resolved);
                        }
                    }
                }

                Ok(serde_json::json!([{ "json": resolved_output }]))
            }

            // =====================================
            // 4. HTTP REQUEST (Shared Connection Pool)
            // =====================================
            "n8n-nodes-base.httpRequest" => {
                self.execute_http_request(node, context).await
            }

            // =====================================
            // 5. IF CONDITION (Branching Logic)
            // =====================================
            "n8n-nodes-base.if" => {
                let condition_passed = self.evaluate_if_condition(node, context);
                if condition_passed {
                    Ok(if !inputs.is_empty() { (*inputs[0]).clone() } else { serde_json::json!([]) })
                } else {
                    Ok(serde_json::json!([]))
                }
            }

            // =====================================
            // 6. FILTER (Array Item Filtering)
            // =====================================
            "n8n-nodes-base.filter" => {
                let items = context.as_array();
                if let Some(arr) = items {
                    let mut matched = Vec::new();
                    for item in arr {
                        if self.evaluate_if_condition(node, item) {
                            matched.push(item.clone());
                        }
                    }
                    Ok(Value::Array(matched))
                } else if self.evaluate_if_condition(node, context) {
                    Ok(serde_json::json!([context]))
                } else {
                    Ok(serde_json::json!([]))
                }
            }

            // =====================================
            // 7. SWITCH (Multi-Way Branching)
            // =====================================
            "n8n-nodes-base.switch" => {
                // Return matched context item
                Ok(if !inputs.is_empty() { (*inputs[0]).clone() } else { serde_json::json!([]) })
            }

            // =====================================
            // 8. MERGE / JOIN (Multiple Input Combiner)
            // =====================================
            "n8n-nodes-base.merge" => {
                let mut combined_items = Vec::new();
                for inp in inputs {
                    if let Some(arr) = inp.as_array() {
                        combined_items.extend(arr.clone());
                    } else if !inp.is_null() {
                        combined_items.push(inp.clone());
                    }
                }
                Ok(Value::Array(combined_items))
            }

            // =====================================
            // 9. SPLIT IN BATCHES (Chunking)
            // =====================================
            "n8n-nodes-base.splitInBatches" | "n8n-nodes-base.splitOut" => {
                let batch_size = node.parameters.get("batchSize")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(10) as usize;

                if let Some(arr) = context.as_array() {
                    let chunk: Vec<Value> = arr.iter().take(batch_size).cloned().collect();
                    Ok(Value::Array(chunk))
                } else {
                    Ok(serde_json::json!([context]))
                }
            }

            // =====================================
            // 10. ITEM LISTS (Sort, Limit, Deduplicate)
            // =====================================
            "n8n-nodes-base.itemLists" => {
                let operation = node.parameters.get("operation").and_then(|v| v.as_str()).unwrap_or("sort");
                if let Some(mut arr) = context.as_array().cloned() {
                    match operation {
                        "limit" => {
                            let max_items = node.parameters.get("maxItems").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
                            arr.truncate(max_items);
                        }
                        "removeDuplicates" => {
                            let mut seen = std::collections::HashSet::new();
                            arr.retain(|item| {
                                let key = serde_json::to_string(item).unwrap_or_default();
                                seen.insert(key)
                            });
                        }
                        _ => {}
                    }
                    Ok(Value::Array(arr))
                } else {
                    Ok(serde_json::json!([context]))
                }
            }

            // =====================================
            // 11. AGGREGATE (Combine into list)
            // =====================================
            "n8n-nodes-base.aggregate" => {
                let items = if let Some(arr) = context.as_array() {
                    arr.clone()
                } else {
                    vec![context.clone()]
                };
                Ok(serde_json::json!([{ "json": { "items": items, "count": items.len() } }]))
            }

            // =====================================
            // 12. CRYPTO (Hashing, Base64, UUID)
            // =====================================
            "n8n-nodes-base.crypto" => {
                let action = node.parameters.get("action").and_then(|v| v.as_str()).unwrap_or("hash");
                let raw_val = node.parameters.get("value").and_then(|v| v.as_str()).unwrap_or("");
                let resolved = Self::resolve_value(&Value::String(raw_val.to_string()), context);
                let text_val = resolved.as_str().unwrap_or(raw_val);

                match action {
                    "base64Encode" => {
                        let encoded = BASE64_STANDARD.encode(text_val.as_bytes());
                        Ok(serde_json::json!([{ "json": { "data": encoded } }]))
                    }
                    "base64Decode" => {
                        let decoded = BASE64_STANDARD.decode(text_val.as_bytes())
                            .map(|b| String::from_utf8_lossy(&b).to_string())
                            .unwrap_or_default();
                        Ok(serde_json::json!([{ "json": { "data": decoded } }]))
                    }
                    "uuid" => {
                        let id = uuid::Uuid::new_v4().to_string();
                        Ok(serde_json::json!([{ "json": { "uuid": id } }]))
                    }
                    _ => {
                        // SHA-256 Default
                        let mut hasher = Sha256::new();
                        hasher.update(text_val.as_bytes());
                        let hash_res = format!("{:x}", hasher.finalize());
                        Ok(serde_json::json!([{ "json": { "hash": hash_res } }]))
                    }
                }
            }

            // =====================================
            // 13. DATE & TIME (Manipulation & Format)
            // =====================================
            "n8n-nodes-base.dateTime" => {
                let now = Utc::now();
                let output = serde_json::json!([{
                    "json": {
                        "currentDate": now.to_rfc3339(),
                        "timestamp": now.timestamp(),
                        "timestampMs": now.timestamp_millis(),
                        "formatted": now.format("%Y-%m-%d %H:%M:%S").to_string()
                    }
                }]);
                Ok(output)
            }

            // =====================================
            // 14. WAIT (Asynchronous Sleep)
            // =====================================
            "n8n-nodes-base.wait" => {
                let amount = node.parameters.get("amount").and_then(|v| v.as_u64()).unwrap_or(1);
                let unit = node.parameters.get("unit").and_then(|v| v.as_str()).unwrap_or("seconds");
                let ms = match unit {
                    "minutes" => amount * 60 * 1000,
                    "hours" => amount * 3600 * 1000,
                    "milliseconds" => amount,
                    _ => amount * 1000,
                };

                // Asynchronous non-blocking sleep in Tokio thread
                tokio::time::sleep(Duration::from_millis(ms)).await;
                Ok(if !inputs.is_empty() { (*inputs[0]).clone() } else { serde_json::json!([]) })
            }

            // =====================================
            // 15. STOP AND ERROR
            // =====================================
            "n8n-nodes-base.stopAndError" => {
                let msg = node.parameters.get("errorMessage")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Workflow dihentikan oleh StopAndError node.");
                Err(msg.to_string())
            }

            // =====================================
            // 16. RESPOND TO WEBHOOK
            // =====================================
            "n8n-nodes-base.respondToWebhook" => {
                let response_body = node.parameters.get("responseBody")
                    .map(|b| Self::resolve_value(b, context))
                    .unwrap_or_else(|| context.clone());

                Ok(serde_json::json!([{
                    "json": {
                        "webhookResponse": response_body,
                        "status": 200
                    }
                }]))
            }

            // =====================================
            // 17. NO-OP & PASSTHROUGH
            // =====================================
            "n8n-nodes-base.noOp" | _ => {
                if !inputs.is_empty() {
                    Ok((*inputs[0]).clone())
                } else {
                    Ok(serde_json::json!([{ "json": { "status": "executed" } }]))
                }
            }
        }
    }

    /// Evaluator kondisi untuk node IF dan Filter
    fn evaluate_if_condition(&self, node: &Node, context: &Value) -> bool {
        let params = &node.parameters;

        // Mendukung skema conditions n8n
        if let Some(conditions) = params.get("conditions") {
            if let Some(str_conditions) = conditions.get("string").and_then(|s| s.as_array()) {
                for cond in str_conditions {
                    let v1_raw = cond.get("value1").and_then(|v| v.as_str()).unwrap_or("");
                    let v2_raw = cond.get("value2").and_then(|v| v.as_str()).unwrap_or("");
                    let op = cond.get("operation").and_then(|v| v.as_str()).unwrap_or("equals");

                    let v1 = Self::resolve_value(&Value::String(v1_raw.to_string()), context);
                    let v2 = Self::resolve_value(&Value::String(v2_raw.to_string()), context);

                    let s1 = v1.as_str().unwrap_or(v1_raw);
                    let s2 = v2.as_str().unwrap_or(v2_raw);

                    match op {
                        "equals" => if s1 != s2 { return false; },
                        "notEquals" => if s1 == s2 { return false; },
                        "contains" => if !s1.contains(s2) { return false; },
                        "notContains" => if s1.contains(s2) { return false; },
                        "startsWith" => if !s1.starts_with(s2) { return false; },
                        "endsWith" => if !s1.ends_with(s2) { return false; },
                        "isEmpty" => if !s1.is_empty() { return false; },
                        "isNotEmpty" => if s1.is_empty() { return false; },
                        _ => {}
                    }
                }
                return true;
            }
        }

        true
    }

    /// High-Efficiency Async HTTP Client dengan Connection Pool Terpadu
    async fn execute_http_request(&self, node: &Node, context: &Value) -> Result<Value, String> {
        let params = &node.parameters;

        let raw_url = params.get("url").and_then(|v| v.as_str()).unwrap_or("https://httpbin.org/get");
        let resolved_url_val = Self::resolve_value(&Value::String(raw_url.to_string()), context);
        let url_str = resolved_url_val.as_str().unwrap_or(raw_url);

        let mut final_url = url_str.to_string();
        if let Some(query_params) = params.get("queryParameters").and_then(|v| v.as_object()) {
            let mut first = !final_url.contains('?');
            for (k, v) in query_params {
                let resolved_v = Self::resolve_value(v, context);
                if let Some(s) = resolved_v.as_str() {
                    let sep = if first { '?' } else { '&' };
                    first = false;
                    final_url.push_str(&format!("{}{k}={s}", sep));
                }
            }
        }

        let method_str = params.get("method").and_then(|v| v.as_str()).unwrap_or("GET").to_uppercase();

        let mut req_builder = match method_str.as_str() {
            "POST" => self.http_client.post(&final_url),
            "PUT" => self.http_client.put(&final_url),
            "DELETE" => self.http_client.delete(&final_url),
            "PATCH" => self.http_client.patch(&final_url),
            "HEAD" => self.http_client.head(&final_url),
            _ => self.http_client.get(&final_url),
        };

        if let Some(headers) = params.get("headerParameters").and_then(|v| v.as_object()) {
            for (k, v) in headers {
                let resolved_v = Self::resolve_value(v, context);
                if let Some(s) = resolved_v.as_str() {
                    req_builder = req_builder.header(k.as_str(), s);
                }
            }
        }

        if matches!(method_str.as_str(), "POST" | "PUT" | "PATCH") {
            if let Some(body) = params.get("body") {
                let resolved_body = Self::resolve_value(body, context);
                if resolved_body.is_object() || resolved_body.is_array() {
                    req_builder = req_builder.json(&resolved_body);
                } else if let Some(s) = resolved_body.as_str() {
                    req_builder = req_builder.header("Content-Type", "application/json").body(s.to_string());
                }
            }
        }

        match req_builder.send().await {
            Ok(response) => {
                let status = response.status().as_u16();
                let headers_map: HashMap<String, String> = response
                    .headers()
                    .iter()
                    .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
                    .collect();

                let body_json: Value = response.json().await.unwrap_or(serde_json::json!({}));

                Ok(serde_json::json!([{
                    "json": {
                        "statusCode": status,
                        "headers": headers_map,
                        "data": body_json
                    }
                }]))
            }
            Err(err) => {
                Ok(serde_json::json!([{
                    "json": {
                        "error": true,
                        "message": err.to_string()
                    }
                }]))
            }
        }
    }
}
