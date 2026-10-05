use serde::{Deserialize, Serialize};

pub const BINARY_ENCODING: &str = "base64";
pub const BINARY_IN_JSON_PROPERTY: &str = "_files";
pub const BINARY_MODE_SEPARATE: &str = "separate";
pub const BINARY_MODE_COMBINED: &str = "combined";

pub const MODE_DEFAULT: &str = "default";
pub const MODE_FILESYSTEM: &str = "filesystem";
pub const MODE_S3: &str = "s3";

/// Canonical n8n IBinaryData representation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BinaryData {
    /// Base64 payload if stored in-memory (id is None), or storage mode name ("filesystem"/"s3") when stored externally.
    pub data: String,
    pub mime_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_extension: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_size: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<usize>,
    /// External storage identifier formatted as "<mode>:<fileId>" e.g. "filesystem:abc-123".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}

impl BinaryData {
    pub fn is_external(&self) -> bool {
        self.id.is_some()
    }

    pub fn storage_mode(&self) -> &str {
        if let Some(ref id) = self.id {
            if let Some(prefix) = id.split(':').next() {
                return prefix;
            }
        }
        MODE_DEFAULT
    }
}

/// Format bytes into human-readable representation like n8n ("7 B", "1.2 KB", "3.4 MB").
pub fn format_file_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{} B", bytes)
    } else if bytes < 1024 * 1024 {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    } else if bytes < 1024 * 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / (1024.0 * 1024.0))
    } else {
        format!("{:.1} GB", bytes as f64 / (1024.0 * 1024.0 * 1024.0))
    }
}

/// Infer high-level category like n8n ('text', 'json', 'image', 'audio', 'video', 'pdf', 'html').
pub fn infer_file_type(mime: &str) -> Option<String> {
    let lower = mime.to_ascii_lowercase();
    if lower == "application/json" {
        Some("json".to_string())
    } else if lower == "application/pdf" {
        Some("pdf".to_string())
    } else if lower == "text/html" {
        Some("html".to_string())
    } else if lower.starts_with("text/") {
        Some("text".to_string())
    } else if lower.starts_with("image/") {
        Some("image".to_string())
    } else if lower.starts_with("audio/") {
        Some("audio".to_string())
    } else if lower.starts_with("video/") {
        Some("video".to_string())
    } else {
        None
    }
}
