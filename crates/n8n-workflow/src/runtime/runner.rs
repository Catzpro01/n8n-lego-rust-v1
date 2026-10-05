use crate::runtime::context::ExecutionContext;
use crate::runtime::error::ExecutionError;
use crate::runtime::executor::NodeExecutor;
use crate::runtime::frame::ExecutionFrame;
use crate::runtime::ir::{NodeIndex, RuntimeGraph};
use crate::Workflow;
use async_trait::async_trait;
use n8n_execution_data::{DataRecord, ItemBuffer};
use n8n_node_model::NodeTypeDescription;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;

/// Standard PassThrough / Start Node Executor
pub struct PassThroughExecutor {
    name: String,
}

impl PassThroughExecutor {
    pub fn new(name: impl Into<String>) -> Self {
        Self { name: name.into() }
    }
}

#[async_trait]
impl NodeExecutor for PassThroughExecutor {
    fn name(&self) -> &str {
        &self.name
    }

    fn description(&self) -> NodeTypeDescription {
        NodeTypeDescription {
            name: self.name.clone(),
            display_name: self.name.clone(),
            version: 1.0,
            description: "Passes through incoming data or generates a seed item".to_string(),
            inputs: vec!["main".to_string()],
            outputs: vec!["main".to_string()],
            translation: None,
        }
    }

    async fn execute(
        &self,
        _ctx: &ExecutionContext,
        frame: &mut ExecutionFrame<'_>,
    ) -> Result<(), ExecutionError> {
        let records: Vec<DataRecord> = frame
            .main_input()
            .map(|in_buf| in_buf.iter().cloned().collect())
            .unwrap_or_default();

        if !records.is_empty() {
            for record in records {
                frame.push_output(0, record)?;
            }
        } else {
            // If input is empty (e.g. root trigger node), generate one seed item
            frame.push_output(0, DataRecord::new(json!({})))?;
        }
        Ok(())
    }
}

/// Standard Set Node Executor
pub struct SetNodeExecutor;

#[async_trait]
impl NodeExecutor for SetNodeExecutor {
    fn name(&self) -> &str {
        "n8n-nodes-base.set"
    }

    fn description(&self) -> NodeTypeDescription {
        NodeTypeDescription {
            name: "n8n-nodes-base.set".to_string(),
            display_name: "Set".to_string(),
            version: 1.0,
            description: "Sets values on incoming items".to_string(),
            inputs: vec!["main".to_string()],
            outputs: vec!["main".to_string()],
            translation: None,
        }
    }

    async fn execute(
        &self,
        _ctx: &ExecutionContext,
        frame: &mut ExecutionFrame<'_>,
    ) -> Result<(), ExecutionError> {
        let params = frame.parameters().cloned().unwrap_or(Value::Null);
        let values_to_set = if let Some(obj) = params.get("values").and_then(|v| v.as_object()) {
            obj.clone()
        } else if let Some(obj) = params.as_object() {
            obj.clone()
        } else {
            serde_json::Map::new()
        };

        let input_records: Vec<DataRecord> = frame
            .main_input()
            .map(|in_buf| in_buf.iter().cloned().collect())
            .unwrap_or_default();

        if !input_records.is_empty() {
            for record in input_records {
                let mut base_obj = match (*record.json).clone() {
                    Value::Object(map) => map,
                    _ => serde_json::Map::new(),
                };
                for (k, v) in &values_to_set {
                    base_obj.insert(k.clone(), v.clone());
                }
                let mut new_record = DataRecord::new(Value::Object(base_obj));
                new_record.paired_item = record.paired_item;
                new_record.binary = record.binary.clone();
                frame.push_output(0, new_record)?;
            }
        } else {
            let new_record = DataRecord::new(Value::Object(values_to_set));
            frame.push_output(0, new_record)?;
        }

        Ok(())
    }
}

/// Registry mapping node type identifiers to their executable implementations
#[derive(Default, Clone)]
pub struct NodeExecutorRegistry {
    executors: HashMap<String, Arc<dyn NodeExecutor>>,
}

impl NodeExecutorRegistry {
    pub fn new() -> Self {
        Self {
            executors: HashMap::new(),
        }
    }

    pub fn register(
        &mut self,
        node_type: impl Into<String>,
        executor: impl NodeExecutor + 'static,
    ) {
        self.executors.insert(node_type.into(), Arc::new(executor));
    }

    pub fn register_arc(&mut self, node_type: impl Into<String>, executor: Arc<dyn NodeExecutor>) {
        self.executors.insert(node_type.into(), executor);
    }

    pub fn get(&self, node_type: &str) -> Option<Arc<dyn NodeExecutor>> {
        self.executors.get(node_type).cloned()
    }

    pub fn contains(&self, node_type: &str) -> bool {
        self.executors.contains_key(node_type)
    }

    /// Pre-populates the registry with standard core nodes
    pub fn with_core_nodes() -> Self {
        let mut reg = Self::new();
        reg.register(
            "n8n-nodes-base.manualTrigger",
            PassThroughExecutor::new("n8n-nodes-base.manualTrigger"),
        );
        reg.register(
            "n8n-nodes-base.start",
            PassThroughExecutor::new("n8n-nodes-base.start"),
        );
        reg.register(
            "n8n-nodes-base.noOp",
            PassThroughExecutor::new("n8n-nodes-base.noOp"),
        );
        reg.register("n8n-nodes-base.set", SetNodeExecutor);
        reg
    }
}

/// Output collection and metadata resulting from a workflow execution
#[derive(Debug, Clone)]
pub struct WorkflowExecutionResult {
    pub workflow_id: String,
    pub execution_id: String,
    pub node_outputs: HashMap<String, Vec<ItemBuffer>>,
    pub executed_nodes: Vec<String>,
}

impl WorkflowExecutionResult {
    pub fn get_node_output(&self, node_name: &str, port: usize) -> Option<&ItemBuffer> {
        self.node_outputs
            .get(node_name)
            .and_then(|slots| slots.get(port))
    }

    pub fn last_node_output(&self) -> Option<&ItemBuffer> {
        self.executed_nodes
            .last()
            .and_then(|name| self.get_node_output(name, 0))
    }
}

/// Single-Threaded Execution Runner (Kernel Runtime M0)
pub struct WorkflowRunner {
    registry: Arc<NodeExecutorRegistry>,
}

impl WorkflowRunner {
    pub fn new(registry: Arc<NodeExecutorRegistry>) -> Self {
        Self { registry }
    }

    pub fn with_core_registry() -> Self {
        Self::new(Arc::new(NodeExecutorRegistry::with_core_nodes()))
    }

    pub async fn run(
        &self,
        workflow: &Workflow,
        ctx: &ExecutionContext,
        initial_input: Option<ItemBuffer>,
    ) -> Result<WorkflowExecutionResult, ExecutionError> {
        if ctx.is_cancelled() {
            return Err(ExecutionError::Cancelled);
        }

        // Lower Workflow DAG into RuntimeGraph with topological ordering and cycle checks
        let graph = RuntimeGraph::from_workflow(workflow)?;

        let mut node_outputs: HashMap<NodeIndex, Vec<ItemBuffer>> =
            HashMap::with_capacity(graph.nodes.len());
        let mut executed_nodes: Vec<String> = Vec::with_capacity(graph.nodes.len());

        for &node_idx in &graph.execution_order {
            if ctx.is_cancelled() {
                return Err(ExecutionError::Cancelled);
            }

            let node = graph
                .node(node_idx)
                .ok_or_else(|| ExecutionError::NodeNotFound(format!("Node index {}", node_idx)))?;

            if node.disabled {
                continue;
            }

            let incoming = graph.incoming(node_idx);
            let mut inputs: Vec<ItemBuffer> = Vec::new();

            if incoming.is_empty() {
                // Root node: seed with initial input if provided, or empty buffer
                if let Some(ref init) = initial_input {
                    inputs.push(init.clone());
                } else {
                    inputs.push(ItemBuffer::new());
                }
            } else {
                // Gather outputs from predecessor nodes according to incoming edges
                let max_target_port = incoming
                    .iter()
                    .map(|e| e.target_input as usize)
                    .max()
                    .unwrap_or(0);
                let needed_ports = std::cmp::max(node.input_ports as usize, max_target_port + 1);
                inputs.resize_with(needed_ports, ItemBuffer::new);

                for edge in incoming {
                    if let Some(src_slots) = node_outputs.get(&edge.source_node) {
                        if let Some(src_buf) = src_slots.get(edge.source_output as usize) {
                            for record in src_buf.iter() {
                                inputs[edge.target_input as usize].push(record.clone());
                            }
                        }
                    }
                }
            }

            let executor = self
                .registry
                .get(&node.node_type)
                .ok_or_else(|| ExecutionError::ExecutorNotFound(node.node_type.clone()))?;

            let mut frame = ExecutionFrame::new(node_idx, &inputs, node.output_ports as usize)
                .with_memory_budget(ctx.memory_budget.clone())
                .with_parameters(node.parameters.clone());

            executor.execute(ctx, &mut frame).await?;

            let outputs = frame.take_outputs();
            node_outputs.insert(node_idx, outputs);
            executed_nodes.push(node.name.clone());
        }

        let mut final_node_outputs: HashMap<String, Vec<ItemBuffer>> =
            HashMap::with_capacity(node_outputs.len());
        for (idx, outs) in node_outputs {
            if let Some(node) = graph.node(idx) {
                final_node_outputs.insert(node.name.clone(), outs);
            }
        }

        Ok(WorkflowExecutionResult {
            workflow_id: ctx.workflow_id.clone(),
            execution_id: ctx.execution_id.clone(),
            node_outputs: final_node_outputs,
            executed_nodes,
        })
    }
}
