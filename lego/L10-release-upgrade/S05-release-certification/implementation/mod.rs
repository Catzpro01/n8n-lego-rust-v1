//! L10.S05 — Release certification
//!
//! Executes multi-gate quality suites for candidate releases:
//! evaluates unit tests, port contracts, DAG compliance, and produces
//! structured certification test results without self-awarding production certification.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GateStatus {
    Passed,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QualityGateResult {
    pub gate_name: String,
    pub status: GateStatus,
    pub duration_ms: u64,
    pub details: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReleaseCertificationReport {
    pub candidate_version: String,
    pub total_gates: usize,
    pub passed_gates: usize,
    pub failed_gates: usize,
    pub all_passed: bool,
    pub gate_results: Vec<QualityGateResult>,
    pub evaluated_at_ms: u64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CertificationError {
    #[error("Empty release candidate version")]
    EmptyVersion,
    #[error("Quality gate evaluation failed: {0}")]
    GateFailed(String),
}

pub struct ReleaseCertificationService {
    reports: Arc<RwLock<HashMap<String, ReleaseCertificationReport>>>,
}

impl Default for ReleaseCertificationService {
    fn default() -> Self {
        Self::new()
    }
}

impl ReleaseCertificationService {
    pub fn new() -> Self {
        Self {
            reports: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Evaluates release candidate quality gates
    pub fn evaluate_gates(
        &self,
        candidate_version: &str,
        gates: Vec<QualityGateResult>,
        now_ms: u64,
    ) -> Result<ReleaseCertificationReport, CertificationError> {
        let ver = candidate_version.trim();
        if ver.is_empty() {
            return Err(CertificationError::EmptyVersion);
        }

        let total_gates = gates.len();
        let passed_gates = gates.iter().filter(|g| g.status == GateStatus::Passed).count();
        let failed_gates = gates.iter().filter(|g| g.status == GateStatus::Failed).count();
        let all_passed = total_gates > 0 && failed_gates == 0;

        let report = ReleaseCertificationReport {
            candidate_version: ver.to_string(),
            total_gates,
            passed_gates,
            failed_gates,
            all_passed,
            gate_results: gates,
            evaluated_at_ms: now_ms,
        };

        let mut map = self.reports.write().unwrap();
        map.insert(ver.to_string(), report.clone());

        if !all_passed {
            Err(CertificationError::GateFailed(format!(
                "{} of {} gates failed for release {}",
                failed_gates, total_gates, ver
            )))
        } else {
            Ok(report)
        }
    }

    /// Retrieves a previous certification report
    pub fn get_report(&self, version: &str) -> Option<ReleaseCertificationReport> {
        let map = self.reports.read().unwrap();
        map.get(version.trim()).cloned()
    }
}

#[cfg(test)]
#[path = "../tests/certification_test.rs"]
mod tests;
