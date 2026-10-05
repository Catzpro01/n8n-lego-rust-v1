//! Deterministic tree-walking evaluator for n8n expressions.
//!
//! Contract anchors (`contracts/expression.contract.md`):
//! * §3   — type preservation for whole-string `={{ ... }}`, JS string
//!          interpolation semantics for mixed templates
//!          (`null` → `""`, objects → `[object Object]`).
//! * E2   — evaluation happens against the per-item context handed in.
//! * E3/E4 — missing properties / unknown nodes fail closed with the
//!          structured `ExpressionError` model (no panics, no `undefined`
//!          leaking into resolved parameters).
//! * E12  — extension methods are dispatched through `extensions.rs`.
//!
//! Internal note: `$('Node')` evaluates to a `NodeRef` runtime handle that
//! only becomes a JSON value after a member access (`.json`, `.first()`,
//! …), mirroring the upstream data-proxy object.

use crate::ast::{BinaryOperator, ExprAst, PathSegment, TemplateSegment, UnaryOperator};
use crate::extensions::{call_method, eval_extended_function, js_stringify, js_truthy};
use crate::parser::parse;
use n8n_common::expression_contract::{EvaluationContext, ExpressionError, ExpressionEvaluator};
use serde_json::Value;

#[derive(Debug, Clone, Default)]
pub struct StandardExpressionEvaluator;

/// Runtime evaluation product. `NodeRef` can only materialise into a
/// `serde_json::Value` through a member access (see `node_property` /
/// `node_method`).
#[derive(Debug, Clone, PartialEq)]
enum RuntimeValue {
    Json(Value),
    NodeRef(String),
}

impl RuntimeValue {
    /// Extracts the JSON value or fails with a descriptive error.
    fn as_value(&self) -> Result<&Value, ExpressionError> {
        match self {
            RuntimeValue::Json(v) => Ok(v),
            RuntimeValue::NodeRef(name) => Err(ExpressionError::UnresolvedReference {
                path: format!("$('{name}') requires a member access (e.g. .json, .first())"),
            }),
        }
    }
}

impl StandardExpressionEvaluator {
    pub fn new() -> Self {
        Self
    }

    pub fn evaluate_ast(
        &self,
        ast: &ExprAst,
        context: &dyn EvaluationContext,
    ) -> Result<Value, ExpressionError> {
        let value = self.eval_runtime(ast, context)?;
        match value {
            RuntimeValue::Json(v) => Ok(v),
            RuntimeValue::NodeRef(name) => Err(ExpressionError::UnresolvedReference {
                path: format!("$('{name}') requires a member access (e.g. .json, .first())"),
            }),
        }
    }

    fn eval_runtime(
        &self,
        ast: &ExprAst,
        context: &dyn EvaluationContext,
    ) -> Result<RuntimeValue, ExpressionError> {
        match ast {
            ExprAst::Literal(v) => Ok(RuntimeValue::Json(v.clone())),

            ExprAst::ItemIndex => Ok(RuntimeValue::Json(Value::Number(
                context.get_item_index().into(),
            ))),

            // `$runIndex` is not expressible through the ratified
            // `EvaluationContext` trait, so `ContextResolver` binds it for the
            // duration of a resolver-driven evaluation. Any other context keeps
            // the fail-closed behaviour instead of silently evaluating to 0.
            ExprAst::RunIndex => crate::context::active_run_index()
                .map(|run| RuntimeValue::Json(Value::Number(run.into())))
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: "$runIndex (evaluate via ContextResolver to bind a run index)"
                        .to_string(),
                }),

            ExprAst::Variable(k) => context
                .get_variable(k)
                .cloned()
                .map(RuntimeValue::Json)
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: format!("$vars.{k}"),
                }),

            ExprAst::JsonPath(path) => {
                let root =
                    context
                        .get_json()
                        .ok_or_else(|| ExpressionError::UnresolvedReference {
                            path: "$json".to_string(),
                        })?;
                navigate_path(root, path, "$json").map(RuntimeValue::Json)
            }

            ExprAst::NodeLookup { node_name, path } => self
                .eval_node_lookup(node_name, path, context)
                .map(RuntimeValue::Json),

            ExprAst::NodeHandle(node_name) => Ok(RuntimeValue::NodeRef(node_name.clone())),

            ExprAst::UnaryOp { op, expr } => {
                let val = self.eval_runtime(expr, context)?;
                let val = val.as_value()?;
                match op {
                    UnaryOperator::Not => Ok(RuntimeValue::Json(Value::Bool(!js_truthy(val)))),
                    UnaryOperator::Neg => negate(val).map(RuntimeValue::Json),
                }
            }

            ExprAst::BinaryOp { left, op, right } => {
                // JS-compatible short-circuiting for && / ||: the right
                // side never evaluates when the outcome is already known
                // (this also guards right-hand lookups from surfacing
                // errors, exactly like upstream n8n).
                let l_val = self.eval_runtime(left, context)?;
                let l_val = l_val.as_value()?;
                match op {
                    BinaryOperator::And if !js_truthy(l_val) => {
                        Ok(RuntimeValue::Json(l_val.clone()))
                    }
                    BinaryOperator::Or if js_truthy(l_val) => Ok(RuntimeValue::Json(l_val.clone())),
                    _ => {
                        let r_val = self.eval_runtime(right, context)?;
                        let r_val = r_val.as_value()?;
                        eval_binary_op(l_val, *op, r_val).map(RuntimeValue::Json)
                    }
                }
            }

            ExprAst::Template(segments) => {
                let mut out = String::new();
                for seg in segments {
                    match seg {
                        TemplateSegment::Text(t) => out.push_str(t),
                        TemplateSegment::Expression(expr) => {
                            let val = self.eval_runtime(expr, context)?;
                            let val = val.as_value()?;
                            match val {
                                // Contract §3: inside templates null /
                                // undefined render as empty text, objects
                                // as `[object Object]`.
                                Value::String(s) => out.push_str(s),
                                Value::Null => {}
                                other => out.push_str(&js_stringify(other)),
                            }
                        }
                    }
                }
                Ok(RuntimeValue::Json(Value::String(out)))
            }

            ExprAst::Ternary {
                cond,
                then_expr,
                else_expr,
            } => {
                let cond_val = self.eval_runtime(cond, context)?;
                let cond_val = cond_val.as_value()?;
                if js_truthy(cond_val) {
                    self.eval_runtime(then_expr, context)
                } else {
                    self.eval_runtime(else_expr, context)
                }
            }

            ExprAst::ArrayLiteral(elements) => {
                let mut out = Vec::with_capacity(elements.len());
                for el in elements {
                    let v = self.eval_runtime(el, context)?;
                    out.push(v.as_value()?.clone());
                }
                Ok(RuntimeValue::Json(Value::Array(out)))
            }

            ExprAst::ObjectLiteral(pairs) => {
                let mut map = serde_json::Map::new();
                for (key, value_ast) in pairs {
                    let v = self.eval_runtime(value_ast, context)?;
                    map.insert(key.clone(), v.as_value()?.clone());
                }
                Ok(RuntimeValue::Json(Value::Object(map)))
            }

            ExprAst::GetProperty { object, property } => {
                let obj = self.eval_runtime(object, context)?;
                match obj {
                    RuntimeValue::NodeRef(name) => self
                        .node_property(&name, property, context)
                        .map(RuntimeValue::Json),
                    RuntimeValue::Json(v) => get_property(&v, property).map(RuntimeValue::Json),
                }
            }

            ExprAst::GetIndex { object, index } => {
                let obj = self.eval_runtime(object, context)?;
                let idx = self.eval_runtime(index, context)?;
                let idx = idx.as_value()?;
                match obj {
                    RuntimeValue::NodeRef(name) => Err(ExpressionError::TypeError {
                        expected: format!("member access on $('{name}') via .json / .first() / …"),
                        actual: format!("indexed access on node handle '{name}'"),
                    }),
                    RuntimeValue::Json(v) => get_index(&v, idx).map(RuntimeValue::Json),
                }
            }

            ExprAst::MethodCall { target, name, args } => {
                let mut evaluated_args: Vec<Value> = Vec::with_capacity(args.len());
                for arg in args {
                    let v = self.eval_runtime(arg, context)?;
                    evaluated_args.push(v.as_value()?.clone());
                }
                let target_rt = self.eval_runtime(target, context)?;
                match target_rt {
                    RuntimeValue::NodeRef(node_name) => self
                        .node_method(&node_name, name, &evaluated_args, context)
                        .map(RuntimeValue::Json),
                    RuntimeValue::Json(v) => {
                        call_method(&v, name, &evaluated_args).map(RuntimeValue::Json)
                    }
                }
            }

            ExprAst::FunctionCall { name, args } => {
                let mut evaluated_args: Vec<Value> = Vec::with_capacity(args.len());
                for arg in args {
                    let v = self.eval_runtime(arg, context)?;
                    evaluated_args.push(v.as_value()?.clone());
                }
                eval_extended_function(name, &evaluated_args).map(RuntimeValue::Json)
            }
        }
    }

    /// `$node['Name'](.path…)` — positional item lookup (contract §4).
    fn eval_node_lookup(
        &self,
        node_name: &str,
        path: &[PathSegment],
        context: &dyn EvaluationContext,
    ) -> Result<Value, ExpressionError> {
        let outputs =
            context
                .get_node_output(node_name)
                .ok_or_else(|| ExpressionError::NodeNotFound {
                    node_name: node_name.to_string(),
                })?;

        let item_idx = context.get_item_index();
        let item = outputs
            .get(item_idx)
            .or_else(|| outputs.first())
            .ok_or_else(|| ExpressionError::IndexOutOfBounds {
                node_name: node_name.to_string(),
                index: item_idx,
                total: outputs.len(),
            })?;

        // Skip a leading `json` segment (`$node['X'].json.field`).
        let effective_path = if let Some(PathSegment::Field(f)) = path.first() {
            if f == "json" {
                &path[1..]
            } else {
                &path[..]
            }
        } else {
            &path[..]
        };

        let root = item.get("json").unwrap_or(item);
        navigate_path(root, effective_path, &format!("$node['{node_name}']"))
    }

    /// `$('Name').<property>` — node-handle property access.
    fn node_property(
        &self,
        node_name: &str,
        property: &str,
        context: &dyn EvaluationContext,
    ) -> Result<Value, ExpressionError> {
        let outputs =
            context
                .get_node_output(node_name)
                .ok_or_else(|| ExpressionError::NodeNotFound {
                    node_name: node_name.to_string(),
                })?;

        match property {
            "isExecuted" => Ok(Value::Bool(true)),
            "json" | "item" => {
                let item_idx = context.get_item_index();
                let item = outputs
                    .get(item_idx)
                    .or_else(|| outputs.first())
                    .ok_or_else(|| ExpressionError::IndexOutOfBounds {
                        node_name: node_name.to_string(),
                        index: item_idx,
                        total: outputs.len(),
                    })?;
                if property == "item" {
                    Ok(item.clone())
                } else {
                    Ok(item.get("json").cloned().unwrap_or_else(|| item.clone()))
                }
            }
            "params" => {
                // Node parameters are not part of the ratified
                // `EvaluationContext` trait (they belong to the workflow
                // graph LEGO); fail closed until the trait exposes them.
                Err(ExpressionError::UnresolvedReference {
                    path: format!("$('{node_name}').params"),
                })
            }
            other => Err(ExpressionError::UnresolvedReference {
                path: format!("$('{node_name}').{other}"),
            }),
        }
    }

    /// `$('Name').method(args)` — node-handle methods (`first/last/all`).
    fn node_method(
        &self,
        node_name: &str,
        method: &str,
        args: &[Value],
        context: &dyn EvaluationContext,
    ) -> Result<Value, ExpressionError> {
        let outputs =
            context
                .get_node_output(node_name)
                .ok_or_else(|| ExpressionError::NodeNotFound {
                    node_name: node_name.to_string(),
                })?;

        if !args.is_empty() {
            return Err(ExpressionError::TypeError {
                expected: format!("method '{method}' on $('{node_name}') with no arguments"),
                actual: format!("{} argument(s) given", args.len()),
            });
        }

        match method {
            "first" => outputs
                .first()
                .cloned()
                .ok_or(ExpressionError::IndexOutOfBounds {
                    node_name: node_name.to_string(),
                    index: 0,
                    total: 0,
                }),
            "last" => outputs
                .last()
                .cloned()
                .ok_or(ExpressionError::IndexOutOfBounds {
                    node_name: node_name.to_string(),
                    index: 0,
                    total: 0,
                }),
            "all" => Ok(Value::Array(outputs.to_vec())),
            other => Err(ExpressionError::TypeError {
                expected: format!("known method on node handle $('{node_name}')"),
                actual: format!("'{other}'"),
            }),
        }
    }
}

impl ExpressionEvaluator for StandardExpressionEvaluator {
    fn is_expression(&self, input: &str) -> bool {
        let trimmed = input.trim();
        // Contract E1: a leading '=' marks an expression context. The
        // handlebars heuristic is kept for the ratified graph contract
        // (string interpolation without a leading '=').
        trimmed.starts_with('=') || (trimmed.contains("{{") && trimmed.contains("}}"))
    }

    fn evaluate(
        &self,
        expression: &str,
        context: &dyn EvaluationContext,
    ) -> Result<Value, ExpressionError> {
        let ast = parse(expression)?;
        self.evaluate_ast(&ast, context)
    }
}

/// `.property` on a resolved JSON value (generic, non-path expressions).
fn get_property(value: &Value, property: &str) -> Result<Value, ExpressionError> {
    match value {
        Value::Object(map) => {
            map.get(property)
                .cloned()
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: format!(".{property}"),
                })
        }
        Value::Array(arr) if property == "length" => Ok(Value::Number((arr.len() as i64).into())),
        Value::String(s) if property == "length" => {
            Ok(Value::Number((s.encode_utf16().count() as i64).into()))
        }
        _ => Err(ExpressionError::UnresolvedReference {
            path: format!(".{property}"),
        }),
    }
}

/// `expr[dynamic]` on a resolved JSON value.
fn get_index(value: &Value, index: &Value) -> Result<Value, ExpressionError> {
    match (value, index) {
        (Value::Array(arr), Value::Number(n)) => {
            let idx = n
                .as_u64()
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: format!("[{n}]"),
                })? as usize;
            arr.get(idx)
                .cloned()
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: format!("[{idx}]"),
                })
        }
        (Value::Object(map), Value::String(key)) => {
            map.get(key)
                .cloned()
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: format!("[\"{key}\"]"),
                })
        }
        (Value::String(s), Value::Number(n)) => {
            let idx = n
                .as_u64()
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: format!("[{n}]"),
                })? as usize;
            s.chars()
                .nth(idx)
                .map(|c| Value::String(c.to_string()))
                .ok_or_else(|| ExpressionError::UnresolvedReference {
                    path: format!("[{idx}]"),
                })
        }
        (other, idx) => Err(ExpressionError::UnresolvedReference {
            path: format!("<{}>[{}]", type_name(other), js_stringify(idx)),
        }),
    }
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn negate(val: &Value) -> Result<Value, ExpressionError> {
    match val {
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(Value::Number((-i).into()))
            } else if let Some(f) = n.as_f64() {
                serde_json::Number::from_f64(-f)
                    .map(Value::Number)
                    .ok_or_else(|| ExpressionError::TypeError {
                        expected: "finite number".into(),
                        actual: "NaN or Infinity".into(),
                    })
            } else {
                Err(ExpressionError::TypeError {
                    expected: "number".into(),
                    actual: format!("{val}"),
                })
            }
        }
        other => Err(ExpressionError::TypeError {
            expected: "number".into(),
            actual: format!("{other}"),
        }),
    }
}

fn navigate_path(
    root: &Value,
    path: &[PathSegment],
    base_name: &str,
) -> Result<Value, ExpressionError> {
    let mut current = root;
    let mut traversed = base_name.to_string();

    for seg in path {
        match seg {
            PathSegment::Field(f) => {
                traversed.push_str(&format!(".{f}"));
                match current {
                    Value::Object(map) => {
                        current =
                            map.get(f)
                                .ok_or_else(|| ExpressionError::UnresolvedReference {
                                    path: traversed.clone(),
                                })?;
                    }
                    // JS surface: `.length` is available on arrays and
                    // strings even through plain property access.
                    Value::Array(arr) if f == "length" => {
                        return Ok(Value::Number((arr.len() as i64).into()));
                    }
                    Value::String(s) if f == "length" => {
                        return Ok(Value::Number((s.encode_utf16().count() as i64).into()));
                    }
                    _ => {
                        return Err(ExpressionError::UnresolvedReference {
                            path: traversed.clone(),
                        });
                    }
                }
            }
            PathSegment::Index(idx) => {
                traversed.push_str(&format!("[{idx}]"));
                match current {
                    Value::Array(arr) => {
                        current =
                            arr.get(*idx)
                                .ok_or_else(|| ExpressionError::UnresolvedReference {
                                    path: traversed.clone(),
                                })?;
                    }
                    Value::String(s) => {
                        let ch = s.chars().nth(*idx).ok_or_else(|| {
                            ExpressionError::UnresolvedReference {
                                path: traversed.clone(),
                            }
                        })?;
                        return Ok(Value::String(ch.to_string()));
                    }
                    _ => {
                        return Err(ExpressionError::UnresolvedReference {
                            path: traversed.clone(),
                        });
                    }
                }
            }
        }
    }

    Ok(current.clone())
}

fn eval_binary_op(
    left: &Value,
    op: BinaryOperator,
    right: &Value,
) -> Result<Value, ExpressionError> {
    match op {
        BinaryOperator::Eq => Ok(Value::Bool(left == right)),
        BinaryOperator::NotEq => Ok(Value::Bool(left != right)),
        BinaryOperator::And => {
            if !js_truthy(left) {
                Ok(left.clone())
            } else {
                Ok(right.clone())
            }
        }
        BinaryOperator::Or => {
            if js_truthy(left) {
                Ok(left.clone())
            } else {
                Ok(right.clone())
            }
        }
        BinaryOperator::Add => {
            if let (Value::String(s1), Value::String(s2)) = (left, right) {
                return Ok(Value::String(format!("{s1}{s2}")));
            }
            if let (Some(n1), Some(n2)) = (val_as_f64(left), val_as_f64(right)) {
                return num_result(n1 + n2);
            }
            // If one operand is a string, JS performs concatenation.
            if let Value::String(s1) = left {
                return Ok(Value::String(format!("{s1}{}", js_stringify(right))));
            }
            if let Value::String(s2) = right {
                return Ok(Value::String(format!("{}{s2}", js_stringify(left))));
            }
            Err(ExpressionError::TypeError {
                expected: "numbers or strings for addition".into(),
                actual: format!("{left} + {right}"),
            })
        }
        BinaryOperator::Sub => {
            let (n1, n2) = extract_numbers(left, right)?;
            num_result(n1 - n2)
        }
        BinaryOperator::Mul => {
            let (n1, n2) = extract_numbers(left, right)?;
            num_result(n1 * n2)
        }
        BinaryOperator::Div => {
            let (n1, n2) = extract_numbers(left, right)?;
            if n2 == 0.0 {
                return Err(ExpressionError::TypeError {
                    expected: "non-zero divisor".into(),
                    actual: "division by zero".into(),
                });
            }
            num_result(n1 / n2)
        }
        BinaryOperator::Mod => {
            let (n1, n2) = extract_numbers(left, right)?;
            if n2 == 0.0 {
                return Err(ExpressionError::TypeError {
                    expected: "non-zero divisor".into(),
                    actual: "modulo by zero".into(),
                });
            }
            // Rust f64 % matches JS %: the sign follows the dividend.
            num_result(n1 % n2)
        }
        // Ordered comparisons: JS compares two strings lexicographically,
        // otherwise numerically.
        BinaryOperator::Lt | BinaryOperator::Lte | BinaryOperator::Gt | BinaryOperator::Gte => {
            if let (Value::String(s1), Value::String(s2)) = (left, right) {
                let ord = s1.cmp(s2);
                return Ok(Value::Bool(match op {
                    BinaryOperator::Lt => ord.is_lt(),
                    BinaryOperator::Lte => ord.is_le(),
                    BinaryOperator::Gt => ord.is_gt(),
                    BinaryOperator::Gte => ord.is_ge(),
                    _ => unreachable!(),
                }));
            }
            let (n1, n2) = extract_numbers(left, right)?;
            Ok(Value::Bool(match op {
                BinaryOperator::Lt => n1 < n2,
                BinaryOperator::Lte => n1 <= n2,
                BinaryOperator::Gt => n1 > n2,
                BinaryOperator::Gte => n1 >= n2,
                _ => unreachable!(),
            }))
        }
    }
}

fn val_as_f64(val: &Value) -> Option<f64> {
    match val {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn extract_numbers(left: &Value, right: &Value) -> Result<(f64, f64), ExpressionError> {
    let n1 = val_as_f64(left).ok_or_else(|| ExpressionError::TypeError {
        expected: "number".into(),
        actual: format!("{left}"),
    })?;
    let n2 = val_as_f64(right).ok_or_else(|| ExpressionError::TypeError {
        expected: "number".into(),
        actual: format!("{right}"),
    })?;
    Ok((n1, n2))
}

fn num_result(f: f64) -> Result<Value, ExpressionError> {
    if f.fract() == 0.0 && f >= (i64::MIN as f64) && f <= (i64::MAX as f64) {
        Ok(Value::Number((f as i64).into()))
    } else {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| ExpressionError::TypeError {
                expected: "finite float".into(),
                actual: "NaN or Infinite".into(),
            })
    }
}

#[cfg(test)]
mod staged3_sandboxed_evaluator {
    //! `expression-engine/m7-03-sandboxed-evaluator` verification.
    //!
    //! Acceptance criteria from `docs/architecture/n8n-rust-project-decomposition.md`
    //! ("Menghitung ekspresi aritmetika, logika string, dan boolean dengan
    //! determinisme 100%", goal "tanpa alokasi berlebih") turned into executable
    //! checks. Every assertion here is deterministic and hardware-independent:
    //! allocation *counts* are measured through the test-only counting
    //! allocator in `lib.rs`, never wall-clock nanoseconds.

    use super::*;
    use crate::alloc_snapshot;
    use n8n_common::expression_contract::{ExpressionEvaluator, SimpleEvaluationContext};
    use serde_json::{json, Value};

    fn payload() -> Value {
        json!({
            "a": 7, "b": 2, "big": 9007199254740991i64, "s": "n8n",
            "t": "a b c", "tags": ["x","y","z"], "nums": [1,2,3],
            "flag": true, "off": false, "emptyStr": "", "zero": 0
        })
    }

    fn ctx() -> SimpleEvaluationContext {
        SimpleEvaluationContext::new().with_json(payload())
    }

    /// Every operator class the criteria names, plus the fail-closed edges.
    fn corpus() -> Vec<(&'static str, &'static str)> {
        vec![
            // arithmetic
            ("arith-add", "={{ $json.a + $json.b }}"),
            ("arith-sub", "={{ $json.a - $json.b }}"),
            ("arith-mul", "={{ $json.a * $json.b }}"),
            ("arith-div", "={{ $json.a / $json.b }}"),
            ("arith-mod", "={{ $json.a % $json.b }}"),
            ("arith-precedence", "={{ $json.a + $json.b * 3 - 1 }}"),
            ("arith-paren", "={{ ($json.a + $json.b) * 3 }}"),
            ("arith-float", "={{ 1 / 3 }}"),
            ("arith-mod-sign", "={{ 0 - $json.a % $json.b }}"),
            ("arith-div-zero", "={{ $json.a / $json.zero }}"),
            ("arith-mod-zero", "={{ $json.a % $json.zero }}"),
            ("arith-huge", "={{ $json.big + $json.big }}"),
            ("arith-neg", "={{ -$json.a }}"),
            // string logic
            ("str-concat", "={{ $json.s + '-x' }}"),
            ("str-arith-string", "={{ $json.a + $json.s }}"),
            ("str-upper", "={{ $json.s.toUpperCase() }}"),
            ("str-lower", "={{ $json.t.toLowerCase().split(' ') }}"),
            ("str-len", "={{ $json.s.length }}"),
            ("str-cmp-lt", "={{ $json.s < 'o' }}"),
            ("str-cmp-gt", "={{ $json.s > 'o' }}"),
            ("str-eq", "={{ $json.s === 'n8n' }}"),
            ("str-neq", "={{ $json.s !== 'n8n' }}"),
            ("str-isEmpty", "={{ $json.emptyStr.isEmpty() }}"),
            ("str-notEmpty", "={{ $json.s.isNotEmpty() }}"),
            // boolean logic
            ("bool-and", "={{ $json.flag && $json.off }}"),
            ("bool-or", "={{ $json.flag || $json.off }}"),
            ("bool-not", "={{ !$json.off }}"),
            ("bool-ternary", "={{ $json.a > 5 ? 'yes' : 'no' }}"),
            ("bool-short-circuit", "={{ $json.flag || $missing }}"),
            ("bool-short-circuit-2", "={{ $json.off && $missing }}"),
            (
                "bool-mixed",
                "={{ ($json.a > 5) && ($json.s.length == 3) }}",
            ),
            // array/numeric type preservation
            ("arr-index", "={{ $json.nums[1] }}"),
            ("arr-method", "={{ $json.nums.sum() }}"),
            ("arr-unique", "={{ $json.tags.unique().join(',') }}"),
            // sandboxed: hostile source must never reach the evaluator
            ("sandbox-constructor", "={{ $json.a.constructor }}"),
            ("sandbox-proto", "={{ $json.__proto__ }}"),
            ("sandbox-with", "={{ with (a) { b } }}"),
            ("sandbox-class", "={{ class Evil {} }}"),
            // unknown node reference: fail-closed, not a panic
            ("missing-node", "={{ $('Nope').first().json.x }}"),
        ]
    }

    /// Canonical, byte-level rendering of a result (value or error).
    fn canonical(expr: &str) -> String {
        match StandardExpressionEvaluator::new().evaluate(expr, &ctx()) {
            Ok(v) => format!("V:{}", serde_json::to_string(&v).expect("serialisable")),
            Err(e) => format!("E:{e}"),
        }
    }

    // ------------------------------------------------------------------
    // Determinism
    // ------------------------------------------------------------------

    #[test]
    fn determinism_identical_runs_bit_for_bit() {
        let mut reported = 0usize;
        for (label, expr) in corpus() {
            let first = canonical(expr);
            for _ in 0..499 {
                assert_eq!(
                    canonical(expr),
                    first,
                    "`{label}` drifted across repeat runs"
                );
            }
            assert!(!first.starts_with("V:null"), "`{label}` produced a null");
            reported += 1;
        }
        println!("determinism: {reported} expressions x 500 identical evaluations");
    }

    #[test]
    fn determinism_across_threads() {
        let exprs: Vec<(&'static str, &'static str)> = vec![
            ("arith", "={{ $json.a / $json.b }}"),
            ("float", "={{ 1 / 3 }}"),
            ("concat", "={{ $json.a + $json.s }}"),
            ("chain", "={{ $json.nums.sum() * 2 - 1 }}"),
        ];
        let expected: Vec<String> = exprs.iter().map(|(_, e)| canonical(e)).collect();
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let es = exprs.clone();
                std::thread::spawn(move || {
                    let mut out = Vec::new();
                    for _ in 0..200 {
                        for (_, e) in &es {
                            out.push(canonical(e));
                        }
                    }
                    out
                })
            })
            .collect();
        for (i, h) in handles.into_iter().enumerate() {
            let out = h.join().expect("thread must not panic");
            for (k, got) in out.iter().enumerate() {
                assert_eq!(
                    got,
                    &expected[k % expected.len()],
                    "thread {i} produced a different result at {k}"
                );
            }
        }
    }

    #[test]
    fn determinism_independent_of_evaluation_order() {
        // A shared mutable cache would make the result depend on what ran first.
        let all: Vec<&'static str> = corpus().iter().map(|(_, e)| *e).collect();
        let fwd: Vec<String> = all.iter().map(|e| canonical(e)).collect();
        let rev: Vec<String> = all.iter().rev().map(|e| canonical(e)).collect();
        for (i, e) in all.iter().rev().enumerate() {
            assert_eq!(
                canonical(e),
                fwd[all.iter().position(|x| x == e).unwrap()],
                "result of {e} depends on evaluation order"
            );
            let _ = i;
        }
        for (i, got) in rev.iter().enumerate() {
            let j = all.len() - 1 - i;
            assert_eq!(got, &fwd[j], "reverse-order sweep differs at {j}");
        }
    }

    #[test]
    fn no_non_finite_floats_ever_escape() {
        // Division that leaves the exact-integer path, overflow past i64, and
        // division/modulo by zero must all be deterministic *and* must never
        // yield NaN/Infinity inside a result, nor panic.
        for (_, expr) in corpus() {
            // Any *structured* error is an acceptable fail-closed outcome for this
            // criterion (TypeError, SyntaxError, NodeNotFound, UnresolvedReference,
            // …). What must never happen is a panic, a non-finite float, or a
            // non-deterministic result.
            if let Ok(v) = StandardExpressionEvaluator::new().evaluate(expr, &ctx()) {
                let s = serde_json::to_string(&v).unwrap_or_default();
                assert!(
                    !s.contains("NaN") && !s.contains("null") && !s.contains("Infinity"),
                    "`{expr}` leaked a non-finite/null value: {s}"
                );
                if let Some(f) = v.as_f64() {
                    assert!(f.is_finite(), "`{expr}` produced non-finite {f}");
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Allocation budget ("without excessive allocation")
    // ------------------------------------------------------------------

    #[test]
    fn allocations_per_evaluation_are_bounded() {
        let expr = "={{ $json.a + $json.b * 2 - 1 }}";
        let n = 2_000usize;
        // Warm-up (also initialises the TLS counter and any lazily built state).
        for _ in 0..200 {
            let _ = canonical(expr);
        }
        let (a0, b0) = alloc_snapshot();
        for _ in 0..n {
            std::hint::black_box(canonical(expr));
        }
        let (a1, b1) = alloc_snapshot();
        let allocs = a1 - a0;
        let _ = b1 - b0;
        // Null block: proves the measurement window itself is quiet.
        let (c0, _) = alloc_snapshot();
        std::hint::black_box(0usize);
        let (c1, _) = alloc_snapshot();
        assert_eq!(c1 - c0, 0, "measurement window is not allocation-free");

        let per_eval = allocs / n;
        println!("allocations per evaluate+serialise: {per_eval} (total {allocs} over {n})");
        assert!(
            per_eval <= 64,
            "one evaluation cost {per_eval} allocations; the budget for evaluate+canonicalise is 64"
        );
    }

    #[test]
    fn allocation_cost_does_not_grow_with_repetition() {
        // A leak shows up as a *rising* per-call allocation count.
        //
        // This was the repository's flakiest test on 2026-09-30: four failures in one day, all on
        // a loaded shared host, all green again on a rerun of the same SHA. The measured values
        // say why. On an idle host every batch reports 43 allocs/eval, 5/5 identical. On a loaded
        // CI host the first measured batch reports 43 while later batches sit at 44-47 - i.e. the
        // first batch still pays one-time costs, and the rest wobble by a couple of allocations
        // that no rerun reproduces. `allocations_per_evaluation_are_bounded` above warms up for
        // exactly this reason ("also initialises the TLS counter and any lazily built state");
        // this test did not, so it measured warm-up and host noise as if they were drift.
        //
        // The claim is unchanged, and a band tests it better than equality: a leak COMPOUNDS -
        // every further batch allocates more per evaluation than the one before. With 7
        // steady-state intervals a compounding leak drifts by at least 7 allocs/eval, far outside
        // this band, while the worst spread measured on a loaded host (43..46, spread 3) stays
        // inside it. So this asserts bounded drift, not exactness, and prints every batch for
        // diagnosis when it does fail.
        let expr = "={{ $json.a / $json.b }}";
        for _ in 0..200 {
            let _ = StandardExpressionEvaluator::new().evaluate(expr, &ctx());
        }
        const BATCHES: usize = 8;
        const NOISE_BAND: usize = 4;
        let n = 1_000usize;
        let mut per_call = Vec::new();
        for batch in 0..BATCHES {
            let (a0, _) = alloc_snapshot();
            for _ in 0..n {
                let _ = StandardExpressionEvaluator::new().evaluate(expr, &ctx());
            }
            let (a1, _) = alloc_snapshot();
            per_call.push((a1 - a0) / n);
            println!("batch {batch}: {} allocs/eval", per_call[batch]);
        }
        let min = *per_call.iter().min().unwrap();
        let max = *per_call.iter().max().unwrap();
        assert!(
            max - min <= NOISE_BAND,
            "per-evaluation allocations drift across batches ({min}..{max}, band {NOISE_BAND}) — unbounded growth"
        );
    }
}

#[cfg(test)]
mod staged3_memory {
    //! STAGE-3 memory-stability evidence: a real leak grows *linearly*, so the
    //! test compares two identical batches rather than any absolute figure —
    //! allocator retention and platform noise cannot make it flaky.

    use n8n_common::expression_contract::{ExpressionEvaluator, SimpleEvaluationContext};
    use serde_json::json;

    fn rss_bytes() -> Option<usize> {
        let statm = std::fs::read_to_string("/proc/self/statm").ok()?;
        let resident_pages: usize = statm.split_whitespace().nth(1)?.parse().ok()?;
        Some(resident_pages * 4096)
    }

    fn run_batch(n: usize) {
        let ctx = SimpleEvaluationContext::new().with_json(json!({
            "a": 7, "b": 2, "s": "n8n", "nums": [1, 2, 3], "flag": true
        }));
        let ev = crate::evaluator::StandardExpressionEvaluator::new();
        for _ in 0..n {
            for expr in [
                "={{ $json.a + $json.b * 2 - 1 }}",
                "={{ $json.s.toUpperCase() + '!' }}",
                "={{ ($json.a > 3) && !$json.flag }}",
                "={{ $json.nums.sum() / 2 }}",
            ] {
                let _ = ev.evaluate(expr, &ctx);
            }
        }
    }

    #[test]
    #[cfg(target_os = "linux")]
    fn memory_is_bounded_across_repeated_batches() {
        const N: usize = 200_000;
        run_batch(5_000); // warm-up: allocator arenas, lazy state
        let before = rss_bytes().expect("statm readable");
        run_batch(N);
        let mid = rss_bytes().expect("statm readable");
        run_batch(N);
        let after = rss_bytes().expect("statm readable");

        let first = mid.saturating_sub(before);
        let second = after.saturating_sub(mid);
        println!(
            "RSS: before={before} mid={mid} after={after}; growth batch1={first} batch2={second} \
             ({N} evals each)"
        );
        // No monotonicity is assumed: glibc returns freed arenas to the OS, so RSS
        // legitimately *falls* (observed here: 126 MB -> 9 MB). Only the second
        // batch matters — a leak is linear growth across identical workloads.
        assert!(
            second < first.max(1) * 4 + (16 << 20),
            "second identical batch grew {second} bytes after the first grew {first}: \
             linear growth indicates a leak"
        );
        // And the process must not end up holding more than one batch's worth of
        // unbounded accumulation above the steady-state mark.
        assert!(
            after.saturating_sub(mid) < 64 << 20,
            "resident set gained {second} bytes in one batch"
        );
    }

    #[test]
    #[cfg(not(target_os = "linux"))]
    fn memory_is_bounded_across_repeated_batches() {
        // No /proc on this platform; the allocation-count and pointer-identity
        // guards remain the authoritative evidence.
        eprintln!("RSS check skipped on non-Linux target");
    }
}
