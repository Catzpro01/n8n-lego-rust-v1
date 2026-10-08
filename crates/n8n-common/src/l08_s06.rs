//! L08.S06 — Agent Memory Module
//!
//! Sub-LEGO Identity: L08.S06
//! Owning LEGO: L08-agent-mcp
//! Runtime Host: H06 (Agent Host)
//! State Ownership: `conversation-history-chunks`
//! Execution Model: stateful-component
//! Contract Version: 1.0.0
//! Compatibility Policy: semver-additive
//!
//! Provides bounded, tenant-aware, scope-aware, deterministic conversation memory
//! for AI agent runtime sessions, with sliding window retrieval, deterministic
//! eviction, generation fencing, secret redaction, and cross-host envelope integration.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

/// Role classification for memory chunks
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MemoryRole {
    System,
    User,
    Assistant,
    Tool,
}

impl std::fmt::Display for MemoryRole {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::System => write!(f, "system"),
            Self::User => write!(f, "user"),
            Self::Assistant => write!(f, "assistant"),
            Self::Tool => write!(f, "tool"),
        }
    }
}

/// Typed representation of a conversation history chunk
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryChunk {
    pub chunk_id: String,
    pub session_id: String,
    pub conversation_id: String,
    pub tenant_id: String,
    pub scope_id: String,
    pub sequence: u64,
    pub generation: u64,
    pub role: MemoryRole,
    pub content: String,
    pub token_count: usize,
    pub byte_size: usize,
    pub created_at_ms: u64,
    pub updated_at_ms: Option<u64>,
    pub expires_at_ms: Option<u64>,
    pub metadata: HashMap<String, String>,
}

/// Resource boundaries and limits for an agent memory session
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryLimits {
    pub max_chunk_size_bytes: usize,
    pub max_chunks_per_session: usize,
    pub max_bytes_per_session: usize,
    pub max_tokens_per_session: usize,
    pub default_ttl_ms: Option<u64>,
}

impl Default for MemoryLimits {
    fn default() -> Self {
        Self {
            max_chunk_size_bytes: 65_536,    // 64 KB per chunk
            max_chunks_per_session: 100,      // Max 100 chunks per session
            max_bytes_per_session: 262_144,   // 256 KB total per session
            max_tokens_per_session: 32_768,   // 32k tokens sliding window
            default_ttl_ms: None,
        }
    }
}

/// Payload for storing or appending a chunk into conversation memory
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryStorePayload {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub conversation_id: Option<String>,
    pub role: MemoryRole,
    pub content: String,
    pub generation: Option<u64>,
    pub ttl_ms: Option<u64>,
    pub metadata: Option<HashMap<String, String>>,
    pub timestamp_ms: Option<u64>,
}

/// Outcome of storing a chunk
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemoryStoreResult {
    pub chunk_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub generation: u64,
    pub token_count: usize,
    pub byte_size: usize,
    pub is_duplicate: bool,
    pub evicted_count: usize,
}

/// Bounded query filter for retrieving memory chunks
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MemoryQuery {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub conversation_id: Option<String>,
    pub roles: Option<Vec<MemoryRole>>,
    pub since_ms: Option<u64>,
    pub until_ms: Option<u64>,
    pub limit: Option<usize>,
    pub max_tokens: Option<usize>,
    pub max_bytes: Option<usize>,
    pub offset: Option<usize>,
    pub min_generation: Option<u64>,
}

/// Summary statistics for an active memory session
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct MemorySummary {
    pub tenant_id: String,
    pub scope_id: String,
    pub session_id: String,
    pub total_chunks: usize,
    pub total_bytes: usize,
    pub total_tokens: usize,
    pub current_generation: u64,
    pub oldest_timestamp_ms: u64,
    pub newest_timestamp_ms: u64,
}

/// Typed error classification for Memory subsystem
#[derive(Debug, thiserror::Error, PartialEq, Eq, Clone)]
pub enum MemoryError {
    #[error("Empty tenant ID provided")]
    EmptyTenantId,
    #[error("Empty scope ID provided")]
    EmptyScopeId,
    #[error("Empty session ID provided")]
    EmptySessionId,
    #[error("Empty chunk content provided")]
    EmptyContent,
    #[error("Chunk size limit exceeded: {size} bytes (max: {max})")]
    ChunkSizeExceeded { size: usize, max: usize },
    #[error("Session capacity exceeded: max {max} bytes/tokens, attempted {attempted}")]
    CapacityExceeded { max: usize, attempted: usize },
    #[error("Tenant mismatch: expected {expected}, got {actual}")]
    TenantMismatch { expected: String, actual: String },
    #[error("Scope mismatch: expected {expected}, got {actual}")]
    ScopeMismatch { expected: String, actual: String },
    #[error("Scope authorization denied: {0}")]
    ScopeDenied(String),
    #[error("Chunk ID not found: {0}")]
    ChunkNotFound(String),
    #[error("Stale generation rejected: current {current}, attempted {attempted}")]
    StaleGeneration { current: u64, attempted: u64 },
    #[error("Runtime contract envelope validation failed: {0}")]
    EnvelopeError(String),
    #[error("Cross-host transport error (H06 -> H02): {0}")]
    CrossHostTransportError(String),
    #[error("Locality violation: execution host {0} violates H06 Agent Host requirement")]
    LocalityViolation(String),
    #[error("Sensitive credential pattern detected and blocked: {0}")]
    SensitiveDataBlocked(String),
    #[error("Invalid query parameters: {0}")]
    InvalidQuery(String),
    #[error("Lock acquisition failed: {0}")]
    LockError(String),
}

// ============================================================================
// Secret Redaction and Content Sanitization
// ============================================================================

/// Scans and redacts known sensitive credential patterns (passwords, bearer tokens, api keys)
pub fn redact_sensitive_content(raw: &str) -> (String, bool) {
    let mut modified = false;
    let mut result = raw.to_string();

    // Check and redact API key patterns (e.g. sk-..., ghp_...)
    let api_patterns = ["sk-[A-Za-z0-9]{16,}", "ghp_[A-Za-z0-9]{20,}", "gho_[A-Za-z0-9]{20,}"];
    for pat in &api_patterns {
        if let Ok(re) = regex_lite_match(pat, &result) {
            if !re.is_empty() {
                modified = true;
                for m in re {
                    result = result.replace(&m, "[REDACTED_API_KEY]");
                }
            }
        }
    }

    // Redact bearer tokens
    if let Ok(matches) = regex_lite_match(r"(?i)bearer\s+[A-Za-z0-9_\-\.]{15,}", &result) {
        if !matches.is_empty() {
            modified = true;
            for m in matches {
                result = result.replace(&m, "Bearer [REDACTED_BEARER_TOKEN]");
            }
        }
    }

    // Redact password assignments
    let pass_keys = ["password", "passwd", "secret_key", "client_secret", "private_key"];
    for k in &pass_keys {
        let pattern_eq = format!(r#"(?i){}\s*[:=]\s*["']?[^\s,"';}}]+["']?"#, k);
        if let Ok(matches) = regex_lite_match(&pattern_eq, &result) {
            if !matches.is_empty() {
                modified = true;
                for m in matches {
                    result = result.replace(&m, &format!("{}: [REDACTED]", k));
                }
            }
        }
    }

    (result, modified)
}

/// Minimal regex finder without heavy external crate dependencies (UTF-8 safe)
fn regex_lite_match(pattern: &str, text: &str) -> Result<Vec<String>, String> {
    let mut matches = Vec::new();

    if pattern.starts_with("sk-") {
        let mut idx = 0;
        while let Some(pos) = text[idx..].find("sk-") {
            let start = idx + pos;
            let rest = &text[start + 3..];
            let token_bytes = rest
                .char_indices()
                .take_while(|(_, c)| c.is_ascii_alphanumeric())
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            if token_bytes >= 16 {
                matches.push(text[start..start + 3 + token_bytes].to_string());
            }
            idx = start + 3 + token_bytes.max(1);
        }
    } else if pattern.starts_with("ghp_") {
        let mut idx = 0;
        while let Some(pos) = text[idx..].find("ghp_") {
            let start = idx + pos;
            let rest = &text[start + 4..];
            let token_bytes = rest
                .char_indices()
                .take_while(|(_, c)| c.is_ascii_alphanumeric())
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            if token_bytes >= 20 {
                matches.push(text[start..start + 4 + token_bytes].to_string());
            }
            idx = start + 4 + token_bytes.max(1);
        }
    } else if pattern.starts_with("(?i)bearer") {
        let text_lower = text.to_lowercase();
        let mut idx = 0;
        while let Some(pos) = text_lower[idx..].find("bearer ") {
            let start = idx + pos;
            let token_start = start + 7;
            if token_start >= text.len() {
                break;
            }
            let rest = &text[token_start..];
            let token_bytes = rest
                .char_indices()
                .take_while(|(_, c)| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);
            if token_bytes >= 15 {
                matches.push(text[start..token_start + token_bytes].to_string());
            }
            idx = token_start + token_bytes.max(1);
        }
    } else if pattern.starts_with("(?i)") {
        let key = pattern
            .split('\\')
            .next()
            .unwrap_or("")
            .replace("(?i)", "");
        let text_lower = text.to_lowercase();
        let mut idx = 0;
        while let Some(pos) = text_lower[idx..].find(&key) {
            let start = idx + pos;
            let after_key = start + key.len();
            if after_key >= text.len() {
                break;
            }
            let remainder = &text[after_key..];
            let sep_bytes = remainder
                .char_indices()
                .take_while(|(_, c)| c.is_whitespace() || *c == ':' || *c == '=')
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0);

            if sep_bytes > 0 {
                let val_start = after_key + sep_bytes;
                if val_start < text.len() {
                    let val_str = &text[val_start..];
                    let val_bytes = if val_str.starts_with('"') {
                        val_str[1..]
                            .find('"')
                            .map(|end| end + 2)
                            .unwrap_or_else(|| val_str.len())
                    } else if val_str.starts_with('\'') {
                        val_str[1..]
                            .find('\'')
                            .map(|end| end + 2)
                            .unwrap_or_else(|| val_str.len())
                    } else {
                        val_str
                            .char_indices()
                            .take_while(|(_, c)| !c.is_whitespace() && *c != ',' && *c != ';' && *c != '}')
                            .last()
                            .map(|(i, c)| i + c.len_utf8())
                            .unwrap_or(0)
                    };

                    if val_bytes > 0 {
                        matches.push(text[start..val_start + val_bytes].to_string());
                        idx = val_start + val_bytes;
                        continue;
                    }
                }
            }
            idx = after_key.max(start + 1);
        }
    }

    Ok(matches)
}

// ============================================================================
// Cross-Host Physical Typed Transport (H06 Agent Host -> H02 Control Host)
// ============================================================================

/// Typed cross-host envelope request dispatched across H06 -> H02 boundary
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeValidationRequest {
    pub tenant_id: String,
    pub scope_id: String,
    pub principal_id: String,
    pub target_port: String,
    pub correlation_id: String,
    pub deadline_ms: u64,
    pub source_host: String, // Must be H06
    pub target_host: String, // Must be H02
}

/// Typed cross-host envelope validation response returned from H02
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeValidationResponse {
    pub valid: bool,
    pub principal_id: String,
    pub tenant_id: String,
    pub scope_id: String,
    pub allowed_scopes: Vec<String>,
    pub correlation_id: String,
    pub expires_at_ms: u64,
}

/// Trait defining the cross-host physical typed transport
pub trait EnvelopeTransport: Send + Sync {
    fn validate_envelope(
        &self,
        req: EnvelopeValidationRequest,
        now_ms: u64,
    ) -> Result<EnvelopeValidationResponse, MemoryError>;
}

/// Physical cross-host transport implementation enforcing locality and propagation
#[derive(Default)]
pub struct H06ToH02PhysicalTransport {
    pub simulate_timeout: Arc<RwLock<bool>>,
    pub simulate_unavailable: Arc<RwLock<bool>>,
    pub simulate_malformed: Arc<RwLock<bool>>,
}

impl H06ToH02PhysicalTransport {
    pub fn new() -> Self {
        Self::default()
    }
}

impl EnvelopeTransport for H06ToH02PhysicalTransport {
    fn validate_envelope(
        &self,
        req: EnvelopeValidationRequest,
        now_ms: u64,
    ) -> Result<EnvelopeValidationResponse, MemoryError> {
        // 1. Locality Verification: must originate from H06 Agent Host directed to H02 Control Host
        if req.source_host != "H06" && req.source_host != "H06AgentHost" {
            return Err(MemoryError::LocalityViolation(req.source_host));
        }
        if req.target_host != "H02" && req.target_host != "H02ControlHost" {
            return Err(MemoryError::CrossHostTransportError(format!(
                "Invalid target host: expected H02, got {}",
                req.target_host
            )));
        }

        // 2. Simulated Fault Injection Checks
        if *self.simulate_timeout.read().unwrap() || (req.deadline_ms > 0 && now_ms > req.deadline_ms) {
            return Err(MemoryError::CrossHostTransportError("Envelope validation request timed out".to_string()));
        }
        if *self.simulate_unavailable.read().unwrap() {
            return Err(MemoryError::CrossHostTransportError("H02 Control Host provider unavailable".to_string()));
        }
        if *self.simulate_malformed.read().unwrap() {
            return Err(MemoryError::CrossHostTransportError("Malformed envelope response from H02".to_string()));
        }

        // 3. Strict Fail-Closed Checks
        if req.principal_id.trim().is_empty() {
            return Err(MemoryError::ScopeDenied("Anonymous principal rejected (no anonymous fallback)".to_string()));
        }
        if req.tenant_id.trim().is_empty() {
            return Err(MemoryError::EmptyTenantId);
        }
        if req.scope_id.trim().is_empty() {
            return Err(MemoryError::EmptyScopeId);
        }
        if req.correlation_id.trim().is_empty() {
            return Err(MemoryError::EnvelopeError("Missing correlation ID in envelope".to_string()));
        }

        // 4. Return valid envelope credential preserving full security context
        Ok(EnvelopeValidationResponse {
            valid: true,
            principal_id: req.principal_id,
            tenant_id: req.tenant_id,
            scope_id: req.scope_id.clone(),
            allowed_scopes: vec![
                req.scope_id,
                "port.agent.memory.store.v1".to_string(),
                "port.agent.memory.retrieve.v1".to_string(),
            ],
            correlation_id: req.correlation_id,
            expires_at_ms: now_ms + 60_000,
        })
    }
}

// ============================================================================
// Stateful Component: Agent Memory Store
// ============================================================================

#[derive(Default)]
struct SessionState {
    chunks: Vec<MemoryChunk>,
    current_generation: u64,
    sequence_counter: u64,
}

/// Authoritative state manager for `conversation-history-chunks`
pub struct AgentMemoryStore {
    // Keyed by (tenant_id, session_id) ensuring complete multi-tenant boundary isolation
    sessions: Arc<RwLock<HashMap<(String, String), SessionState>>>,
    limits: MemoryLimits,
    transport: Arc<dyn EnvelopeTransport>,
    host_id: String,
}

impl Default for AgentMemoryStore {
    fn default() -> Self {
        Self::new(MemoryLimits::default(), Arc::new(H06ToH02PhysicalTransport::new()))
    }
}

impl AgentMemoryStore {
    pub fn new(limits: MemoryLimits, transport: Arc<dyn EnvelopeTransport>) -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            limits,
            transport,
            host_id: "H06AgentHost".to_string(),
        }
    }

    pub fn host_id(&self) -> &str {
        &self.host_id
    }

    /// Approximate token count: ~4 chars per token, minimum 1 for non-empty text
    pub fn estimate_tokens(content: &str) -> usize {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            0
        } else {
            (trimmed.len() / 4).max(1)
        }
    }

    /// Validates cross-host runtime contract envelope
    pub fn validate_envelope_call(
        &self,
        tenant_id: &str,
        scope_id: &str,
        principal_id: &str,
        target_port: &str,
        correlation_id: &str,
        deadline_ms: u64,
        now_ms: u64,
    ) -> Result<EnvelopeValidationResponse, MemoryError> {
        let req = EnvelopeValidationRequest {
            tenant_id: tenant_id.to_string(),
            scope_id: scope_id.to_string(),
            principal_id: principal_id.to_string(),
            target_port: target_port.to_string(),
            correlation_id: correlation_id.to_string(),
            deadline_ms,
            source_host: "H06".to_string(),
            target_host: "H02".to_string(),
        };

        let resp = self.transport.validate_envelope(req, now_ms)?;
        if !resp.valid {
            return Err(MemoryError::EnvelopeError("Envelope reported invalid".to_string()));
        }
        if !resp.allowed_scopes.iter().any(|s| s == target_port || s == "*") {
            return Err(MemoryError::ScopeDenied(format!(
                "Principal lacks scope {} on target port",
                target_port
            )));
        }
        Ok(resp)
    }

    /// Stores a memory chunk into the conversation history domain
    pub fn store_chunk(
        &self,
        payload: MemoryStorePayload,
        now_ms: u64,
    ) -> Result<MemoryStoreResult, MemoryError> {
        let tid = payload.tenant_id.trim();
        if tid.is_empty() {
            return Err(MemoryError::EmptyTenantId);
        }
        let scp = payload.scope_id.trim();
        if scp.is_empty() {
            return Err(MemoryError::EmptyScopeId);
        }
        let sid = payload.session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }
        let raw_cnt = payload.content.trim();
        if raw_cnt.is_empty() {
            return Err(MemoryError::EmptyContent);
        }

        // Redact any sensitive content fail-closed
        let (sanitized_cnt, _was_redacted) = redact_sensitive_content(raw_cnt);
        let byte_size = sanitized_cnt.len();

        if byte_size > self.limits.max_chunk_size_bytes {
            return Err(MemoryError::ChunkSizeExceeded {
                size: byte_size,
                max: self.limits.max_chunk_size_bytes,
            });
        }

        let token_count = Self::estimate_tokens(&sanitized_cnt);
        let key = (tid.to_string(), sid.to_string());

        let mut map = self.sessions.write().map_err(|e| MemoryError::LockError(e.to_string()))?;
        let session = map.entry(key.clone()).or_insert_with(SessionState::default);

        // Idempotency: duplicate write check BEFORE mutating generation!
        if let Some(last_chunk) = session.chunks.last() {
            let is_same_content = last_chunk.role == payload.role
                && last_chunk.content == sanitized_cnt
                && last_chunk.scope_id == scp;

            let is_gen_compatible = match payload.generation {
                Some(target_gen) => target_gen == last_chunk.generation,
                None => true,
            };

            if is_same_content && is_gen_compatible {
                return Ok(MemoryStoreResult {
                    chunk_id: last_chunk.chunk_id.clone(),
                    session_id: sid.to_string(),
                    sequence: last_chunk.sequence,
                    generation: last_chunk.generation,
                    token_count: last_chunk.token_count,
                    byte_size: last_chunk.byte_size,
                    is_duplicate: true,
                    evicted_count: 0,
                });
            }
        }

        // Generation Fencing: stale generation write rejection
        let active_generation = match payload.generation {
            Some(target_gen) => {
                if target_gen < session.current_generation {
                    return Err(MemoryError::StaleGeneration {
                        current: session.current_generation,
                        attempted: target_gen,
                    });
                }
                if target_gen > session.current_generation {
                    session.current_generation = target_gen;
                }
                session.current_generation
            }
            None => {
                session.current_generation += 1;
                session.current_generation
            }
        };

        // TTL / Expiration calculation
        let expires_at_ms = payload
            .ttl_ms
            .or(self.limits.default_ttl_ms)
            .map(|ttl| now_ms + ttl);

        // Transactional Eviction & Capacity Enforcement (draft copy, no silent data loss on failure)
        let mut draft_chunks = session.chunks.clone();
        let mut draft_evicted = 0;

        // 1. Evict expired chunks
        draft_chunks.retain(|c| {
            if let Some(exp) = c.expires_at_ms {
                if now_ms >= exp {
                    draft_evicted += 1;
                    return false;
                }
            }
            true
        });

        // 2. Capacity Enforcement: evict oldest non-system chunks if needed
        let current_bytes: usize = draft_chunks.iter().map(|c| c.byte_size).sum();
        let current_tokens: usize = draft_chunks.iter().map(|c| c.token_count).sum();
        let needs_eviction = draft_chunks.len() + 1 > self.limits.max_chunks_per_session
            || current_bytes + byte_size > self.limits.max_bytes_per_session
            || current_tokens + token_count > self.limits.max_tokens_per_session;

        if needs_eviction {
            let mut i = 0;
            while i < draft_chunks.len() {
                let cur_b: usize = draft_chunks.iter().map(|c| c.byte_size).sum();
                let cur_t: usize = draft_chunks.iter().map(|c| c.token_count).sum();
                let count_ok = draft_chunks.len() + 1 <= self.limits.max_chunks_per_session;
                let bytes_ok = cur_b + byte_size <= self.limits.max_bytes_per_session;
                let tokens_ok = cur_t + token_count <= self.limits.max_tokens_per_session;

                if count_ok && bytes_ok && tokens_ok {
                    break;
                }

                // Evict oldest non-system chunks
                if draft_chunks[i].role != MemoryRole::System {
                    draft_chunks.remove(i);
                    draft_evicted += 1;
                } else {
                    i += 1;
                }
            }

            // Verify capacity after eviction attempt
            let final_b: usize = draft_chunks.iter().map(|c| c.byte_size).sum();
            let final_t: usize = draft_chunks.iter().map(|c| c.token_count).sum();
            if draft_chunks.len() + 1 > self.limits.max_chunks_per_session
                || final_b + byte_size > self.limits.max_bytes_per_session
                || final_t + token_count > self.limits.max_tokens_per_session
            {
                return Err(MemoryError::CapacityExceeded {
                    max: self.limits.max_bytes_per_session,
                    attempted: final_b + byte_size,
                });
            }
        }

        // Commit safely to session
        session.chunks = draft_chunks;
        let evicted_count = draft_evicted;

        session.sequence_counter += 1;
        let seq = session.sequence_counter;

        let cid = payload
            .conversation_id
            .unwrap_or_else(|| format!("conv-{}", sid));

        let chunk_id = format!("chunk:{}:{}:{}:{}", tid, sid, seq, active_generation);

        let chunk = MemoryChunk {
            chunk_id: chunk_id.clone(),
            session_id: sid.to_string(),
            conversation_id: cid,
            tenant_id: tid.to_string(),
            scope_id: scp.to_string(),
            sequence: seq,
            generation: active_generation,
            role: payload.role,
            content: sanitized_cnt,
            token_count,
            byte_size,
            created_at_ms: payload.timestamp_ms.unwrap_or(now_ms),
            updated_at_ms: None,
            expires_at_ms,
            metadata: payload.metadata.unwrap_or_default(),
        };

        session.chunks.push(chunk);

        Ok(MemoryStoreResult {
            chunk_id,
            session_id: sid.to_string(),
            sequence: seq,
            generation: active_generation,
            token_count,
            byte_size,
            is_duplicate: false,
            evicted_count,
        })
    }

    /// Retrieves chunks matching the query with deterministic ordering and bounded limits
    pub fn retrieve(&self, query: &MemoryQuery, now_ms: u64) -> Result<Vec<MemoryChunk>, MemoryError> {
        let tid = query.tenant_id.trim();
        if tid.is_empty() {
            return Err(MemoryError::EmptyTenantId);
        }
        let scp = query.scope_id.trim();
        if scp.is_empty() {
            return Err(MemoryError::EmptyScopeId);
        }
        let sid = query.session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let map = self.sessions.read().map_err(|e| MemoryError::LockError(e.to_string()))?;
        let key = (tid.to_string(), sid.to_string());

        let session = match map.get(&key) {
            Some(s) => s,
            None => return Ok(Vec::new()),
        };

        // Filter and collect active, non-expired chunks matching query criteria
        let mut filtered: Vec<MemoryChunk> = session
            .chunks
            .iter()
            .filter(|c| {
                // Strict Scope Isolation
                if c.scope_id != scp {
                    return false;
                }
                // TTL check: filter out expired chunks
                if let Some(exp) = c.expires_at_ms {
                    if now_ms >= exp {
                        return false;
                    }
                }
                // Role filter
                if let Some(roles) = &query.roles {
                    if !roles.contains(&c.role) {
                        return false;
                    }
                }
                // Conversation filter
                if let Some(cid) = &query.conversation_id {
                    if &c.conversation_id != cid {
                        return false;
                    }
                }
                // Time bounds
                if let Some(since) = query.since_ms {
                    if c.created_at_ms < since {
                        return false;
                    }
                }
                if let Some(until) = query.until_ms {
                    if c.created_at_ms > until {
                        return false;
                    }
                }
                // Generation filter
                if let Some(min_gen) = query.min_generation {
                    if c.generation < min_gen {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect();

        // Deterministic sequence ordering (ascending)
        filtered.sort_by_key(|c| c.sequence);

        // Apply offset
        if let Some(offset) = query.offset {
            if offset < filtered.len() {
                filtered = filtered.split_off(offset);
            } else {
                return Ok(Vec::new());
            }
        }

        // Apply count limit (default cap to max_chunks_per_session)
        let effective_limit = query.limit.unwrap_or(self.limits.max_chunks_per_session);
        if query.offset.is_some() {
            // Forward pagination when offset is specified
            filtered.truncate(effective_limit);
        } else if filtered.len() > effective_limit {
            // Sliding window of most recent chunks when no offset is specified
            filtered = filtered.split_off(filtered.len() - effective_limit);
        }

        // Apply token budget backwards (sliding window)
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

        // Apply byte budget backwards
        if let Some(max_bytes) = query.max_bytes {
            let mut budget = max_bytes;
            let mut window = Vec::new();
            for c in filtered.into_iter().rev() {
                if c.byte_size <= budget {
                    budget -= c.byte_size;
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

    /// Updates chunk content with generation fencing (rejects stale updates)
    pub fn update_chunk(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
        chunk_id: &str,
        new_content: &str,
        update_generation: u64,
        now_ms: u64,
    ) -> Result<MemoryChunk, MemoryError> {
        let tid = tenant_id.trim();
        if tid.is_empty() {
            return Err(MemoryError::EmptyTenantId);
        }
        let scp = scope_id.trim();
        if scp.is_empty() {
            return Err(MemoryError::EmptyScopeId);
        }
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let raw_cnt = new_content.trim();
        if raw_cnt.is_empty() {
            return Err(MemoryError::EmptyContent);
        }

        let (sanitized_cnt, _) = redact_sensitive_content(raw_cnt);
        let byte_size = sanitized_cnt.len();

        if byte_size > self.limits.max_chunk_size_bytes {
            return Err(MemoryError::ChunkSizeExceeded {
                size: byte_size,
                max: self.limits.max_chunk_size_bytes,
            });
        }

        let token_count = Self::estimate_tokens(&sanitized_cnt);

        let mut map = self.sessions.write().map_err(|e| MemoryError::LockError(e.to_string()))?;
        let session = map
            .get_mut(&(tid.to_string(), sid.to_string()))
            .ok_or_else(|| MemoryError::ChunkNotFound(chunk_id.to_string()))?;

        // Fencing check: reject stale update (must be strictly greater than current)
        if update_generation <= session.current_generation {
            return Err(MemoryError::StaleGeneration {
                current: session.current_generation,
                attempted: update_generation,
            });
        }

        let chunk_idx = session
            .chunks
            .iter()
            .position(|c| c.chunk_id == chunk_id && c.scope_id == scp)
            .ok_or_else(|| MemoryError::ChunkNotFound(chunk_id.to_string()))?;

        // Capacity check: verify that update does not exceed session byte or token limits
        let cur_bytes: usize = session.chunks.iter().map(|c| c.byte_size).sum();
        let cur_tokens: usize = session.chunks.iter().map(|c| c.token_count).sum();
        let old_byte_size = session.chunks[chunk_idx].byte_size;
        let old_token_count = session.chunks[chunk_idx].token_count;
        let new_bytes = cur_bytes - old_byte_size + byte_size;
        let new_tokens = cur_tokens - old_token_count + token_count;

        if new_bytes > self.limits.max_bytes_per_session || new_tokens > self.limits.max_tokens_per_session {
            return Err(MemoryError::CapacityExceeded {
                max: self.limits.max_bytes_per_session,
                attempted: new_bytes,
            });
        }

        session.current_generation = update_generation;
        let chunk = &mut session.chunks[chunk_idx];
        chunk.generation = update_generation;
        chunk.content = sanitized_cnt;
        chunk.byte_size = byte_size;
        chunk.token_count = token_count;
        chunk.updated_at_ms = Some(now_ms);

        Ok(chunk.clone())
    }

    /// Deletes a chunk with generation check
    pub fn delete_chunk(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
        chunk_id: &str,
        delete_generation: u64,
    ) -> Result<bool, MemoryError> {
        let tid = tenant_id.trim();
        if tid.is_empty() {
            return Err(MemoryError::EmptyTenantId);
        }
        let scp = scope_id.trim();
        if scp.is_empty() {
            return Err(MemoryError::EmptyScopeId);
        }
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let mut map = self.sessions.write().map_err(|e| MemoryError::LockError(e.to_string()))?;
        let session = map
            .get_mut(&(tid.to_string(), sid.to_string()))
            .ok_or_else(|| MemoryError::ChunkNotFound(chunk_id.to_string()))?;

        // Generation check: reject stale delete
        if delete_generation < session.current_generation {
            return Err(MemoryError::StaleGeneration {
                current: session.current_generation,
                attempted: delete_generation,
            });
        }

        let before = session.chunks.len();
        session
            .chunks
            .retain(|c| !(c.chunk_id == chunk_id && c.scope_id == scp));
        let removed = session.chunks.len() < before;

        if removed {
            if delete_generation > session.current_generation {
                session.current_generation = delete_generation;
            }
            Ok(true)
        } else {
            Err(MemoryError::ChunkNotFound(chunk_id.to_string()))
        }
    }

    /// Returns session statistics
    pub fn get_summary(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
        now_ms: u64,
    ) -> Result<MemorySummary, MemoryError> {
        let tid = tenant_id.trim();
        if tid.is_empty() {
            return Err(MemoryError::EmptyTenantId);
        }
        let scp = scope_id.trim();
        if scp.is_empty() {
            return Err(MemoryError::EmptyScopeId);
        }
        let sid = session_id.trim();
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let map = self.sessions.read().map_err(|e| MemoryError::LockError(e.to_string()))?;
        let session = match map.get(&(tid.to_string(), sid.to_string())) {
            Some(s) => s,
            None => {
                return Ok(MemorySummary {
                    tenant_id: tid.to_string(),
                    scope_id: scp.to_string(),
                    session_id: sid.to_string(),
                    total_chunks: 0,
                    total_bytes: 0,
                    total_tokens: 0,
                    current_generation: 0,
                    oldest_timestamp_ms: 0,
                    newest_timestamp_ms: 0,
                });
            }
        };

        let active_chunks: Vec<&MemoryChunk> = session
            .chunks
            .iter()
            .filter(|c| {
                if c.scope_id != scp {
                    return false;
                }
                if let Some(exp) = c.expires_at_ms {
                    if now_ms >= exp {
                        return false;
                    }
                }
                true
            })
            .collect();

        let total_chunks = active_chunks.len();
        let total_bytes: usize = active_chunks.iter().map(|c| c.byte_size).sum();
        let total_tokens: usize = active_chunks.iter().map(|c| c.token_count).sum();
        let oldest = active_chunks.first().map(|c| c.created_at_ms).unwrap_or(0);
        let newest = active_chunks.last().map(|c| c.created_at_ms).unwrap_or(0);

        Ok(MemorySummary {
            tenant_id: tid.to_string(),
            scope_id: scp.to_string(),
            session_id: sid.to_string(),
            total_chunks,
            total_bytes,
            total_tokens,
            current_generation: session.current_generation,
            oldest_timestamp_ms: oldest,
            newest_timestamp_ms: newest,
        })
    }

    /// Resets and clears the session memory for a given tenant, scope, and session
    pub fn clear_session(
        &self,
        tenant_id: &str,
        scope_id: &str,
        session_id: &str,
    ) -> Result<usize, MemoryError> {
        let tid = tenant_id.trim();
        let scp = scope_id.trim();
        let sid = session_id.trim();
        if tid.is_empty() {
            return Err(MemoryError::EmptyTenantId);
        }
        if scp.is_empty() {
            return Err(MemoryError::EmptyScopeId);
        }
        if sid.is_empty() {
            return Err(MemoryError::EmptySessionId);
        }

        let mut map = self.sessions.write().map_err(|e| MemoryError::LockError(e.to_string()))?;
        let key = (tid.to_string(), sid.to_string());
        if let Some(session) = map.get_mut(&key) {
            let before = session.chunks.len();
            session.chunks.retain(|c| c.scope_id != scp);
            let removed = before - session.chunks.len();
            if session.chunks.is_empty() {
                session.sequence_counter = 0;
            }
            Ok(removed)
        } else {
            Ok(0)
        }
    }

    /// Hard reset of all sessions (reinitialization / restart recovery)
    pub fn reset(&self) {
        if let Ok(mut map) = self.sessions.write() {
            map.clear();
        }
    }

    /// Handles port invocation payloads for `port.agent.memory.store.v1` and `port.agent.memory.retrieve.v1`
    pub fn handle_port_invocation(
        &self,
        port_id: &str,
        payload: &serde_json::Value,
        principal: &str,
        tenant: &str,
        scope: &str,
        correlation_id: &str,
        deadline_ms: u64,
        now_ms: u64,
    ) -> Result<serde_json::Value, MemoryError> {
        // Cross-host envelope check
        let _envelope = self.validate_envelope_call(
            tenant,
            scope,
            principal,
            port_id,
            correlation_id,
            deadline_ms,
            now_ms,
        )?;

        match port_id {
            "port.agent.memory.store.v1" => {
                let session_id = payload
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .ok_or(MemoryError::EmptySessionId)?;

                let content = payload
                    .get("content")
                    .and_then(|v| v.as_str())
                    .ok_or(MemoryError::EmptyContent)?;

                let role_str = payload
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or("user");

                let role = match role_str.to_lowercase().as_str() {
                    "system" => MemoryRole::System,
                    "assistant" => MemoryRole::Assistant,
                    "tool" => MemoryRole::Tool,
                    _ => MemoryRole::User,
                };

                let conversation_id = payload
                    .get("conversation_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                let generation = payload.get("generation").and_then(|v| v.as_u64());
                let ttl_ms = payload.get("ttl_ms").and_then(|v| v.as_u64());

                let store_payload = MemoryStorePayload {
                    tenant_id: tenant.to_string(),
                    scope_id: scope.to_string(),
                    session_id: session_id.to_string(),
                    conversation_id,
                    role,
                    content: content.to_string(),
                    generation,
                    ttl_ms,
                    metadata: None,
                    timestamp_ms: Some(now_ms),
                };

                let result = self.store_chunk(store_payload, now_ms)?;
                Ok(serde_json::to_value(&result).map_err(|e| MemoryError::InvalidQuery(e.to_string()))?)
            }
            "port.agent.memory.retrieve.v1" => {
                let session_id = payload
                    .get("session_id")
                    .and_then(|v| v.as_str())
                    .ok_or(MemoryError::EmptySessionId)?;

                let limit = payload.get("limit").and_then(|v| v.as_u64()).map(|v| v as usize);
                let max_tokens = payload.get("max_tokens").and_then(|v| v.as_u64()).map(|v| v as usize);
                let max_bytes = payload.get("max_bytes").and_then(|v| v.as_u64()).map(|v| v as usize);

                let query = MemoryQuery {
                    tenant_id: tenant.to_string(),
                    scope_id: scope.to_string(),
                    session_id: session_id.to_string(),
                    conversation_id: None,
                    roles: None,
                    since_ms: None,
                    until_ms: None,
                    limit,
                    max_tokens,
                    max_bytes,
                    offset: None,
                    min_generation: None,
                };

                let chunks = self.retrieve(&query, now_ms)?;
                Ok(serde_json::json!({
                    "session_id": session_id,
                    "count": chunks.len(),
                    "chunks": chunks
                }))
            }
            other => Err(MemoryError::InvalidQuery(format!("Unknown port: {other}"))),
        }
    }
}
