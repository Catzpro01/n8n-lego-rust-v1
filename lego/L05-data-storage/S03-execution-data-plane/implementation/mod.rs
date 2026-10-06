//! Implementation of L05.S03 Execution data plane
//!
//! Sub-LEGO Identity: L05.S03
//! Authoritative State Domain: `execution-item-blobs`
//! Runtime Host: H05 (Data Host)
//! Execution Model: stateful-component
//! Invariants:
//! - Multi-tenant isolation: execution item blobs strictly segregated per tenant.
//! - Content integrity: stores items with byte length and hash checksum for tamper detection.
//! - Compact data handle: returns canonical handle references (`edp:<tenant>:<exec_id>:<blob_id>`) to prevent memory ballooning.
//! - State boundary: manages state strictly within `execution-item-blobs`.
//! - Typed port contract: provides `port.storage.dataplane.store_handle.v1` and `port.storage.dataplane.read_handle.v1`.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

/// Execution data plane blob descriptor stored in `execution-item-blobs`
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionItemBlob {
    pub handle_id: String,
    pub tenant_id: String,
    pub execution_id: String,
    pub node_name: String,
    pub item_count: usize,
    pub byte_size: usize,
    pub checksum: String,
    pub items: serde_json::Value,
    pub stored_at_ms: u64,
}

/// Errors occurring in execution data plane operations
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataPlaneError {
    BlobNotFound(String),
    TenantMismatch { expected: String, actual: String },
    IntegrityCheckFailed { expected: String, actual: String },
    InvalidRequest(String),
    LockPoisoned,
}

impl std::fmt::Display for DataPlaneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BlobNotFound(h) => write!(f, "Execution data plane handle not found: {h}"),
            Self::TenantMismatch { expected, actual } => {
                write!(f, "Tenant mismatch: expected {expected}, actual {actual}")
            }
            Self::IntegrityCheckFailed { expected, actual } => {
                write!(f, "Integrity check failed: expected checksum {expected}, got {actual}")
            }
            Self::InvalidRequest(msg) => write!(f, "Invalid request: {msg}"),
            Self::LockPoisoned => write!(f, "Data plane storage lock poisoned"),
        }
    }
}

/// Result returned from storing items in the data plane
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoreHandleResult {
    pub success: bool,
    pub handle_id: String,
    pub tenant_id: String,
    pub execution_id: String,
    pub item_count: usize,
    pub byte_size: usize,
    pub checksum: String,
    pub stored_at_ms: u64,
}

/// Result returned from reading items by handle
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadHandleResult {
    pub success: bool,
    pub handle_id: String,
    pub tenant_id: String,
    pub execution_id: String,
    pub node_name: String,
    pub item_count: usize,
    pub byte_size: usize,
    pub checksum: String,
    pub items: serde_json::Value,
}

/// Service managing authoritative state domain `execution-item-blobs`
pub struct ExecutionDataPlaneService {
    blobs: RwLock<HashMap<String, ExecutionItemBlob>>,
}

impl Default for ExecutionDataPlaneService {
    fn default() -> Self {
        Self::new()
    }
}

impl ExecutionDataPlaneService {
    pub fn new() -> Self {
        Self {
            blobs: RwLock::new(HashMap::new()),
        }
    }

    /// Computes a lightweight deterministic checksum for items
    fn compute_checksum(data_str: &str) -> String {
        let mut hash: u64 = 0xcbf29ce484222325; // FNV-1a 64-bit offset basis
        for b in data_str.as_bytes() {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3); // FNV prime
        }
        format!("fnv1a:{:016x}", hash)
    }

    /// Stores items into `execution-item-blobs` and returns an immutable handle
    pub fn store_handle(
        &self,
        tenant_id: &str,
        execution_id: &str,
        node_name: &str,
        items: serde_json::Value,
    ) -> Result<StoreHandleResult, DataPlaneError> {
        if tenant_id.trim().is_empty() {
            return Err(DataPlaneError::InvalidRequest("tenant_id cannot be empty".to_string()));
        }
        if execution_id.trim().is_empty() {
            return Err(DataPlaneError::InvalidRequest("execution_id cannot be empty".to_string()));
        }

        let item_count = items.as_array().map(|a| a.len()).unwrap_or(1);
        let serialized = serde_json::to_string(&items)
            .map_err(|e| DataPlaneError::InvalidRequest(format!("Serialization error: {e}")))?;
        let byte_size = serialized.len();
        let checksum = Self::compute_checksum(&serialized);

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let handle_id = format!("edp:{tenant_id}:{execution_id}:blob-{}", &checksum[6..14]);

        let blob = ExecutionItemBlob {
            handle_id: handle_id.clone(),
            tenant_id: tenant_id.to_string(),
            execution_id: execution_id.to_string(),
            node_name: node_name.to_string(),
            item_count,
            byte_size,
            checksum: checksum.clone(),
            items,
            stored_at_ms: now_ms,
        };

        let mut blobs = self.blobs.write().map_err(|_| DataPlaneError::LockPoisoned)?;
        blobs.insert(handle_id.clone(), blob);

        Ok(StoreHandleResult {
            success: true,
            handle_id,
            tenant_id: tenant_id.to_string(),
            execution_id: execution_id.to_string(),
            item_count,
            byte_size,
            checksum,
            stored_at_ms: now_ms,
        })
    }

    /// Reads execution items from `execution-item-blobs` by handle with tenant check
    pub fn read_handle(
        &self,
        tenant_id: &str,
        handle_id: &str,
    ) -> Result<ReadHandleResult, DataPlaneError> {
        let blobs = self.blobs.read().map_err(|_| DataPlaneError::LockPoisoned)?;
        let blob = blobs
            .get(handle_id)
            .ok_or_else(|| DataPlaneError::BlobNotFound(handle_id.to_string()))?;

        if blob.tenant_id != tenant_id {
            return Err(DataPlaneError::TenantMismatch {
                expected: blob.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        // Verify checksum integrity
        let serialized = serde_json::to_string(&blob.items)
            .map_err(|e| DataPlaneError::InvalidRequest(format!("Serialization error: {e}")))?;
        let current_checksum = Self::compute_checksum(&serialized);
        if current_checksum != blob.checksum {
            return Err(DataPlaneError::IntegrityCheckFailed {
                expected: blob.checksum.clone(),
                actual: current_checksum,
            });
        }

        Ok(ReadHandleResult {
            success: true,
            handle_id: blob.handle_id.clone(),
            tenant_id: blob.tenant_id.clone(),
            execution_id: blob.execution_id.clone(),
            node_name: blob.node_name.clone(),
            item_count: blob.item_count,
            byte_size: blob.byte_size,
            checksum: blob.checksum.clone(),
            items: blob.items.clone(),
        })
    }

    /// Dispatcher for port `port.storage.dataplane.store_handle.v1`
    pub fn handle_port_store_handle(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant_id'".to_string())?;

        let execution_id = payload
            .get("execution_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'execution_id'".to_string())?;

        let node_name = payload
            .get("node_name")
            .and_then(|v| v.as_str())
            .unwrap_or("unnamed_node");

        let items = payload
            .get("items")
            .cloned()
            .ok_or_else(|| "Missing required 'items'".to_string())?;

        let res = self
            .store_handle(tenant_id, execution_id, node_name, items)
            .map_err(|e| e.to_string())?;

        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }

    /// Dispatcher for port `port.storage.dataplane.read_handle.v1`
    pub fn handle_port_read_handle(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant_id'".to_string())?;

        let handle_id = payload
            .get("handle_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'handle_id'".to_string())?;

        let res = self
            .read_handle(tenant_id, handle_id)
            .map_err(|e| e.to_string())?;

        serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
    }
}

#[cfg(test)]
#[path = "../tests/execution_data_plane_test.rs"]
mod tests;
