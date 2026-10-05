use petgraph::graph::{Graph, NodeIndex};
use std::collections::HashMap;

use crate::workflow::{Connection, Node, Workflow};

pub struct WorkflowGraph {
    pub graph: Graph<Node, Connection>,
    pub node_indices: HashMap<String, NodeIndex>,
}

impl WorkflowGraph {
    /// Builds a Directed Acyclic Graph (DAG) from an n8n Workflow definition.
    pub fn build(workflow: &Workflow) -> Self {
        let mut graph = Graph::<Node, Connection>::new();
        let mut node_indices = HashMap::new();

        // 1. Add all nodes to the graph
        for node in &workflow.nodes {
            let index = graph.add_node(node.clone());
            node_indices.insert(node.name.clone(), index);
        }

        // 2. Add edges (connections) between nodes
        for (source_node_name, node_output_connections) in &workflow.connections {
            if let Some(&source_idx) = node_indices.get(source_node_name) {
                
                // node_output_connections is HashMap<String, Vec<Vec<Connection>>>
                // Key is the type of output (e.g., "main")
                for (_output_type, connection_arrays) in node_output_connections {
                    for connections in connection_arrays {
                        for connection in connections {
                            if let Some(&target_idx) = node_indices.get(&connection.node) {
                                graph.add_edge(source_idx, target_idx, connection.clone());
                            }
                        }
                    }
                }
            }
        }

        Self {
            graph,
            node_indices,
        }
    }
}
