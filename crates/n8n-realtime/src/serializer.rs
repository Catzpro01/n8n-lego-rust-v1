use crate::types::{PushMessage, MAX_PAYLOAD_SIZE_BYTES};
use serde_json::Value;

#[derive(Debug, thiserror::Error)]
pub enum SerializerError {
    #[error("Serialization failed: {0}")]
    JsonError(#[from] serde_json::Error),
    #[error("Payload exceeds maximum ceiling: {0} bytes (max: {1})")]
    PayloadTooLarge(usize, usize),
}

/// Serializes a PushMessage to JSON string with payload ceiling enforcement.
pub fn serialize_push_message(msg: &PushMessage) -> Result<String, SerializerError> {
    let json_str = serde_json::to_string(msg)?;
    if json_str.len() > MAX_PAYLOAD_SIZE_BYTES {
        return Err(SerializerError::PayloadTooLarge(json_str.len(), MAX_PAYLOAD_SIZE_BYTES));
    }
    Ok(json_str)
}

/// Formats a push message as an SSE frame: `data: <json>\n\n`
pub fn format_sse_frame(msg: &PushMessage) -> Result<String, SerializerError> {
    let json_str = serialize_push_message(msg)?;
    Ok(format!("data: {}\n\n", json_str))
}

/// Formats an SSE handshake frame: `:ok\n\n`
pub fn format_sse_handshake() -> &'static str {
    ":ok\n\n"
}

/// Formats an SSE ping frame: `:ping\n\n`
pub fn format_sse_ping() -> &'static str {
    ":ping\n\n"
}

/// Checks if an arbitrary JSON value exceeds the maximum payload size.
pub fn is_oversized_payload(val: &Value) -> bool {
    serde_json::to_string(val)
        .map(|s| s.len() > MAX_PAYLOAD_SIZE_BYTES)
        .unwrap_or(false)
}
