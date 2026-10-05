use crate::runtime::error::ExecutionError;
use crate::Workflow;
use serde_json::Value;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;

pub type NodeIndex = u32;
pub type PortIndex = u16;

#[derive(Debug, Clone)]
pub struct RuntimeNode {
    pub id: NodeIndex,
    pub name: String,
    pub node_type: String,
    pub type_version: f64,
    pub parameters: Arc<Value>,
    pub input_ports: PortIndex,
    pub output_ports: PortIndex,
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct RuntimeEdge {
    pub source_node: NodeIndex,
    pub source_output: PortIndex,
    pub target_node: NodeIndex,
    pub target_input: PortIndex,
}

#[derive(Debug, Clone)]
pub struct RuntimeGraph {
    pub nodes: Vec<RuntimeNode>,
    pub node_indices: HashMap<String, NodeIndex>,
    pub outgoing_edges: Vec<Vec<RuntimeEdge>>,
    pub incoming_edges: Vec<Vec<RuntimeEdge>>,
    pub execution_order: Vec<NodeIndex>,
}

impl RuntimeGraph {
    pub fn from_workflow(workflow: &Workflow) -> Result<Self, ExecutionError> {
        let raw_nodes = workflow.get_nodes_in_order();
        let total_nodes = raw_nodes.len();

        let mut nodes = Vec::with_capacity(total_nodes);
        let mut node_indices = HashMap::with_capacity(total_nodes);

        for (idx, node) in raw_nodes.iter().enumerate() {
            let node_idx = idx as NodeIndex;
            node_indices.insert(node.name.clone(), node_idx);

            nodes.push(RuntimeNode {
                id: node_idx,
                name: node.name.clone(),
                node_type: node.node_type.clone(),
                type_version: node.type_version,
                parameters: Arc::new(serde_json::to_value(&node.parameters).unwrap_or(Value::Null)),
                input_ports: 1,  // Default main input
                output_ports: 1, // Default main output
                disabled: node.disabled.unwrap_or(false),
            });
        }

        let mut outgoing_edges: Vec<Vec<RuntimeEdge>> = vec![Vec::new(); total_nodes];
        let mut incoming_edges: Vec<Vec<RuntimeEdge>> = vec![Vec::new(); total_nodes];
        let mut in_degrees = vec![0usize; total_nodes];

        // Lower connections from n8n connection representation
        for (source_name, outputs) in workflow.connections_by_source_node.iter() {
            if let Some(&src_idx) = node_indices.get(source_name) {
                for (_conn_type, output_slots) in outputs.iter() {
                    for (slot_idx, slot) in output_slots.iter().enumerate() {
                        let Some(connections) = slot else {
                            continue;
                        };
                        for conn in connections {
                            if let Some(&tgt_idx) = node_indices.get(&conn.node) {
                                let edge = RuntimeEdge {
                                    source_node: src_idx,
                                    source_output: slot_idx as PortIndex,
                                    target_node: tgt_idx,
                                    target_input: conn.index as PortIndex,
                                };
                                outgoing_edges[src_idx as usize].push(edge.clone());
                                incoming_edges[tgt_idx as usize].push(edge);
                                in_degrees[tgt_idx as usize] += 1;
                            }
                        }
                    }
                }
            }
        }

        // Topological Sort (Kahn's Algorithm)
        let mut queue = VecDeque::new();
        for (idx, &degree) in in_degrees.iter().enumerate() {
            if degree == 0 {
                queue.push_back(idx as NodeIndex);
            }
        }

        let mut execution_order = Vec::with_capacity(total_nodes);
        while let Some(curr) = queue.pop_front() {
            execution_order.push(curr);
            for edge in &outgoing_edges[curr as usize] {
                let tgt = edge.target_node as usize;
                in_degrees[tgt] -= 1;
                if in_degrees[tgt] == 0 {
                    queue.push_back(tgt as NodeIndex);
                }
            }
        }

        if execution_order.len() != total_nodes {
            return Err(ExecutionError::CycleDetected);
        }

        Ok(Self {
            nodes,
            node_indices,
            outgoing_edges,
            incoming_edges,
            execution_order,
        })
    }

    pub fn node(&self, idx: NodeIndex) -> Option<&RuntimeNode> {
        self.nodes.get(idx as usize)
    }

    pub fn node_by_name(&self, name: &str) -> Option<&RuntimeNode> {
        self.node_indices.get(name).and_then(|&idx| self.node(idx))
    }

    pub fn outgoing(&self, idx: NodeIndex) -> &[RuntimeEdge] {
        self.outgoing_edges
            .get(idx as usize)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }

    pub fn incoming(&self, idx: NodeIndex) -> &[RuntimeEdge] {
        self.incoming_edges
            .get(idx as usize)
            .map(|v| v.as_slice())
            .unwrap_or(&[])
    }
}
