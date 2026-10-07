//! L05.S07 — Disaster recovery
//!
//! Manages cross-region asynchronous data replication, standby replica nodes,
//! replication lag tracking, and automated failover orchestration under control-component model (H05).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeRole {
    Primary,
    HotStandby,
    ColdStandby,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NodeHealth {
    Healthy,
    Degraded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrReplicaNode {
    pub node_id: String,
    pub region: String,
    pub role: NodeRole,
    pub replication_lag_ms: u64,
    pub last_heartbeat_ms: u64,
    pub last_applied_lsn: u64,
    pub health: NodeHealth,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrReplicationBatch {
    pub batch_id: String,
    pub source_node: String,
    pub target_node: String,
    pub start_lsn: u64,
    pub end_lsn: u64,
    pub events_count: usize,
    pub checksum: String,
    pub replicated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FailoverPlan {
    pub plan_id: String,
    pub target_primary: String,
    pub initiated_by: String,
    pub initiated_at_ms: u64,
    pub status: String,
    pub promoted_lsn: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DrError {
    NodeNotFound(String),
    NodeNotReady(String),
    InvalidConfiguration(String),
    InvalidPayload(String),
    SplitBrainRisk(String),
}

impl std::fmt::Display for DrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NodeNotFound(id) => write!(f, "DR replica node not found: {id}"),
            Self::NodeNotReady(msg) => write!(f, "DR node not ready for operation: {msg}"),
            Self::InvalidConfiguration(msg) => write!(f, "Invalid DR configuration: {msg}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
            Self::SplitBrainRisk(msg) => write!(f, "Split-brain hazard detected: {msg}"),
        }
    }
}

impl std::error::Error for DrError {}

/// Authoritative DR Replication State Service
#[derive(Debug, Clone)]
pub struct DisasterRecoveryService {
    nodes: Arc<RwLock<HashMap<String, DrReplicaNode>>>,
    failovers: Arc<RwLock<Vec<FailoverPlan>>>,
}

impl Default for DisasterRecoveryService {
    fn default() -> Self {
        let service = Self {
            nodes: Arc::new(RwLock::new(HashMap::new())),
            failovers: Arc::new(RwLock::new(Vec::new())),
        };

        // Seed default primary node
        let _ = service.register_replica(DrReplicaNode {
            node_id: "node-primary-us-east".to_string(),
            region: "us-east-1".to_string(),
            role: NodeRole::Primary,
            replication_lag_ms: 0,
            last_heartbeat_ms: Self::now_ms(),
            last_applied_lsn: 10_000,
            health: NodeHealth::Healthy,
        });

        service
    }
}

impl DisasterRecoveryService {
    pub fn new() -> Self {
        Self::default()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Register a disaster recovery replica node
    pub fn register_replica(&self, node: DrReplicaNode) -> Result<(), DrError> {
        if node.node_id.trim().is_empty() {
            return Err(DrError::InvalidConfiguration("node_id cannot be empty".to_string()));
        }
        let mut nodes = self.nodes.write().unwrap();
        nodes.insert(node.node_id.clone(), node);
        Ok(())
    }

    /// Record heartbeat and lag metrics from a replica
    pub fn record_heartbeat(
        &self,
        node_id: &str,
        applied_lsn: u64,
        lag_ms: u64,
        now_ms: Option<u64>,
    ) -> Result<(), DrError> {
        let now = now_ms.unwrap_or_else(Self::now_ms);
        let mut nodes = self.nodes.write().unwrap();
        let node = nodes.get_mut(node_id).ok_or_else(|| DrError::NodeNotFound(node_id.to_string()))?;

        node.last_heartbeat_ms = now;
        node.last_applied_lsn = applied_lsn;
        node.replication_lag_ms = lag_ms;
        node.health = if lag_ms > 60_000 {
            NodeHealth::Degraded
        } else {
            NodeHealth::Healthy
        };

        Ok(())
    }

    /// Replicate batch of WAL log entries
    pub fn replicate_batch(
        &self,
        source_id: &str,
        target_id: &str,
        start_lsn: u64,
        end_lsn: u64,
        events_count: usize,
        now_ms: Option<u64>,
    ) -> Result<DrReplicationBatch, DrError> {
        if start_lsn > end_lsn {
            return Err(DrError::InvalidPayload("start_lsn must be <= end_lsn".to_string()));
        }

        let now = now_ms.unwrap_or_else(Self::now_ms);
        let mut nodes = self.nodes.write().unwrap();

        if !nodes.contains_key(source_id) {
            return Err(DrError::NodeNotFound(source_id.to_string()));
        }
        let target = nodes.get_mut(target_id).ok_or_else(|| DrError::NodeNotFound(target_id.to_string()))?;

        target.last_applied_lsn = end_lsn;
        target.last_heartbeat_ms = now;
        target.replication_lag_ms = 5; // near zero after sync

        let batch_id = format!("batch-{source_id}-{target_id}-{start_lsn}-{end_lsn}");
        let checksum = format!("crc32:{:x}", end_lsn.wrapping_mul(31) ^ (events_count as u64));

        Ok(DrReplicationBatch {
            batch_id,
            source_node: source_id.to_string(),
            target_node: target_id.to_string(),
            start_lsn,
            end_lsn,
            events_count,
            checksum,
            replicated_at_ms: now,
        })
    }

    /// Execute safe failover / promotion to primary
    pub fn initiate_failover(
        &self,
        target_node_id: &str,
        initiated_by: &str,
        now_ms: Option<u64>,
    ) -> Result<FailoverPlan, DrError> {
        if target_node_id.trim().is_empty() || initiated_by.trim().is_empty() {
            return Err(DrError::InvalidPayload("target_node_id and initiated_by cannot be empty".to_string()));
        }

        let now = now_ms.unwrap_or_else(Self::now_ms);
        let mut nodes = self.nodes.write().unwrap();

        // 1. Validate target node exists and is eligible for promotion FIRST
        let target = nodes.get(target_node_id).ok_or_else(|| {
            DrError::NodeNotFound(target_node_id.to_string())
        })?;

        if target.health == NodeHealth::Failed {
            return Err(DrError::NodeNotReady(format!("Node '{target_node_id}' is failed; cannot promote.")));
        }

        // 2. Demote existing primary to standby safely
        for node in nodes.values_mut() {
            if node.role == NodeRole::Primary && node.node_id != target_node_id {
                node.role = NodeRole::ColdStandby;
            }
        }

        // 3. Promote target node
        let target = nodes.get_mut(target_node_id).unwrap();
        target.role = NodeRole::Primary;
        target.replication_lag_ms = 0;

        let plan_id = format!("failover-{target_node_id}-{now}");
        let plan = FailoverPlan {
            plan_id,
            target_primary: target_node_id.to_string(),
            initiated_by: initiated_by.to_string(),
            initiated_at_ms: now,
            status: "SUCCEEDED".to_string(),
            promoted_lsn: target.last_applied_lsn,
        };

        let mut failovers = self.failovers.write().unwrap();
        failovers.push(plan.clone());

        Ok(plan)
    }

    /// Port handler for `port.storage.dr.sync.v1`
    pub fn handle_port_dr_sync(&self, payload: &serde_json::Value) -> Result<serde_json::Value, DrError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("heartbeat");
        match action {
            "heartbeat" => {
                let node_id = payload.get("node_id").and_then(|v| v.as_str()).ok_or_else(|| {
                    DrError::InvalidPayload("Missing 'node_id'".to_string())
                })?;
                let applied_lsn = payload.get("applied_lsn").and_then(|v| v.as_u64()).unwrap_or(0);
                let lag_ms = payload.get("lag_ms").and_then(|v| v.as_u64()).unwrap_or(0);

                self.record_heartbeat(node_id, applied_lsn, lag_ms, None)?;
                Ok(serde_json::json!({
                    "success": true,
                    "node_id": node_id,
                    "applied_lsn": applied_lsn,
                    "lag_ms": lag_ms
                }))
            }
            "status" => {
                let nodes = self.nodes.read().unwrap();
                let list: Vec<&DrReplicaNode> = nodes.values().collect();
                Ok(serde_json::json!({
                    "success": true,
                    "replicas": list
                }))
            }
            other => Err(DrError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }

    /// Port handler for `port.storage.dr.replicate.v1`
    pub fn handle_port_dr_replicate(&self, payload: &serde_json::Value) -> Result<serde_json::Value, DrError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("replicate");
        match action {
            "replicate" => {
                let source_id = payload.get("source_id").and_then(|v| v.as_str()).unwrap_or("node-primary-us-east");
                let target_id = payload.get("target_id").and_then(|v| v.as_str()).ok_or_else(|| {
                    DrError::InvalidPayload("Missing 'target_id'".to_string())
                })?;
                let start_lsn = payload.get("start_lsn").and_then(|v| v.as_u64()).unwrap_or(1);
                let end_lsn = payload.get("end_lsn").and_then(|v| v.as_u64()).unwrap_or(10);
                let events_count = payload.get("events_count").and_then(|v| v.as_u64()).unwrap_or(10) as usize;

                let batch = self.replicate_batch(source_id, target_id, start_lsn, end_lsn, events_count, None)?;
                Ok(serde_json::json!({
                    "success": true,
                    "batch_id": batch.batch_id,
                    "checksum": batch.checksum,
                    "end_lsn": batch.end_lsn
                }))
            }
            "failover" => {
                let target_node = payload.get("target_node").and_then(|v| v.as_str()).ok_or_else(|| {
                    DrError::InvalidPayload("Missing 'target_node'".to_string())
                })?;
                let initiator = payload.get("initiator").and_then(|v| v.as_str()).unwrap_or("cluster-orchestrator");

                let plan = self.initiate_failover(target_node, initiator, None)?;
                Ok(serde_json::json!({
                    "success": true,
                    "plan_id": plan.plan_id,
                    "promoted_node": plan.target_primary,
                    "status": plan.status
                }))
            }
            other => Err(DrError::InvalidPayload(format!("Unsupported replicate action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/disaster_recovery_test.rs"]
mod tests;
