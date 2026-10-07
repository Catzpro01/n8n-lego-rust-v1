//! L10.S06 — Security/performance certification
//!
//! Provides the security audit scanner and performance benchmark evaluator:
//! tracks benchmark audit traces, latency percentiles (p50, p95, p99),
//! memory thresholds, vulnerability findings, and fail-closed compliance gates.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum VulnerabilitySeverity {
    Low,
    Medium,
    High,
    Critical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityFinding {
    pub cve_id: String,
    pub title: String,
    pub severity: VulnerabilitySeverity,
    pub component: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchmarkMetrics {
    pub p50_latency_ms: f64,
    pub p95_latency_ms: f64,
    pub p99_latency_ms: f64,
    pub throughput_rps: f64,
    pub max_rss_mb: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SecurityPerfAuditRecord {
    pub audit_id: String,
    pub release_version: String,
    pub benchmark: BenchmarkMetrics,
    pub security_findings: Vec<SecurityFinding>,
    pub passed: bool,
    pub audited_at_ms: u64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum SecurityPerfError {
    #[error("Empty audit ID or release version")]
    EmptyIdentifier,
    #[error("Critical security vulnerability detected: {0}")]
    CriticalVulnerability(String),
    #[error("Latency threshold exceeded: p99 {current:.2}ms > max {threshold:.2}ms")]
    LatencyExceeded { current: f64, threshold: f64 },
}

pub struct SecurityPerfCertificationService {
    audits: Arc<RwLock<HashMap<String, SecurityPerfAuditRecord>>>,
    max_allowed_p99_ms: f64,
}

impl Default for SecurityPerfCertificationService {
    fn default() -> Self {
        Self::new(50.0)
    }
}

impl SecurityPerfCertificationService {
    pub fn new(max_allowed_p99_ms: f64) -> Self {
        Self {
            audits: Arc::new(RwLock::new(HashMap::new())),
            max_allowed_p99_ms,
        }
    }

    /// Evaluates security findings and benchmark metrics
    pub fn evaluate_audit(
        &self,
        audit_id: &str,
        release_version: &str,
        benchmark: BenchmarkMetrics,
        security_findings: Vec<SecurityFinding>,
        now_ms: u64,
    ) -> Result<SecurityPerfAuditRecord, SecurityPerfError> {
        let aid = audit_id.trim();
        let ver = release_version.trim();
        if aid.is_empty() || ver.is_empty() {
            return Err(SecurityPerfError::EmptyIdentifier);
        }

        // 1. Check for Critical security vulnerabilities
        let crit_msg = security_findings
            .iter()
            .find(|f| f.severity == VulnerabilitySeverity::Critical)
            .map(|f| format!("{}: {}", f.cve_id, f.title));

        if let Some(msg) = crit_msg {
            let record = SecurityPerfAuditRecord {
                audit_id: aid.to_string(),
                release_version: ver.to_string(),
                benchmark,
                security_findings,
                passed: false,
                audited_at_ms: now_ms,
            };
            let mut map = self.audits.write().unwrap();
            map.insert(aid.to_string(), record);
            return Err(SecurityPerfError::CriticalVulnerability(msg));
        }

        // 2. Check p99 latency threshold
        if benchmark.p99_latency_ms > self.max_allowed_p99_ms {
            let record = SecurityPerfAuditRecord {
                audit_id: aid.to_string(),
                release_version: ver.to_string(),
                benchmark: benchmark.clone(),
                security_findings,
                passed: false,
                audited_at_ms: now_ms,
            };
            let mut map = self.audits.write().unwrap();
            map.insert(aid.to_string(), record);
            return Err(SecurityPerfError::LatencyExceeded {
                current: benchmark.p99_latency_ms,
                threshold: self.max_allowed_p99_ms,
            });
        }

        let record = SecurityPerfAuditRecord {
            audit_id: aid.to_string(),
            release_version: ver.to_string(),
            benchmark,
            security_findings,
            passed: true,
            audited_at_ms: now_ms,
        };

        let mut map = self.audits.write().unwrap();
        map.insert(aid.to_string(), record.clone());
        Ok(record)
    }

    /// Retrieves an audit record by ID
    pub fn get_audit(&self, audit_id: &str) -> Option<SecurityPerfAuditRecord> {
        let map = self.audits.read().unwrap();
        map.get(audit_id.trim()).cloned()
    }
}

#[cfg(test)]
#[path = "../tests/security_perf_test.rs"]
mod tests;
