//! Connection maps, ported from `reference/n8n/packages/workflow/src/common/map-connections-by-destination.ts`
//! and the `IConnections` shape in `interfaces.ts`.
//!
//! Wire shape (document order preserved, see `ordered.rs`):
//!
//! ```text
//! connections[sourceNodeName][connectionType][sourceOutputIndex] = [ {node, type, index}, … ]
//! ```
//!
//! The aggregate keeps two maps: `connectionsBySourceNode` (as wired) and
//! `connectionsByDestinationNode` (derived once, at `setConnections` time — the
//! reference never re-derives it on rename, which is deliberate per D-08).

use crate::ordered::OrderedMap;
use serde::{Deserialize, Serialize};

/// A single edge as stored in the source map. In the destination map, `index` is the
/// *source* output index (see `map_connections_by_destination`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Connection {
    pub node: String,
    #[serde(rename = "type")]
    pub connection_type: String,
    pub index: usize,
}

/// One output slot; `null` entries are legal in n8n data and are skipped when traversed.
pub type ConnectionSlot = Option<Vec<Connection>>;

/// `[[…], null, […]]` — indexed by source output index.
pub type OutputLists = Vec<ConnectionSlot>;

/// `{ "main": [[…]] }` — connection type to output lists.
pub type NodeOutputs = OrderedMap<OutputLists>;

/// `{ "NodeName": { "main": [[…]] } }` — source or destination node name to outputs.
pub type Connections = OrderedMap<NodeOutputs>;

/// Port of `mapConnectionsByDestination`.
pub fn map_connections_by_destination(connections: &Connections) -> Connections {
    let mut by_destination: Connections = OrderedMap::new();

    for (source_node, outputs) in connections.iter() {
        for (connection_type, output_lists) in outputs.iter() {
            for (source_index, slot) in output_lists.iter().enumerate() {
                let Some(connections_in_slot) = slot else {
                    continue;
                };
                for connection in connections_in_slot {
                    let destination = by_destination.entry_or_insert_default(&connection.node);
                    let lists = destination.entry_or_insert_default(&connection.connection_type);

                    // JS: maxIndex = length - 1; for (j = maxIndex; j < index; j++) push([])
                    // → pads the array so that slot `index` exists.
                    while lists.len() <= connection.index {
                        lists.push(None);
                    }
                    if let Some(target_slot) = lists.get_mut(connection.index) {
                        target_slot.get_or_insert_with(Vec::new).push(Connection {
                            node: source_node.clone(),
                            connection_type: connection_type.clone(),
                            index: source_index,
                        });
                    }
                }
            }
        }
    }

    by_destination
}

impl Connections {
    /// All `(sourceNode, type, sourceIndex, connection)` tuples in document order.
    pub fn edges(&self) -> Vec<(String, String, usize, Connection)> {
        let mut out = Vec::new();
        for (source, outputs) in self.iter() {
            for (connection_type, lists) in outputs.iter() {
                for (source_index, slot) in lists.iter().enumerate() {
                    if let Some(slot) = slot {
                        for connection in slot {
                            out.push((
                                source.clone(),
                                connection_type.clone(),
                                source_index,
                                connection.clone(),
                            ));
                        }
                    }
                }
            }
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection(node: &str, index: usize) -> Connection {
        Connection {
            node: node.into(),
            connection_type: "main".into(),
            index,
        }
    }

    #[test]
    fn destination_map_inverts_the_source_map() {
        let mut outputs = NodeOutputs::new();
        outputs.insert("main".into(), vec![Some(vec![connection("B", 0)])]);
        let mut source: Connections = OrderedMap::new();
        source.insert("A".into(), outputs);

        let destination = map_connections_by_destination(&source);
        let b = destination.get("B").expect("B is a destination");
        let main = b.get("main").expect("main slot");
        assert_eq!(main.len(), 1);
        assert_eq!(
            main[0].as_ref().unwrap()[0],
            Connection {
                node: "A".into(),
                connection_type: "main".into(),
                index: 0
            }
        );
    }

    #[test]
    fn destination_slots_are_padded_to_the_source_output_index() {
        let mut outputs = NodeOutputs::new();
        outputs.insert(
            "main".into(),
            vec![None, Some(vec![connection("B", 1)]), None, None],
        );
        let mut source: Connections = OrderedMap::new();
        source.insert("A".into(), outputs);

        let destination = map_connections_by_destination(&source);
        let b = destination.get("B").unwrap();
        let main = b.get("main").unwrap();
        // slot 1 is where the source output index lands; earlier slots are padded
        assert_eq!(main.len(), 2);
        assert_eq!(main[0], None);
        assert_eq!(main[1].as_ref().unwrap()[0].index, 1);
    }
}
