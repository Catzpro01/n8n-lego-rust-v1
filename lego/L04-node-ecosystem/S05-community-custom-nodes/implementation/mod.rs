//! L04.S05 — Community/private/custom node compatibility
//!
//! Manages custom node package tarballs, manifest extraction,
//! checksum verification, package activation, and loader compatibility.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CustomNodePackage {
    pub package_name: String,
    pub version: String,
    pub author: String,
    pub tarball_checksum: String,
    pub manifest_json: String,
    pub installed_at_ms: u64,
    pub is_enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomNodeDescriptor {
    pub package_name: String,
    pub node_name: String,
    pub version: String,
    pub is_executable: bool,
}

#[derive(Debug)]
pub enum CustomNodeError {
    PackageNotFound(String),
    ChecksumMismatch { expected: String, found: String },
    PackageDisabled(String),
    InvalidPayload(String),
}

impl std::fmt::Display for CustomNodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PackageNotFound(p) => write!(f, "Custom package not found: {p}"),
            Self::ChecksumMismatch { expected, found } => {
                write!(f, "Tarball checksum mismatch: expected {expected}, found {found}")
            }
            Self::PackageDisabled(p) => write!(f, "Custom package is disabled: {p}"),
            Self::InvalidPayload(m) => write!(f, "Invalid custom node payload: {m}"),
        }
    }
}

impl std::error::Error for CustomNodeError {}

#[derive(Debug, Clone)]
pub struct CustomNodeLoaderService {
    tarball_ledger: Arc<RwLock<HashMap<String, CustomNodePackage>>>,
}

impl Default for CustomNodeLoaderService {
    fn default() -> Self {
        let service = Self {
            tarball_ledger: Arc::new(RwLock::new(HashMap::new())),
        };

        // Seed a sample community package
        service.install_package(
            "n8n-nodes-slack-enhanced",
            "1.2.0",
            "community-contributor",
            "sha256_slack_enhanced_v1",
            r#"{"nodes": ["SlackEnhanced"]}"#,
            1000,
        ).unwrap();

        service
    }
}

impl CustomNodeLoaderService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn install_package(
        &self,
        package_name: &str,
        version: &str,
        author: &str,
        tarball_checksum: &str,
        manifest_json: &str,
        now_ms: u64,
    ) -> Result<(), CustomNodeError> {
        let mut ledger = self.tarball_ledger.write().unwrap();
        ledger.insert(
            package_name.to_string(),
            CustomNodePackage {
                package_name: package_name.to_string(),
                version: version.to_string(),
                author: author.to_string(),
                tarball_checksum: tarball_checksum.to_string(),
                manifest_json: manifest_json.to_string(),
                installed_at_ms: now_ms,
                is_enabled: true,
            },
        );
        Ok(())
    }

    pub fn load_node(&self, package_name: &str, node_name: &str) -> Result<CustomNodeDescriptor, CustomNodeError> {
        let ledger = self.tarball_ledger.read().unwrap();
        let pkg = ledger.get(package_name).ok_or_else(|| CustomNodeError::PackageNotFound(package_name.to_string()))?;

        if !pkg.is_enabled {
            return Err(CustomNodeError::PackageDisabled(package_name.to_string()));
        }

        Ok(CustomNodeDescriptor {
            package_name: pkg.package_name.clone(),
            node_name: node_name.to_string(),
            version: pkg.version.clone(),
            is_executable: true,
        })
    }

    pub fn disable_package(&self, package_name: &str) -> Result<(), CustomNodeError> {
        let mut ledger = self.tarball_ledger.write().unwrap();
        let pkg = ledger.get_mut(package_name).ok_or_else(|| CustomNodeError::PackageNotFound(package_name.to_string()))?;
        pkg.is_enabled = false;
        Ok(())
    }

    pub fn verify_checksum(&self, package_name: &str, expected_checksum: &str) -> Result<bool, CustomNodeError> {
        let ledger = self.tarball_ledger.read().unwrap();
        let pkg = ledger.get(package_name).ok_or_else(|| CustomNodeError::PackageNotFound(package_name.to_string()))?;
        if pkg.tarball_checksum != expected_checksum {
            Err(CustomNodeError::ChecksumMismatch {
                expected: expected_checksum.to_string(),
                found: pkg.tarball_checksum.clone(),
            })
        } else {
            Ok(true)
        }
    }

    pub fn handle_port_custom_load(&self, payload: &serde_json::Value) -> Result<serde_json::Value, CustomNodeError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("load");
        match action {
            "load" => {
                let package_name = payload.get("package_name").and_then(|v| v.as_str()).unwrap_or("");
                let node_name = payload.get("node_name").and_then(|v| v.as_str()).unwrap_or("");
                let desc = self.load_node(package_name, node_name)?;
                Ok(serde_json::json!({
                    "success": true,
                    "package_name": desc.package_name,
                    "node_name": desc.node_name,
                    "version": desc.version,
                    "is_executable": desc.is_executable
                }))
            }
            "install" => {
                let package_name = payload.get("package_name").and_then(|v| v.as_str()).unwrap_or("");
                let version = payload.get("version").and_then(|v| v.as_str()).unwrap_or("1.0.0");
                let author = payload.get("author").and_then(|v| v.as_str()).unwrap_or("unknown");
                let checksum = payload.get("checksum").and_then(|v| v.as_str()).unwrap_or("");
                let manifest = payload.get("manifest").and_then(|v| v.as_str()).unwrap_or("{}");
                let now_ms = payload.get("now_ms").and_then(|v| v.as_u64()).unwrap_or(0);

                self.install_package(package_name, version, author, checksum, manifest, now_ms)?;
                Ok(serde_json::json!({
                    "success": true,
                    "package_name": package_name,
                    "installed": true
                }))
            }
            "disable" => {
                let package_name = payload.get("package_name").and_then(|v| v.as_str()).unwrap_or("");
                self.disable_package(package_name)?;
                Ok(serde_json::json!({
                    "success": true,
                    "package_name": package_name,
                    "disabled": true
                }))
            }
            other => Err(CustomNodeError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }
}

#[cfg(test)]
#[path = "../tests/community_custom_nodes_test.rs"]
mod tests;
