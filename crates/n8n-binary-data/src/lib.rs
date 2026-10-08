pub mod l05_s04;
pub mod manager;
pub mod types;

pub use l05_s04::{
    BinaryChunk, BinaryDataStreamingService, BinaryStreamError, BinaryStreamSession, StreamStatus,
    DEFAULT_CHUNK_SIZE, DEFAULT_MAX_CHUNK_SIZE, DEFAULT_MAX_STREAM_SIZE,
};
pub use manager::{BinaryDataManager, StorageConfig};
pub use types::{
    format_file_size, infer_file_type, BinaryData, BINARY_ENCODING, BINARY_IN_JSON_PROPERTY,
    BINARY_MODE_COMBINED, BINARY_MODE_SEPARATE, MODE_DEFAULT, MODE_FILESYSTEM, MODE_S3,
};

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_constants_and_contract() {
        assert_eq!(BINARY_ENCODING, "base64");
        assert_eq!(BINARY_IN_JSON_PROPERTY, "_files");
        assert_eq!(BINARY_MODE_SEPARATE, "separate");
        assert_eq!(BINARY_MODE_COMBINED, "combined");
        assert_eq!(MODE_DEFAULT, "default");
        assert_eq!(MODE_FILESYSTEM, "filesystem");
        assert_eq!(MODE_S3, "s3");
    }

    #[test]
    fn test_format_file_size() {
        assert_eq!(format_file_size(500), "500 B");
        assert_eq!(format_file_size(1024), "1.0 KB");
        assert_eq!(format_file_size(1024 * 1024), "1.0 MB");
        assert_eq!(format_file_size(1024 * 1024 * 1024), "1.0 GB");
    }

    #[test]
    fn test_infer_file_type() {
        assert_eq!(infer_file_type("text/plain"), Some("text".to_string()));
        assert_eq!(infer_file_type("application/json"), Some("json".to_string()));
        assert_eq!(infer_file_type("application/pdf"), Some("pdf".to_string()));
        assert_eq!(infer_file_type("image/png"), Some("image".to_string()));
        assert_eq!(infer_file_type("audio/mpeg"), Some("audio".to_string()));
        assert_eq!(infer_file_type("video/mp4"), Some("video".to_string()));
        assert_eq!(infer_file_type("unknown/binary"), None);
    }

    #[test]
    fn test_in_memory_store_and_retrieve_roundtrip() {
        let manager = BinaryDataManager::new_default();
        let payload = b"Hello, n8n binary data in full Rust!";

        let binary_item = manager
            .store(payload, Some("test_file.txt"), Some("text/plain"))
            .expect("Store failed");

        assert_eq!(binary_item.mime_type, "text/plain");
        assert_eq!(binary_item.file_name.as_deref(), Some("test_file.txt"));
        assert_eq!(binary_item.file_extension.as_deref(), Some("txt"));
        assert_eq!(binary_item.file_type.as_deref(), Some("text"));
        assert!(binary_item.id.is_none());
        assert!(!binary_item.is_external());
        assert_eq!(binary_item.storage_mode(), "default");

        let retrieved = manager.retrieve(&binary_item).expect("Retrieve failed");
        assert_eq!(retrieved, payload);

        // Check sha256
        let hash = BinaryDataManager::sha256(&retrieved);
        assert_eq!(hash, BinaryDataManager::sha256(payload));
    }

    #[test]
    fn test_filesystem_store_and_retrieve_roundtrip() {
        let dir = tempdir().expect("Failed to create tempdir");
        let manager = BinaryDataManager::new_filesystem(dir.path()).expect("Failed to create manager");
        let payload = b"Deep in the filesystem storage mode";

        let binary_item = manager
            .store(payload, Some("archive.pdf"), None)
            .expect("Store filesystem failed");

        assert_eq!(binary_item.mime_type, "application/pdf");
        assert_eq!(binary_item.file_extension.as_deref(), Some("pdf"));
        assert_eq!(binary_item.file_type.as_deref(), Some("pdf"));
        assert!(binary_item.is_external());
        assert_eq!(binary_item.storage_mode(), "filesystem");
        assert!(binary_item.id.as_ref().unwrap().starts_with("filesystem:"));

        let retrieved = manager.retrieve(&binary_item).expect("Retrieve filesystem failed");
        assert_eq!(retrieved, payload);
    }

    #[test]
    fn test_serde_json_compatibility() {
        let item = BinaryData {
            data: "aGVsbG8=".to_string(),
            mime_type: "text/plain".to_string(),
            file_name: Some("test.txt".to_string()),
            file_extension: Some("txt".to_string()),
            file_size: Some("5 B".to_string()),
            file_type: Some("text".to_string()),
            directory: None,
            bytes: Some(5),
            id: None,
        };

        let json_str = serde_json::to_string(&item).unwrap();
        assert!(json_str.contains("\"mimeType\":\"text/plain\""));
        assert!(json_str.contains("\"fileName\":\"test.txt\""));
        assert!(!json_str.contains("\"id\":"));

        let deserialized: BinaryData = serde_json::from_str(&json_str).unwrap();
        assert_eq!(item, deserialized);
    }

    #[test]
    fn test_streaming_service_roundtrip_and_chunk_split() {
        let service = BinaryDataStreamingService::new();
        let stream_id = "test-stream-crate-1";
        let tenant_id = "tenant-unit";

        service
            .init_stream(stream_id, tenant_id, "data.log", "text/plain")
            .expect("Init stream succeeds");

        let payload = b"Hello from crates/n8n-binary-data streaming module!";
        let chunks = BinaryDataStreamingService::split_into_chunks(payload, 16);
        assert_eq!(chunks.len(), 4);

        for (idx, chk) in chunks.into_iter().enumerate() {
            service
                .append_chunk(tenant_id, stream_id, idx, chk)
                .expect("Append succeeds");
        }

        let finalized = service
            .finalize_stream(tenant_id, stream_id)
            .expect("Finalize succeeds");

        assert_eq!(finalized.total_bytes, payload.len());
        assert_eq!(finalized.status, StreamStatus::Finalized);

        let reconstructed = service
            .read_all_bytes(tenant_id, stream_id)
            .expect("Read all bytes succeeds");

        assert_eq!(reconstructed, payload);
    }
}
