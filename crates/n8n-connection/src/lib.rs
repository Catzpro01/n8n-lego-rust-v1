use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use std::collections::{HashSet, VecDeque};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ConnectionItem {
    pub node: String,
    #[serde(rename = "type")]
    pub connection_type: String,
    pub index: usize,
}

pub type ConnectionOutput = Option<Vec<ConnectionItem>>;
pub type NodeConnections = IndexMap<String, Vec<ConnectionOutput>>;
pub type WorkflowConnections = IndexMap<String, NodeConnections>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionTypeFilter {
    Type(String),
    All,
    AllNonMain,
}

impl Default for ConnectionTypeFilter {
    fn default() -> Self {
        Self::Type("main".to_string())
    }
}

/// Transitive connected nodes traversal conforming to reference common/get-connected-nodes.ts
/// - Deduplicated
/// - Farthest-first order (prepended recursion results)
/// - Depth-bounded (-1 = unlimited)
/// - Cycle-safe
pub fn get_connected_nodes(
    connections: &WorkflowConnections,
    node_name: &str,
    filter: &ConnectionTypeFilter,
    depth: i64,
) -> Vec<String> {
    let mut checked_nodes = HashSet::new();
    get_connected_nodes_internal(connections, node_name, filter, depth, &mut checked_nodes)
}

fn get_connected_nodes_internal(
    connections: &WorkflowConnections,
    node_name: &str,
    filter: &ConnectionTypeFilter,
    depth: i64,
    checked_nodes: &mut HashSet<String>,
) -> Vec<String> {
    if checked_nodes.contains(node_name) || depth == 0 {
        return Vec::new();
    }
    checked_nodes.insert(node_name.to_string());

    let mut direct_nodes = Vec::new();
    let mut recursive_nodes = Vec::new();

    if let Some(node_connections) = connections.get(node_name) {
        for (conn_type, output_slots) in node_connections {
            let is_matched = match filter {
                ConnectionTypeFilter::Type(t) => conn_type == t,
                ConnectionTypeFilter::All => true,
                ConnectionTypeFilter::AllNonMain => conn_type != "main",
            };

            if !is_matched {
                continue;
            }

            for slot in output_slots {
                if let Some(items) = slot {
                    for item in items {
                        if !direct_nodes.contains(&item.node) {
                            direct_nodes.push(item.node.clone());
                        }
                    }
                }
            }
        }
    }

    let next_depth = if depth > 0 { depth - 1 } else { -1 };
    for next_node in &direct_nodes {
        let mut sub_nodes =
            get_connected_nodes_internal(connections, next_node, filter, next_depth, checked_nodes);
        for sub in sub_nodes.drain(..) {
            if !recursive_nodes.contains(&sub) && !direct_nodes.contains(&sub) {
                recursive_nodes.push(sub);
            }
        }
    }

    // Farthest-first order: recursive nodes prepended before direct nodes
    let mut result = recursive_nodes;
    for direct in direct_nodes {
        if !result.contains(&direct) {
            result.push(direct);
        }
    }

    result
}

/// Invert connections from bySource to byDestination with padding per contract §3.3
pub fn map_connections_by_destination(by_source: &WorkflowConnections) -> WorkflowConnections {
    let mut by_dest: WorkflowConnections = IndexMap::new();

    for (src_node, outputs) in by_source {
        for (conn_type, output_slots) in outputs {
            for (out_idx, slot) in output_slots.iter().enumerate() {
                if let Some(items) = slot {
                    for target_item in items {
                        let dest_node = &target_item.node;
                        let input_idx = target_item.index;

                        let dest_map = by_dest.entry(dest_node.clone()).or_default();
                        let input_slots = dest_map.entry(conn_type.clone()).or_default();

                        // Pad missing input indexes with empty slot Some(vec![])
                        while input_slots.len() <= input_idx {
                            input_slots.push(Some(Vec::new()));
                        }

                        if let Some(ref mut input_list) = input_slots[input_idx] {
                            input_list.push(ConnectionItem {
                                node: src_node.clone(),
                                connection_type: conn_type.clone(),
                                index: out_idx,
                            });
                        }
                    }
                }
            }
        }
    }

    by_dest
}

/// Check if there is a directed path from source to target
pub fn has_path(connections: &WorkflowConnections, from: &str, to: &str) -> bool {
    if from == to {
        return true;
    }

    let mut visited: HashSet<String> = HashSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back(from.to_string());
    visited.insert(from.to_string());

    while let Some(current) = queue.pop_front() {
        let filter = ConnectionTypeFilter::All;
        for next in get_connected_nodes(connections, &current, &filter, 1) {
            if next == to {
                return true;
            }
            if !visited.contains(&next) {
                visited.insert(next.clone());
                queue.push_back(next);
            }
        }
    }

    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_farthest_first_get_connected_nodes() {
        // Trigger -> A -> B
        let mut conns = WorkflowConnections::new();
        let mut t_outs = IndexMap::new();
        t_outs.insert(
            "main".into(),
            vec![Some(vec![ConnectionItem {
                node: "A".into(),
                connection_type: "main".into(),
                index: 0,
            }])],
        );
        conns.insert("Trigger".into(), t_outs);

        let mut a_outs = IndexMap::new();
        a_outs.insert(
            "main".into(),
            vec![Some(vec![ConnectionItem {
                node: "B".into(),
                connection_type: "main".into(),
                index: 0,
            }])],
        );
        conns.insert("A".into(), a_outs);

        let filter = ConnectionTypeFilter::default();
        let connected = get_connected_nodes(&conns, "Trigger", &filter, -1);
        // In farthest-first order, B is farthest so it comes before A: ["B", "A"]
        assert_eq!(connected, vec!["B", "A"]);
    }

    #[test]
    fn test_null_slot_and_destination_inversion() {
        let mut by_source = WorkflowConnections::new();
        let mut src_outs = IndexMap::new();
        // Slot 0 is null, slot 1 has connection to Dest
        src_outs.insert(
            "main".into(),
            vec![
                None,
                Some(vec![ConnectionItem {
                    node: "Dest".into(),
                    connection_type: "main".into(),
                    index: 1,
                }]),
            ],
        );
        by_source.insert("Src".into(), src_outs);

        let by_dest = map_connections_by_destination(&by_source);
        assert!(by_dest.contains_key("Dest"));
        let dest_slots = &by_dest["Dest"]["main"];
        // Slot 0 is padded with Some([]), Slot 1 has Src
        assert_eq!(dest_slots.len(), 2);
        assert_eq!(dest_slots[0], Some(vec![]));
        assert_eq!(
            dest_slots[1],
            Some(vec![ConnectionItem {
                node: "Src".into(),
                connection_type: "main".into(),
                index: 1
            }])
        );
    }
}
