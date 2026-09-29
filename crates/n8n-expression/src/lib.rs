//! n8n expression engine (Phase 3 Rust runtime, LEGO `expression`).
//!
//! Public surface:
//! * [`StandardExpressionEvaluator`] — the ratified `ExpressionEvaluator`
//!   implementation behind the graph ⇄ expression contract.
//! * [`parse`] — expression → AST (see `parser` for the grammar coverage).
//! * [`is_expression`] — detection heuristic shared with the workflow graph.
//! * [`resolve_template`] — convenience single-item template renderer.
//! * `extensions` — n8n extension methods & extended functions (E12).
//! * `sandbox` — static sandbox gate for hostile source (E9).

// ---------------------------------------------------------------------------
// STAGE-3 (m7-03-sandboxed-evaluator) instrumentation — test builds only.
//
// A counting global allocator lets the harness assert the spec's "without
// excessive allocation" criterion with *counts* rather than wall-clock, so the
// test is hardware-independent and cannot flake on a loaded CI worker.
// `#[cfg(test)]` guarantees the production artefact keeps the plain `System`
// allocator and pays nothing for this.
#[cfg(test)]
mod alloc_count {
    use std::alloc::{GlobalAlloc, Layout, System};
    use std::cell::Cell;

    thread_local! {
        static COUNT: Cell<usize> = const { Cell::new(0) };
        static BYTES: Cell<usize> = const { Cell::new(0) };
    }

    struct Counting;

    #[deny(unsafe_op_in_unsafe_fn)]
    unsafe impl GlobalAlloc for Counting {
        unsafe fn alloc(&self, l: Layout) -> *mut u8 {
            COUNT.with(|c| c.set(c.get() + 1));
            BYTES.with(|c| c.set(c.get() + l.size()));
            unsafe { System.alloc(l) }
        }
        unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
            unsafe { System.dealloc(p, l) }
        }
        unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
            COUNT.with(|c| c.set(c.get() + 1));
            BYTES.with(|c| c.set(c.get() + new));
            unsafe { System.realloc(p, l, new) }
        }
    }

    #[global_allocator]
    static ALLOC: Counting = Counting;

    pub fn snapshot() -> (usize, usize) {
        (COUNT.with(|c| c.get()), BYTES.with(|c| c.get()))
    }
}

#[cfg(test)]
pub(crate) use alloc_count::snapshot as alloc_snapshot;

pub mod ast;
pub mod context;
pub mod evaluator;
pub mod extensions;
pub mod parser;
pub mod sandbox;

pub use ast::{BinaryOperator, ExprAst, PathSegment, TemplateSegment, UnaryOperator};
pub use context::ContextResolver;
pub use evaluator::StandardExpressionEvaluator;
pub use parser::parse;

use extensions::js_stringify;
use n8n_common::expression_contract::ExpressionEvaluator;
use serde_json::Value;

/// Checks if a string has expression markers.
///
/// Contract E1: any string whose first character is `=` is evaluated. For
/// compatibility with the ratified graph ⇄ expression contract (pilot
/// phase), strings containing a `{{ ... }}` block are expressions even
/// without the `=` marker.
pub fn is_expression(val: &str) -> bool {
    let trimmed = val.trim();
    trimmed.starts_with('=') || (trimmed.contains("{{") && trimmed.contains("}}"))
}

/// Convenience standalone evaluation against a single Value payload.
pub fn evaluate_simple_json_path<'a>(json: &'a Value, path: &str) -> Option<&'a Value> {
    let parts: Vec<&str> = path.split('.').collect();
    let mut current = json;
    for part in parts {
        if part == "$json" || part.is_empty() {
            continue;
        }
        match current {
            Value::Object(map) => {
                current = map.get(part)?;
            }
            Value::Array(arr) => {
                let idx: usize = part.parse().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
}

/// Convenience string template resolver against one current-item payload.
///
/// Falls back to the raw template on evaluation failure (best-effort UI
/// helper — the fail-closed runtime path is `ExpressionEvaluator::evaluate`).
pub fn resolve_template(template: &str, current_json: &Value) -> String {
    let evaluator = StandardExpressionEvaluator::new();
    let context = n8n_common::expression_contract::SimpleEvaluationContext::new()
        .with_json(current_json.clone());
    evaluator
        .evaluate(template, &context)
        .map(|v| match v {
            Value::String(s) => s,
            other => js_stringify(&other),
        })
        .unwrap_or_else(|_| template.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use n8n_common::expression_contract::{ExpressionError, SimpleEvaluationContext};
    use serde_json::json;

    fn evaluator() -> StandardExpressionEvaluator {
        StandardExpressionEvaluator::new()
    }

    // ======================================================================
    // Ratified pilot behaviour (regression guard — do not weaken).
    // ======================================================================

    #[test]
    fn test_is_expression() {
        assert!(is_expression("={{ $json.myVar }}"));
        assert!(is_expression("Hello {{ $json.name }}!"));
        assert!(is_expression("=text")); // contract E1: leading '=' marker
        assert!(!is_expression("Plain string without tags"));
    }

    #[test]
    fn test_evaluator_json_lookup() {
        let context = SimpleEvaluationContext::new().with_json(json!({
            "user": { "id": 101, "name": "Bob", "active": true },
            "scores": [95, 88, 72]
        }));

        let r1 = evaluator()
            .evaluate("={{ $json.user.name }}", &context)
            .unwrap();
        assert_eq!(r1, json!("Bob"));

        let r2 = evaluator()
            .evaluate("={{ $json.scores[1] }}", &context)
            .unwrap();
        assert_eq!(r2, json!(88));

        let r3 = evaluator()
            .evaluate("={{ $json.user.active }}", &context)
            .unwrap();
        assert_eq!(r3, json!(true));
    }

    #[test]
    fn test_evaluator_template_interpolation() {
        let context = SimpleEvaluationContext::new().with_json(json!({
            "user": { "name": "Alice" },
            "status": "Online"
        }));

        let rendered = evaluator()
            .evaluate(
                "User: {{ $json.user.name }} is {{ $json.status }}",
                &context,
            )
            .unwrap();
        assert_eq!(rendered, json!("User: Alice is Online"));
    }

    #[test]
    fn test_evaluator_node_lookup() {
        let context = SimpleEvaluationContext::new()
            .with_json(json!({ "current": 1 }))
            .with_node_output(
                "TriggerNode",
                vec![json!({ "json": { "token": "abc-123" } })],
            );

        let res = evaluator()
            .evaluate("={{ $node['TriggerNode'].json.token }}", &context)
            .unwrap();
        assert_eq!(res, json!("abc-123"));
    }

    #[test]
    fn test_evaluator_arithmetic_and_logic() {
        let context = SimpleEvaluationContext::new().with_json(json!({
            "a": 10, "b": 25, "valid": true
        }));

        let r_math = evaluator()
            .evaluate("={{ $json.a * 2 + $json.b }}", &context)
            .unwrap();
        assert_eq!(r_math, json!(45));

        let r_cmp = evaluator()
            .evaluate("={{ $json.b > $json.a }}", &context)
            .unwrap();
        assert_eq!(r_cmp, json!(true));

        let r_logic = evaluator()
            .evaluate("={{ $json.valid && $json.a == 10 }}", &context)
            .unwrap();
        assert_eq!(r_logic, json!(true));
    }

    #[test]
    fn test_evaluator_strict_error_model_no_panic() {
        let context = SimpleEvaluationContext::new().with_json(json!({ "foo": "bar" }));

        // Missing field
        let err_field = evaluator()
            .evaluate("={{ $json.nonexistent.nested }}", &context)
            .unwrap_err();
        match err_field {
            ExpressionError::UnresolvedReference { path } => {
                assert!(path.contains("nonexistent"));
            }
            other => panic!("Expected UnresolvedReference, got: {other:?}"),
        }

        // Missing node
        let err_node = evaluator()
            .evaluate("={{ $node['GhostNode'].json.val }}", &context)
            .unwrap_err();
        match err_node {
            ExpressionError::NodeNotFound { node_name } => {
                assert_eq!(node_name, "GhostNode");
            }
            other => panic!("Expected NodeNotFound, got: {other:?}"),
        }

        // Division by zero
        let err_div = evaluator().evaluate("={{ 10 / 0 }}", &context).unwrap_err();
        match err_div {
            ExpressionError::TypeError { actual, .. } => {
                assert!(actual.contains("division by zero"));
            }
            other => panic!("Expected division by zero TypeError, got: {other:?}"),
        }

        // Malformed syntax (unclosed delimiter) -> strictly SyntaxError, zero panic!
        let err_syntax = evaluator()
            .evaluate("={{ $json.foo + }}", &context)
            .unwrap_err();
        match err_syntax {
            ExpressionError::SyntaxError { .. } => {}
            other => panic!("Expected SyntaxError, got: {other:?}"),
        }
    }

    // ======================================================================
    // Contract §3 / E1: expression contexts and output typing.
    // ======================================================================

    #[test]
    fn test_equals_marker_semantics() {
        // `=` alone → empty string; `=text` → `text` (contract §3).
        let context = SimpleEvaluationContext::new().with_json(json!({}));
        assert_eq!(evaluator().evaluate("=", &context).unwrap(), json!(""));
        assert_eq!(
            evaluator().evaluate("=text", &context).unwrap(),
            json!("text")
        );
    }

    #[test]
    fn test_whole_string_expression_preserves_type() {
        let context = SimpleEvaluationContext::new().with_json(json!({
            "price": 45, "quantity": 3,
            "obj": { "nested": 1 },
            "arr": [7, 8]
        }));
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.price * $json.quantity }}", &context)
                .unwrap(),
            json!(135)
        );
        // Objects and arrays pass through as typed values (no stringification).
        assert_eq!(
            evaluator().evaluate("={{ $json.obj }}", &context).unwrap(),
            json!({ "nested": 1 })
        );
        assert_eq!(
            evaluator().evaluate("={{ $json.arr }}", &context).unwrap(),
            json!([7, 8])
        );
    }

    #[test]
    fn test_template_js_string_semantics() {
        let context = SimpleEvaluationContext::new().with_json(json!({
            "obj": { "a": 1 },
            "nums": [1, 2, 3],
            "count": 3
        }));
        // Objects render as [object Object] inside mixed templates.
        assert_eq!(
            evaluator()
                .evaluate("val: {{ $json.obj }}", &context)
                .unwrap(),
            json!("val: [object Object]")
        );
        // Arrays join with commas.
        assert_eq!(
            evaluator()
                .evaluate("nums: {{ $json.nums }}", &context)
                .unwrap(),
            json!("nums: 1,2,3")
        );
        // null renders as empty text.
        assert_eq!(
            evaluator().evaluate("x{{ null }}y", &context).unwrap(),
            json!("xy")
        );
        // Numbers render plainly.
        assert_eq!(
            evaluator()
                .evaluate("total: {{ $json.count }}!", &context)
                .unwrap(),
            json!("total: 3!")
        );
    }

    // ======================================================================
    // Language features: ternary, modulo, literals, operators.
    // ======================================================================

    #[test]
    fn test_ternary_operator() {
        let context = SimpleEvaluationContext::new().with_json(json!({ "a": 10, "b": 1 }));
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.a > 5 ? 'big' : 'small' }}", &context)
                .unwrap(),
            json!("big")
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.b > 5 ? 'big' : 'small' }}", &context)
                .unwrap(),
            json!("small")
        );
        // Right-associativity: a ? b : c ? d : e  ===  a ? b : (c ? d : e)
        assert_eq!(
            evaluator()
                .evaluate("={{ false ? 1 : true ? 2 : 3 }}", &context)
                .unwrap(),
            json!(2)
        );
    }

    #[test]
    fn test_operator_precedence_and_modulo() {
        let context = SimpleEvaluationContext::new().with_json(json!({}));
        assert_eq!(
            evaluator().evaluate("={{ 1 + 2 * 3 }}", &context).unwrap(),
            json!(7)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ (1 + 2) * 3 }}", &context)
                .unwrap(),
            json!(9)
        );
        assert_eq!(
            evaluator().evaluate("={{ 10 % 3 }}", &context).unwrap(),
            json!(1)
        );
        assert_eq!(
            evaluator().evaluate("={{ 2 * 3 % 4 }}", &context).unwrap(),
            json!(2)
        );
        assert_eq!(
            evaluator().evaluate("={{ 7 / 2 }}", &context).unwrap(),
            json!(3.5)
        );
        // modulo by zero fails closed
        assert!(evaluator().evaluate("={{ 5 % 0 }}", &context).is_err());
    }

    #[test]
    fn test_strict_equality_aliases() {
        let context = SimpleEvaluationContext::new().with_json(json!({}));
        assert_eq!(
            evaluator().evaluate("={{ 1 === 1 }}", &context).unwrap(),
            json!(true)
        );
        assert_eq!(
            evaluator().evaluate("={{ 1 !== 2 }}", &context).unwrap(),
            json!(true)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ 'a' === 'a' }}", &context)
                .unwrap(),
            json!(true)
        );
    }

    #[test]
    fn test_string_comparison_and_unary() {
        let context = SimpleEvaluationContext::new().with_json(json!({ "ok": false }));
        assert_eq!(
            evaluator()
                .evaluate("={{ 'abc' < 'abd' }}", &context)
                .unwrap(),
            json!(true)
        );
        assert_eq!(
            evaluator().evaluate("={{ -5 + 3 }}", &context).unwrap(),
            json!(-2)
        );
        assert_eq!(
            evaluator().evaluate("={{ !true }}", &context).unwrap(),
            json!(false)
        );
        assert_eq!(
            evaluator().evaluate("={{ !$json.ok }}", &context).unwrap(),
            json!(true)
        );
    }

    #[test]
    fn test_string_escapes_and_literals() {
        let context = SimpleEvaluationContext::new().with_json(json!({}));
        assert_eq!(
            evaluator().evaluate("={{ 'a\nb' }}", &context).unwrap(),
            json!("a\nb")
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ 'it\\'s ok' }}", &context)
                .unwrap(),
            json!("it's ok")
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ '\\u0041BC' }}", &context)
                .unwrap(),
            json!("ABC")
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ \"tab\\there\" }}", &context)
                .unwrap(),
            json!("tab\there")
        );
        // numbers: floats, exponents, leading dot
        assert_eq!(
            evaluator().evaluate("={{ .5 + .5 }}", &context).unwrap(),
            json!(1)
        );
        assert_eq!(
            evaluator().evaluate("={{ 1e3 }}", &context).unwrap(),
            json!(1000)
        );
    }

    #[test]
    fn test_array_and_object_literals() {
        let context = SimpleEvaluationContext::new().with_json(json!({ "x": 5 }));
        assert_eq!(
            evaluator()
                .evaluate("={{ [1, 2, $json.x] }}", &context)
                .unwrap(),
            json!([1, 2, 5])
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ {k: 1, 'x': 'v'} }}", &context)
                .unwrap(),
            json!({ "k": 1, "x": "v" })
        );
        assert_eq!(
            evaluator().evaluate("={{ [] }}", &context).unwrap(),
            json!([])
        );
        assert_eq!(
            evaluator().evaluate("={{ {} }}", &context).unwrap(),
            json!({})
        );
    }

    // ======================================================================
    // Extension methods & extended functions (contract E12).
    // ======================================================================

    #[test]
    fn test_extension_methods_on_values() {
        let context = SimpleEvaluationContext::new().with_json(json!({
            "name": "n8n8",
            "items": [9, 8, 7],
            "rows": []
        }));
        assert_eq!(
            evaluator()
                .evaluate("={{ 'hello'.toUpperCase() }}", &context)
                .unwrap(),
            json!("HELLO")
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ ' hello '.trim().length() }}", &context)
                .unwrap(),
            json!(5)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.items.first() }}", &context)
                .unwrap(),
            json!(9)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.items.last() }}", &context)
                .unwrap(),
            json!(7)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.items.isEmpty() }}", &context)
                .unwrap(),
            json!(false)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.rows.isEmpty() }}", &context)
                .unwrap(),
            json!(true)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.items.length() }}", &context)
                .unwrap(),
            json!(3)
        );
        // `.length` plain property access on arrays and strings (JS surface)
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.items.length }}", &context)
                .unwrap(),
            json!(3)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.name.length }}", &context)
                .unwrap(),
            json!(4)
        );
    }

    #[test]
    fn test_extended_functions() {
        let context = SimpleEvaluationContext::new().with_json(json!({
            "a": 4, "b": 9, "empty": ""
        }));
        assert_eq!(
            evaluator()
                .evaluate("={{ $if($json.b > 5, 'yes', 'no') }}", &context)
                .unwrap(),
            json!("yes")
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $min($json.a, $json.b) }}", &context)
                .unwrap(),
            json!(4)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $max([1, $json.b, 2]) }}", &context)
                .unwrap(),
            json!(9)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $average([2, 4, 6]) }}", &context)
                .unwrap(),
            json!(4)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $not(false) }}", &context)
                .unwrap(),
            json!(true)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $ifEmpty($json.empty, 'fallback') }}", &context)
                .unwrap(),
            json!("fallback")
        );
        // Unknown $-functions fail closed.
        assert!(evaluator()
            .evaluate("={{ $jmespath($json, 'a') }}", &context)
            .is_err());
    }

    // ======================================================================
    // Node handles: $('Name') member access.
    // ======================================================================

    #[test]
    fn test_node_handle_member_access() {
        let context = SimpleEvaluationContext::new()
            .with_json(json!({ "current": true }))
            .with_node_output(
                "Webhook",
                vec![
                    json!({ "json": { "id": 1 } }),
                    json!({ "json": { "id": 2 } }),
                ],
            );

        assert_eq!(
            evaluator()
                .evaluate("={{ $('Webhook').first().json.id }}", &context)
                .unwrap(),
            json!(1)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $('Webhook').last().json.id }}", &context)
                .unwrap(),
            json!(2)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $('Webhook').all().length() }}", &context)
                .unwrap(),
            json!(2)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $('Webhook').json.id }}", &context)
                .unwrap(),
            json!(1)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $('Webhook').isExecuted }}", &context)
                .unwrap(),
            json!(true)
        );
        // Missing node handle → NodeNotFound (contract E4).
        let err = evaluator()
            .evaluate("={{ $('Ghost').first() }}", &context)
            .unwrap_err();
        match err {
            ExpressionError::NodeNotFound { node_name } => assert_eq!(node_name, "Ghost"),
            other => panic!("Expected NodeNotFound, got: {other:?}"),
        }
        // A bare handle without member access fails closed.
        assert!(evaluator()
            .evaluate("={{ $('Webhook') }}", &context)
            .is_err());
    }

    // ======================================================================
    // Dynamic access, short-circuiting, chained calls.
    // ======================================================================

    #[test]
    fn test_dynamic_index_and_chained_calls() {
        let mut context = SimpleEvaluationContext::new().with_json(json!({
            "name": "Bob",
            "scores": [10, 20, 30]
        }));
        context.variables.insert("key".to_string(), json!("name"));
        context.variables.insert("idx".to_string(), json!(1));

        assert_eq!(
            evaluator()
                .evaluate("={{ $json[$vars.key] }}", &context)
                .unwrap(),
            json!("Bob")
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.scores[$vars.idx] }}", &context)
                .unwrap(),
            json!(20)
        );
        // chained method calls
        assert_eq!(
            evaluator()
                .evaluate("={{ ' hello '.trim().toUpperCase() }}", &context)
                .unwrap(),
            json!("HELLO")
        );
    }

    #[test]
    fn test_js_short_circuit_semantics() {
        let context = SimpleEvaluationContext::new().with_json(json!({ "x": 1 }));
        // Right side never evaluates — no error despite the missing path.
        assert_eq!(
            evaluator()
                .evaluate("={{ false && $json.missing.deep }}", &context)
                .unwrap(),
            json!(false)
        );
        assert_eq!(
            evaluator()
                .evaluate("={{ $json.x == 1 || $json.missing }}", &context)
                .unwrap(),
            json!(true)
        );
    }

    // ======================================================================
    // Sandbox & robustness (contract E9 / E14).
    // ======================================================================

    #[test]
    fn test_sandbox_blocks_prototype_chain_attacks() {
        let context = SimpleEvaluationContext::new().with_json(json!({ "a": 1 }));
        // constructor access (E9) — rejected pre-parse, classic ExpressionError surface.
        let err = evaluator()
            .evaluate("={{ $json.a.constructor }}", &context)
            .unwrap_err();
        match err {
            ExpressionError::SyntaxError { message, .. } => {
                assert!(message.contains("constructor"))
            }
            other => panic!("Expected SyntaxError, got: {other:?}"),
        }
        // __proto__ / prototype identifiers.
        assert!(evaluator()
            .evaluate("={{ $json.__proto__ }}", &context)
            .is_err());
        assert!(evaluator()
            .evaluate("={{ a.prototype }}", &context)
            .is_err());
        // with / class statements.
        assert!(evaluator()
            .evaluate("={{ with(a) { b } }}", &context)
            .is_err());
        // But the words inside plain strings are benign data.
        assert_eq!(
            evaluator()
                .evaluate("={{ 'prototype' }}", &context)
                .unwrap(),
            json!("prototype")
        );
    }

    #[test]
    fn test_nesting_depth_guard_fail_closed() {
        // 1000 nested parentheses must fail closed (no stack overflow).
        let depth = 1000;
        let mut expr = String::from("={{ ");
        for _ in 0..depth {
            expr.push('(');
        }
        expr.push('1');
        for _ in 0..depth {
            expr.push(')');
        }
        expr.push_str(" }}");
        let context = SimpleEvaluationContext::new().with_json(json!({}));
        let err = evaluator().evaluate(&expr, &context).unwrap_err();
        match err {
            ExpressionError::SyntaxError { message, .. } => {
                assert!(message.contains("depth"), "unexpected message: {message}");
            }
            other => panic!("Expected SyntaxError, got: {other:?}"),
        }
    }

    #[test]
    fn test_quoted_handlebars_do_not_close_template() {
        let context = SimpleEvaluationContext::new().with_json(json!({}));
        // `}}` inside a string literal must not terminate the block.
        assert_eq!(
            evaluator().evaluate("={{ 'a}}b' }}", &context).unwrap(),
            json!("a}}b")
        );
    }

    #[test]
    fn test_resolve_template_helper() {
        let payload = json!({ "user": { "name": "Dana" }, "obj": { "x": 1 } });
        assert_eq!(
            resolve_template("Hi {{ $json.user.name }}", &payload),
            "Hi Dana"
        );
        assert_eq!(
            resolve_template("o={{ $json.obj }}", &payload),
            "o=[object Object]"
        );
        // evaluation failure falls back to the raw template
        assert_eq!(
            resolve_template("={{ $missing.deep.path }}", &payload),
            "={{ $missing.deep.path }}"
        );
    }
}

#[cfg(test)]
mod staged1_syntax_harness {
    //! STAGE-1 harness: what the ratified parser actually accepts.
    //!
    //! (A) typed variable extraction for String / Number / Array works, in the
    //!     crate's own expression language.
    //! (B) "JSONata / JMESPath syntax passes the parser" does NOT hold: there
    //!     is no such grammar here. Such input is neither parsed nor rejected —
    //!     `parse` returns `Literal(String)` for any `=`-less, `{{`-less string,
    //!     so a bare "no error" assertion would pass vacuously. Pinned below so
    //!     nobody reads "parsed OK" as "JSONata supported".

    use super::*;
    use n8n_common::expression_contract::SimpleEvaluationContext;
    use serde_json::json;

    fn payload() -> Value {
        json!({
            "name": "n8n", "count": 3, "zero": 0, "emptyStr": "",
            "tags": ["x", "y"], "nums": [1, 2, 3], "empty": [],
            "items": [{ "json": { "name": "a", "n": 1 } }, { "json": { "name": "b", "n": 2 } }],
            "nested": { "deep": { "flag": true, "s": "yes" } }
        })
    }

    fn take(expr: &str) -> Value {
        StandardExpressionEvaluator::new()
            .evaluate(expr, &SimpleEvaluationContext::new().with_json(payload()))
            .unwrap_or_else(|e| panic!("expected `{expr}` to evaluate, got: {e}"))
    }

    #[test]
    fn staged1_string_type_passes() {
        assert_eq!(take("={{ $json.name }}"), json!("n8n"));
        assert_eq!(take("={{ $json.nested.deep.s }}"), json!("yes"));
        assert_eq!(take("={{ 'hi' }}"), json!("hi"));
        assert_eq!(take("={{ $json.name + '-x' }}"), json!("n8n-x"));
    }

    #[test]
    fn staged1_number_type_passes() {
        assert_eq!(take("={{ $json.count }}"), json!(3));
        assert_eq!(take("={{ $json.zero }}"), json!(0));
        assert_eq!(take("={{ 42 }}"), json!(42));
        assert_eq!(take("={{ $json.count * 2 + 1 }}"), json!(7));
        assert!(!matches!(take("={{ $json.count }}"), Value::String(_)));
    }

    #[test]
    fn staged1_array_type_passes() {
        assert_eq!(take("={{ $json.tags }}"), json!(["x", "y"]));
        assert_eq!(take("={{ $json.empty }}"), json!([]));
        assert_eq!(take("={{ [1, 2, 3] }}"), json!([1, 2, 3]));
        assert_eq!(take("={{ $json.nums[1] }}"), json!(2));
        assert_eq!(take("={{ $json.tags.join('-') }}"), json!("x-y"));
        assert_eq!(take("={{ $json.nums.length }}"), json!(3));
    }

    #[test]
    fn staged1_mixed_extraction_under_one_template() {
        assert_eq!(
            resolve_template(
                "{{ $json.name }}/{{ $json.count }}/{{ $json.tags }}",
                &payload()
            ),
            "n8n/3/x,y"
        );
    }

    #[test]
    fn staged1_dotpath_extraction_for_both_languages() {
        let p = payload();
        assert_eq!(evaluate_simple_json_path(&p, "name"), Some(&json!("n8n")));
        assert_eq!(evaluate_simple_json_path(&p, "tags.0"), Some(&json!("x")));
        assert_eq!(
            evaluate_simple_json_path(&p, "items.0.json.name"),
            Some(&json!("a"))
        );
        assert_eq!(evaluate_simple_json_path(&p, "nope.missing"), None);
    }

    #[test]
    fn staged1_jsonata_and_jmespath_are_neither_parsed_nor_rejected() {
        let foreign = [
            "name",
            "items.name",
            "$",
            "tags[0]",
            "$sum(nums)",
            "items[*].name",
            "nums[0:2]",
            "tags | [0]",
            "items[?json.n > `1`].json.name",
        ];
        for src in foreign {
            assert!(!is_expression(src), "`{src}` must not be an expression");
            match parse(src) {
                Ok(ExprAst::Literal(Value::String(s))) => {
                    assert_eq!(s, src, "identity literal must round-trip `{src}` verbatim");
                }
                other => panic!("`{src}` must stay an identity literal, got {other:?}"),
            }
        }
    }

    #[test]
    fn staged1_foreign_syntax_fails_closed_as_bare_identifiers() {
        for src in [
            "={{ items[*].name }}",
            "={{ nums[0:2] }}",
            "={{ length(tags) }}",
            "={{ tags | [0] }}",
            "={{ $sum(nums) }}",
        ] {
            let r = parse(src);
            assert!(
                matches!(
                    r,
                    Err(n8n_common::expression_contract::ExpressionError::SyntaxError { .. })
                ),
                "`{src}` must fail closed as SyntaxError, got {r:?}"
            );
        }
    }

    #[test]
    fn staged1_bare_form_type_downgrade_is_locked() {
        assert_eq!(take("42"), json!("42"));
        assert_eq!(take("[1, 2, 3]"), json!("[1, 2, 3]"));
        assert_eq!(take("true"), json!("true"));
        assert_eq!(take("={{ 42 }}"), json!(42));
        assert_eq!(take("={{ [1, 2, 3] }}"), json!([1, 2, 3]));
    }
}

#[cfg(test)]
mod staged4_wiring {
    //! End-to-end checks that the resolver is what the *parser/evaluator* see,
    //! not just a standalone struct.

    use crate::context::ContextResolver;
    use crate::{parse, ExprAst};
    use n8n_common::expression_contract::{
        ExpressionError, ExpressionEvaluator, SimpleEvaluationContext,
    };
    use serde_json::json;

    fn resolver() -> ContextResolver {
        ContextResolver::new()
            .with_json(json!({ "name": "ada", "n": 5 }))
            .with_node_output(
                "Start",
                vec![json!({ "json": { "v": 1 } }), json!({ "json": { "v": 2 } })],
            )
            .with_item_index(1)
            .with_run_index(7)
    }

    #[test]
    fn all_four_variables_evaluate_through_the_real_pipeline() {
        let r = resolver();
        assert_eq!(r.evaluate("={{ $json.name }}").unwrap(), json!("ada"));
        assert_eq!(r.evaluate("={{ $json.n * 2 }}").unwrap(), json!(10));
        assert_eq!(r.evaluate("={{ $itemIndex }}").unwrap(), json!(1));
        assert_eq!(r.evaluate("={{ $item }}").unwrap(), json!(1));
        assert_eq!(r.evaluate("={{ $runIndex }}").unwrap(), json!(7));
        assert_eq!(r.evaluate("={{ $thisRunIndex }}").unwrap(), json!(7));
        // `$node['X']` resolves positionally at the current item index
        // (evaluator::eval_node_lookup), which is the ratified behaviour, and
        // `.json` then narrows to the payload — matching contract §4 line 95.
        assert_eq!(
            r.evaluate("={{ $node['Start'] }}").unwrap(),
            json!({ "v": 2 })
        );
        assert_eq!(
            r.evaluate("={{ $node['Start'].json }}").unwrap(),
            json!({ "v": 2 })
        );
        // Unknown node names stay a structured NodeNotFound, through this resolver.
        let err = r.evaluate("={{ $node['Ghost'].json }}").unwrap_err();
        assert!(
            matches!(&err, n8n_common::expression_contract::ExpressionError::NodeNotFound { node_name }
                if node_name == "Ghost"),
            "expected NodeNotFound(Ghost), got {err:?}"
        );
        // run index participates in logic like any other number
        assert_eq!(
            r.evaluate("={{ $runIndex > 5 && $json.n === 5 }}").unwrap(),
            json!(true)
        );
        assert_eq!(r.evaluate("={{ $runIndex % 2 }}").unwrap(), json!(1));
    }

    #[test]
    fn run_index_fails_closed_when_the_context_cannot_supply_it() {
        // SimpleEvaluationContext has no run index; the ratified trait cannot
        // express one. The result must be a structured error, never a silent 0.
        let ctx = SimpleEvaluationContext::new().with_json(json!({ "a": 1 }));
        let err = crate::StandardExpressionEvaluator::new()
            .evaluate("={{ $runIndex }}", &ctx)
            .unwrap_err();
        assert!(
            matches!(err, ExpressionError::UnresolvedReference { .. }),
            "expected UnresolvedReference, got {err:?}"
        );
        assert!(
            err.to_string().contains("$runIndex"),
            "error must name the variable: {err}"
        );
    }

    #[test]
    fn nested_evaluation_restores_the_previous_run_index() {
        // The bridge must be scoped, not sticky.
        let outer = resolver();
        let inner = ContextResolver::new()
            .with_run_index(1)
            .with_json(json!({ "x": 1 }));
        assert_eq!(outer.evaluate("={{ $runIndex }}").unwrap(), json!(7));
        assert_eq!(inner.evaluate("={{ $runIndex }}").unwrap(), json!(1));
        assert_eq!(
            outer.evaluate("={{ $runIndex }}").unwrap(),
            json!(7),
            "outer must be restored"
        );
    }

    #[test]
    fn parser_ast_shape_is_untouched_for_existing_expressions() {
        // m7-04 must not change the AST of anything that worked before: the new
        // variant only appears for the syntax that was previously a hard error.
        for src in [
            "={{ $json.a }}",
            "={{ $node['X'].json }}",
            "={{ $itemIndex }}",
        ] {
            let before = parse(src).expect("previously supported expression still parses");
            // Same shape as the evaluator has always produced (JsonPath / NodeLookup / ItemIndex).
            assert!(matches!(
                before,
                ExprAst::JsonPath(_) | ExprAst::NodeLookup { .. } | ExprAst::ItemIndex
            ));
        }
        assert_eq!(parse("={{ $runIndex }}").unwrap(), ExprAst::RunIndex);
        // And the previously-unresolvable name no longer errors.
        assert!(crate::parser::parse("={{ $runIndex }}").is_ok());
    }
}
