//! L08.S09 — Usage accounting and audit
//!
//! Provides the immutable token audit ledger, usage recording, and cost accounting aggregation
//! for agent runtime operations.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenAuditRecord {
    pub audit_id: String,
    pub session_id: String,
    pub tenant_id: String,
    pub user_id: String,
    pub model: String,
    pub prompt_tokens: u64,
    pub completion_tokens: u64,
    pub total_tokens: u64,
    pub cost_usd: f64,
    pub latency_ms: u64,
    pub tool_calls_count: usize,
    pub timestamp_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageAuditQuery {
    pub tenant_id: Option<String>,
    pub user_id: Option<String>,
    pub session_id: Option<String>,
    pub from_timestamp_ms: Option<u64>,
    pub to_timestamp_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UsageAuditSummary {
    pub record_count: usize,
    pub total_prompt_tokens: u64,
    pub total_completion_tokens: u64,
    pub total_tokens: u64,
    pub total_cost_usd: f64,
    pub total_tool_calls: usize,
    pub average_latency_ms: f64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum UsageAuditError {
    #[error("Empty audit ID or session ID")]
    EmptyIdentifier,
    #[error("Invalid token count: prompt={prompt}, completion={completion}")]
    InvalidTokenCount { prompt: u64, completion: u64 },
    #[error("Invalid cost value: ${0}")]
    InvalidCost(f64),
    #[error("Record not found: {0}")]
    RecordNotFound(String),
}

pub struct UsageAccountingAuditService {
    // Append-only ledger of audit records
    records: Arc<RwLock<Vec<TokenAuditRecord>>>,
}

impl Default for UsageAccountingAuditService {
    fn default() -> Self {
        Self::new()
    }
}

impl UsageAccountingAuditService {
    pub fn new() -> Self {
        Self {
            records: Arc::new(RwLock::new(Vec::new())),
        }
    }

    /// Records an immutable token usage audit event
    pub fn record_usage(
        &self,
        record: TokenAuditRecord,
    ) -> Result<TokenAuditRecord, UsageAuditError> {
        let aid = record.audit_id.trim();
        let sid = record.session_id.trim();
        let tid = record.tenant_id.trim();
        if aid.is_empty() || sid.is_empty() || tid.is_empty() {
            return Err(UsageAuditError::EmptyIdentifier);
        }

        if record.prompt_tokens == 0 && record.completion_tokens == 0 {
            return Err(UsageAuditError::InvalidTokenCount {
                prompt: record.prompt_tokens,
                completion: record.completion_tokens,
            });
        }

        if record.cost_usd < 0.0 || record.cost_usd.is_nan() {
            return Err(UsageAuditError::InvalidCost(record.cost_usd));
        }

        let mut sanitized = record;
        sanitized.total_tokens = sanitized.prompt_tokens + sanitized.completion_tokens;

        let mut ledger = self.records.write().unwrap();
        ledger.push(sanitized.clone());

        Ok(sanitized)
    }

    /// Queries audit records matching filter criteria
    pub fn query_records(
        &self,
        query: &UsageAuditQuery,
    ) -> Vec<TokenAuditRecord> {
        let ledger = self.records.read().unwrap();
        ledger
            .iter()
            .filter(|r| {
                if let Some(tid) = &query.tenant_id {
                    if &r.tenant_id != tid {
                        return false;
                    }
                }
                if let Some(uid) = &query.user_id {
                    if &r.user_id != uid {
                        return false;
                    }
                }
                if let Some(sid) = &query.session_id {
                    if &r.session_id != sid {
                        return false;
                    }
                }
                if let Some(from) = query.from_timestamp_ms {
                    if r.timestamp_ms < from {
                        return false;
                    }
                }
                if let Some(to) = query.to_timestamp_ms {
                    if r.timestamp_ms > to {
                        return false;
                    }
                }
                true
            })
            .cloned()
            .collect()
    }

    /// Summarizes token usage and costs across queried records
    pub fn summarize_usage(
        &self,
        query: &UsageAuditQuery,
    ) -> UsageAuditSummary {
        let matches = self.query_records(query);
        let count = matches.len();

        let mut total_prompt = 0;
        let mut total_completion = 0;
        let mut total_cost = 0.0;
        let mut total_tools = 0;
        let mut total_latency = 0;

        for r in &matches {
            total_prompt += r.prompt_tokens;
            total_completion += r.completion_tokens;
            total_cost += r.cost_usd;
            total_tools += r.tool_calls_count;
            total_latency += r.latency_ms;
        }

        let avg_latency = if count > 0 {
            total_latency as f64 / count as f64
        } else {
            0.0
        };

        UsageAuditSummary {
            record_count: count,
            total_prompt_tokens: total_prompt,
            total_completion_tokens: total_completion,
            total_tokens: total_prompt + total_completion,
            total_cost_usd: total_cost,
            total_tool_calls: total_tools,
            average_latency_ms: avg_latency,
        }
    }
}

#[cfg(test)]
#[path = "../tests/usage_accounting_test.rs"]
mod tests;
