//! Implementation of L01.S06 Compatibility Oracle
//!
//! Sub-LEGO Identity: L01.S06
//! Authoritative State Domain: `golden-differential-corpus`
//! Runtime Host: H07 (Compatibility Host)
//! Execution Model: tooling
//! Invariants:
//! - Golden differential verification: validates n8n node/workflow executions against authoritative reference fixtures.
//! - Strict mismatch detection: pinpoints structural diffs, missing/extra fields, type mismatches, and numerical deviations.
//! - Configurable tolerance policies: supports field exclusions (e.g. timestamps, IDs), floating-point epsilon, and array ordering relaxations.
//! - Authoritative state tracking: records fixture corpus and verification receipts in `golden-differential-corpus`.
//! - Fail-closed verification: reports exact mismatch diagnostics rather than silently swallowing incompatibilities.
//! - 0 private cross-Sub-LEGO imports: isolated boundary.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

/// Kinds of differential mismatches detected during verification
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MismatchKind {
    MissingField,
    ExtraField,
    TypeMismatch,
    ValueMismatch,
    ArrayLengthMismatch,
}

impl fmt::Display for MismatchKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::MissingField => write!(f, "Missing field in actual output"),
            Self::ExtraField => write!(f, "Unexpected extra field in actual output"),
            Self::TypeMismatch => write!(f, "Type mismatch between expected and actual"),
            Self::ValueMismatch => write!(f, "Value deviation between expected and actual"),
            Self::ArrayLengthMismatch => write!(f, "Array length deviation"),
        }
    }
}

/// Detailed description of a differential mismatch
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct MismatchDetail {
    pub path: String,
    pub kind: MismatchKind,
    pub expected: serde_json::Value,
    pub actual: serde_json::Value,
    pub message: String,
}

/// Configurable tolerance policy for comparisons
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ToleranceRules {
    #[serde(default)]
    pub ignore_fields: Vec<String>,
    #[serde(default)]
    pub numeric_epsilon: Option<f64>,
    #[serde(default)]
    pub ignore_array_order: bool,
}

/// Stored golden fixture in the `golden-differential-corpus` state domain
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct GoldenFixture {
    pub corpus_id: String,
    pub target_node_or_workflow: String,
    pub expected_output: serde_json::Value,
    pub tolerance_rules: ToleranceRules,
    pub description: String,
    pub created_at_ms: u64,
}

/// Structured report summarizing the differential verification
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DifferentialReport {
    pub corpus_id: String,
    pub is_match: bool,
    pub mismatch_count: usize,
    pub mismatches: Vec<MismatchDetail>,
    pub verified_at_ms: u64,
}

/// Errors occurring during oracle operations
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum OracleError {
    FixtureNotFound(String),
    LockPoisoned,
    InvalidPayload(String),
}

impl fmt::Display for OracleError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::FixtureNotFound(id) => write!(f, "Golden fixture '{id}' not found in corpus"),
            Self::LockPoisoned => write!(f, "Golden differential corpus state lock poisoned"),
            Self::InvalidPayload(s) => write!(f, "Invalid oracle payload: {s}"),
        }
    }
}

impl std::error::Error for OracleError {}

/// Oracle Engine managing golden differential verification (State Domain: `golden-differential-corpus`)
#[derive(Debug, Clone, Default)]
pub struct CompatibilityOracleEngine {
    corpus: Arc<RwLock<HashMap<String, GoldenFixture>>>,
}

impl CompatibilityOracleEngine {
    pub fn new() -> Self {
        Self {
            corpus: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Registers a golden reference fixture into the corpus
    pub fn register_fixture(&self, fixture: GoldenFixture) -> Result<(), OracleError> {
        let mut lock = self.corpus.write().map_err(|_| OracleError::LockPoisoned)?;
        lock.insert(fixture.corpus_id.clone(), fixture);
        Ok(())
    }

    /// Retrieves a golden fixture by ID
    pub fn get_fixture(&self, corpus_id: &str) -> Option<GoldenFixture> {
        let lock = self.corpus.read().ok()?;
        lock.get(corpus_id).cloned()
    }

    /// Lists all registered fixture corpus IDs
    pub fn list_fixtures(&self) -> Vec<String> {
        let lock = match self.corpus.read() {
            Ok(l) => l,
            Err(_) => return Vec::new(),
        };
        let mut keys: Vec<String> = lock.keys().cloned().collect();
        keys.sort();
        keys
    }

    /// Verifies actual output against a registered golden corpus fixture
    pub fn verify_differential(
        &self,
        corpus_id: &str,
        actual_output: &serde_json::Value,
    ) -> Result<DifferentialReport, OracleError> {
        let fixture = self
            .get_fixture(corpus_id)
            .ok_or_else(|| OracleError::FixtureNotFound(corpus_id.to_string()))?;

        Ok(Self::compare_values(
            corpus_id,
            &fixture.expected_output,
            actual_output,
            &fixture.tolerance_rules,
        ))
    }

    /// Verifies actual output directly against inline expected value
    pub fn verify_inline(
        corpus_id: &str,
        expected_output: &serde_json::Value,
        actual_output: &serde_json::Value,
        tolerance_rules: &ToleranceRules,
    ) -> DifferentialReport {
        Self::compare_values(corpus_id, expected_output, actual_output, tolerance_rules)
    }

    /// Deep recursive comparator with tolerance application
    fn compare_values(
        corpus_id: &str,
        expected: &serde_json::Value,
        actual: &serde_json::Value,
        tolerance: &ToleranceRules,
    ) -> DifferentialReport {
        let mut mismatches = Vec::new();
        let ignore_set: HashSet<&str> = tolerance.ignore_fields.iter().map(|s| s.as_str()).collect();

        Self::recursive_compare("$", expected, actual, tolerance, &ignore_set, &mut mismatches);

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        DifferentialReport {
            corpus_id: corpus_id.to_string(),
            is_match: mismatches.is_empty(),
            mismatch_count: mismatches.len(),
            mismatches,
            verified_at_ms: now,
        }
    }

    fn recursive_compare(
        path: &str,
        expected: &serde_json::Value,
        actual: &serde_json::Value,
        tolerance: &ToleranceRules,
        ignore_set: &HashSet<&str>,
        mismatches: &mut Vec<MismatchDetail>,
    ) {
        use serde_json::Value;

        // Check ignore by full path or terminal key
        let terminal_key = path.rsplit('.').next().unwrap_or(path);
        if ignore_set.contains(path) || ignore_set.contains(terminal_key) {
            return;
        }

        match (expected, actual) {
            (Value::Null, Value::Null) => {}
            (Value::Bool(b1), Value::Bool(b2)) => {
                if b1 != b2 {
                    mismatches.push(MismatchDetail {
                        path: path.to_string(),
                        kind: MismatchKind::ValueMismatch,
                        expected: expected.clone(),
                        actual: actual.clone(),
                        message: format!("Boolean mismatch at {path}: expected {b1}, got {b2}"),
                    });
                }
            }
            (Value::Number(n1), Value::Number(n2)) => {
                let match_num = if let Some(eps) = tolerance.numeric_epsilon {
                    match (n1.as_f64(), n2.as_f64()) {
                        (Some(f1), Some(f2)) => (f1 - f2).abs() <= eps,
                        _ => n1 == n2,
                    }
                } else if let (Some(i1), Some(i2)) = (n1.as_i64(), n2.as_i64()) {
                    i1 == i2
                } else if let (Some(u1), Some(u2)) = (n1.as_u64(), n2.as_u64()) {
                    u1 == u2
                } else {
                    match (n1.as_f64(), n2.as_f64()) {
                        (Some(f1), Some(f2)) => f1 == f2,
                        _ => n1 == n2,
                    }
                };

                if !match_num {
                    mismatches.push(MismatchDetail {
                        path: path.to_string(),
                        kind: MismatchKind::ValueMismatch,
                        expected: expected.clone(),
                        actual: actual.clone(),
                        message: format!("Numeric deviation at {path}: expected {n1}, got {n2}"),
                    });
                }
            }
            (Value::String(s1), Value::String(s2)) => {
                if s1 != s2 {
                    mismatches.push(MismatchDetail {
                        path: path.to_string(),
                        kind: MismatchKind::ValueMismatch,
                        expected: expected.clone(),
                        actual: actual.clone(),
                        message: format!("String mismatch at {path}: expected '{s1}', got '{s2}'"),
                    });
                }
            }
            (Value::Array(a1), Value::Array(a2)) => {
                if a1.len() != a2.len() {
                    mismatches.push(MismatchDetail {
                        path: path.to_string(),
                        kind: MismatchKind::ArrayLengthMismatch,
                        expected: Value::from(a1.len()),
                        actual: Value::from(a2.len()),
                        message: format!(
                            "Array length mismatch at {path}: expected {} items, got {}",
                            a1.len(),
                            a2.len()
                        ),
                    });
                }

                if tolerance.ignore_array_order {
                    // Check multiset equivalence for simple elements or best-effort
                    let mut matched_indices = HashSet::new();
                    for (i, item1) in a1.iter().enumerate() {
                        let mut found = false;
                        for (j, item2) in a2.iter().enumerate() {
                            if !matched_indices.contains(&j) {
                                let mut sub_mismatches = Vec::new();
                                Self::recursive_compare(
                                    &format!("{path}[{i}]"),
                                    item1,
                                    item2,
                                    tolerance,
                                    ignore_set,
                                    &mut sub_mismatches,
                                );
                                if sub_mismatches.is_empty() {
                                    matched_indices.insert(j);
                                    found = true;
                                    break;
                                }
                            }
                        }
                        if !found {
                            mismatches.push(MismatchDetail {
                                path: format!("{path}[{i}]"),
                                kind: MismatchKind::ValueMismatch,
                                expected: item1.clone(),
                                actual: Value::Null,
                                message: format!("Element at {path}[{i}] not found in actual array"),
                            });
                        }
                    }
                } else {
                    let min_len = a1.len().min(a2.len());
                    for i in 0..min_len {
                        Self::recursive_compare(
                            &format!("{path}[{i}]"),
                            &a1[i],
                            &a2[i],
                            tolerance,
                            ignore_set,
                            mismatches,
                        );
                    }
                }
            }
            (Value::Object(o1), Value::Object(o2)) => {
                // Check missing fields in actual
                for (k, v1) in o1 {
                    let sub_path = if path == "$" { format!("$.{k}") } else { format!("{path}.{k}") };
                    if ignore_set.contains(sub_path.as_str()) || ignore_set.contains(k.as_str()) {
                        continue;
                    }

                    match o2.get(k) {
                        Some(v2) => {
                            Self::recursive_compare(&sub_path, v1, v2, tolerance, ignore_set, mismatches);
                        }
                        None => {
                            mismatches.push(MismatchDetail {
                                path: sub_path,
                                kind: MismatchKind::MissingField,
                                expected: v1.clone(),
                                actual: Value::Null,
                                message: format!("Field '{k}' missing from actual output"),
                            });
                        }
                    }
                }

                // Check unexpected extra fields in actual
                for (k, v2) in o2 {
                    let sub_path = if path == "$" { format!("$.{k}") } else { format!("{path}.{k}") };
                    if ignore_set.contains(sub_path.as_str()) || ignore_set.contains(k.as_str()) {
                        continue;
                    }

                    if !o1.contains_key(k) {
                        mismatches.push(MismatchDetail {
                            path: sub_path,
                            kind: MismatchKind::ExtraField,
                            expected: Value::Null,
                            actual: v2.clone(),
                            message: format!("Unexpected field '{k}' found in actual output"),
                        });
                    }
                }
            }
            _ => {
                // Type mismatch
                mismatches.push(MismatchDetail {
                    path: path.to_string(),
                    kind: MismatchKind::TypeMismatch,
                    expected: expected.clone(),
                    actual: actual.clone(),
                    message: format!(
                        "Type mismatch at {path}: expected {}, got {}",
                        value_type_name(expected),
                        value_type_name(actual)
                    ),
                });
            }
        }
    }

    /// Dispatcher for port `port.execution.oracle.verify.v1`
    pub fn handle_port_oracle_verify(
        &self,
        payload: &serde_json::Value,
    ) -> Result<serde_json::Value, String> {
        let action = payload
            .get("action")
            .and_then(|v| v.as_str())
            .unwrap_or("verify");

        match action {
            "register" => {
                let corpus_id = payload
                    .get("corpus_id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Missing required 'corpus_id'".to_string())?;

                let target = payload
                    .get("target")
                    .and_then(|v| v.as_str())
                    .unwrap_or("default_target");

                let expected = payload
                    .get("expected_output")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null);

                let desc = payload
                    .get("description")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Golden reference fixture");

                let mut tolerance = ToleranceRules::default();
                if let Some(tol_obj) = payload.get("tolerance") {
                    if let Some(arr) = tol_obj.get("ignore_fields").and_then(|v| v.as_array()) {
                        tolerance.ignore_fields = arr
                            .iter()
                            .filter_map(|x| x.as_str().map(|s| s.to_string()))
                            .collect();
                    }
                    if let Some(eps) = tol_obj.get("numeric_epsilon").and_then(|v| v.as_f64()) {
                        tolerance.numeric_epsilon = Some(eps);
                    }
                    if let Some(ord) = tol_obj.get("ignore_array_order").and_then(|v| v.as_bool()) {
                        tolerance.ignore_array_order = ord;
                    }
                }

                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;

                let fixture = GoldenFixture {
                    corpus_id: corpus_id.to_string(),
                    target_node_or_workflow: target.to_string(),
                    expected_output: expected,
                    tolerance_rules: tolerance,
                    description: desc.to_string(),
                    created_at_ms: now,
                };

                self.register_fixture(fixture).map_err(|e| e.to_string())?;

                Ok(serde_json::json!({
                    "corpus_id": corpus_id,
                    "status": "registered"
                }))
            }
            "verify" => {
                let actual = payload
                    .get("actual_output")
                    .ok_or_else(|| "Missing required 'actual_output'".to_string())?;

                let report = if let Some(corpus_id) = payload.get("corpus_id").and_then(|v| v.as_str()) {
                    if let Some(fixture) = self.get_fixture(corpus_id) {
                        Self::compare_values(corpus_id, &fixture.expected_output, actual, &fixture.tolerance_rules)
                    } else if let Some(inline_expected) = payload.get("expected_output") {
                        let mut tolerance = ToleranceRules::default();
                        if let Some(tol_obj) = payload.get("tolerance") {
                            if let Some(arr) = tol_obj.get("ignore_fields").and_then(|v| v.as_array()) {
                                tolerance.ignore_fields = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                            }
                            if let Some(eps) = tol_obj.get("numeric_epsilon").and_then(|v| v.as_f64()) {
                                tolerance.numeric_epsilon = Some(eps);
                            }
                            if let Some(ord) = tol_obj.get("ignore_array_order").and_then(|v| v.as_bool()) {
                                tolerance.ignore_array_order = ord;
                            }
                        }
                        Self::compare_values(corpus_id, inline_expected, actual, &tolerance)
                    } else {
                        return Err(format!("Corpus fixture '{corpus_id}' not found"));
                    }
                } else if let Some(inline_expected) = payload.get("expected_output") {
                    let mut tolerance = ToleranceRules::default();
                    if let Some(tol_obj) = payload.get("tolerance") {
                        if let Some(arr) = tol_obj.get("ignore_fields").and_then(|v| v.as_array()) {
                            tolerance.ignore_fields = arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect();
                        }
                        if let Some(eps) = tol_obj.get("numeric_epsilon").and_then(|v| v.as_f64()) {
                            tolerance.numeric_epsilon = Some(eps);
                        }
                        if let Some(ord) = tol_obj.get("ignore_array_order").and_then(|v| v.as_bool()) {
                            tolerance.ignore_array_order = ord;
                        }
                    }
                    Self::compare_values("inline_verification", inline_expected, actual, &tolerance)
                } else {
                    return Err("Missing 'corpus_id' or 'expected_output'".to_string());
                };

                serde_json::to_value(report).map_err(|e| format!("Serialization error: {e}"))
            }
            "list" => {
                let fixtures = self.list_fixtures();
                Ok(serde_json::json!({ "fixtures": fixtures }))
            }
            other => Err(format!("Unsupported action '{other}'")),
        }
    }
}

fn value_type_name(val: &serde_json::Value) -> &'static str {
    match val {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "boolean",
        serde_json::Value::Number(_) => "number",
        serde_json::Value::String(_) => "string",
        serde_json::Value::Array(_) => "array",
        serde_json::Value::Object(_) => "object",
    }
}

#[cfg(test)]
#[path = "../tests/compatibility_oracle_test.rs"]
mod tests;
