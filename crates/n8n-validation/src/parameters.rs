//! Required-parameter integrity validation (task `validation/m8-04-parameter-integrity`).
//!
//! Runs **before execution starts**: for every workflow node, each parameter declared
//! *required* for the node's type must resolve to a real, non-empty value inside the
//! node's parameter bag (`INode.parameters`, carried as a [`serde_json::Value`]).
//! Violations surface as descriptive errors identifying the node, its type, and the
//! offending parameter.
//!
//! Design notes (L1 scope, matching the crate's conventions):
//!
//! - **Decoupled specs.** n8n-validation must not depend on node-type metadata crates
//!   (`n8n-workflow` already depends on n8n-validation — depending back would create a
//!   cycle). Callers therefore pass a [`ParameterSpecSet`] (node type → required
//!   parameters) harvested from whatever node registry is in front of them, plus a
//!   minimal borrowed [`NodeParameterView`] per node. Node types without a spec entry
//!   are skipped — never guessed (documented L1 leniency, mirroring `connections.rs`).
//! - **"Missing or empty" is pinned.** A parameter fails when its path does not
//!   resolve, or resolves to `null`, an empty string, an empty array, or an empty
//!   object. `false` and `0` are legitimate explicit values and always count as
//!   present (see [`parameter_is_missing`]).
//! - **Paths.** Dot-separated segments (`"options.auth.user"`); a numeric segment
//!   indexes into arrays (`"assignments.0.name"`). Object keys are consulted first for
//!   non-array values, so an object key that happens to be numeric (e.g. `"0"`) keeps
//!   working. An empty segment is malformed and resolves as *missing*.
//! - **Fail-fast, deterministic.** The first violation in (nodes, then required-list)
//!   order is returned, so the reported error is stable for a stable input — mirroring
//!   the crate's existing validators. Conditional display options (`displayOptions`
//!   gating in the reference) are out of scope for L1 and documented here as such.

use serde_json::Value;
use std::collections::HashMap;

/// One required parameter of a node type.
///
/// `display_name` is optional human-facing metadata (e.g. `"URL"` for path `"url"`);
/// error messages fall back to the path when it is absent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredParameter {
    /// Dot-separated lookup path inside the node's parameter bag (array indices as
    /// numeric segments).
    pub path: String,
    /// Human-facing label from the node-type description, if known.
    pub display_name: Option<String>,
}

impl RequiredParameter {
    /// A required parameter identified by path only.
    pub fn new(path: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            display_name: None,
        }
    }

    /// A required parameter with a human-facing display name for error messages.
    pub fn with_display_name(path: impl Into<String>, display_name: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            display_name: Some(display_name.into()),
        }
    }
}

/// Declarative spec: node type (e.g. `"n8n-nodes-base.httpRequest"`) → the parameter
/// list every node of that type must carry before execution.
///
/// Node types missing from the map are skipped (no metadata known at this level —
/// L1 leniency, consistent with `connections.rs::OutputSlotSpec`).
pub type ParameterSpecSet = HashMap<String, Vec<RequiredParameter>>;

/// Minimal borrowed view of a workflow node for parameter validation. Callers adapt
/// their own node representation (e.g. `INode` from n8n-node-model) into this view —
/// the validator itself takes no dependency on any node-model crate.
#[derive(Debug, Clone, Copy)]
pub struct NodeParameterView<'a> {
    /// Node name (unique within the workflow), used in error messages.
    pub name: &'a str,
    /// Node type identifier, matched against [`ParameterSpecSet`] keys.
    pub node_type: &'a str,
    /// The node's parameter bag. Nested object/array structures are traversed by
    /// [`RequiredParameter::path`].
    pub parameters: &'a Value,
}

/// Failure modes for parameter integrity validation.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ParameterValidationError {
    /// A parameter declared required for the node's type is absent or empty.
    #[error(
        "node '{node}' (type '{node_type}'): required parameter '{label}' (path '{path}') is missing or empty"
    )]
    MissingRequiredParameter {
        /// Name of the offending node.
        node: String,
        /// Node type identifier.
        node_type: String,
        /// Dot-separated path that failed to resolve to a real value.
        path: String,
        /// Display label used in the message (display name, falling back to `path`).
        label: String,
    },
}

/// Validates required parameters on every node against the parameter spec.
///
/// # Arguments
///
/// * `nodes` — borrowed views of the workflow's nodes, in workflow order.
/// * `specs` — node-type → required parameters (see [`ParameterSpecSet`]). Pass an
///   empty map to validate nothing (documented no-op).
///
/// # Errors
///
/// Returns [`ParameterValidationError::MissingRequiredParameter`] for the first node
/// (in slice order, then spec order) whose required parameter is missing or empty.
///
/// # Examples
///
/// ```ignore
/// use n8n_validation::parameters::{validate_parameters, NodeParameterView, ParameterSpecSet, RequiredParameter};
/// use serde_json::json;
///
/// let params = json!({ "url": "https://example.com" });
/// let nodes = [NodeParameterView { name: "Fetch", node_type: "n8n-nodes-base.httpRequest", parameters: &params }];
/// let mut specs = ParameterSpecSet::new();
/// specs.insert("n8n-nodes-base.httpRequest".into(), vec![RequiredParameter::with_display_name("url", "URL")]);
/// assert!(validate_parameters(&nodes, &specs).is_ok());
/// ```
pub fn validate_parameters(
    nodes: &[NodeParameterView<'_>],
    specs: &ParameterSpecSet,
) -> Result<(), ParameterValidationError> {
    for node in nodes {
        let Some(required) = specs.get(node.node_type) else {
            continue; // no metadata for this node type — skipped, never guessed (L1)
        };

        for parameter in required {
            let value = resolve_path(node.parameters, &parameter.path);
            if parameter_is_missing(value) {
                return Err(ParameterValidationError::MissingRequiredParameter {
                    node: node.name.to_string(),
                    node_type: node.node_type.to_string(),
                    label: parameter
                        .display_name
                        .clone()
                        .unwrap_or_else(|| parameter.path.clone()),
                    path: parameter.path.clone(),
                });
            }
        }
    }

    Ok(())
}

/// Resolves a dot-separated path inside a JSON value. Numeric segments index into
/// arrays; otherwise segments are object keys. Returns `None` when any hop fails or a
/// segment is empty.
fn resolve_path<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = root;
    for segment in path.split('.') {
        if segment.is_empty() {
            return None; // malformed path resolves as missing
        }
        current = match current {
            Value::Object(map) => map.get(segment)?,
            Value::Array(items) => {
                let index: usize = segment.parse().ok()?;
                items.get(index)?
            }
            _ => return None,
        };
    }
    Some(current)
}

/// The pinned "missing or empty" rule: absent path, `null`, empty string, empty array
/// or empty object count as missing; booleans and numbers — including `false` and
/// `0` — are explicit values and count as present.
fn parameter_is_missing(value: Option<&Value>) -> bool {
    match value {
        None => true,
        Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty(),
        Some(Value::Array(items)) => items.is_empty(),
        Some(Value::Object(map)) => map.is_empty(),
        Some(Value::Bool(_)) | Some(Value::Number(_)) => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn view<'a>(name: &'a str, node_type: &'a str, parameters: &'a Value) -> NodeParameterView<'a> {
        NodeParameterView {
            name,
            node_type,
            parameters,
        }
    }

    fn http_spec() -> ParameterSpecSet {
        let mut specs = ParameterSpecSet::new();
        specs.insert(
            "n8n-nodes-base.httpRequest".to_string(),
            vec![
                RequiredParameter::with_display_name("url", "URL"),
                RequiredParameter::new("authentication"),
            ],
        );
        specs
    }

    #[test]
    fn all_required_parameters_present_passes() {
        let params = json!({ "url": "https://example.com", "authentication": "none" });
        let nodes = [view("Fetch", "n8n-nodes-base.httpRequest", &params)];
        assert!(validate_parameters(&nodes, &http_spec()).is_ok());
    }

    #[test]
    fn missing_key_fails_with_descriptive_message() {
        let params = json!({ "authentication": "none" });
        let nodes = [view("Fetch", "n8n-nodes-base.httpRequest", &params)];
        let err = validate_parameters(&nodes, &http_spec()).unwrap_err();
        assert_eq!(
            err.to_string(),
            "node 'Fetch' (type 'n8n-nodes-base.httpRequest'): required parameter 'URL' (path 'url') is missing or empty"
        );
    }

    #[test]
    fn null_empty_string_empty_array_and_empty_object_all_count_as_missing() {
        for params in [
            json!({ "url": null }),
            json!({ "url": "" }),
            json!({ "url": [] }),
            json!({ "url": {} }),
        ] {
            let nodes = [view("Fetch", "n8n-nodes-base.httpRequest", &params)];
            assert_eq!(
                validate_parameters(&nodes, &http_spec()),
                Err(ParameterValidationError::MissingRequiredParameter {
                    node: "Fetch".into(),
                    node_type: "n8n-nodes-base.httpRequest".into(),
                    path: "url".into(),
                    label: "URL".into(),
                }),
                "params {params} must fail"
            );
        }
    }

    #[test]
    fn false_and_zero_are_explicit_values_and_pass() {
        // `authentication: false` would be missing under naive truthiness; it is not.
        let params = json!({ "url": "https://example.com", "authentication": false, "retries": 0 });
        let mut specs = http_spec();
        specs
            .get_mut("n8n-nodes-base.httpRequest")
            .unwrap()
            .push(RequiredParameter::new("retries"));
        let nodes = [view("Fetch", "n8n-nodes-base.httpRequest", &params)];
        assert!(validate_parameters(&nodes, &specs).is_ok());
    }

    #[test]
    fn nested_dot_paths_and_array_indices_resolve() {
        let params = json!({
            "options": { "auth": { "user": "u", "pass": "p" } },
            "assignments": [ { "name": "x" } ]
        });
        let mut specs = ParameterSpecSet::new();
        specs.insert(
            "custom".to_string(),
            vec![
                RequiredParameter::new("options.auth.user"),
                RequiredParameter::new("assignments.0.name"),
            ],
        );
        let nodes = [view("N", "custom", &params)];
        assert!(validate_parameters(&nodes, &specs).is_ok());

        // Same spec, missing deep value → fails on the deep path.
        let params = json!({ "options": { "auth": {} }, "assignments": [ { } ] });
        let nodes = [view("N", "custom", &params)];
        assert_eq!(
            validate_parameters(&nodes, &specs),
            Err(ParameterValidationError::MissingRequiredParameter {
                node: "N".into(),
                node_type: "custom".into(),
                path: "options.auth.user".into(),
                label: "options.auth.user".into(),
            })
        );
    }

    #[test]
    fn label_falls_back_to_path_when_no_display_name() {
        // Entries built with `RequiredParameter::new` carry no display name: the
        // message label must fall back to the path itself.
        let params = json!({});
        let specs: ParameterSpecSet = [("t".to_string(), vec![RequiredParameter::new("url")])]
            .into_iter()
            .collect();
        let nodes = [view("N", "t", &params)];
        let err = validate_parameters(&nodes, &specs).unwrap_err();
        assert_eq!(
            err.to_string(),
            "node 'N' (type 't'): required parameter 'url' (path 'url') is missing or empty"
        );
    }

    #[test]
    fn numeric_segment_still_works_as_object_key() {
        // An object key that happens to be numeric must resolve before array indexing.
        let params = json!({ "0": "value" });
        let mut specs = ParameterSpecSet::new();
        specs.insert("t".to_string(), vec![RequiredParameter::new("0")]);
        let nodes = [view("N", "t", &params)];
        assert!(validate_parameters(&nodes, &specs).is_ok());
    }

    #[test]
    fn node_types_without_spec_are_skipped() {
        let params = json!({});
        let nodes = [view("Legacy", "unknown.nodeType", &params)];
        assert!(validate_parameters(&nodes, &http_spec()).is_ok());
    }

    #[test]
    fn empty_nodes_and_empty_required_lists_pass() {
        assert!(validate_parameters(&[], &http_spec()).is_ok());
        let params = json!({});
        let mut specs = ParameterSpecSet::new();
        specs.insert("t".to_string(), vec![]);
        let nodes = [view("N", "t", &params)];
        assert!(validate_parameters(&nodes, &specs).is_ok());
    }

    #[test]
    fn malformed_path_with_empty_segment_resolves_as_missing() {
        let params = json!({ "a": 1 });
        let mut specs = ParameterSpecSet::new();
        specs.insert("t".to_string(), vec![RequiredParameter::new("a..b")]);
        let nodes = [view("N", "t", &params)];
        assert!(validate_parameters(&nodes, &specs).is_err());
    }
}
