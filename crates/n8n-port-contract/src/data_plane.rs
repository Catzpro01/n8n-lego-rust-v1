use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

/// Storage tier for DataHandle resolution
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum StorageTier {
    Memory,
    LocalSpool,
    SharedStorage,
    ObjectStore,
}

/// Lightweight handle referencing large binary data or bulky item sets.
/// Prevents repetitive serialized JSON payload copying across control plane ports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataHandle {
    pub handle_id: String,
    pub storage_tier: StorageTier,
    pub mime_type: String,
    pub size_bytes: u64,
    pub location_uri: String,
    pub checksum_sha256: Option<String>,
}

impl DataHandle {
    pub fn new(
        handle_id: impl Into<String>,
        storage_tier: StorageTier,
        mime_type: impl Into<String>,
        size_bytes: u64,
        location_uri: impl Into<String>,
    ) -> Self {
        Self {
            handle_id: handle_id.into(),
            storage_tier,
            mime_type: mime_type.into(),
            size_bytes,
            location_uri: location_uri.into(),
            checksum_sha256: None,
        }
    }

    pub fn with_checksum(mut self, sha256: impl Into<String>) -> Self {
        self.checksum_sha256 = Some(sha256.into());
        self
    }
}

/// A chunk of streaming binary or item payload
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StreamChunk {
    pub sequence_number: u64,
    pub is_last: bool,
    pub payload: Vec<u8>,
}

/// StreamPort providing bounded buffer streaming with backpressure support
pub struct StreamPort {
    sender: mpsc::Sender<StreamChunk>,
    receiver: tokio::sync::Mutex<mpsc::Receiver<StreamChunk>>,
    max_buffer_size: usize,
}

impl StreamPort {
    /// Creates a bounded StreamPort channel. When the buffer is full,
    /// `send_chunk` will apply backpressure asynchronously.
    pub fn new_bounded(buffer_capacity: usize) -> Self {
        let (tx, rx) = mpsc::channel(buffer_capacity);
        Self {
            sender: tx,
            receiver: tokio::sync::Mutex::new(rx),
            max_buffer_size: buffer_capacity,
        }
    }

    pub fn sender(&self) -> mpsc::Sender<StreamChunk> {
        self.sender.clone()
    }

    pub async fn send_chunk(&self, chunk: StreamChunk) -> Result<(), mpsc::error::SendError<StreamChunk>> {
        self.sender.send(chunk).await
    }

    pub async fn next_chunk(&self) -> Option<StreamChunk> {
        let mut rx = self.receiver.lock().await;
        rx.recv().await
    }

    pub fn buffer_capacity(&self) -> usize {
        self.max_buffer_size
    }
}
