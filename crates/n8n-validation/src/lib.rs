use n8n_connection::WorkflowConnections;
pub mod parameters;
pub use parameters::{
    validate_parameters, NodeParameterView, ParameterSpecSet, ParameterValidationError,
    RequiredParameter,
};

use std::collections::{HashMap, HashSet};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum ValidationError {
    #[error("Node with name '{0}' is duplicated")]
    DuplicateNodeName(String),
    #[error("Connection targets non-existent node '{0}'")]
    DanglingConnection(String),
    #[error("Workflow contains cycle involving node '{0}'")]
    CycleDetected(String),
}

pub fn validate_node_uniqueness(nodes: &[String]) -> Result<(), ValidationError> {
    let mut seen = HashSet::new();
    for name in nodes {
        if !seen.insert(name) {
            return Err(ValidationError::DuplicateNodeName(name.clone()));
        }
    }
    Ok(())
}

pub fn validate_dangling_connections(
    nodes: &[String],
    connections: &WorkflowConnections,
) -> Result<(), ValidationError> {
    let node_set: HashSet<&str> = nodes.iter().map(|s| s.as_str()).collect();
    for (source, outputs) in connections {
        if !node_set.contains(source.as_str()) {
            return Err(ValidationError::DanglingConnection(source.clone()));
        }
        for list in outputs.values() {
            for slot in list {
                if let Some(items) = slot {
                    for item in items {
                        if !node_set.contains(item.node.as_str()) {
                            return Err(ValidationError::DanglingConnection(item.node.clone()));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

pub fn detect_cycles(
    nodes: &[String],
    connections: &WorkflowConnections,
) -> Result<(), ValidationError> {
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for n in nodes {
        adj.insert(n.as_str(), Vec::new());
    }

    for (src, outputs) in connections {
        for list in outputs.values() {
            for slot in list {
                if let Some(items) = slot {
                    for item in items {
                        adj.entry(src.as_str())
                            .or_default()
                            .push(item.node.as_str());
                    }
                }
            }
        }
    }

    let mut visited = HashSet::new();
    let mut rec_stack = HashSet::new();

    fn dfs<'a>(
        node: &'a str,
        adj: &HashMap<&'a str, Vec<&'a str>>,
        visited: &mut HashSet<&'a str>,
        rec_stack: &mut HashSet<&'a str>,
    ) -> Option<&'a str> {
        visited.insert(node);
        rec_stack.insert(node);

        if let Some(neighbors) = adj.get(node) {
            for &next_node in neighbors {
                if !visited.contains(next_node) {
                    if let Some(cycle_node) = dfs(next_node, adj, visited, rec_stack) {
                        return Some(cycle_node);
                    }
                } else if rec_stack.contains(next_node) {
                    return Some(next_node);
                }
            }
        }

        rec_stack.remove(node);
        None
    }

    for n in nodes {
        let name = n.as_str();
        if !visited.contains(name) {
            if let Some(cycle_node) = dfs(name, &adj, &mut visited, &mut rec_stack) {
                return Err(ValidationError::CycleDetected(cycle_node.to_string()));
            }
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use indexmap::IndexMap;

    #[test]
    fn test_node_uniqueness_pass() {
        let nodes = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        assert!(validate_node_uniqueness(&nodes).is_ok());
    }

    #[test]
    fn test_node_uniqueness_fail() {
        let nodes = vec!["A".to_string(), "B".to_string(), "A".to_string()];
        assert_eq!(
            validate_node_uniqueness(&nodes),
            Err(ValidationError::DuplicateNodeName("A".to_string()))
        );
    }

    #[test]
    fn test_cycle_detection_pass() {
        let nodes = vec!["A".to_string(), "B".to_string(), "C".to_string()];
        let mut conns = WorkflowConnections::new();
        let mut a_outs = IndexMap::new();
        a_outs.insert(
            "main".into(),
            vec![Some(vec![n8n_connection::ConnectionItem {
                node: "B".into(),
                connection_type: "main".into(),
                index: 0,
            }])],
        );
        conns.insert("A".into(), a_outs);

        let mut b_outs = IndexMap::new();
        b_outs.insert(
            "main".into(),
            vec![Some(vec![n8n_connection::ConnectionItem {
                node: "C".into(),
                connection_type: "main".into(),
                index: 0,
            }])],
        );
        conns.insert("B".into(), b_outs);

        assert!(detect_cycles(&nodes, &conns).is_ok());
    }

    #[test]
    fn test_cycle_detection_fail() {
        let nodes = vec!["A".to_string(), "B".to_string()];
        let mut conns = WorkflowConnections::new();

        let mut a_outs = IndexMap::new();
        a_outs.insert(
            "main".into(),
            vec![Some(vec![n8n_connection::ConnectionItem {
                node: "B".into(),
                connection_type: "main".into(),
                index: 0,
            }])],
        );
        conns.insert("A".into(), a_outs);

        let mut b_outs = IndexMap::new();
        b_outs.insert(
            "main".into(),
            vec![Some(vec![n8n_connection::ConnectionItem {
                node: "A".into(),
                connection_type: "main".into(),
                index: 0,
            }])],
        );
        conns.insert("B".into(), b_outs);

        assert!(detect_cycles(&nodes, &conns).is_err());
    }
}
