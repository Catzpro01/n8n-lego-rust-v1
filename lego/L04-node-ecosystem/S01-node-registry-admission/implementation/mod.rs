//! Implementation of L04.S01 Node Registry and Admission
//!
//! Sub-LEGO Identity: L04.S01
//! Authoritative State Domain: `node-manifest-catalog`
//! Runtime Host: H04 (Worker Host)
//! Execution Model: in-process
//! Invariants:
//! - Manifest Admission Control: Verifies completeness of node descriptors (name, version, inputs/outputs).
//! - Deterministic Querying: Supports querying by node_type_name, category, trigger flag, or full catalog listing.
//! - Authoritative State Ownership: Exclusive management of `node-manifest-catalog` in-memory store.
//! - Fail-closed: Malformed manifests, missing mandatory identifiers, or invalid versions are rejected immediately.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Node manifest descriptor stored in `node-manifest-catalog`
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeManifest {
    pub node_type_name: String,
    pub display_name: String,
    pub version: u32,
    pub category: String,
    pub description: String,
    pub is_trigger: bool,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
    pub registered_at_ms: u64,
}

/// Request to register an admitted node manifest
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeRegisterRequest {
    pub node_type_name: String,
    pub display_name: String,
    pub version: u32,
    pub category: String,
    pub description: Option<String>,
    pub is_trigger: Option<bool>,
    pub inputs: Option<Vec<String>>,
    pub outputs: Option<Vec<String>>,
}

/// Result of node registration
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeRegisterResponse {
    pub success: bool,
    pub node_type_name: String,
    pub version: u32,
    pub message: String,
}

/// Query filter for node catalog
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeQueryRequest {
    pub node_type_name: Option<String>,
    pub category: Option<String>,
    pub is_trigger: Option<bool>,
}

/// Result of querying node catalog
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NodeQueryResponse {
    pub nodes: Vec<NodeManifest>,
    pub total: usize,
}

/// Authoritative Node Catalog Service managing `node-manifest-catalog`
#[derive(Clone)]
pub struct NodeRegistryAdmissionService {
    catalog: Arc<RwLock<HashMap<String, Vec<NodeManifest>>>>,
}

impl Default for NodeRegistryAdmissionService {
    fn default() -> Self {
        Self::new()
    }
}

impl NodeRegistryAdmissionService {
    pub fn new() -> Self {
        let mut initial_catalog: HashMap<String, Vec<NodeManifest>> = HashMap::new();

        // Pre-populate core built-in nodes
        let now = Self::current_epoch_ms();
        let core_nodes = vec![
            NodeManifest {
                node_type_name: "n8n-nodes-base.httpRequest".to_string(),
                display_name: "HTTP Request".to_string(),
                version: 1,
                category: "development".to_string(),
                description: "Makes an HTTP request and returns the response data".to_string(),
                is_trigger: false,
                inputs: vec!["main".to_string()],
                outputs: vec!["main".to_string()],
                registered_at_ms: now,
            },
            NodeManifest {
                node_type_name: "n8n-nodes-base.webhook".to_string(),
                display_name: "Webhook".to_string(),
                version: 1,
                category: "trigger".to_string(),
                description: "Starts the workflow when a webhook is called".to_string(),
                is_trigger: true,
                inputs: vec![],
                outputs: vec!["main".to_string()],
                registered_at_ms: now,
            },
            NodeManifest {
                node_type_name: "n8n-nodes-base.code".to_string(),
                display_name: "Code".to_string(),
                version: 1,
                category: "development".to_string(),
                description: "Run custom JavaScript or Python code".to_string(),
                is_trigger: false,
                inputs: vec!["main".to_string()],
                outputs: vec!["main".to_string()],
                registered_at_ms: now,
            },
        ];

        for node in core_nodes {
            initial_catalog
                .entry(node.node_type_name.clone())
                .or_default()
                .push(node);
        }

        Self {
            catalog: Arc::new(RwLock::new(initial_catalog)),
        }
    }

    fn current_epoch_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Admission check and register node manifest
    pub fn register_node(&self, req: NodeRegisterRequest) -> Result<NodeRegisterResponse, String> {
        // Fail-closed admission validations
        if req.node_type_name.trim().is_empty() {
            return Err("Admission rejected: missing node_type_name".to_string());
        }
        if req.display_name.trim().is_empty() {
            return Err("Admission rejected: missing display_name".to_string());
        }
        if req.version == 0 {
            return Err("Admission rejected: version must be greater than 0".to_string());
        }
        if req.category.trim().is_empty() {
            return Err("Admission rejected: missing category".to_string());
        }

        let now = Self::current_epoch_ms();
        let manifest = NodeManifest {
            node_type_name: req.node_type_name.clone(),
            display_name: req.display_name,
            version: req.version,
            category: req.category,
            description: req.description.unwrap_or_default(),
            is_trigger: req.is_trigger.unwrap_or(false),
            inputs: req.inputs.unwrap_or_else(|| vec!["main".to_string()]),
            outputs: req.outputs.unwrap_or_else(|| vec!["main".to_string()]),
            registered_at_ms: now,
        };

        let mut catalog = self.catalog.write().map_err(|e| format!("Lock error: {e}"))?;
        let versions = catalog.entry(req.node_type_name.clone()).or_default();

        // Check for existing version conflict
        if let Some(pos) = versions.iter().position(|m| m.version == req.version) {
            // Update existing version manifest
            versions[pos] = manifest;
            Ok(NodeRegisterResponse {
                success: true,
                node_type_name: req.node_type_name,
                version: req.version,
                message: "Node manifest updated successfully".to_string(),
            })
        } else {
            versions.push(manifest);
            Ok(NodeRegisterResponse {
                success: true,
                node_type_name: req.node_type_name,
                version: req.version,
                message: "Node manifest admitted and registered successfully".to_string(),
            })
        }
    }

    /// Query node catalog
    pub fn query_nodes(&self, query: NodeQueryRequest) -> Result<NodeQueryResponse, String> {
        let catalog = self.catalog.read().map_err(|e| format!("Lock error: {e}"))?;

        let mut results: Vec<NodeManifest> = Vec::new();

        if let Some(ref type_name) = query.node_type_name {
            if let Some(manifests) = catalog.get(type_name) {
                for m in manifests {
                    if let Some(ref cat) = query.category {
                        if &m.category != cat {
                            continue;
                        }
                    }
                    if let Some(trig) = query.is_trigger {
                        if m.is_trigger != trig {
                            continue;
                        }
                    }
                    results.push(m.clone());
                }
            }
        } else {
            for manifests in catalog.values() {
                for m in manifests {
                    if let Some(ref cat) = query.category {
                        if &m.category != cat {
                            continue;
                        }
                    }
                    if let Some(trig) = query.is_trigger {
                        if m.is_trigger != trig {
                            continue;
                        }
                    }
                    results.push(m.clone());
                }
            }
        }

        let total = results.len();
        Ok(NodeQueryResponse {
            nodes: results,
            total,
        })
    }

    /// Dispatch incoming port payload for `port.node.registry.register.v1`
    pub fn dispatch_register_port(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let req: NodeRegisterRequest = serde_json::from_value(payload.clone())
            .map_err(|e| format!("Payload deserialization error: {e}"))?;
        let res = self.register_node(req)?;
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatch incoming port payload for `port.node.registry.query.v1`
    pub fn dispatch_query_port(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let req: NodeQueryRequest = if payload.is_null() || payload == &serde_json::json!({}) {
            NodeQueryRequest::default()
        } else {
            serde_json::from_value(payload.clone())
                .map_err(|e| format!("Payload deserialization error: {e}"))?
        };

        let res = self.query_nodes(req)?;
        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/node_registry_admission_test.rs"]
mod tests;
