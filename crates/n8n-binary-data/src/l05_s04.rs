//! L05.S04 Binary Data Streaming Module
//! Provides chunked streaming, lifecycle state machine, checksum integrity, and resource limit enforcement.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_MAX_CHUNK_SIZE: usize = 5 * 1024 * 1024; // 5 MB max per chunk
pub const DEFAULT_MAX_STREAM_SIZE: usize = 100 * 1024 * 1024; // 100 MB max per stream
pub const DEFAULT_CHUNK_SIZE: usize = 64 * 1024; // 64 KB default chunk size

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StreamStatus {
    Open,
    Finalized,
    Aborted,
    Closed,
}

impl std::fmt::Display for StreamStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Open => write!(f, "open"),
            Self::Finalized => write!(f, "finalized"),
            Self::Aborted => write!(f, "aborted"),
            Self::Closed => write!(f, "closed"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryChunk {
    pub chunk_index: usize,
    pub chunk_bytes: Vec<u8>,
    pub chunk_size: usize,
    pub checksum: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BinaryStreamSession {
    pub stream_id: String,
    pub tenant_id: String,
    pub file_name: String,
    pub mime_type: String,
    pub status: StreamStatus,
    pub is_finalized: bool,
    pub total_bytes: usize,
    pub checksum: Option<String>,
    pub sha256_checksum: Option<String>,
    pub chunks: Vec<BinaryChunk>,
    pub created_at_ms: u64,
    pub finalized_at_ms: Option<u64>,
    pub abort_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BinaryStreamError {
    StreamNotFound(String),
    StreamAlreadyFinalized(String),
    StreamAborted(String),
    StreamClosed(String),
    StreamNotFinalized(String),
    TenantMismatch { expected: String, actual: String },
    InvalidChunkSequence { expected: usize, actual: usize },
    DuplicateChunk { chunk_index: usize },
    ChunkSizeExceeded { size: usize, max_size: usize },
    StreamSizeExceeded { total_size: usize, max_size: usize },
    CorruptChunk { chunk_index: usize, expected: usize, actual: usize },
    IntegrityChecksumMismatch { expected: String, actual: String },
    EnvelopeValidationFailed(String),
    InvalidRequest(String),
    LockPoisoned,
}

impl std::fmt::Display for BinaryStreamError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::StreamNotFound(id) => write!(f, "Binary stream not found: {id}"),
            Self::StreamAlreadyFinalized(id) => write!(f, "Binary stream is already finalized: {id}"),
            Self::StreamAborted(id) => write!(f, "Binary stream is aborted: {id}"),
            Self::StreamClosed(id) => write!(f, "Binary stream is closed: {id}"),
            Self::StreamNotFinalized(id) => write!(f, "Binary stream is not yet finalized: {id}"),
            Self::TenantMismatch { expected, actual } => {
                write!(f, "Tenant mismatch: expected {expected}, actual {actual}")
            }
            Self::InvalidChunkSequence { expected, actual } => {
                write!(f, "Invalid chunk sequence: expected index {expected}, got {actual}")
            }
            Self::DuplicateChunk { chunk_index } => {
                write!(f, "Duplicate chunk rejected: chunk index {chunk_index} already received")
            }
            Self::ChunkSizeExceeded { size, max_size } => {
                write!(f, "Chunk size limit exceeded: {size} bytes (max: {max_size})")
            }
            Self::StreamSizeExceeded { total_size, max_size } => {
                write!(f, "Stream size limit exceeded: {total_size} bytes (max: {max_size})")
            }
            Self::CorruptChunk { chunk_index, expected, actual } => {
                write!(f, "Corrupt chunk at index {chunk_index}: expected {expected} bytes, got {actual}")
            }
            Self::IntegrityChecksumMismatch { expected, actual } => {
                write!(f, "Integrity checksum mismatch: expected {expected}, got {actual}")
            }
            Self::EnvelopeValidationFailed(msg) => write!(f, "Envelope validation failed: {msg}"),
            Self::InvalidRequest(msg) => write!(f, "Invalid binary stream request: {msg}"),
            Self::LockPoisoned => write!(f, "Binary chunk store lock poisoned"),
        }
    }
}

impl std::error::Error for BinaryStreamError {}

pub struct BinaryDataStreamingService {
    streams: RwLock<HashMap<String, BinaryStreamSession>>,
    max_chunk_size: usize,
    max_stream_size: usize,
}

impl Default for BinaryDataStreamingService {
    fn default() -> Self {
        Self::new()
    }
}

impl BinaryDataStreamingService {
    pub fn new() -> Self {
        Self {
            streams: RwLock::new(HashMap::new()),
            max_chunk_size: DEFAULT_MAX_CHUNK_SIZE,
            max_stream_size: DEFAULT_MAX_STREAM_SIZE,
        }
    }

    pub fn with_limits(max_chunk_size: usize, max_stream_size: usize) -> Self {
        Self {
            streams: RwLock::new(HashMap::new()),
            max_chunk_size,
            max_stream_size,
        }
    }

    pub fn compute_fnv1a(bytes: &[u8]) -> String {
        let mut hash: u64 = 0xcbf29ce484222325;
        for b in bytes {
            hash ^= *b as u64;
            hash = hash.wrapping_mul(0x100000001b3);
        }
        format!("fnv1a:{:016x}", hash)
    }

    pub fn compute_sha256(bytes: &[u8]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        format!("{:x}", hasher.finalize())
    }

    pub fn split_into_chunks(data: &[u8], chunk_size: usize) -> Vec<Vec<u8>> {
        if data.is_empty() {
            return Vec::new();
        }
        data.chunks(chunk_size).map(|c| c.to_vec()).collect()
    }

    pub fn init_stream(
        &self,
        stream_id: &str,
        tenant_id: &str,
        file_name: &str,
        mime_type: &str,
    ) -> Result<BinaryStreamSession, BinaryStreamError> {
        if stream_id.trim().is_empty() {
            return Err(BinaryStreamError::InvalidRequest("stream_id cannot be empty".to_string()));
        }
        if tenant_id.trim().is_empty() {
            return Err(BinaryStreamError::InvalidRequest("tenant_id cannot be empty".to_string()));
        }

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let session = BinaryStreamSession {
            stream_id: stream_id.to_string(),
            tenant_id: tenant_id.to_string(),
            file_name: file_name.to_string(),
            mime_type: mime_type.to_string(),
            status: StreamStatus::Open,
            is_finalized: false,
            total_bytes: 0,
            checksum: None,
            sha256_checksum: None,
            chunks: Vec::new(),
            created_at_ms: now_ms,
            finalized_at_ms: None,
            abort_reason: None,
        };

        let mut streams = self.streams.write().map_err(|_| BinaryStreamError::LockPoisoned)?;
        streams.insert(stream_id.to_string(), session.clone());
        Ok(session)
    }

    pub fn append_chunk(
        &self,
        tenant_id: &str,
        stream_id: &str,
        chunk_index: usize,
        data: Vec<u8>,
    ) -> Result<usize, BinaryStreamError> {
        let mut streams = self.streams.write().map_err(|_| BinaryStreamError::LockPoisoned)?;
        let session = streams
            .get_mut(stream_id)
            .ok_or_else(|| BinaryStreamError::StreamNotFound(stream_id.to_string()))?;

        if session.tenant_id != tenant_id {
            return Err(BinaryStreamError::TenantMismatch {
                expected: session.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        match session.status {
            StreamStatus::Open => {}
            StreamStatus::Finalized => {
                return Err(BinaryStreamError::StreamAlreadyFinalized(stream_id.to_string()));
            }
            StreamStatus::Aborted => {
                return Err(BinaryStreamError::StreamAborted(stream_id.to_string()));
            }
            StreamStatus::Closed => {
                return Err(BinaryStreamError::StreamClosed(stream_id.to_string()));
            }
        }

        let chunk_size = data.len();
        if chunk_size > self.max_chunk_size {
            return Err(BinaryStreamError::ChunkSizeExceeded {
                size: chunk_size,
                max_size: self.max_chunk_size,
            });
        }

        let new_total = session.total_bytes + chunk_size;
        if new_total > self.max_stream_size {
            return Err(BinaryStreamError::StreamSizeExceeded {
                total_size: new_total,
                max_size: self.max_stream_size,
            });
        }

        if chunk_index < session.chunks.len() {
            return Err(BinaryStreamError::DuplicateChunk { chunk_index });
        }

        if chunk_index > session.chunks.len() {
            return Err(BinaryStreamError::InvalidChunkSequence {
                expected: session.chunks.len(),
                actual: chunk_index,
            });
        }

        let chunk_checksum = Self::compute_fnv1a(&data);
        session.total_bytes = new_total;
        session.chunks.push(BinaryChunk {
            chunk_index,
            chunk_bytes: data,
            chunk_size,
            checksum: chunk_checksum,
        });

        Ok(session.total_bytes)
    }

    pub fn finalize_stream(
        &self,
        tenant_id: &str,
        stream_id: &str,
    ) -> Result<BinaryStreamSession, BinaryStreamError> {
        let mut streams = self.streams.write().map_err(|_| BinaryStreamError::LockPoisoned)?;
        let session = streams
            .get_mut(stream_id)
            .ok_or_else(|| BinaryStreamError::StreamNotFound(stream_id.to_string()))?;

        if session.tenant_id != tenant_id {
            return Err(BinaryStreamError::TenantMismatch {
                expected: session.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        match session.status {
            StreamStatus::Open => {}
            StreamStatus::Finalized => {
                return Err(BinaryStreamError::StreamAlreadyFinalized(stream_id.to_string()));
            }
            StreamStatus::Aborted => {
                return Err(BinaryStreamError::StreamAborted(stream_id.to_string()));
            }
            StreamStatus::Closed => {
                return Err(BinaryStreamError::StreamClosed(stream_id.to_string()));
            }
        }

        let mut full_bytes = Vec::with_capacity(session.total_bytes);
        for chunk in &session.chunks {
            if chunk.chunk_bytes.len() != chunk.chunk_size {
                return Err(BinaryStreamError::CorruptChunk {
                    chunk_index: chunk.chunk_index,
                    expected: chunk.chunk_size,
                    actual: chunk.chunk_bytes.len(),
                });
            }
            full_bytes.extend_from_slice(&chunk.chunk_bytes);
        }

        let fnv1a = Self::compute_fnv1a(&full_bytes);
        let sha256 = Self::compute_sha256(&full_bytes);

        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        session.checksum = Some(fnv1a);
        session.sha256_checksum = Some(sha256);
        session.status = StreamStatus::Finalized;
        session.is_finalized = true;
        session.finalized_at_ms = Some(now_ms);

        Ok(session.clone())
    }

    pub fn read_chunk(
        &self,
        tenant_id: &str,
        stream_id: &str,
        chunk_index: usize,
    ) -> Result<Vec<u8>, BinaryStreamError> {
        let streams = self.streams.read().map_err(|_| BinaryStreamError::LockPoisoned)?;
        let session = streams
            .get(stream_id)
            .ok_or_else(|| BinaryStreamError::StreamNotFound(stream_id.to_string()))?;

        if session.tenant_id != tenant_id {
            return Err(BinaryStreamError::TenantMismatch {
                expected: session.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        if session.status == StreamStatus::Aborted {
            return Err(BinaryStreamError::StreamAborted(stream_id.to_string()));
        }

        let chunk = session
            .chunks
            .get(chunk_index)
            .ok_or_else(|| BinaryStreamError::InvalidRequest(format!("Chunk index {chunk_index} out of bounds")))?;

        if chunk.chunk_bytes.len() != chunk.chunk_size {
            return Err(BinaryStreamError::CorruptChunk {
                chunk_index,
                expected: chunk.chunk_size,
                actual: chunk.chunk_bytes.len(),
            });
        }

        Ok(chunk.chunk_bytes.clone())
    }

    pub fn read_all_bytes(
        &self,
        tenant_id: &str,
        stream_id: &str,
    ) -> Result<Vec<u8>, BinaryStreamError> {
        let streams = self.streams.read().map_err(|_| BinaryStreamError::LockPoisoned)?;
        let session = streams
            .get(stream_id)
            .ok_or_else(|| BinaryStreamError::StreamNotFound(stream_id.to_string()))?;

        if session.tenant_id != tenant_id {
            return Err(BinaryStreamError::TenantMismatch {
                expected: session.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        if session.status == StreamStatus::Aborted {
            return Err(BinaryStreamError::StreamAborted(stream_id.to_string()));
        }

        if !session.is_finalized {
            return Err(BinaryStreamError::StreamNotFinalized(stream_id.to_string()));
        }

        let mut reconstructed = Vec::with_capacity(session.total_bytes);
        for chunk in &session.chunks {
            reconstructed.extend_from_slice(&chunk.chunk_bytes);
        }

        let computed_sha = Self::compute_sha256(&reconstructed);
        if let Some(ref expected_sha) = session.sha256_checksum {
            if &computed_sha != expected_sha {
                return Err(BinaryStreamError::IntegrityChecksumMismatch {
                    expected: expected_sha.clone(),
                    actual: computed_sha,
                });
            }
        }

        Ok(reconstructed)
    }

    pub fn abort_stream(
        &self,
        tenant_id: &str,
        stream_id: &str,
        reason: &str,
    ) -> Result<BinaryStreamSession, BinaryStreamError> {
        let mut streams = self.streams.write().map_err(|_| BinaryStreamError::LockPoisoned)?;
        let session = streams
            .get_mut(stream_id)
            .ok_or_else(|| BinaryStreamError::StreamNotFound(stream_id.to_string()))?;

        if session.tenant_id != tenant_id {
            return Err(BinaryStreamError::TenantMismatch {
                expected: session.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        if session.is_finalized {
            return Err(BinaryStreamError::StreamAlreadyFinalized(stream_id.to_string()));
        }

        session.status = StreamStatus::Aborted;
        session.abort_reason = Some(reason.to_string());
        Ok(session.clone())
    }

    pub fn close_stream(
        &self,
        tenant_id: &str,
        stream_id: &str,
    ) -> Result<BinaryStreamSession, BinaryStreamError> {
        let mut streams = self.streams.write().map_err(|_| BinaryStreamError::LockPoisoned)?;
        let session = streams
            .get_mut(stream_id)
            .ok_or_else(|| BinaryStreamError::StreamNotFound(stream_id.to_string()))?;

        if session.tenant_id != tenant_id {
            return Err(BinaryStreamError::TenantMismatch {
                expected: session.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        session.status = StreamStatus::Closed;
        Ok(session.clone())
    }

    pub fn get_stream_metadata(
        &self,
        tenant_id: &str,
        stream_id: &str,
    ) -> Result<BinaryStreamSession, BinaryStreamError> {
        let streams = self.streams.read().map_err(|_| BinaryStreamError::LockPoisoned)?;
        let session = streams
            .get(stream_id)
            .ok_or_else(|| BinaryStreamError::StreamNotFound(stream_id.to_string()))?;

        if session.tenant_id != tenant_id {
            return Err(BinaryStreamError::TenantMismatch {
                expected: session.tenant_id.clone(),
                actual: tenant_id.to_string(),
            });
        }

        Ok(session.clone())
    }

    pub fn validate_envelope(
        envelope: &serde_json::Value,
        expected_tenant: &str,
    ) -> Result<(), BinaryStreamError> {
        let env_tenant = envelope
            .get("tenant_id")
            .or_else(|| envelope.get("tenant"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                BinaryStreamError::EnvelopeValidationFailed("Missing 'tenant_id' in envelope".to_string())
            })?;

        if env_tenant != expected_tenant {
            return Err(BinaryStreamError::EnvelopeValidationFailed(format!(
                "Envelope tenant '{}' does not match request tenant '{}'",
                env_tenant, expected_tenant
            )));
        }

        let correlation_id = envelope
            .get("correlation_id")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        if correlation_id.trim().is_empty() {
            return Err(BinaryStreamError::EnvelopeValidationFailed(
                "Missing or empty 'correlation_id' in envelope".to_string(),
            ));
        }

        Ok(())
    }

    pub fn handle_port_stream(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'action'".to_string())?;

        let tenant_id = payload
            .get("tenant_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'tenant_id'".to_string())?;

        let stream_id = payload
            .get("stream_id")
            .and_then(|v| v.as_str())
            .ok_or_else(|| "Missing required 'stream_id'".to_string())?;

        if let Some(envelope) = payload.get("envelope") {
            Self::validate_envelope(envelope, tenant_id).map_err(|e| e.to_string())?;
        }

        match action {
            "init" | "open" => {
                let file_name = payload.get("file_name").and_then(|v| v.as_str()).unwrap_or("unnamed.bin");
                let mime_type = payload.get("mime_type").and_then(|v| v.as_str()).unwrap_or("application/octet-stream");
                let res = self.init_stream(stream_id, tenant_id, file_name, mime_type).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
            }
            "append" | "write" => {
                let chunk_index = payload
                    .get("chunk_index")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "Missing required 'chunk_index'".to_string())? as usize;

                let bytes = if let Some(data_str) = payload.get("data").and_then(|v| v.as_str()) {
                    data_str.as_bytes().to_vec()
                } else if let Some(bytes_arr) = payload.get("bytes").and_then(|v| v.as_array()) {
                    bytes_arr.iter().filter_map(|b| b.as_u64().map(|n| n as u8)).collect()
                } else {
                    return Err("Missing required 'data' or 'bytes'".to_string());
                };

                let total_bytes = self.append_chunk(tenant_id, stream_id, chunk_index, bytes).map_err(|e| e.to_string())?;
                Ok(serde_json::json!({
                    "success": true,
                    "stream_id": stream_id,
                    "chunk_index": chunk_index,
                    "total_bytes": total_bytes,
                }))
            }
            "finalize" | "flush" => {
                let res = self.finalize_stream(tenant_id, stream_id).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
            }
            "read" => {
                let chunk_index = payload
                    .get("chunk_index")
                    .and_then(|v| v.as_u64())
                    .ok_or_else(|| "Missing required 'chunk_index'".to_string())? as usize;

                let bytes = self.read_chunk(tenant_id, stream_id, chunk_index).map_err(|e| e.to_string())?;
                let data_str = String::from_utf8_lossy(&bytes).to_string();
                Ok(serde_json::json!({
                    "success": true,
                    "stream_id": stream_id,
                    "chunk_index": chunk_index,
                    "data": data_str,
                    "byte_size": bytes.len(),
                }))
            }
            "read_all" => {
                let bytes = self.read_all_bytes(tenant_id, stream_id).map_err(|e| e.to_string())?;
                let data_str = String::from_utf8_lossy(&bytes).to_string();
                Ok(serde_json::json!({
                    "success": true,
                    "stream_id": stream_id,
                    "data": data_str,
                    "total_bytes": bytes.len(),
                }))
            }
            "abort" => {
                let reason = payload.get("reason").and_then(|v| v.as_str()).unwrap_or("Aborted by client");
                let res = self.abort_stream(tenant_id, stream_id, reason).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
            }
            "close" => {
                let res = self.close_stream(tenant_id, stream_id).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
            }
            "status" | "get_metadata" => {
                let res = self.get_stream_metadata(tenant_id, stream_id).map_err(|e| e.to_string())?;
                serde_json::to_value(res).map_err(|e| format!("Serialization error: {e}"))
            }
            unknown => Err(format!("Unknown stream action: {unknown}")),
        }
    }
}
