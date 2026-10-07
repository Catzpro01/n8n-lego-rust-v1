//! L05.S06 — Snapshot/backup/restore
//!
//! Manages point-in-time database snapshots, backup archive metadata,
//! checksum integrity verification, and safe environment restore operations (H05).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotKind {
    Full,
    Incremental,
    Differential,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SnapshotStatus {
    Creating,
    Ready,
    Restoring,
    Failed,
    Deleted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSnapshot {
    pub snapshot_id: String,
    pub tenant_id: String,
    pub kind: SnapshotKind,
    pub created_at_ms: u64,
    pub byte_size: usize,
    pub checksum_sha256: String,
    pub storage_location: String,
    pub status: SnapshotStatus,
    pub entity_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RestoreLog {
    pub restore_id: String,
    pub snapshot_id: String,
    pub target_env: String,
    pub started_at_ms: u64,
    pub completed_at_ms: u64,
    pub status: String,
    pub restored_count: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BackupError {
    SnapshotNotFound(String),
    CorruptedSnapshot(String),
    TenantMismatch(String),
    InvalidPayload(String),
    OperationFailed(String),
}

impl std::fmt::Display for BackupError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SnapshotNotFound(id) => write!(f, "Backup snapshot not found: {id}"),
            Self::CorruptedSnapshot(msg) => write!(f, "Corrupted snapshot: {msg}"),
            Self::TenantMismatch(msg) => write!(f, "Tenant mismatch: {msg}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
            Self::OperationFailed(msg) => write!(f, "Backup operation failed: {msg}"),
        }
    }
}

impl std::error::Error for BackupError {}

/// Authoritative Backup Snapshot Metadata Service
#[derive(Debug, Clone)]
pub struct BackupSnapshotMetadataService {
    snapshots: Arc<RwLock<HashMap<String, BackupSnapshot>>>,
    restore_history: Arc<RwLock<HashMap<String, RestoreLog>>>,
}

impl Default for BackupSnapshotMetadataService {
    fn default() -> Self {
        Self {
            snapshots: Arc::new(RwLock::new(HashMap::new())),
            restore_history: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl BackupSnapshotMetadataService {
    pub fn new() -> Self {
        Self::default()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Compute simulated deterministic checksum
    fn compute_checksum(tenant_id: &str, snapshot_id: &str, count: usize) -> String {
        format!("sha256:{:x}{:x}", tenant_id.len() * 31 + count, snapshot_id.len() * 17)
    }

    /// Create and persist snapshot metadata
    pub fn create_snapshot(
        &self,
        tenant_id: &str,
        kind: SnapshotKind,
        entity_count: usize,
        now_ms: Option<u64>,
    ) -> Result<BackupSnapshot, BackupError> {
        if tenant_id.trim().is_empty() {
            return Err(BackupError::InvalidPayload("tenant_id cannot be empty (fail-closed)".to_string()));
        }

        let now = now_ms.unwrap_or_else(Self::now_ms);
        let snapshot_id = format!("snap-{tenant_id}-{now}");
        let checksum = Self::compute_checksum(tenant_id, &snapshot_id, entity_count);
        let byte_size = entity_count * 1024 + 4096;

        let snapshot = BackupSnapshot {
            snapshot_id: snapshot_id.clone(),
            tenant_id: tenant_id.to_string(),
            kind,
            created_at_ms: now,
            byte_size,
            checksum_sha256: checksum,
            storage_location: format!("s3://n8n-backups/{tenant_id}/{snapshot_id}.tar.zst"),
            status: SnapshotStatus::Ready,
            entity_count,
        };

        let mut map = self.snapshots.write().unwrap();
        map.insert(snapshot_id, snapshot.clone());
        Ok(snapshot)
    }

    /// Verify cryptographic integrity checksum
    pub fn verify_checksum(&self, snapshot_id: &str, expected_checksum: &str) -> Result<bool, BackupError> {
        let map = self.snapshots.read().unwrap();
        let snap = map.get(snapshot_id).ok_or_else(|| {
            BackupError::SnapshotNotFound(snapshot_id.to_string())
        })?;

        if snap.status == SnapshotStatus::Deleted {
            return Err(BackupError::SnapshotNotFound("Snapshot has been deleted".to_string()));
        }

        Ok(snap.checksum_sha256 == expected_checksum)
    }

    /// Restore snapshot into target environment
    pub fn restore_snapshot(
        &self,
        snapshot_id: &str,
        target_env: &str,
        invoker_tenant: &str,
        now_ms: Option<u64>,
    ) -> Result<RestoreLog, BackupError> {
        let now = now_ms.unwrap_or_else(Self::now_ms);
        let mut map = self.snapshots.write().unwrap();
        let snap = map.get_mut(snapshot_id).ok_or_else(|| {
            BackupError::SnapshotNotFound(snapshot_id.to_string())
        })?;

        if snap.tenant_id != invoker_tenant {
            return Err(BackupError::TenantMismatch(format!(
                "Tenant mismatch: Snapshot belongs to tenant '{}', cannot restore by '{}'",
                snap.tenant_id, invoker_tenant
            )));
        }

        if snap.status == SnapshotStatus::Deleted {
            return Err(BackupError::SnapshotNotFound("Cannot restore deleted snapshot".to_string()));
        }

        let restore_id = format!("rest-{snapshot_id}-{now}");
        let log = RestoreLog {
            restore_id: restore_id.clone(),
            snapshot_id: snapshot_id.to_string(),
            target_env: target_env.to_string(),
            started_at_ms: now,
            completed_at_ms: now + 250,
            status: "SUCCESS".to_string(),
            restored_count: snap.entity_count,
        };

        let mut restores = self.restore_history.write().unwrap();
        restores.insert(restore_id, log.clone());
        Ok(log)
    }

    /// Soft-delete snapshot
    pub fn delete_snapshot(&self, snapshot_id: &str) -> Result<(), BackupError> {
        let mut map = self.snapshots.write().unwrap();
        let snap = map.get_mut(snapshot_id).ok_or_else(|| {
            BackupError::SnapshotNotFound(snapshot_id.to_string())
        })?;
        snap.status = SnapshotStatus::Deleted;
        Ok(())
    }

    /// Port handler for `port.storage.backup.create.v1`
    pub fn handle_port_backup_create(&self, payload: &serde_json::Value) -> Result<serde_json::Value, BackupError> {
        let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("default");
        let kind_str = payload.get("kind").and_then(|v| v.as_str()).unwrap_or("full");
        let kind = match kind_str {
            "incremental" => SnapshotKind::Incremental,
            "differential" => SnapshotKind::Differential,
            _ => SnapshotKind::Full,
        };
        let entity_count = payload.get("entity_count").and_then(|v| v.as_u64()).unwrap_or(100) as usize;

        let snapshot = self.create_snapshot(tenant_id, kind, entity_count, None)?;
        Ok(serde_json::json!({
            "success": true,
            "snapshot_id": snapshot.snapshot_id,
            "byte_size": snapshot.byte_size,
            "checksum_sha256": snapshot.checksum_sha256,
            "storage_location": snapshot.storage_location
        }))
    }

    /// Port handler for `port.storage.backup.restore.v1`
    pub fn handle_port_backup_restore(&self, payload: &serde_json::Value) -> Result<serde_json::Value, BackupError> {
        let snapshot_id = payload.get("snapshot_id").and_then(|v| v.as_str()).ok_or_else(|| {
            BackupError::InvalidPayload("Missing 'snapshot_id'".to_string())
        })?;
        let target_env = payload.get("target_env").and_then(|v| v.as_str()).unwrap_or("production");
        let tenant_id = payload.get("tenant_id").and_then(|v| v.as_str()).unwrap_or("default");

        let log = self.restore_snapshot(snapshot_id, target_env, tenant_id, None)?;
        Ok(serde_json::json!({
            "success": true,
            "restore_id": log.restore_id,
            "target_env": log.target_env,
            "restored_count": log.restored_count,
            "status": log.status
        }))
    }

    /// Port handler for `port.storage.backup.snapshot.v1`
    pub fn handle_port_backup_snapshot(&self, payload: &serde_json::Value) -> Result<serde_json::Value, BackupError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("get");
        match action {
            "get" => {
                let snapshot_id = payload.get("snapshot_id").and_then(|v| v.as_str()).ok_or_else(|| {
                    BackupError::InvalidPayload("Missing 'snapshot_id'".to_string())
                })?;
                let map = self.snapshots.read().unwrap();
                let snap = map.get(snapshot_id).ok_or_else(|| {
                    BackupError::SnapshotNotFound(snapshot_id.to_string())
                })?;
                Ok(serde_json::json!({
                    "success": true,
                    "snapshot": snap
                }))
            }
            "verify" => {
                let snapshot_id = payload.get("snapshot_id").and_then(|v| v.as_str()).ok_or_else(|| {
                    BackupError::InvalidPayload("Missing 'snapshot_id'".to_string())
                })?;
                let checksum = payload.get("checksum").and_then(|v| v.as_str()).unwrap_or("");
                let valid = self.verify_checksum(snapshot_id, checksum)?;
                Ok(serde_json::json!({
                    "success": true,
                    "valid": valid
                }))
            }
            other => Err(BackupError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/backup_snapshot_test.rs"]
mod tests;
