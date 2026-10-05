use std::path::{Path, PathBuf};
use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::types::{
    format_file_size, infer_file_type, BinaryData, MODE_DEFAULT, MODE_FILESYSTEM,
};

#[derive(Debug, Clone)]
pub enum StorageConfig {
    /// In-memory base64 encoded data (standard n8n default mode)
    Default,
    /// Filesystem directory for zero-copy file storage
    Filesystem { storage_path: PathBuf },
}

#[derive(Debug, Clone)]
pub struct BinaryDataManager {
    config: StorageConfig,
}

impl BinaryDataManager {
    /// Creates in-memory default binary data manager.
    pub fn new_default() -> Self {
        Self {
            config: StorageConfig::Default,
        }
    }

    /// Creates filesystem-backed binary data manager.
    pub fn new_filesystem(path: impl Into<PathBuf>) -> Result<Self> {
        let storage_path = path.into();
        if !storage_path.exists() {
            std::fs::create_dir_all(&storage_path)
                .with_context(|| format!("Failed to create binary storage dir {:?}", storage_path))?;
        }
        Ok(Self {
            config: StorageConfig::Filesystem { storage_path },
        })
    }

    /// Computes SHA-256 hex string of bytes.
    pub fn sha256(data: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(data);
        format!("{:x}", hasher.finalize())
    }

    /// Prepares / stores binary data according to configured storage mode.
    pub fn store(
        &self,
        buffer: &[u8],
        file_name: Option<&str>,
        mime_type: Option<&str>,
    ) -> Result<BinaryData> {
        let mime = mime_type
            .map(|m| m.to_string())
            .unwrap_or_else(|| {
                file_name
                    .and_then(|f| mime_guess::from_path(f).first_raw())
                    .unwrap_or("application/octet-stream")
                    .to_string()
            });

        let file_extension = file_name.and_then(|f| {
            Path::new(f)
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|s| s.to_string())
        });

        let file_type = infer_file_type(&mime);
        let byte_count = buffer.len();
        let file_size_str = format_file_size(byte_count);

        match &self.config {
            StorageConfig::Default => {
                let base64_data = BASE64.encode(buffer);
                Ok(BinaryData {
                    data: base64_data,
                    mime_type: mime,
                    file_name: file_name.map(|s| s.to_string()),
                    file_extension,
                    file_size: Some(file_size_str),
                    file_type,
                    directory: None,
                    bytes: Some(byte_count),
                    id: None,
                })
            }
            StorageConfig::Filesystem { storage_path } => {
                let file_id = Uuid::new_v4().to_string();
                let stored_filename = if let Some(ref ext) = file_extension {
                    format!("{}.{}", file_id, ext)
                } else {
                    file_id.clone()
                };
                let target_path = storage_path.join(&stored_filename);
                std::fs::write(&target_path, buffer)
                    .with_context(|| format!("Failed to write binary file {:?}", target_path))?;

                let id_str = format!("{}:{}", MODE_FILESYSTEM, file_id);
                Ok(BinaryData {
                    data: MODE_FILESYSTEM.to_string(),
                    mime_type: mime,
                    file_name: file_name.map(|s| s.to_string()),
                    file_extension,
                    file_size: Some(file_size_str),
                    file_type,
                    directory: Some(storage_path.to_string_lossy().to_string()),
                    bytes: Some(byte_count),
                    id: Some(id_str),
                })
            }
        }
    }

    /// Retrieves raw bytes from BinaryData object.
    pub fn retrieve(&self, item: &BinaryData) -> Result<Vec<u8>> {
        if let Some(ref id) = item.id {
            let mut parts = id.splitn(2, ':');
            let mode = parts.next().unwrap_or(MODE_DEFAULT);
            let file_id = parts.next().unwrap_or("");

            match mode {
                MODE_FILESYSTEM => match &self.config {
                    StorageConfig::Filesystem { storage_path } => {
                        let search_stem = file_id;
                        let mut resolved_path = None;

                        if let Ok(entries) = std::fs::read_dir(storage_path) {
                            for entry in entries.flatten() {
                                let path = entry.path();
                                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                                    if stem == search_stem {
                                        resolved_path = Some(path);
                                        break;
                                    }
                                }
                            }
                        }

                        let target = resolved_path.unwrap_or_else(|| {
                            if let Some(ref ext) = item.file_extension {
                                storage_path.join(format!("{}.{}", file_id, ext))
                            } else {
                                storage_path.join(file_id)
                            }
                        });

                        if !target.exists() {
                            bail!("Binary file not found on disk at {:?}", target);
                        }
                        let bytes = std::fs::read(&target)
                            .with_context(|| format!("Failed to read binary file {:?}", target))?;
                        Ok(bytes)
                    }
                    _ => bail!("Manager is not configured for filesystem storage"),
                },
                _ => bail!("Unsupported external storage mode: {}", mode),
            }
        } else {
            // In-memory base64 decode
            let bytes = BASE64
                .decode(item.data.as_bytes())
                .with_context(|| "Failed to decode base64 binary payload")?;
            Ok(bytes)
        }
    }
}
