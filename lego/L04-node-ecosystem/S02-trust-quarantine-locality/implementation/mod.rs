//! L04.S02 — Trust/quarantine/runtime locality
//!
//! Evaluates node trust tiers (CoreVerified, VerifiedCommunity, UnverifiedCommunity, Quarantined),
//! determines execution locality policies, and enforces quarantine restrictions.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TrustTier {
    CoreVerified,
    VerifiedCommunity,
    UnverifiedCommunity,
    Quarantined,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum RuntimeLocality {
    InProcess,
    WorkerPool,
    SandboxedWorker,
    Blocked,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeTrustRecord {
    pub node_type: String,
    pub tier: TrustTier,
    pub locality: RuntimeLocality,
    pub sha256_hash: Option<String>,
    pub author: String,
    pub quarantine_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeTrustEvaluation {
    pub node_type: String,
    pub tier: TrustTier,
    pub locality: RuntimeLocality,
    pub is_executable: bool,
    pub quarantine_reason: Option<String>,
}

#[derive(Debug)]
pub enum TrustError {
    InvalidPayload(String),
    NodeNotFound(String),
}

impl std::fmt::Display for TrustError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidPayload(m) => write!(f, "Invalid trust payload: {m}"),
            Self::NodeNotFound(n) => write!(f, "Node trust entry not found: {n}"),
        }
    }
}

impl std::error::Error for TrustError {}

#[derive(Debug, Clone)]
pub struct NodeTrustService {
    records: Arc<RwLock<HashMap<String, NodeTrustRecord>>>,
}

impl Default for NodeTrustService {
    fn default() -> Self {
        let service = Self {
            records: Arc::new(RwLock::new(HashMap::new())),
        };

        // Seed foundational core verified nodes
        service.register_node(
            "n8n-nodes-base.httpRequest",
            TrustTier::CoreVerified,
            RuntimeLocality::InProcess,
            "core-team",
            None,
        );
        service.register_node(
            "n8n-nodes-base.set",
            TrustTier::CoreVerified,
            RuntimeLocality::InProcess,
            "core-team",
            None,
        );
        service.register_node(
            "n8n-nodes-base.if",
            TrustTier::CoreVerified,
            RuntimeLocality::InProcess,
            "core-team",
            None,
        );
        service.register_node(
            "n8n-nodes-base.code",
            TrustTier::CoreVerified,
            RuntimeLocality::SandboxedWorker,
            "core-team",
            None,
        );

        service
    }
}

impl NodeTrustService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register_node(
        &self,
        node_type: &str,
        tier: TrustTier,
        locality: RuntimeLocality,
        author: &str,
        sha256_hash: Option<String>,
    ) {
        let mut recs = self.records.write().unwrap();
        recs.insert(
            node_type.to_string(),
            NodeTrustRecord {
                node_type: node_type.to_string(),
                tier,
                locality,
                sha256_hash,
                author: author.to_string(),
                quarantine_reason: None,
            },
        );
    }

    pub fn quarantine_node(&self, node_type: &str, reason: &str) -> Result<(), TrustError> {
        let mut recs = self.records.write().unwrap();
        if let Some(entry) = recs.get_mut(node_type) {
            entry.tier = TrustTier::Quarantined;
            entry.locality = RuntimeLocality::Blocked;
            entry.quarantine_reason = Some(reason.to_string());
            Ok(())
        } else {
            recs.insert(
                node_type.to_string(),
                NodeTrustRecord {
                    node_type: node_type.to_string(),
                    tier: TrustTier::Quarantined,
                    locality: RuntimeLocality::Blocked,
                    sha256_hash: None,
                    author: "unknown".to_string(),
                    quarantine_reason: Some(reason.to_string()),
                },
            );
            Ok(())
        }
    }

    pub fn evaluate(&self, node_type: &str) -> NodeTrustEvaluation {
        let recs = self.records.read().unwrap();
        if let Some(rec) = recs.get(node_type) {
            NodeTrustEvaluation {
                node_type: rec.node_type.clone(),
                tier: rec.tier,
                locality: rec.locality,
                is_executable: rec.tier != TrustTier::Quarantined && rec.locality != RuntimeLocality::Blocked,
                quarantine_reason: rec.quarantine_reason.clone(),
            }
        } else {
            // Unregistered node defaults to UnverifiedCommunity in SandboxedWorker
            NodeTrustEvaluation {
                node_type: node_type.to_string(),
                tier: TrustTier::UnverifiedCommunity,
                locality: RuntimeLocality::SandboxedWorker,
                is_executable: true,
                quarantine_reason: None,
            }
        }
    }

    pub fn handle_port_trust_evaluate(&self, payload: &serde_json::Value) -> Result<serde_json::Value, TrustError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("evaluate");
        match action {
            "evaluate" => {
                let node_type = payload.get("node_type").and_then(|v| v.as_str()).unwrap_or("");
                let eval = self.evaluate(node_type);
                Ok(serde_json::json!({
                    "success": true,
                    "node_type": eval.node_type,
                    "tier": format!("{:?}", eval.tier),
                    "locality": format!("{:?}", eval.locality),
                    "is_executable": eval.is_executable,
                    "quarantine_reason": eval.quarantine_reason
                }))
            }
            "quarantine" => {
                let node_type = payload.get("node_type").and_then(|v| v.as_str()).unwrap_or("");
                let reason = payload.get("reason").and_then(|v| v.as_str()).unwrap_or("Unspecified vulnerability");
                self.quarantine_node(node_type, reason)?;
                Ok(serde_json::json!({
                    "success": true,
                    "node_type": node_type,
                    "quarantined": true
                }))
            }
            "register" => {
                let node_type = payload.get("node_type").and_then(|v| v.as_str()).unwrap_or("");
                let author = payload.get("author").and_then(|v| v.as_str()).unwrap_or("community");
                self.register_node(
                    node_type,
                    TrustTier::VerifiedCommunity,
                    RuntimeLocality::WorkerPool,
                    author,
                    None,
                );
                Ok(serde_json::json!({
                    "success": true,
                    "node_type": node_type,
                    "registered": true
                }))
            }
            other => Err(TrustError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/trust_quarantine_locality_test.rs"]
mod tests;
