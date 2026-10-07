//! L10.S03 — Runtime/node compatibility matrix
//!
//! Evaluates compatibility matrix rules between workflow node definitions,
//! core runtime versions, schema revisions, and engine capabilities.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CompatibilityVerdict {
    FullyCompatible,
    CompatibleWithDeprecations,
    IncompatibleBreakingChanges,
    UnknownNodeOrVersion,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodeCompatRule {
    pub node_type: String,
    pub min_runtime_version: String,
    pub max_runtime_version: Option<String>,
    pub supported_versions: Vec<u32>,
    pub breaking_changes_notes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatEvaluationRequest {
    pub node_type: String,
    pub node_version: u32,
    pub target_runtime_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompatEvaluationResult {
    pub node_type: String,
    pub verdict: CompatibilityVerdict,
    pub details: String,
    pub recommended_action: Option<String>,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CompatMatrixError {
    #[error("Empty node type or runtime version")]
    EmptyIdentifier,
    #[error("Rule not found for node type: {0}")]
    RuleNotFound(String),
}

pub struct NodeCompatMatrixService {
    rules: Arc<RwLock<HashMap<String, NodeCompatRule>>>,
}

impl Default for NodeCompatMatrixService {
    fn default() -> Self {
        Self::new()
    }
}

impl NodeCompatMatrixService {
    pub fn new() -> Self {
        Self {
            rules: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Registers a compatibility rule for a node type
    pub fn register_rule(&self, rule: NodeCompatRule) -> Result<(), CompatMatrixError> {
        let nt = rule.node_type.trim();
        if nt.is_empty() || rule.min_runtime_version.trim().is_empty() {
            return Err(CompatMatrixError::EmptyIdentifier);
        }

        let mut map = self.rules.write().unwrap();
        map.insert(nt.to_string(), rule);
        Ok(())
    }

    fn parse_version_tuple(ver: &str) -> Vec<u64> {
        ver.trim()
            .trim_start_matches('v')
            .split('.')
            .filter_map(|part| {
                let num_str: String = part.chars().take_while(|c| c.is_ascii_digit()).collect();
                num_str.parse::<u64>().ok()
            })
            .collect()
    }

    fn compare_versions(a: &str, b: &str) -> std::cmp::Ordering {
        let t_a = Self::parse_version_tuple(a);
        let t_b = Self::parse_version_tuple(b);
        t_a.cmp(&t_b)
    }

    /// Evaluates compatibility of a node against target runtime
    pub fn evaluate_compatibility(
        &self,
        request: &CompatEvaluationRequest,
    ) -> Result<CompatEvaluationResult, CompatMatrixError> {
        let nt = request.node_type.trim();
        let target_ver = request.target_runtime_version.trim();
        if nt.is_empty() || target_ver.is_empty() {
            return Err(CompatMatrixError::EmptyIdentifier);
        }

        let map = self.rules.read().unwrap();
        let rule = map.get(nt).ok_or_else(|| CompatMatrixError::RuleNotFound(nt.to_string()))?;

        if !rule.supported_versions.contains(&request.node_version) {
            return Ok(CompatEvaluationResult {
                node_type: nt.to_string(),
                verdict: CompatibilityVerdict::IncompatibleBreakingChanges,
                details: format!(
                    "Node version {} not in supported versions {:?}",
                    request.node_version, rule.supported_versions
                ),
                recommended_action: Some("Upgrade node configuration or use adapter".to_string()),
            });
        }

        if Self::compare_versions(target_ver, &rule.min_runtime_version) == std::cmp::Ordering::Less {
            return Ok(CompatEvaluationResult {
                node_type: nt.to_string(),
                verdict: CompatibilityVerdict::IncompatibleBreakingChanges,
                details: format!(
                    "Runtime version {} is below minimum required {}",
                    target_ver, rule.min_runtime_version
                ),
                recommended_action: Some("Upgrade runtime engine to match node requirement".to_string()),
            });
        }

        if let Some(max_ver) = &rule.max_runtime_version {
            if Self::compare_versions(target_ver, max_ver) == std::cmp::Ordering::Greater {
                return Ok(CompatEvaluationResult {
                    node_type: nt.to_string(),
                    verdict: CompatibilityVerdict::CompatibleWithDeprecations,
                    details: format!(
                        "Runtime version {} exceeds deprecated boundary {}",
                        target_ver, max_ver
                    ),
                    recommended_action: Some("Prepare node migration for future engine releases".to_string()),
                });
            }
        }

        Ok(CompatEvaluationResult {
            node_type: nt.to_string(),
            verdict: CompatibilityVerdict::FullyCompatible,
            details: "Node fully compatible with target runtime version".to_string(),
            recommended_action: None,
        })
    }
}

#[cfg(test)]
#[path = "../tests/compat_matrix_test.rs"]
mod tests;
