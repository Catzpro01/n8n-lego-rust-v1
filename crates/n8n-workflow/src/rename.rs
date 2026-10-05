//! `renameNode` semantics, ported from `reference/n8n/packages/workflow/src/workflow.ts`
//! (`renameNode`, `renameNodeInParameterValue`) and
//! `reference/n8n/packages/workflow/src/node-parameters/rename-node-utils.ts`.
//!
//! Fidelity notes:
//!
//! * The 13 restricted keys are compared case-insensitively and throw a `UserError` with the exact
//!   reference message. The reference has **no** collision check — renaming onto an existing name
//!   replaces that node (last write wins), which the `collision-overwrites` fixture pins.
//! * `renameNodeInParameterValue` only rewrites strings that start with `=` (an expression) or sit
//!   in a "renamable content" container. Objects propagate that flag, **arrays reset it**, and a
//!   nested `null` becomes `{}` — all three are ported as-is.
//! * Parameter rewriting goes through `applyAccessPatterns`, whose full reference implementation is
//!   a ~400-line expression parser (dot-notation variables, `$node[…]`, `$items(…)`, item
//!   accessors, `splitOut` special cases). The port implements the accessor forms listed in
//!   [`ACCESS_PATTERN_FORMS`] and is documented as a coverage gap in
//!   `docs/isolation/workflow-rust-port-review.md` §6.

use n8n_node_model::{INode, INodeParameters};
use serde_json::{Map, Value};
use thiserror::Error;

pub const RESTRICTED_KEYS: [&str; 13] = [
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "constructor",
    "prototype",
    "__proto__",
    "__defineGetter__",
    "__defineSetter__",
    "__lookupGetter__",
    "__lookupSetter__",
];

#[derive(Debug, Clone, PartialEq, Error)]
pub enum WorkflowError {
    /// Reference `UserError` for restricted names.
    #[error("Node name \"{name}\" is a restricted name.")]
    RestrictedNodeName { name: String },
}

impl WorkflowError {
    /// Reference error class name (`error.constructor.name`).
    pub fn error_name(&self) -> &'static str {
        match self {
            WorkflowError::RestrictedNodeName { .. } => "UserError",
        }
    }
}

pub fn is_restricted_node_name(name: &str) -> bool {
    RESTRICTED_KEYS
        .iter()
        .any(|restricted| restricted.eq_ignore_ascii_case(name))
}

/// The accessor forms the port rewrites (prefix, suffix). The reference additionally handles
/// `$node.Name` dot notation, item accessors and `splitOut`; those are not ported yet.
pub const ACCESS_PATTERN_FORMS: [(&str, &str); 6] = [
    ("$('", "')"),
    ("$(\"", "\")"),
    ("$items('", "')"),
    ("$items(\"", "\")"),
    ("$node['", "']"),
    ("$node[\"", "\"]"),
];

/// Subset port of `applyAccessPatterns`: rewrites `previous_name` to `new_name` inside the
/// supported accessor forms and leaves every other byte of the expression alone.
pub fn apply_access_patterns(expression: &str, previous_name: &str, new_name: &str) -> String {
    // Reference short-circuit: only run when the name appears at all.
    if !expression.contains(previous_name) {
        return expression.to_string();
    }

    let mut out = String::with_capacity(expression.len() + new_name.len());
    let mut rest = expression;

    'outer: while !rest.is_empty() {
        for (prefix, suffix) in ACCESS_PATTERN_FORMS {
            let Some(after_prefix) = rest.strip_prefix(prefix) else {
                continue;
            };
            let Some(end) = after_prefix.find(suffix) else {
                continue;
            };
            if &after_prefix[..end] != previous_name {
                continue;
            }
            out.push_str(prefix);
            out.push_str(new_name);
            out.push_str(suffix);
            rest = &after_prefix[end + suffix.len()..];
            continue 'outer;
        }

        let character = rest.chars().next().expect("non-empty");
        out.push(character);
        rest = &rest[character.len_utf8()..];
    }

    out
}

/// Port of `renameNodeInParameterValue`.
pub fn rename_node_in_parameter_value(
    parameter_value: &Value,
    current_name: &str,
    new_name: &str,
    has_renamable_content: bool,
) -> Value {
    match parameter_value {
        // Reached the actual value: primitives.
        Value::String(text) => {
            if text.starts_with('=') || has_renamable_content {
                Value::String(apply_access_patterns(text, current_name, new_name))
            } else {
                parameter_value.clone()
            }
        }
        // `Array.isArray` branch: the reference recurses WITHOUT the renamable flag.
        Value::Array(elements) => Value::Array(
            elements
                .iter()
                .map(|element| {
                    rename_node_in_parameter_value(element, current_name, new_name, false)
                })
                .collect(),
        ),
        // `typeof null === 'object'` and `Object.keys(null || {}) === []` → null becomes `{}`.
        Value::Null => Value::Object(Map::new()),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, entry) in map {
                out.insert(
                    key.clone(),
                    rename_node_in_parameter_value(
                        entry,
                        current_name,
                        new_name,
                        has_renamable_content,
                    ),
                );
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Node types whose content fields are rewritten even outside expressions.
pub const NODES_WITH_RENAMABLE_CONTENT: [&str; 4] = [
    "n8n-nodes-base.code",
    "n8n-nodes-base.function",
    "n8n-nodes-base.functionItem",
    "n8n-nodes-base.aiTransform",
];
pub const NODES_WITH_RENAMEABLE_TOPLEVEL_HTML_CONTENT: [&str; 2] =
    ["n8n-nodes-base.mailgun", "n8n-nodes-base.html"];
pub const NODES_WITH_RENAMABLE_FORM_HTML_CONTENT: [&str; 1] = ["n8n-nodes-base.form"];

/// The node-type-specific part of `renameNode` (`jsCode`, top-level `html`, `formFields.values[].html`).
pub fn rename_node_extra_content(node: &mut INode, current_name: &str, new_name: &str) {
    if let Value::Object(parameters) = &mut node.parameters.0 {
        if NODES_WITH_RENAMABLE_CONTENT.contains(&node.node_type.as_str()) {
            if let Some(js_code) = parameters.get("jsCode") {
                parameters.insert(
                    "jsCode".into(),
                    rename_node_in_parameter_value(js_code, current_name, new_name, true),
                );
            }
        }

        if NODES_WITH_RENAMEABLE_TOPLEVEL_HTML_CONTENT.contains(&node.node_type.as_str()) {
            if let Some(html) = parameters.get("html") {
                parameters.insert(
                    "html".into(),
                    rename_node_in_parameter_value(html, current_name, new_name, true),
                );
            }
        }

        if NODES_WITH_RENAMABLE_FORM_HTML_CONTENT.contains(&node.node_type.as_str()) {
            if let Some(Value::Array(values)) = parameters
                .get_mut("formFields")
                .and_then(|form_fields| form_fields.get_mut("values"))
            {
                for value in values.iter_mut() {
                    let is_html_field = value
                        .get("fieldType")
                        .and_then(Value::as_str)
                        .map(|field_type| field_type == "html")
                        .unwrap_or(false);
                    if !is_html_field {
                        continue;
                    }
                    if let Some(html) = value.get("html") {
                        let rewritten =
                            rename_node_in_parameter_value(html, current_name, new_name, true);
                        value["html"] = rewritten;
                    }
                }
            }
        }
    }
}

/// Convenience wrapper mirroring the reference's `node.parameters = renameNodeInParameterValue(...)`.
pub fn rename_parameters(
    parameters: &INodeParameters,
    current_name: &str,
    new_name: &str,
) -> INodeParameters {
    INodeParameters(rename_node_in_parameter_value(
        &parameters.0,
        current_name,
        new_name,
        false,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn restricted_names_cover_all_thirteen_keys_case_insensitively() {
        assert_eq!(RESTRICTED_KEYS.len(), 13);
        for key in RESTRICTED_KEYS {
            assert!(is_restricted_node_name(key), "{key}");
            assert!(is_restricted_node_name(&key.to_uppercase()), "{key}");
        }
        assert!(!is_restricted_node_name("hasOwnProperty2"));
        assert!(!is_restricted_node_name("My Node"));
    }

    #[test]
    fn access_patterns_rewrite_only_the_accessor_forms() {
        assert_eq!(
            apply_access_patterns("={{ $('A').item.json.x }}", "A", "Alpha"),
            "={{ $('Alpha').item.json.x }}"
        );
        assert_eq!(
            apply_access_patterns("={{ $node[\"A\"].json.y }}", "A", "Alpha"),
            "={{ $node[\"Alpha\"].json.y }}"
        );
        assert_eq!(
            apply_access_patterns("={{ $items('A') }}", "A", "Alpha"),
            "={{ $items('Alpha') }}"
        );
        // Not an accessor, and the name only appears as text: untouched.
        assert_eq!(
            apply_access_patterns("prefix A suffix", "A", "Alpha"),
            "prefix A suffix"
        );
        // Name reused by a different accessor form.
        assert_eq!(
            apply_access_patterns("={{ $('AA').x + $('A').y }}", "A", "Alpha"),
            "={{ $('AA').x + $('Alpha').y }}"
        );
    }

    #[test]
    fn arrays_reset_the_renamable_flag_and_null_becomes_an_object() {
        let value = json!({"list": ["node A"], "nested": {"deep": ["node A"]}, "gone": null});
        let rewritten = rename_node_in_parameter_value(&value, "A", "Alpha", true);

        // The object level passes the flag down, the array level drops it again.
        assert_eq!(rewritten["list"][0], json!("node A"));
        assert_eq!(rewritten["nested"]["deep"][0], json!("node A"));
        assert_eq!(rewritten["gone"], json!({}));
    }

    #[test]
    fn plain_strings_are_untouched_but_expressions_are_rewritten() {
        let value = json!({"value": "={{ $('A').item.json.x }}", "plain": "A"});
        let rewritten = rename_node_in_parameter_value(&value, "A", "Alpha", false);
        assert_eq!(rewritten["value"], json!("={{ $('Alpha').item.json.x }}"));
        assert_eq!(rewritten["plain"], json!("A"));
    }
}
