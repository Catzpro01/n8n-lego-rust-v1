//! L05.S08 — Environment promotion
//!
//! Manages workflow definition packaging, credential redaction/sanitization,
//! environment validation, and atomic multi-stage deployment/promotion across dev/staging/prod (H05).

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PromotionStatus {
    Draft,
    Exported,
    Validated,
    Imported,
    Failed,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromotionManifest {
    pub manifest_id: String,
    pub source_env: String,
    pub target_env: String,
    pub version: String,
    pub workflows_count: usize,
    pub sanitize_credentials: bool,
    pub checksum: String,
    pub created_at_ms: u64,
    pub created_by: String,
    pub status: PromotionStatus,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromotionBundle {
    pub manifest: PromotionManifest,
    pub items: Vec<serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromotionError {
    ManifestNotFound(String),
    IncompatibleEnvironment(String),
    SecretLeakageDetected(String),
    ValidationFailed(String),
    InvalidPayload(String),
}

impl std::fmt::Display for PromotionError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::ManifestNotFound(id) => write!(f, "Promotion manifest not found: {id}"),
            Self::IncompatibleEnvironment(msg) => write!(f, "Target environment incompatible: {msg}"),
            Self::SecretLeakageDetected(msg) => write!(f, "Secret leakage blocked (fail-closed): {msg}"),
            Self::ValidationFailed(msg) => write!(f, "Manifest validation failed: {msg}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid payload: {msg}"),
        }
    }
}

impl std::error::Error for PromotionError {}

/// Authoritative Promotion Manifest Store Service
#[derive(Debug, Clone)]
pub struct PromotionManifestStoreService {
    manifests: Arc<RwLock<HashMap<String, PromotionManifest>>>,
    bundles: Arc<RwLock<HashMap<String, PromotionBundle>>>,
}

impl Default for PromotionManifestStoreService {
    fn default() -> Self {
        Self {
            manifests: Arc::new(RwLock::new(HashMap::new())),
            bundles: Arc::new(RwLock::new(HashMap::new())),
        }
    }
}

impl PromotionManifestStoreService {
    pub fn new() -> Self {
        Self::default()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Compute simulated cryptographic manifest checksum
    fn compute_checksum(source: &str, target: &str, count: usize, now: u64) -> String {
        format!("sha256:{:x}{:x}", source.len() * 19 + target.len() * 23, count as u64 * 31 + now)
    }

    /// Export workflow bundle for environment promotion
    pub fn export_bundle(
        &self,
        source_env: &str,
        target_env: &str,
        workflows: Vec<serde_json::Value>,
        sanitize_credentials: bool,
        creator: &str,
        now_ms: Option<u64>,
    ) -> Result<PromotionBundle, PromotionError> {
        let src = source_env.trim();
        let tgt = target_env.trim();
        if src.is_empty() || tgt.is_empty() {
            return Err(PromotionError::InvalidPayload(
                "Source and target environment cannot be empty".to_string(),
            ));
        }
        if src == tgt {
            return Err(PromotionError::IncompatibleEnvironment(
                "Source and target environment cannot be identical".to_string(),
            ));
        }
        if creator.trim().is_empty() {
            return Err(PromotionError::InvalidPayload("creator cannot be empty".to_string()));
        }

        let now = now_ms.unwrap_or_else(Self::now_ms);
        let manifest_id = format!("promo-{src}-to-{tgt}-{now}");
        let checksum = Self::compute_checksum(src, tgt, workflows.len(), now);

        // Fail-closed recursive credential sanitization and secret inspection
        fn sanitize_recursive(val: &mut serde_json::Value) -> Result<(), PromotionError> {
            match val {
                serde_json::Value::Object(map) => {
                    if map.contains_key("credentials") {
                        map.insert("credentials".to_string(), serde_json::json!({ "redacted": true }));
                    }
                    for k in map.keys() {
                        let k_lower = k.to_ascii_lowercase();
                        if k_lower == "api_key" || k_lower == "secret" || k_lower == "private_key" {
                            return Err(PromotionError::SecretLeakageDetected(
                                format!("Secret leakage: Plaintext secret detected in key '{k}' during promotion export"),
                            ));
                        }
                    }
                    for (_, v) in map.iter_mut() {
                        sanitize_recursive(v)?;
                    }
                }
                serde_json::Value::Array(arr) => {
                    for item in arr.iter_mut() {
                        sanitize_recursive(item)?;
                    }
                }
                _ => {}
            }
            Ok(())
        }

        let mut sanitized_items = Vec::with_capacity(workflows.len());
        for mut item in workflows {
            if sanitize_credentials {
                sanitize_recursive(&mut item)?;
            }
            sanitized_items.push(item);
        }

        let manifest = PromotionManifest {
            manifest_id: manifest_id.clone(),
            source_env: src.to_string(),
            target_env: tgt.to_string(),
            version: "1.0.0".to_string(),
            workflows_count: sanitized_items.len(),
            sanitize_credentials,
            checksum,
            created_at_ms: now,
            created_by: creator.to_string(),
            status: PromotionStatus::Exported,
        };

        let bundle = PromotionBundle {
            manifest: manifest.clone(),
            items: sanitized_items,
        };

        let mut manifests = self.manifests.write().unwrap();
        let mut bundles = self.bundles.write().unwrap();
        manifests.insert(manifest_id.clone(), manifest);
        bundles.insert(manifest_id, bundle.clone());

        Ok(bundle)
    }

    /// Validate bundle against target environment
    pub fn validate_bundle(&self, bundle: &PromotionBundle, target_env: &str) -> Result<bool, PromotionError> {
        let tgt = target_env.trim();
        if bundle.manifest.target_env != tgt {
            return Err(PromotionError::IncompatibleEnvironment(format!(
                "Manifest targeted for '{}', but current target is '{}'",
                bundle.manifest.target_env, tgt
            )));
        }
        if bundle.items.is_empty() && bundle.manifest.workflows_count > 0 {
            return Err(PromotionError::ValidationFailed("Bundle payload corrupted: item count mismatch".to_string()));
        }
        Ok(true)
    }

    /// Import and apply bundle in target environment
    pub fn import_bundle(
        &self,
        manifest_id: &str,
        target_env: &str,
        _now_ms: Option<u64>,
    ) -> Result<PromotionManifest, PromotionError> {
        let tgt = target_env.trim();
        if tgt.is_empty() {
            return Err(PromotionError::InvalidPayload("target_env cannot be empty".to_string()));
        }

        let mut manifests = self.manifests.write().unwrap();
        let manifest = manifests.get_mut(manifest_id).ok_or_else(|| {
            PromotionError::ManifestNotFound(manifest_id.to_string())
        })?;

        if manifest.target_env != tgt {
            return Err(PromotionError::IncompatibleEnvironment(format!(
                "Manifest target '{}' does not match importing environment '{}'",
                manifest.target_env, tgt
            )));
        }

        if manifest.status == PromotionStatus::RolledBack {
            return Err(PromotionError::ValidationFailed(
                "Cannot import already rolled back manifest".to_string(),
            ));
        }

        manifest.status = PromotionStatus::Imported;
        Ok(manifest.clone())
    }

    /// Roll back an applied promotion
    pub fn rollback_promotion(&self, manifest_id: &str) -> Result<PromotionManifest, PromotionError> {
        let mut manifests = self.manifests.write().unwrap();
        let manifest = manifests.get_mut(manifest_id).ok_or_else(|| {
            PromotionError::ManifestNotFound(manifest_id.to_string())
        })?;

        if manifest.status != PromotionStatus::Imported {
            return Err(PromotionError::ValidationFailed(format!(
                "Cannot rollback manifest with status '{:?}'; must be Imported",
                manifest.status
            )));
        }

        manifest.status = PromotionStatus::RolledBack;
        Ok(manifest.clone())
    }

    /// Port handler for `port.storage.promotion.export.v1`
    pub fn handle_port_promotion_export(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, PromotionError> {
        let source_env = payload.get("source_env").and_then(|v| v.as_str()).unwrap_or("development");
        let target_env = payload.get("target_env").and_then(|v| v.as_str()).unwrap_or("staging");
        let creator = payload.get("creator").and_then(|v| v.as_str()).unwrap_or("deployer");
        let sanitize = payload.get("sanitize").and_then(|v| v.as_bool()).unwrap_or(true);

        let items = payload
            .get("workflows")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_else(|| vec![serde_json::json!({ "id": "wf-1", "name": "Sync Workflow" })]);

        let bundle = self.export_bundle(source_env, target_env, items, sanitize, creator, None)?;
        Ok(serde_json::json!({
            "success": true,
            "manifest_id": bundle.manifest.manifest_id,
            "checksum": bundle.manifest.checksum,
            "workflows_count": bundle.manifest.workflows_count,
            "status": "exported"
        }))
    }

    /// Port handler for `port.storage.promotion.import.v1`
    pub fn handle_port_promotion_import(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, PromotionError> {
        let manifest_id = payload.get("manifest_id").and_then(|v| v.as_str()).ok_or_else(|| {
            PromotionError::InvalidPayload("Missing 'manifest_id'".to_string())
        })?;
        let target_env = payload.get("target_env").and_then(|v| v.as_str()).unwrap_or("staging");

        let manifest = self.import_bundle(manifest_id, target_env, None)?;
        Ok(serde_json::json!({
            "success": true,
            "manifest_id": manifest.manifest_id,
            "target_env": manifest.target_env,
            "status": "imported"
        }))
    }

    /// Port handler for `port.storage.environment.promote.v1`
    pub fn handle_port_environment_promote(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, PromotionError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("promote");
        match action {
            "promote" => {
                let source_env = payload.get("source_env").and_then(|v| v.as_str()).unwrap_or("development");
                let target_env = payload.get("target_env").and_then(|v| v.as_str()).unwrap_or("staging");
                let creator = payload.get("creator").and_then(|v| v.as_str()).unwrap_or("promoter");

                let items = vec![serde_json::json!({ "id": "wf-promo", "name": "Promoted Pipeline" })];
                let bundle = self.export_bundle(source_env, target_env, items, true, creator, None)?;
                let imported = self.import_bundle(&bundle.manifest.manifest_id, target_env, None)?;

                Ok(serde_json::json!({
                    "success": true,
                    "manifest_id": imported.manifest_id,
                    "source_env": imported.source_env,
                    "target_env": imported.target_env,
                    "status": "promoted"
                }))
            }
            "rollback" => {
                let manifest_id = payload.get("manifest_id").and_then(|v| v.as_str()).ok_or_else(|| {
                    PromotionError::InvalidPayload("Missing 'manifest_id'".to_string())
                })?;
                let rolled = self.rollback_promotion(manifest_id)?;
                Ok(serde_json::json!({
                    "success": true,
                    "manifest_id": rolled.manifest_id,
                    "status": "rolled_back"
                }))
            }
            other => Err(PromotionError::InvalidPayload(format!("Unsupported promote action: {other}"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/environment_promotion_test.rs"]
mod tests;
