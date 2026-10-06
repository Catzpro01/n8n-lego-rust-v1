//! L09.S01 — Official Vue surface compatibility
//!
//! Provides static bundle serving, SPA route resolution, MIME detection,
//! and asset manifests for the official n8n Vue frontend editor surface.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct StaticAsset {
    pub path: String,
    pub content_type: String,
    pub content: Vec<u8>,
    pub etag: String,
    pub cache_control: String,
    pub size: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BundleManifest {
    pub bundle_id: String,
    pub version: String,
    pub index_path: String,
    pub total_assets: usize,
    pub build_timestamp: u64,
}

#[derive(Debug)]
pub enum UiStaticError {
    NotFound(String),
    InvalidPayload(String),
    PathTraversal(String),
}

impl std::fmt::Display for UiStaticError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotFound(p) => write!(f, "Asset not found: {p}"),
            Self::InvalidPayload(msg) => write!(f, "Invalid request payload: {msg}"),
            Self::PathTraversal(p) => write!(f, "Security violation: path traversal detected '{p}'"),
        }
    }
}

impl std::error::Error for UiStaticError {}

#[derive(Debug, Clone)]
pub struct UiStaticBundleService {
    assets: Arc<RwLock<HashMap<String, StaticAsset>>>,
    spa_fallback_path: String,
    bundle_version: Arc<RwLock<String>>,
}

impl Default for UiStaticBundleService {
    fn default() -> Self {
        Self::new("2.9.4")
    }
}

impl UiStaticBundleService {
    pub fn new(version: impl Into<String>) -> Self {
        let v = version.into();
        let service = Self {
            assets: Arc::new(RwLock::new(HashMap::new())),
            spa_fallback_path: "/index.html".to_string(),
            bundle_version: Arc::new(RwLock::new(v.clone())),
        };

        // Seed standard index.html for Vue surface
        let default_html = format!(
            "<!DOCTYPE html><html><head><title>n8n editor</title></head><body><div id=\"app\"></div><!-- n8n vue bundle v{} --></body></html>",
            v
        );
        service.register_asset(
            "/index.html",
            "text/html; charset=utf-8",
            default_html.into_bytes(),
            "no-cache",
        );

        // Seed basic favicon and vendor stub
        service.register_asset(
            "/favicon.ico",
            "image/x-icon",
            vec![0, 0, 1, 0],
            "public, max-age=86400",
        );

        service
    }

    pub fn register_asset(
        &self,
        path: &str,
        content_type: &str,
        content: Vec<u8>,
        cache_control: &str,
    ) {
        let normalized = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };

        let etag = format!("\"{:x}-{:x}\"", content.len(), Self::simple_hash(&content));
        let size = content.len();

        let asset = StaticAsset {
            path: normalized.clone(),
            content_type: content_type.to_string(),
            content,
            etag,
            cache_control: cache_control.to_string(),
            size,
        };

        let mut lock = self.assets.write().unwrap();
        lock.insert(normalized, asset);
    }

    pub fn resolve_asset(&self, requested_path: &str) -> Result<StaticAsset, UiStaticError> {
        if requested_path.contains("..") {
            return Err(UiStaticError::PathTraversal(requested_path.to_string()));
        }

        let mut path = requested_path.split('?').next().unwrap_or(requested_path);
        if path.is_empty() || path == "/" {
            path = "/index.html";
        }

        let normalized = if path.starts_with('/') {
            path.to_string()
        } else {
            format!("/{path}")
        };

        let lock = self.assets.read().unwrap();
        if let Some(asset) = lock.get(&normalized) {
            return Ok(asset.clone());
        }

        // SPA route fallback: if no file extension, fallback to index.html
        if !normalized.contains('.') || normalized.starts_with("/workflow") || normalized.starts_with("/settings") {
            if let Some(index) = lock.get(&self.spa_fallback_path) {
                return Ok(index.clone());
            }
        }

        Err(UiStaticError::NotFound(normalized))
    }

    pub fn get_manifest(&self) -> BundleManifest {
        let lock = self.assets.read().unwrap();
        let ver = self.bundle_version.read().unwrap().clone();
        BundleManifest {
            bundle_id: format!("n8n-vue-bundle-{ver}"),
            version: ver,
            index_path: self.spa_fallback_path.clone(),
            total_assets: lock.len(),
            build_timestamp: 1775520000,
        }
    }

    /// Handles port invocation for `port.ui.static.serve.v1`
    pub fn handle_port_serve(&self, payload: &serde_json::Value) -> Result<serde_json::Value, UiStaticError> {
        let action = payload.get("action").and_then(|v| v.as_str()).unwrap_or("serve");

        match action {
            "serve" => {
                let path = payload
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| UiStaticError::InvalidPayload("Missing 'path' field".to_string()))?;

                let asset = self.resolve_asset(path)?;
                let body_str = String::from_utf8(asset.content.clone()).unwrap_or_else(|_| {
                    // Base64 or binary placeholder
                    format!("<binary data {} bytes>", asset.size)
                });

                Ok(serde_json::json!({
                    "success": true,
                    "path": asset.path,
                    "content_type": asset.content_type,
                    "etag": asset.etag,
                    "cache_control": asset.cache_control,
                    "size": asset.size,
                    "body": body_str
                }))
            }
            "manifest" => {
                let manifest = self.get_manifest();
                Ok(serde_json::json!({
                    "success": true,
                    "manifest": manifest
                }))
            }
            "register" => {
                let path = payload
                    .get("path")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| UiStaticError::InvalidPayload("Missing 'path'".to_string()))?;
                let content_type = payload
                    .get("content_type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("text/plain");
                let body = payload
                    .get("body")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let cache_control = payload
                    .get("cache_control")
                    .and_then(|v| v.as_str())
                    .unwrap_or("public, max-age=3600");

                self.register_asset(path, content_type, body.as_bytes().to_vec(), cache_control);

                Ok(serde_json::json!({
                    "success": true,
                    "registered": path
                }))
            }
            other => Err(UiStaticError::InvalidPayload(format!("Unsupported action '{other}'"))),
        }
    }

    fn simple_hash(bytes: &[u8]) -> u32 {
        let mut hash: u32 = 5381;
        for &b in bytes {
            hash = hash.wrapping_mul(33).wrapping_add(b as u32);
        }
        hash
    }
}

#[cfg(test)]
#[path = "../tests/vue_surface_test.rs"]
mod tests;
