//! L08.S06 — Agent memory
//!
//! Provides durable and in-session conversation history chunk storage,
//! sliding window retrieval, token estimation, and memory eviction policies.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum MemoryRole {
    System,
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryChunk {
    pub chunk_id: String,
    pub session_id: String,
    pub role: MemoryRole,
    pub content: String,
    pub token_count: usize,
    pub timestamp_ms: u64,
    pub metadata: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryQuery {
    pub session_id: String,
    pub max_tokens: Option<usize>,
    pub limit: Option<usize>,
    pub roles: Option<Vec<MemoryRole>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemorySummary {
    pub session_id: String,
    pub total_chunks: usize,
    pub total_tokens: usize,
    pub oldest_timestamp_ms: u64,
    pub newest_timestamp_ms: u64,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MemoryError {
    #[error("Empty session ID provided")]
    EmptySessionId,
    #[error("Empty chunk content provided")]
    EmptyContent,
    #[error("Chunk ID not found: {0}")]
    ChunkNotFound(String),
    #[error("Session capacity exceeded: max {max} tokens, attempted {attempted}")]
    CapacityExceeded { max: usize, attempted: usize },
    #[error("Invalid query parameters: {0}")]
    InvalidQuery(String),
}

pub struct AgentMemoryStore {
    // session_id -> list of chunks ordered by insertion
    chunks: Arc<RwLock<HashMap<String, Vec<MemoryChunk>>>>,
    session_max_tokens: usize,
}

impl Default for AgentMemoryStore {
    fn default() -> Self {
        Self::new(32_768)
    }
}

impl AgentMemoryStore {
    pub fn new(session_max_tokens: usize) -> Self {
        Self {
            chunks: Arc::new(RwLock::new(HashMap::new())),
            session_max_tokens,
        }
    }

    /// Approximate token count: 1 token ~= 4 chars, minimum 1 token
    pub fn estimate_tokens(content: &str) -> usize {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            0
        } else {
            (trimmed.len() / 4).max(1)
        }
    }

    /// Stores a memory chunk into the conversation history domain
    pub fn store_chunk(
        &self,
        session_id: &str,
        role: MemoryRole,
        content: &str,
        metadata: HashMap<String, String>,
        timestamp_ms: u64,
    ) -> Result<MemoryChunk, MemoryError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }
        let cnt = content.trim();
        if cnt.is_empty() {
            return Err(MemoryError::EmptyContent);
        }

        let token_count = Self::estimate_tokens(cnt);
        let mut map = self.chunks.write().unwrap();
        let session_chunks = map.entry(sid.to_string()).or_default();

        let current_tokens: usize = session_chunks.iter().map(|c| c.token_count).sum();
        if current_tokens + token_count > self.session_max_tokens {
            // Evict oldest non-system chunks until fits
            let mut evicted_tokens = 0;
            let mut i = 0;
            while i < session_chunks.len() && (current_tokens - evicted_tokens + token_count > self.session_max_tokens) {
                if session_chunks[i].role != MemoryRole::System {
                    evicted_tokens += session_chunks[i].token_count;
                    session_chunks.remove(i);
                } else {
                    i += 1;
                }
            }

            // If still exceeds, fail closed
            let remaining_tokens: usize = session_chunks.iter().map(|c| c.token_count).sum();
            if remaining_tokens + token_count > self.session_max_tokens {
                return Err(MemoryError::CapacityExceeded {
                    max: self.session_max_tokens,
                    attempted: remaining_tokens + token_count,
                });
            }
        }

        let chunk = MemoryChunk {
            chunk_id: format!("chunk-{}-{}", sid, session_chunks.len() + 1),
            session_id: sid.to_string(),
            role,
            content: cnt.to_string(),
            token_count,
            timestamp_ms,
            metadata,
        };

        session_chunks.push(chunk.clone());
        Ok(chunk)
    }

    /// Retrieves chunks matching the query
    pub fn retrieve(&self, query: &MemoryQuery) -> Result<Vec<MemoryChunk>, MemoryError> {
        let sid = query.session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let map = self.chunks.read().unwrap();
        let session_chunks = match map.get(sid) {
            Some(c) => c,
            None => return Ok(Vec::new()),
        };

        let mut filtered: Vec<MemoryChunk> = session_chunks
            .iter()
            .filter(|c| {
                if let Some(roles) = &query.roles {
                    roles.contains(&c.role)
                } else {
                    true
                }
            })
            .cloned()
            .collect();

        // If limit is set, take the most recent N
        if let Some(limit) = query.limit {
            if filtered.len() > limit {
                filtered = filtered.split_off(filtered.len() - limit);
            }
        }

        // If max_tokens is set, take from most recent backwards until token budget exhausted
        if let Some(max_tokens) = query.max_tokens {
            let mut budget = max_tokens;
            let mut window = Vec::new();
            for c in filtered.into_iter().rev() {
                if c.token_count <= budget {
                    budget -= c.token_count;
                    window.push(c);
                } else {
                    break;
                }
            }
            window.reverse();
            filtered = window;
        }

        Ok(filtered)
    }

    /// Returns session memory summary statistics
    pub fn get_summary(&self, session_id: &str) -> Result<MemorySummary, MemoryError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let map = self.chunks.read().unwrap();
        let session_chunks = match map.get(sid) {
            Some(c) => c,
            None => {
                return Ok(MemorySummary {
                    session_id: sid.to_string(),
                    total_chunks: 0,
                    total_tokens: 0,
                    oldest_timestamp_ms: 0,
                    newest_timestamp_ms: 0,
                });
            }
        };

        let total_chunks = session_chunks.len();
        let total_tokens = session_chunks.iter().map(|c| c.token_count).sum();
        let oldest = session_chunks.first().map(|c| c.timestamp_ms).unwrap_or(0);
        let newest = session_chunks.last().map(|c| c.timestamp_ms).unwrap_or(0);

        Ok(MemorySummary {
            session_id: sid.to_string(),
            total_chunks,
            total_tokens,
            oldest_timestamp_ms: oldest,
            newest_timestamp_ms: newest,
        })
    }

    /// Clears memory for a given session
    pub fn clear_session(&self, session_id: &str) -> Result<usize, MemoryError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let mut map = self.chunks.write().unwrap();
        let removed = map.remove(sid).map(|c| c.len()).unwrap_or(0);
        Ok(removed)
    }
}

#[cfg(test)]
#[path = "../tests/agent_memory_test.rs"]
mod tests;
