//! L10.S01 — Installation and packaging
//!
//! Provides the packaging artifact builder, platform distribution manifest generator,
//! checksum validation, and release bundle integrity verification.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TargetPlatform {
    LinuxX86_64,
    LinuxAarch64,
    DarwinX86_64,
    DarwinAarch64,
    WindowsX86_64,
    DockerMultiArch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PackageArtifact {
    pub artifact_id: String,
    pub release_version: String,
    pub platform: TargetPlatform,
    pub filename: String,
    pub sha256_checksum: String,
    pub size_bytes: u64,
    pub built_at_ms: u64,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseBundleManifest {
    pub release_version: String,
    pub artifacts: Vec<PackageArtifact>,
    pub git_commit: String,
    pub verified: bool,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PackagingError {
    #[error("Empty release version or artifact ID")]
    EmptyIdentifier,
    #[error("Invalid SHA256 checksum: {0} (must be 64 hex characters)")]
    InvalidChecksum(String),
    #[error("Zero size artifact: {0}")]
    ZeroSizeBytes(String),
    #[error("Artifact not found: {0}")]
    NotFound(String),
}

pub struct InstallationPackagingService {
    manifests: Arc<RwLock<HashMap<String, ReleaseBundleManifest>>>,
}

impl Default for InstallationPackagingService {
    fn default() -> Self {
        Self::new()
    }
}

impl InstallationPackagingService {
    pub fn new() -> Self {
        Self {
            manifests: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Validates SHA256 hex string (64 characters)
    fn is_valid_sha256(checksum: &str) -> bool {
        checksum.len() == 64 && checksum.chars().all(|c| c.is_ascii_hexdigit())
    }

    /// Registers a packaging artifact into a release version manifest
    pub fn register_artifact(
        &self,
        artifact: PackageArtifact,
        git_commit: &str,
    ) -> Result<PackageArtifact, PackagingError> {
        let aid = artifact.artifact_id.trim();
        let ver = artifact.release_version.trim();
        if aid.is_empty() || ver.is_empty() {
            return Err(PackagingError::EmptyIdentifier);
        }

        if !Self::is_valid_sha256(&artifact.sha256_checksum) {
            return Err(PackagingError::InvalidChecksum(artifact.sha256_checksum));
        }

        if artifact.size_bytes == 0 {
            return Err(PackagingError::ZeroSizeBytes(artifact.filename));
        }

        let mut map = self.manifests.write().unwrap();
        let manifest = map.entry(ver.to_string()).or_insert_with(|| ReleaseBundleManifest {
            release_version: ver.to_string(),
            artifacts: Vec::new(),
            git_commit: git_commit.to_string(),
            verified: false,
        });

        manifest.artifacts.push(artifact.clone());
        manifest.verified = true;

        Ok(artifact)
    }

    /// Retrieves a release manifest by version
    pub fn get_manifest(&self, release_version: &str) -> Result<ReleaseBundleManifest, PackagingError> {
        let ver = release_version.trim();
        if ver.is_empty() {
            return Err(PackagingError::EmptyIdentifier);
        }

        let map = self.manifests.read().unwrap();
        map.get(ver)
            .cloned()
            .ok_or_else(|| PackagingError::NotFound(ver.to_string()))
    }
}

#[cfg(test)]
#[path = "../tests/packaging_test.rs"]
mod tests;
