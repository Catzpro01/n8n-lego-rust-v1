use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use serde_json::Value;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub node: String,
    #[serde(rename = "type")]
    pub connection_type: String,
    pub index: usize,
}

// In n8n, connections are formatted like:
// "SourceNodeName": {
//    "main": [
//        [ { "node": "TargetNode", "type": "main", "index": 0 } ]
//    ]
// }
pub type NodeOutputConnections = HashMap<String, Vec<Vec<Connection>>>;
pub type Connections = HashMap<String, NodeOutputConnections>;

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Node {
    pub id: String,
    pub name: String,
    pub type_version: f64, // Sometimes float in n8n
    #[serde(rename = "type")]
    pub node_type: String,
    pub position: (f64, f64),
    pub disabled: Option<bool>,
    pub parameters: Value,
    pub credentials: Option<Value>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Workflow {
    pub id: Option<String>,
    pub name: String,
    pub active: bool,
    pub nodes: Vec<Node>,
    pub connections: Connections,
    #[serde(rename = "createdAt", skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    #[serde(rename = "updatedAt", skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}
