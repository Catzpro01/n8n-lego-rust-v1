//! Graph traversal, ported from `reference/n8n/packages/workflow/src/common/get-connected-nodes.ts`
//! (shared by `getConnectedNodes`, `getChildNodes` and `getParentNodes`).
//!
//! Ported details that look like bugs but are observable behaviour:
//!
//! * `depth` counts *down* from the requested one and `-1` means unlimited
//!   (`depth === 0` returns immediately, so `depth: 1` visits the direct neighbours only);
//! * results are built with `unshift`, and a node that is re-found later is removed from its
//!   current position and moved to the front, so the returned array is "closest to the end
//!   first";
//! * `checkedNodes` is copied **per connection type**, which is why `ALL` can reach nodes
//!   that `main` alone would have marked as visited;
//! * a missing source key, or a source key without the requested type, yields `[]`.

use crate::connections::Connections;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionTypeFilter {
    /// A concrete type, normally `main`.
    Named(String),
    /// `'ALL'` — every type present on the node, in document order.
    All,
    /// `'ALL_NON_MAIN'` — every type except `main`, in document order.
    AllNonMain,
}

impl ConnectionTypeFilter {
    pub fn main() -> Self {
        Self::Named("main".to_string())
    }

    /// Parses the wire vocabulary used by the reference (`main`, `ALL`, `ALL_NON_MAIN`, any type).
    pub fn parse(value: &str) -> Self {
        match value {
            "ALL" => Self::All,
            "ALL_NON_MAIN" => Self::AllNonMain,
            other => Self::Named(other.to_string()),
        }
    }
}

impl Default for ConnectionTypeFilter {
    fn default() -> Self {
        Self::main()
    }
}

/// Port of `getConnectedNodes`. `depth` is `-1` for unlimited.
pub fn get_connected_nodes(
    connections: &Connections,
    node_name: &str,
    connection_type: &ConnectionTypeFilter,
    depth: i32,
    checked_nodes_incoming: Option<&[String]>,
) -> Vec<String> {
    let new_depth = if depth == -1 { -1 } else { depth - 1 };
    if depth == 0 {
        // Reached max depth
        return Vec::new();
    }

    let Some(node_outputs) = connections.get(node_name) else {
        // Node does not have incoming connections (source map: has no outgoing ones)
        return Vec::new();
    };

    let types: Vec<String> = match connection_type {
        ConnectionTypeFilter::All => node_outputs.key_names(),
        ConnectionTypeFilter::AllNonMain => node_outputs
            .keys()
            .filter(|key| key.as_str() != "main")
            .cloned()
            .collect(),
        ConnectionTypeFilter::Named(name) => vec![name.clone()],
    };

    let mut return_nodes: Vec<String> = Vec::new();

    for type_name in types {
        let Some(output_lists) = node_outputs.get(&type_name) else {
            continue;
        };

        let mut checked_nodes: Vec<String> = checked_nodes_incoming
            .map(|names| names.to_vec())
            .unwrap_or_default();

        if checked_nodes.iter().any(|name| name == node_name) {
            // Node got checked already before
            continue;
        }
        checked_nodes.push(node_name.to_string());

        for slot in output_lists {
            let Some(connections_in_slot) = slot else {
                continue;
            };
            for connection in connections_in_slot {
                if checked_nodes.iter().any(|name| name == &connection.node) {
                    continue;
                }

                return_nodes.insert(0, connection.node.clone());

                let add_nodes = get_connected_nodes(
                    connections,
                    &connection.node,
                    connection_type,
                    new_depth,
                    Some(&checked_nodes),
                );

                // JS iterates the collected nodes back to front (see `for (i = addNodes.length; i--; )`)
                // and unshifts each, removing a previous occurrence so the order stays "nearest first".
                for parent_node_name in add_nodes.iter().rev() {
                    if let Some(position) = return_nodes
                        .iter()
                        .position(|name| name == parent_node_name)
                    {
                        return_nodes.remove(position);
                    }
                    return_nodes.insert(0, parent_node_name.clone());
                }
            }
        }
    }

    return_nodes
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{Connection, Connections, NodeOutputs, OutputLists};
    use crate::ordered::OrderedMap;

    fn connection(node: &str) -> Connection {
        Connection {
            node: node.into(),
            connection_type: "main".into(),
            index: 0,
        }
    }

    fn graph() -> Connections {
        let mut graph: Connections = OrderedMap::new();
        let mut a = NodeOutputs::new();
        a.insert("main".into(), vec![Some(vec![connection("B")])]);
        a.insert(
            "ai_languageModel".into(),
            vec![Some(vec![Connection {
                node: "M".into(),
                connection_type: "ai_languageModel".into(),
                index: 0,
            }])],
        );
        graph.insert("A".into(), a);

        for (from, to) in [("B", "C"), ("C", "D")] {
            let mut outputs = NodeOutputs::new();
            outputs.insert("main".into(), vec![Some(vec![connection(to)])]);
            graph.insert(from.into(), outputs);
        }

        let empty: OutputLists = Vec::new();
        let _ = empty;
        graph.insert("D".into(), NodeOutputs::new());
        graph.insert("M".into(), NodeOutputs::new());
        graph
    }

    #[test]
    fn unlimited_main_walks_to_the_end_and_reports_nearest_last() {
        assert_eq!(
            get_connected_nodes(&graph(), "A", &ConnectionTypeFilter::main(), -1, None),
            vec!["D", "C", "B"]
        );
    }

    #[test]
    fn depth_limits_the_walk() {
        let graph = graph();
        assert!(
            get_connected_nodes(&graph, "A", &ConnectionTypeFilter::main(), 0, None).is_empty()
        );
        assert_eq!(
            get_connected_nodes(&graph, "A", &ConnectionTypeFilter::main(), 1, None),
            vec!["B"]
        );
        assert_eq!(
            get_connected_nodes(&graph, "A", &ConnectionTypeFilter::main(), 2, None),
            vec!["C", "B"]
        );
    }

    #[test]
    fn all_and_all_non_main_follow_document_order() {
        let graph = graph();
        assert_eq!(
            get_connected_nodes(&graph, "A", &ConnectionTypeFilter::All, -1, None),
            vec!["M", "D", "C", "B"]
        );
        assert_eq!(
            get_connected_nodes(&graph, "A", &ConnectionTypeFilter::AllNonMain, -1, None),
            vec!["M"]
        );
    }

    #[test]
    fn leaf_and_unknown_nodes_return_nothing() {
        let graph = graph();
        assert!(
            get_connected_nodes(&graph, "D", &ConnectionTypeFilter::main(), -1, None).is_empty()
        );
        assert!(
            get_connected_nodes(&graph, "ZZZ", &ConnectionTypeFilter::main(), -1, None).is_empty()
        );
    }
}
