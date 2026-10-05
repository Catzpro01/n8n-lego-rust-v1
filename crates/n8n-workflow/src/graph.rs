use crate::Workflow;
use n8n_common::expression_contract::{
    EvaluationContext, ExpressionError, ExpressionEvaluator, ExpressionRef,
};
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum GraphValidationError {
    #[error("Cycle detected in workflow graph involving nodes: {cycle:?}")]
    CycleDetected { cycle: Vec<String> },

    #[error("Orphaned nodes detected without connections: {orphans:?}")]
    OrphanNodes { orphans: Vec<String> },
}

/// Validates that the workflow graph is a valid DAG (Directed Acyclic Graph)
/// and optionally checks for orphaned nodes.
pub fn validate_dag(workflow: &Workflow) -> Result<(), GraphValidationError> {
    if let Some(cycle) = detect_cycles(workflow) {
        return Err(GraphValidationError::CycleDetected { cycle });
    }
    Ok(())
}

/// Detects if there are any cycles in the workflow using Depth First Search (DFS).
/// Returns the cycle path if found, or None if the graph is strictly acyclic.
pub fn detect_cycles(workflow: &Workflow) -> Option<Vec<String>> {
    let mut visited = HashSet::new();
    let mut rec_stack = HashSet::new();
    let mut path = Vec::new();

    for node_name in workflow.node_keys() {
        if !visited.contains(&node_name) {
            if dfs_cycle(
                workflow,
                &node_name,
                &mut visited,
                &mut rec_stack,
                &mut path,
            ) {
                return Some(path);
            }
        }
    }
    None
}

fn dfs_cycle(
    workflow: &Workflow,
    current: &str,
    visited: &mut HashSet<String>,
    rec_stack: &mut HashSet<String>,
    path: &mut Vec<String>,
) -> bool {
    visited.insert(current.to_string());
    rec_stack.insert(current.to_string());
    path.push(current.to_string());

    if let Some(outputs) = workflow.connections_by_source_node.get(current) {
        for slot in outputs
            .values()
            .flat_map(|s| s.iter().filter_map(|x| x.as_ref()))
        {
            for conn in slot {
                let next = &conn.node;
                if !visited.contains(next) {
                    if dfs_cycle(workflow, next, visited, rec_stack, path) {
                        return true;
                    }
                } else if rec_stack.contains(next) {
                    path.push(next.clone());
                    return true;
                }
            }
        }
    }

    rec_stack.remove(current);
    path.pop();
    false
}

/// Finds all nodes that have neither incoming nor outgoing connections.
/// For workflows with more than 1 node, these are considered disconnected/orphaned.
pub fn find_orphan_nodes(workflow: &Workflow) -> Vec<String> {
    if workflow.node_count() <= 1 {
        return Vec::new();
    }

    let mut connected_nodes = HashSet::new();

    // Scan outgoing connections
    for (src, outputs) in workflow.connections_by_source_node.iter() {
        let mut has_outgoing = false;
        for slot in outputs
            .values()
            .flat_map(|s| s.iter().filter_map(|x| x.as_ref()))
        {
            for conn in slot {
                has_outgoing = true;
                connected_nodes.insert(conn.node.clone());
            }
        }
        if has_outgoing {
            connected_nodes.insert(src.clone());
        }
    }

    workflow
        .node_keys()
        .into_iter()
        .filter(|name| !connected_nodes.contains(name))
        .collect()
}

/// Checks if `target` is reachable from `source` in the workflow graph.
pub fn is_reachable(workflow: &Workflow, source: &str, target: &str) -> bool {
    if source == target {
        return true;
    }

    let mut visited = HashSet::new();
    let mut queue = std::collections::VecDeque::new();
    queue.push_back(source.to_string());
    visited.insert(source.to_string());

    while let Some(curr) = queue.pop_front() {
        if curr == target {
            return true;
        }

        if let Some(outputs) = workflow.connections_by_source_node.get(&curr) {
            for slot in outputs
                .values()
                .flat_map(|s| s.iter().filter_map(|x| x.as_ref()))
            {
                for conn in slot {
                    if !visited.contains(&conn.node) {
                        visited.insert(conn.node.clone());
                        queue.push_back(conn.node.clone());
                    }
                }
            }
        }
    }

    false
}

/// Traverses all node parameters in the workflow and extracts every expression reference.
pub fn extract_expressions(workflow: &Workflow) -> Vec<ExpressionRef> {
    let mut refs = Vec::new();

    for (node_name, node) in workflow.nodes.iter() {
        scan_value_for_expressions(node_name, "", &node.parameters.0, &mut refs);
    }

    refs
}

fn scan_value_for_expressions(
    node_name: &str,
    path: &str,
    val: &Value,
    refs: &mut Vec<ExpressionRef>,
) {
    match val {
        Value::String(s) => {
            if is_potential_expression(s) {
                refs.push(ExpressionRef {
                    node_name: node_name.to_string(),
                    parameter_path: path.to_string(),
                    raw_expression: s.clone(),
                });
            }
        }
        Value::Object(map) => {
            for (k, v) in map {
                let sub_path = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                scan_value_for_expressions(node_name, &sub_path, v, refs);
            }
        }
        Value::Array(arr) => {
            for (i, v) in arr.iter().enumerate() {
                let sub_path = format!("{path}[{i}]");
                scan_value_for_expressions(node_name, &sub_path, v, refs);
            }
        }
        _ => {}
    }
}

/// Quick heuristic check: starts with '={{' or contains '{{' and '}}'.
pub fn is_potential_expression(s: &str) -> bool {
    s.starts_with("={{") || (s.contains("{{") && s.contains("}}"))
}

/// Evaluates all expressions in a node's parameters using the provided ExpressionEvaluator.
/// Replaces expression strings with their evaluated Values, returning the full resolved parameters.
pub fn evaluate_node_parameters(
    workflow: &Workflow,
    node_name: &str,
    evaluator: &dyn ExpressionEvaluator,
    context: &dyn EvaluationContext,
) -> Result<Value, ExpressionError> {
    let node = workflow
        .get_node(node_name)
        .ok_or_else(|| ExpressionError::NodeNotFound {
            node_name: node_name.to_string(),
        })?;

    resolve_value_recursively(&node.parameters.0, evaluator, context)
}

fn resolve_value_recursively(
    val: &Value,
    evaluator: &dyn ExpressionEvaluator,
    context: &dyn EvaluationContext,
) -> Result<Value, ExpressionError> {
    match val {
        Value::String(s) if evaluator.is_expression(s) => evaluator.evaluate(s, context),
        Value::Object(map) => {
            let mut resolved_map = serde_json::Map::new();
            for (k, v) in map {
                resolved_map.insert(k.clone(), resolve_value_recursively(v, evaluator, context)?);
            }
            Ok(Value::Object(resolved_map))
        }
        Value::Array(arr) => {
            let mut resolved_arr = Vec::new();
            for v in arr {
                resolved_arr.push(resolve_value_recursively(v, evaluator, context)?);
            }
            Ok(Value::Array(resolved_arr))
        }
        other => Ok(other.clone()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::Connections;
    use crate::INode;
    use serde_json::json;

    fn make_node(name: &str, params: Value) -> INode {
        serde_json::from_value(json!({
            "id": format!("id-{name}"),
            "name": name,
            "type": "n8n-nodes-base.noOp",
            "typeVersion": 1,
            "position": [0, 0],
            "parameters": params
        }))
        .unwrap()
    }

    #[test]
    fn test_dag_acyclic_and_reachability() {
        let n1 = make_node("Start", json!({}));
        let n2 = make_node("Process", json!({}));
        let n3 = make_node("End", json!({}));

        let connections: Connections = serde_json::from_value(json!({
            "Start": { "main": [[{"node": "Process", "type": "main", "index": 0}]] },
            "Process": { "main": [[{"node": "End", "type": "main", "index": 0}]] }
        }))
        .unwrap();

        let wf = Workflow::new(
            None,
            None,
            vec![n1, n2, n3],
            connections,
            true,
            None,
            None,
            None,
        );

        assert!(validate_dag(&wf).is_ok());
        assert!(is_reachable(&wf, "Start", "End"));
        assert!(!is_reachable(&wf, "End", "Start"));
        assert!(find_orphan_nodes(&wf).is_empty());
    }

    #[test]
    fn test_dag_cycle_detection() {
        let n1 = make_node("A", json!({}));
        let n2 = make_node("B", json!({}));

        let connections: Connections = serde_json::from_value(json!({
            "A": { "main": [[{"node": "B", "type": "main", "index": 0}]] },
            "B": { "main": [[{"node": "A", "type": "main", "index": 0}]] }
        }))
        .unwrap();

        let wf = Workflow::new(
            None,
            None,
            vec![n1, n2],
            connections,
            true,
            None,
            None,
            None,
        );

        let err = validate_dag(&wf).unwrap_err();
        match err {
            GraphValidationError::CycleDetected { cycle } => {
                assert!(cycle.contains(&"A".to_string()));
                assert!(cycle.contains(&"B".to_string()));
            }
            _ => panic!("Expected CycleDetected"),
        }
    }

    #[test]
    fn test_extract_expressions() {
        let n1 = make_node(
            "Node1",
            json!({
                "plain": "Just text",
                "expr": "={{ $json.id }}",
                "nested": {
                    "arr": ["Hello {{ $json.name }}!", 42]
                }
            }),
        );

        let wf = Workflow::new(
            None,
            None,
            vec![n1],
            Connections::new(),
            true,
            None,
            None,
            None,
        );
        let refs = extract_expressions(&wf);

        assert_eq!(refs.len(), 2);
        assert_eq!(refs[0].parameter_path, "expr");
        assert_eq!(refs[0].raw_expression, "={{ $json.id }}");
        assert_eq!(refs[1].parameter_path, "nested.arr[0]");
        assert_eq!(refs[1].raw_expression, "Hello {{ $json.name }}!");
    }
}
