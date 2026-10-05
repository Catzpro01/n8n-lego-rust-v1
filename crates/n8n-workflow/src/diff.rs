//! `compareConnections`, ported from `reference/n8n/packages/workflow/src/connections-diff.ts`.
//!
//! Compares two source maps node by node, connection type by connection type and output slot
//! by output slot, and reports the edges that only exist on one side. Edges are keyed by their
//! serialised form (the reference uses `JSON.stringify(conn)` as the `Map` key), so two edges
//! are "the same" only when node, type and index all match.
//!
//! `Map` semantics worth keeping: an entry keeps the position of its **first** insertion but
//! carries the value of the **last** one.

use crate::connections::{Connection, Connections, NodeOutputs};
use crate::ordered::OrderedMap;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffValue {
    /// Position of the edge inside its output slot.
    pub index: usize,
    pub connection: Connection,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiffEntry {
    #[serde(rename = "sourceIndex")]
    pub source_index: usize,
    pub value: DiffValue,
}

/// connection type → entries of one node
pub type InputDiff = OrderedMap<Vec<DiffEntry>>;
/// node name → input diffs
pub type ConnectionsDiffMap = OrderedMap<InputDiff>;

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
pub struct ConnectionsDiff {
    pub added: ConnectionsDiffMap,
    pub removed: ConnectionsDiffMap,
}

fn collect_slot(slot: Option<&Vec<Connection>>) -> Vec<(String, DiffValue)> {
    let mut entries: Vec<(String, DiffValue)> = Vec::new();
    for (index, connection) in slot
        .map(|list| list.as_slice())
        .unwrap_or(&[])
        .iter()
        .enumerate()
    {
        let key = serde_json::to_string(connection).unwrap_or_default();
        let value = DiffValue {
            index,
            connection: connection.clone(),
        };
        // JS Map.set: existing key keeps its position, takes the new value.
        match entries.iter_mut().find(|(existing, _)| *existing == key) {
            Some((_, slot)) => *slot = value,
            None => entries.push((key, value)),
        }
    }
    entries
}

fn push(target: &mut ConnectionsDiffMap, node_name: &str, input_name: &str, entry: DiffEntry) {
    let node = target.entry_or_insert_default(node_name);
    let input = node.entry_or_insert_default(input_name);
    input.push(entry);
}

/// Port of `compareConnections`.
pub fn compare_connections(prev: &Connections, next: &Connections) -> ConnectionsDiff {
    let mut diff = ConnectionsDiff::default();

    for node_name in OrderedMap::union_keys(prev, next) {
        // `prev[nodeName] ?? {}`
        let empty_node = NodeOutputs::new();
        let prev_node = prev.get(&node_name).unwrap_or(&empty_node);
        let next_node = next.get(&node_name).unwrap_or(&empty_node);

        for input_name in OrderedMap::union_keys(prev_node, next_node) {
            let prev_input = prev_node.get(&input_name);
            let next_input = next_node.get(&input_name);

            let max_length = prev_input
                .map(|lists| lists.len())
                .unwrap_or(0)
                .max(next_input.map(|lists| lists.len()).unwrap_or(0));

            for source_index in 0..max_length {
                let prev_connections = prev_input
                    .and_then(|lists| lists.get(source_index))
                    .and_then(|slot| slot.as_ref());
                let next_connections = next_input
                    .and_then(|lists| lists.get(source_index))
                    .and_then(|slot| slot.as_ref());

                let prev_map = collect_slot(prev_connections);
                let next_map = collect_slot(next_connections);

                for (key, value) in &next_map {
                    if !prev_map.iter().any(|(existing, _)| existing == key) {
                        push(
                            &mut diff.added,
                            &node_name,
                            &input_name,
                            DiffEntry {
                                source_index,
                                value: value.clone(),
                            },
                        );
                    }
                }

                for (key, value) in &prev_map {
                    if !next_map.iter().any(|(existing, _)| existing == key) {
                        push(
                            &mut diff.removed,
                            &node_name,
                            &input_name,
                            DiffEntry {
                                source_index,
                                value: value.clone(),
                            },
                        );
                    }
                }
            }
        }
    }

    diff
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connections::{Connection, OutputLists};

    fn connection(node: &str) -> Connection {
        Connection {
            node: node.into(),
            connection_type: "main".into(),
            index: 0,
        }
    }

    fn source(entries: &[(&str, OutputLists)]) -> Connections {
        let mut connections: Connections = OrderedMap::new();
        for (node, lists) in entries {
            let mut outputs = NodeOutputs::new();
            outputs.insert("main".into(), lists.clone());
            connections.insert((*node).into(), outputs);
        }
        connections
    }

    #[test]
    fn identical_maps_produce_no_diff() {
        let a = source(&[("A", vec![Some(vec![connection("B")])])]);
        let diff = compare_connections(&a, &a);
        assert!(diff.added.is_empty());
        assert!(diff.removed.is_empty());
    }

    #[test]
    fn changed_destination_is_added_and_removed() {
        let prev = source(&[("A", vec![Some(vec![connection("B")])])]);
        let next = source(&[("A", vec![Some(vec![connection("C")])])]);
        let diff = compare_connections(&prev, &next);

        let added = diff
            .added
            .get("A")
            .and_then(|inputs| inputs.get("main"))
            .expect("added entry");
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].value.connection.node, "C");

        let removed = diff
            .removed
            .get("A")
            .and_then(|inputs| inputs.get("main"))
            .expect("removed entry");
        assert_eq!(removed[0].value.connection.node, "B");
    }

    #[test]
    fn removed_output_slot_is_reported_with_its_source_index() {
        let prev = source(&[(
            "A",
            vec![Some(vec![connection("B")]), Some(vec![connection("C")])],
        )]);
        let next = source(&[("A", vec![Some(vec![connection("B")])])]);
        let diff = compare_connections(&prev, &next);

        let removed = diff
            .removed
            .get("A")
            .and_then(|inputs| inputs.get("main"))
            .expect("removed entry");
        assert_eq!(removed.len(), 1);
        assert_eq!(removed[0].source_index, 1);
        assert_eq!(removed[0].value.connection.node, "C");
    }
}
