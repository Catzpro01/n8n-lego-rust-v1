//! n8n extension methods and extended functions (contract invariant E12).
//!
//! Upstream n8n v2.9.4 rewrites `value.method(...)` through `extendSyntax()`
//! into `extend(value, 'method', args)` and resolves it against the
//! extension libraries in `packages/workflow/src/extensions/*-extensions.ts`
//! plus the extended functions in `extended-functions.ts`. Native JavaScript
//! methods pass through unchanged.
//!
//! This module is the Rust equivalent: a deterministic, side-effect-free
//! dispatch over `serde_json::Value`. Methods that do not exist for a given
//! type are rejected fail-closed with a structured error instead of
//! silently returning `undefined` (the project-wide strict error model).
//!
//! Documented, deliberate divergences from upstream:
//! * No method mutates its target (e.g. `push`, `sort`, `reverse` return a
//!   *new* array). Execution data is immutable in the Rust runtime.
//! * `length` on strings counts UTF-16 code units only through
//!   `encode_utf16()` (identical to JS for all practical payloads).
//! * Invalid numeric conversions raise `TypeError` instead of yielding
//!   `NaN`, because `NaN` cannot be represented in a `serde_json::Value`.
//! * Date/DateTime extensions are not part of this module (no luxon/chrono
//!   dependency is allowed to be added by this LEGO); calling them fails
//!   closed as "unknown method".

use n8n_common::expression_contract::ExpressionError;
use serde_json::Value;

// ===========================================================================
// Shared JS-ish value helpers (also used by the evaluator and lib glue).
// ===========================================================================

/// Strict truthiness used by the evaluator's `&&`/`||`/`!` and ternary.
///
/// Matches the pre-existing evaluator semantics: empty array/object are
/// falsy (differs from raw JS where `[]` and `{}` are truthy — kept for
/// backwards compatibility with the Phase-3 pilot behaviour).
pub fn js_truthy(val: &Value) -> bool {
    match val {
        Value::Bool(b) => *b,
        Value::Null => false,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
        Value::String(s) => !s.is_empty(),
        Value::Array(arr) => !arr.is_empty(),
        Value::Object(map) => !map.is_empty(),
    }
}

/// n8n `isEmpty` extension semantics on a raw value.
pub fn is_empty_value(val: &Value) -> bool {
    match val {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(arr) => arr.is_empty(),
        Value::Object(map) => map.is_empty(),
        Value::Number(_) | Value::Bool(_) => false,
    }
}

/// `String(value)` coercion used by interpolations and the `toString()`
/// extension: objects become `[object Object]`, arrays are joined with
/// `,` (recursively, `null` elements render as empty), numbers use the
/// shortest JSON representation.
pub fn js_stringify(val: &Value) -> String {
    match val {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => s.clone(),
        Value::Array(arr) => arr
            .iter()
            .map(js_array_element_string)
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// Element-level stringification for arrays: `null`/`undefined` render as
/// empty strings (matches `String([null, 1]) === ",1"` in JS).
fn js_array_element_string(val: &Value) -> String {
    match val {
        Value::Null => String::new(),
        other => js_stringify(other),
    }
}

/// Builds a JSON number from an f64: integrals collapse to `i64`, finite
/// floats keep precision, NaN/Infinity fail closed.
fn f64_to_value(f: f64) -> Result<Value, ExpressionError> {
    if f.is_nan() || f.is_infinite() {
        return Err(ExpressionError::TypeError {
            expected: "finite number".into(),
            actual: if f.is_nan() {
                "NaN".into()
            } else {
                "Infinity".into()
            },
        });
    }
    if f.fract() == 0.0 && f >= i64::MIN as f64 && f <= i64::MAX as f64 {
        Ok(Value::Number((f as i64).into()))
    } else {
        serde_json::Number::from_f64(f)
            .map(Value::Number)
            .ok_or_else(|| ExpressionError::TypeError {
                expected: "finite float".into(),
                actual: format!("{f}"),
            })
    }
}

fn as_f64(val: &Value) -> Option<f64> {
    match val {
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn arity_error(name: &str, expected: &str, got: usize) -> ExpressionError {
    ExpressionError::TypeError {
        expected: format!("method '{name}' with {expected}"),
        actual: format!("{got} argument(s) given"),
    }
}

fn unknown_method(type_name: &str, name: &str) -> ExpressionError {
    ExpressionError::TypeError {
        expected: format!("known method on {type_name}"),
        actual: format!("'{name}'"),
    }
}

fn arg_string(name: &str, args: &[Value], idx: usize) -> Result<String, ExpressionError> {
    match args.get(idx) {
        Some(Value::String(s)) => Ok(s.clone()),
        Some(other) => Err(ExpressionError::TypeError {
            expected: format!("string argument {idx} for method '{name}'"),
            actual: js_stringify(other),
        }),
        None => Err(arity_error(name, "more arguments", idx)),
    }
}

fn arg_f64(name: &str, args: &[Value], idx: usize) -> Result<f64, ExpressionError> {
    args.get(idx)
        .and_then(as_f64)
        .ok_or_else(|| ExpressionError::TypeError {
            expected: format!("number argument {idx} for method '{name}'"),
            actual: args
                .get(idx)
                .map(js_stringify)
                .unwrap_or_else(|| "<missing>".into()),
        })
}

/// Normalizes one JS slice-style index (negative counts from the end) into a
/// clamped `usize` in `0..=len`.
fn slice_index(index: i64, len: usize) -> usize {
    let len_i = len as i64;
    if index < 0 {
        (len_i + index).max(0) as usize
    } else {
        index.min(len_i) as usize
    }
}

// ===========================================================================
// Value method dispatch (`value.method(args)`).
// ===========================================================================

/// Dispatches `target.name(args)` against the extension/native method set.
/// Fails closed with `TypeError` for unknown methods.
pub fn call_method(target: &Value, name: &str, args: &[Value]) -> Result<Value, ExpressionError> {
    match target {
        Value::String(s) => call_string_method(s, name, args),
        Value::Array(arr) => call_array_method(arr, name, args),
        Value::Number(n) => call_number_method(n, name, args),
        Value::Bool(b) => call_bool_method(*b, name, args),
        Value::Null => call_null_method(name, args),
        Value::Object(map) => call_object_method(map, name, args),
    }
}

fn call_string_method(s: &str, name: &str, args: &[Value]) -> Result<Value, ExpressionError> {
    // Arity guard: every pure method below declares `(min, max)` arity.
    let no_args = |name: &str| -> Result<(), ExpressionError> {
        if args.is_empty() {
            Ok(())
        } else {
            Err(arity_error(name, "no arguments", args.len()))
        }
    };

    match name {
        "isEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(s.is_empty()))
        }
        "isNotEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(!s.is_empty()))
        }
        "length" => {
            no_args(name)?;
            Ok(Value::Number((s.encode_utf16().count() as i64).into()))
        }
        "toString" => {
            no_args(name)?;
            Ok(Value::String(s.to_string()))
        }
        "toNumber" => {
            no_args(name)?;
            string_to_number(s)
        }
        "toBoolean" => {
            no_args(name)?;
            // n8n string-extension behaviour: only the literal "true".
            Ok(Value::Bool(s == "true"))
        }
        "trim" => {
            no_args(name)?;
            Ok(Value::String(s.trim().to_string()))
        }
        "toUpperCase" => {
            no_args(name)?;
            Ok(Value::String(s.to_uppercase()))
        }
        "toLowerCase" => {
            no_args(name)?;
            Ok(Value::String(s.to_lowercase()))
        }
        "urlEncode" => {
            no_args(name)?;
            Ok(Value::String(percent_encode(s)))
        }
        "urlDecode" => {
            no_args(name)?;
            Ok(Value::String(percent_decode(s)))
        }
        "split" => {
            let out: Vec<Value> = match args.first() {
                None => vec![Value::String(s.to_string())],
                Some(Value::String(sep)) if sep.is_empty() => {
                    s.chars().map(|c| Value::String(c.to_string())).collect()
                }
                Some(Value::String(sep)) => s
                    .split(sep.as_str())
                    .map(|p| Value::String(p.to_string()))
                    .collect(),
                Some(other) => {
                    return Err(ExpressionError::TypeError {
                        expected: "string separator for method 'split'".into(),
                        actual: js_stringify(other),
                    })
                }
            };
            Ok(Value::Array(out))
        }
        "contains" => {
            let needle = arg_string(name, args, 0)?;
            Ok(Value::Bool(s.contains(needle.as_str())))
        }
        "startsWith" => {
            let needle = arg_string(name, args, 0)?;
            Ok(Value::Bool(s.starts_with(needle.as_str())))
        }
        "endsWith" => {
            let needle = arg_string(name, args, 0)?;
            Ok(Value::Bool(s.ends_with(needle.as_str())))
        }
        "replace" => {
            let find = arg_string(name, args, 0)?;
            let replacement = arg_string(name, args, 1)?;
            // JS String.replace with a *string* pattern replaces the FIRST
            // occurrence only — replacen mirrors that exactly.
            Ok(Value::String(s.replacen(&find, &replacement, 1)))
        }
        "replaceAll" => {
            let find = arg_string(name, args, 0)?;
            let replacement = arg_string(name, args, 1)?;
            Ok(Value::String(s.replace(&find, &replacement)))
        }
        "slice" => {
            let chars: Vec<char> = s.chars().collect();
            let len = chars.len();
            let start = match args.first() {
                None => 0,
                Some(v) => slice_index(
                    as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                        expected: "number start index for method 'slice'".into(),
                        actual: js_stringify(v),
                    })? as i64,
                    len,
                ),
            };
            let end = match args.get(1) {
                None => len,
                Some(v) => slice_index(
                    as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                        expected: "number end index for method 'slice'".into(),
                        actual: js_stringify(v),
                    })? as i64,
                    len,
                ),
            };
            let out: String = if start >= end {
                String::new()
            } else {
                chars[start..end].iter().collect()
            };
            Ok(Value::String(out))
        }
        "substring" => {
            let chars: Vec<char> = s.chars().collect();
            let len = chars.len() as i64;
            let mut start = match args.first() {
                None => 0,
                Some(_) => arg_f64(name, args, 0)? as i64,
            };
            let mut end = match args.get(1) {
                None => len,
                Some(_) => arg_f64(name, args, 1)? as i64,
            };
            // JS substring semantics: clamp negatives to 0, cap at length,
            // and swap when start > end.
            start = start.clamp(0, len);
            end = end.clamp(0, len);
            if start > end {
                std::mem::swap(&mut start, &mut end);
            }
            let out: String = chars[start as usize..end as usize].iter().collect();
            Ok(Value::String(out))
        }
        "charAt" => {
            let idx = arg_f64(name, args, 0)? as i64;
            let chars: Vec<char> = s.chars().collect();
            let out = if idx < 0 || idx as usize >= chars.len() {
                String::new()
            } else {
                chars[idx as usize].to_string()
            };
            Ok(Value::String(out))
        }
        "indexOf" => {
            let needle = arg_string(name, args, 0)?;
            let from_char_idx = match args.get(1) {
                None => 0usize,
                Some(_) => {
                    let raw = arg_f64(name, args, 1)? as i64;
                    if raw < 0 {
                        0
                    } else {
                        raw as usize
                    }
                }
            };
            let chars: Vec<char> = s.chars().collect();
            if from_char_idx >= chars.len() {
                return Ok(Value::Number((-1).into()));
            }
            let byte_start: usize = s
                .char_indices()
                .nth(from_char_idx)
                .map(|(byte, _)| byte)
                .unwrap_or(s.len());
            match s[byte_start..].find(needle.as_str()) {
                Some(byte_off) => {
                    let char_off = s[byte_start..byte_start + byte_off].chars().count();
                    Ok(Value::Number(((from_char_idx + char_off) as i64).into()))
                }
                None => Ok(Value::Number((-1).into())),
            }
        }
        "padStart" | "padEnd" => {
            let target_len = arg_f64(name, args, 0)? as i64;
            let fill = match args.get(1) {
                None => " ".to_string(),
                Some(Value::String(f)) => f.clone(),
                Some(other) => {
                    return Err(ExpressionError::TypeError {
                        expected: format!("string fill for method '{name}'"),
                        actual: js_stringify(other),
                    })
                }
            };
            let current = s.chars().count();
            let target = target_len.max(0) as usize;
            let mut out = s.to_string();
            if target > current && !fill.is_empty() {
                // JS folds the filler and truncates it to exactly the gap.
                let gap = target - current;
                let fill_chars: Vec<char> = fill.chars().collect();
                let mut pad = String::with_capacity(gap);
                let mut pad_len = 0usize;
                'outer: while pad_len < gap {
                    for &fc in &fill_chars {
                        if pad_len >= gap {
                            break 'outer;
                        }
                        pad.push(fc);
                        pad_len += 1;
                    }
                }
                out = if name == "padStart" {
                    format!("{pad}{s}")
                } else {
                    format!("{s}{pad}")
                };
            }
            Ok(Value::String(out))
        }
        "repeat" => {
            let count = arg_f64(name, args, 0)? as i64;
            if count < 0 {
                return Err(ExpressionError::TypeError {
                    expected: "non-negative count for method 'repeat'".into(),
                    actual: format!("{count}"),
                });
            }
            Ok(Value::String(s.repeat(count as usize)))
        }
        other => Err(unknown_method("string", other)),
    }
}

fn call_array_method(arr: &[Value], name: &str, args: &[Value]) -> Result<Value, ExpressionError> {
    let no_args = |name: &str| -> Result<(), ExpressionError> {
        if args.is_empty() {
            Ok(())
        } else {
            Err(arity_error(name, "no arguments", args.len()))
        }
    };

    match name {
        "isEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(arr.is_empty()))
        }
        "isNotEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(!arr.is_empty()))
        }
        "length" => {
            no_args(name)?;
            Ok(Value::Number((arr.len() as i64).into()))
        }
        "first" => {
            no_args(name)?;
            Ok(arr.first().cloned().unwrap_or(Value::Null))
        }
        "last" => {
            no_args(name)?;
            Ok(arr.last().cloned().unwrap_or(Value::Null))
        }
        "toString" => {
            no_args(name)?;
            Ok(Value::String(js_stringify(&Value::Array(arr.to_vec()))))
        }
        "slice" => {
            let len = arr.len();
            let start = match args.first() {
                None => 0,
                Some(v) => slice_index(
                    as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                        expected: "number start index for method 'slice'".into(),
                        actual: js_stringify(v),
                    })? as i64,
                    len,
                ),
            };
            let end = match args.get(1) {
                None => len,
                Some(v) => slice_index(
                    as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                        expected: "number end index for method 'slice'".into(),
                        actual: js_stringify(v),
                    })? as i64,
                    len,
                ),
            };
            if start >= end {
                Ok(Value::Array(vec![]))
            } else {
                Ok(Value::Array(arr[start..end].to_vec()))
            }
        }
        "join" => {
            let sep = match args.first() {
                None => ",".to_string(),
                Some(Value::String(s)) => s.clone(),
                Some(other) => {
                    return Err(ExpressionError::TypeError {
                        expected: "string separator for method 'join'".into(),
                        actual: js_stringify(other),
                    })
                }
            };
            Ok(Value::String(
                arr.iter()
                    .map(js_array_element_string)
                    .collect::<Vec<_>>()
                    .join(&sep),
            ))
        }
        "push" => {
            // Immutable runtime: returns a NEW array with the element
            // appended (upstream JS mutates and returns the new length).
            let item = args
                .first()
                .cloned()
                .ok_or_else(|| arity_error(name, "1 argument", 0))?;
            let mut out = arr.to_vec();
            out.push(item);
            Ok(Value::Array(out))
        }
        "concat" => {
            let other = match args.first() {
                Some(Value::Array(o)) => o.clone(),
                Some(v) => {
                    return Err(ExpressionError::TypeError {
                        expected: "array argument for method 'concat'".into(),
                        actual: js_stringify(v),
                    })
                }
                None => return Err(arity_error(name, "1 argument", 0)),
            };
            let mut out = arr.to_vec();
            out.extend(other);
            Ok(Value::Array(out))
        }
        "reverse" => {
            no_args(name)?;
            let mut out = arr.to_vec();
            out.reverse();
            Ok(Value::Array(out))
        }
        "sort" => {
            // JS default sort orders by string comparison of elements.
            let mut keyed: Vec<(String, Value)> =
                arr.iter().map(|v| (js_stringify(v), v.clone())).collect();
            keyed.sort_by(|a, b| a.0.cmp(&b.0));
            let mut out: Vec<Value> = keyed.into_iter().map(|(_, v)| v).collect();
            match args.first() {
                None => {}
                Some(Value::String(dir)) if dir == "asc" => {}
                Some(Value::String(dir)) if dir == "desc" => out.reverse(),
                Some(Value::String(dir)) => {
                    return Err(ExpressionError::TypeError {
                        expected: "sort direction 'asc' or 'desc'".into(),
                        actual: dir.clone(),
                    })
                }
                Some(other) => {
                    return Err(ExpressionError::TypeError {
                        expected: "sort direction 'asc' or 'desc'".into(),
                        actual: js_stringify(other),
                    })
                }
            }
            Ok(Value::Array(out))
        }
        "unique" => {
            no_args(name)?;
            let mut out: Vec<Value> = Vec::new();
            for v in arr {
                if !out.contains(v) {
                    out.push(v.clone());
                }
            }
            Ok(Value::Array(out))
        }
        "contains" => {
            let needle = args
                .first()
                .ok_or_else(|| arity_error(name, "1 argument", 0))?;
            Ok(Value::Bool(arr.contains(needle)))
        }
        "indexOf" => {
            let needle = args
                .first()
                .ok_or_else(|| arity_error(name, "1 argument", 0))?;
            match arr.iter().position(|v| v == needle) {
                Some(i) => Ok(Value::Number((i as i64).into())),
                None => Ok(Value::Number((-1).into())),
            }
        }
        "sum" => {
            no_args(name)?;
            let mut total = 0.0;
            for v in arr {
                total += as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                    expected: "only numeric elements for method 'sum'".into(),
                    actual: js_stringify(v),
                })?;
            }
            f64_to_value(total)
        }
        "avg" | "average" => {
            no_args(name)?;
            if arr.is_empty() {
                return Err(ExpressionError::TypeError {
                    expected: "non-empty array for method 'avg'".into(),
                    actual: "[]".into(),
                });
            }
            let mut total = 0.0;
            for v in arr {
                total += as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                    expected: "only numeric elements for method 'avg'".into(),
                    actual: js_stringify(v),
                })?;
            }
            f64_to_value(total / arr.len() as f64)
        }
        "min" | "max" => {
            no_args(name)?;
            let mut acc: Option<f64> = None;
            for v in arr {
                let f = as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                    expected: format!("only numeric elements for method '{name}'"),
                    actual: js_stringify(v),
                })?;
                acc = Some(match acc {
                    None => f,
                    Some(cur) if name == "min" => cur.min(f),
                    Some(cur) => cur.max(f),
                });
            }
            match acc {
                Some(f) => f64_to_value(f),
                None => Err(ExpressionError::TypeError {
                    expected: format!("non-empty array for method '{name}'"),
                    actual: "[]".into(),
                }),
            }
        }
        "pluck" => {
            let key = arg_string(name, args, 0)?;
            let out: Vec<Value> = arr
                .iter()
                .map(|el| el.get(key.as_str()).cloned().unwrap_or(Value::Null))
                .collect();
            Ok(Value::Array(out))
        }
        "compact" => {
            no_args(name)?;
            Ok(Value::Array(
                arr.iter()
                    .filter(|v| !matches!(v, Value::Null))
                    .cloned()
                    .collect(),
            ))
        }
        other => Err(unknown_method("array", other)),
    }
}

fn call_number_method(
    n: &serde_json::Number,
    name: &str,
    args: &[Value],
) -> Result<Value, ExpressionError> {
    let no_args = |name: &str| -> Result<(), ExpressionError> {
        if args.is_empty() {
            Ok(())
        } else {
            Err(arity_error(name, "no arguments", args.len()))
        }
    };
    let f = n.as_f64().unwrap_or(f64::NAN);
    // i64 is always exactly representable; u64 above 2^63 goes through f64.
    let i = n.as_i64().unwrap_or_else(|| f as i64);

    match name {
        "isEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(false))
        }
        "isNotEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(true))
        }
        "toString" => {
            no_args(name)?;
            Ok(Value::String(n.to_string()))
        }
        "toNumber" => {
            no_args(name)?;
            Ok(Value::Number(n.clone()))
        }
        "toBoolean" => {
            no_args(name)?;
            Ok(Value::Bool(f != 0.0))
        }
        "round" => {
            let dp = match args.first() {
                None => 0usize,
                Some(_) => {
                    let raw = arg_f64(name, args, 0)?;
                    raw.clamp(0.0, 10.0) as usize
                }
            };
            let rendered = format!("{:.*}", dp, f);
            let parsed: f64 = rendered.parse().map_err(|_| ExpressionError::TypeError {
                expected: "finite number".into(),
                actual: n.to_string(),
            })?;
            f64_to_value(parsed)
        }
        "floor" => {
            no_args(name)?;
            f64_to_value(f.floor())
        }
        "ceil" => {
            no_args(name)?;
            f64_to_value(f.ceil())
        }
        "abs" => {
            no_args(name)?;
            f64_to_value(f.abs())
        }
        "sqrt" => {
            no_args(name)?;
            f64_to_value(f.sqrt())
        }
        "pow" => {
            let exp = arg_f64(name, args, 0)?;
            f64_to_value(f.powf(exp))
        }
        "toFixed" => {
            let dp = match args.first() {
                None => 0usize,
                Some(_) => arg_f64(name, args, 0)?.clamp(0.0, 20.0) as usize,
            };
            Ok(Value::String(format!("{:.*}", dp, f)))
        }
        "isEven" => {
            no_args(name)?;
            Ok(Value::Bool(f.fract() == 0.0 && i % 2 == 0))
        }
        "isOdd" => {
            no_args(name)?;
            Ok(Value::Bool(!(f.fract() == 0.0 && i % 2 == 0)))
        }
        "min" => {
            let other = arg_f64(name, args, 0)?;
            f64_to_value(f.min(other))
        }
        "max" => {
            let other = arg_f64(name, args, 0)?;
            f64_to_value(f.max(other))
        }
        other => Err(unknown_method("number", other)),
    }
}

fn call_bool_method(b: bool, name: &str, args: &[Value]) -> Result<Value, ExpressionError> {
    let no_args = |name: &str| -> Result<(), ExpressionError> {
        if args.is_empty() {
            Ok(())
        } else {
            Err(arity_error(name, "no arguments", args.len()))
        }
    };
    match name {
        "toString" => {
            no_args(name)?;
            Ok(Value::String(b.to_string()))
        }
        "toNumber" => {
            no_args(name)?;
            Ok(Value::Number((if b { 1 } else { 0 }).into()))
        }
        "toBoolean" => {
            no_args(name)?;
            Ok(Value::Bool(b))
        }
        other => Err(unknown_method("boolean", other)),
    }
}

fn call_null_method(name: &str, args: &[Value]) -> Result<Value, ExpressionError> {
    let no_args = |name: &str| -> Result<(), ExpressionError> {
        if args.is_empty() {
            Ok(())
        } else {
            Err(arity_error(name, "no arguments", args.len()))
        }
    };
    match name {
        "isEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(true))
        }
        "isNotEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(false))
        }
        other => Err(unknown_method("null", other)),
    }
}

fn call_object_method(
    map: &serde_json::Map<String, Value>,
    name: &str,
    args: &[Value],
) -> Result<Value, ExpressionError> {
    let no_args = |name: &str| -> Result<(), ExpressionError> {
        if args.is_empty() {
            Ok(())
        } else {
            Err(arity_error(name, "no arguments", args.len()))
        }
    };
    match name {
        "isEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(map.is_empty()))
        }
        "isNotEmpty" => {
            no_args(name)?;
            Ok(Value::Bool(!map.is_empty()))
        }
        "length" => {
            no_args(name)?;
            Ok(Value::Number((map.len() as i64).into()))
        }
        "toString" => {
            no_args(name)?;
            Ok(Value::String("[object Object]".to_string()))
        }
        other => Err(unknown_method("object", other)),
    }
}

fn string_to_number(s: &str) -> Result<Value, ExpressionError> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        // JS Number("") === 0.
        return Ok(Value::Number(0.into()));
    }
    match trimmed.parse::<f64>() {
        Ok(f) if f.is_finite() => f64_to_value(f),
        _ => Err(ExpressionError::TypeError {
            expected: "numeric string".into(),
            actual: s.to_string(),
        }),
    }
}

fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        // A valid escape needs `%` + two hex digits fully inside the slice.
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            let hex = &s[i + 1..i + 3];
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ===========================================================================
// Extended functions (`$if`, `$min`, `$max`, `$average`, `$not`, `$ifEmpty`).
// ===========================================================================

/// Returns `true` when `name` is a callable extended function.
pub fn is_extended_function(name: &str) -> bool {
    matches!(
        name,
        "$if" | "$min" | "$max" | "$average" | "$avg" | "$not" | "$ifEmpty"
    )
}

/// Evaluates an n8n extended function against already-evaluated arguments.
/// Unknown names fail closed as unresolved references.
pub fn eval_extended_function(name: &str, args: &[Value]) -> Result<Value, ExpressionError> {
    match name {
        "$if" => {
            if args.len() != 3 {
                return Err(arity_error(
                    name,
                    "3 arguments (condition, whenTrue, whenFalse)",
                    args.len(),
                ));
            }
            Ok(if js_truthy(&args[0]) {
                args[1].clone()
            } else {
                args[2].clone()
            })
        }
        "$not" => {
            if args.len() != 1 {
                return Err(arity_error(name, "1 argument", args.len()));
            }
            Ok(Value::Bool(!js_truthy(&args[0])))
        }
        "$ifEmpty" => {
            if args.len() != 2 {
                return Err(arity_error(
                    name,
                    "2 arguments (value, fallback)",
                    args.len(),
                ));
            }
            Ok(if is_empty_value(&args[0]) {
                args[1].clone()
            } else {
                args[0].clone()
            })
        }
        "$min" | "$max" | "$average" | "$avg" => {
            let nums = collect_numbers(name, args)?;
            if nums.is_empty() {
                return Err(ExpressionError::TypeError {
                    expected: format!("at least one number for function '{name}'"),
                    actual: "none".into(),
                });
            }
            let result = match name {
                "$min" => nums.iter().fold(f64::INFINITY, |a, b| a.min(*b)),
                "$max" => nums.iter().fold(f64::NEG_INFINITY, |a, b| a.max(*b)),
                _ => nums.iter().sum::<f64>() / nums.len() as f64,
            };
            f64_to_value(result)
        }
        other => Err(ExpressionError::UnresolvedReference {
            path: other.to_string(),
        }),
    }
}

/// `$min(1, 2, 3)` and `$min([1, 2, 3])` are both legal upstream.
fn collect_numbers(name: &str, args: &[Value]) -> Result<Vec<f64>, ExpressionError> {
    let mut out = Vec::new();
    for arg in args {
        match arg {
            Value::Array(arr) => {
                for v in arr {
                    out.push(as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                        expected: format!("only numbers for function '{name}'"),
                        actual: js_stringify(v),
                    })?);
                }
            }
            v => out.push(as_f64(v).ok_or_else(|| ExpressionError::TypeError {
                expected: format!("only numbers for function '{name}'"),
                actual: js_stringify(v),
            })?),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn call(target: Value, name: &str, args: Vec<Value>) -> Value {
        call_method(&target, name, &args).expect("method call must succeed")
    }

    #[test]
    fn string_extensions() {
        assert_eq!(call(json!(" hello "), "trim", vec![]), json!("hello"));
        assert_eq!(call(json!("hello"), "toUpperCase", vec![]), json!("HELLO"));
        assert_eq!(call(json!("HeLLo"), "toLowerCase", vec![]), json!("hello"));
        assert_eq!(call(json!("hello world"), "length", vec![]), json!(11));
        assert_eq!(call(json!(""), "isEmpty", vec![]), json!(true));
        assert_eq!(call(json!("xy"), "isNotEmpty", vec![]), json!(true));
        assert_eq!(
            call(json!("a;b;;c"), "split", vec![json!(";")]),
            json!(["a", "b", "", "c"])
        );
        assert_eq!(
            call(json!("abc"), "split", vec![json!("")]),
            json!(["a", "b", "c"])
        );
        assert_eq!(
            call(json!("hello"), "contains", vec![json!("ell")]),
            json!(true)
        );
        assert_eq!(
            call(json!("hello"), "startsWith", vec![json!("he")]),
            json!(true)
        );
        assert_eq!(
            call(json!("hello"), "endsWith", vec![json!("lo")]),
            json!(true)
        );
        assert_eq!(
            call(json!("aaa"), "replace", vec![json!("a"), json!("b")]),
            json!("baa")
        );
        assert_eq!(
            call(json!("aaa"), "replaceAll", vec![json!("a"), json!("b")]),
            json!("bbb")
        );
        assert_eq!(
            call(json!("hello"), "slice", vec![json!(1), json!(3)]),
            json!("el")
        );
        assert_eq!(call(json!("hello"), "slice", vec![json!(-2)]), json!("lo"));
        assert_eq!(
            call(json!("hello"), "substring", vec![json!(3), json!(1)]),
            json!("el")
        );
        assert_eq!(call(json!("hello"), "charAt", vec![json!(1)]), json!("e"));
        assert_eq!(call(json!("hello"), "charAt", vec![json!(99)]), json!(""));
        assert_eq!(
            call(json!("hello world"), "indexOf", vec![json!("o")]),
            json!(4)
        );
        assert_eq!(call(json!("hello"), "indexOf", vec![json!("z")]), json!(-1));
        assert_eq!(
            call(json!("5"), "padStart", vec![json!(3), json!("0")]),
            json!("005")
        );
        assert_eq!(
            call(json!("5"), "padEnd", vec![json!(3), json!("0")]),
            json!("500")
        );
        assert_eq!(call(json!("ab"), "repeat", vec![json!(3)]), json!("ababab"));
        assert_eq!(call(json!("42"), "toNumber", vec![]), json!(42));
        assert_eq!(call(json!("true"), "toBoolean", vec![]), json!(true));
        assert_eq!(call(json!("anything"), "toBoolean", vec![]), json!(false));
        assert_eq!(
            call(json!("a b&c"), "urlEncode", vec![]),
            json!("a%20b%26c")
        );
        assert_eq!(
            call(json!("a%20b%26c"), "urlDecode", vec![]),
            json!("a b&c")
        );
    }

    #[test]
    fn array_extensions() {
        let arr = json!([3, 1, 2]);
        assert_eq!(call(arr.clone(), "first", vec![]), json!(3));
        assert_eq!(call(arr.clone(), "last", vec![]), json!(2));
        assert_eq!(call(arr.clone(), "length", vec![]), json!(3));
        assert_eq!(call(arr.clone(), "slice", vec![json!(1)]), json!([1, 2]));
        assert_eq!(call(arr.clone(), "reverse", vec![]), json!([2, 1, 3]));
        assert_eq!(call(arr.clone(), "sum", vec![]), json!(6));
        assert_eq!(call(arr.clone(), "avg", vec![]), json!(2));
        assert_eq!(call(arr.clone(), "min", vec![]), json!(1));
        assert_eq!(call(arr.clone(), "max", vec![]), json!(3));
        assert_eq!(call(arr.clone(), "join", vec![json!("-")]), json!("3-1-2"));
        assert_eq!(
            call(json!([1, 2, 2, 3, 1]), "unique", vec![]),
            json!([1, 2, 3])
        );
        assert_eq!(
            call(json!([1, 2]), "push", vec![json!(3)]),
            json!([1, 2, 3])
        );
        assert_eq!(
            call(json!([1]), "concat", vec![json!([2, 3])]),
            json!([1, 2, 3])
        );
        assert_eq!(
            call(json!([1, null, 2, null]), "compact", vec![]),
            json!([1, 2])
        );
        assert_eq!(
            call(
                json!([{"id": 1}, {"id": 2}, {"x": 0}]),
                "pluck",
                vec![json!("id")]
            ),
            json!([1, 2, null])
        );
        // JS default sort is lexicographic on stringified elements.
        assert_eq!(call(json!([10, 9, 1]), "sort", vec![]), json!([1, 10, 9]));
        assert_eq!(
            call(json!([1, 2, 3]), "contains", vec![json!(2)]),
            json!(true)
        );
        assert_eq!(
            call(json!(["a", "b"]), "indexOf", vec![json!("b")]),
            json!(1)
        );
    }

    #[test]
    fn number_extensions() {
        assert_eq!(call(json!(2.567), "round", vec![]), json!(3));
        assert_eq!(call(json!(2.5), "round", vec![]), json!(2)); // round-half-even via format!
        assert_eq!(call(json!(2.567), "round", vec![json!(1)]), json!(2.6));
        assert_eq!(call(json!(-1.5), "floor", vec![]), json!(-2));
        assert_eq!(call(json!(-1.5), "ceil", vec![]), json!(-1));
        assert_eq!(call(json!(-7), "abs", vec![]), json!(7));
        assert_eq!(call(json!(9), "sqrt", vec![]), json!(3));
        assert_eq!(call(json!(2), "pow", vec![json!(10)]), json!(1024));
        assert_eq!(call(json!(2.567), "toFixed", vec![json!(1)]), json!("2.6"));
        assert_eq!(call(json!(4), "isEven", vec![]), json!(true));
        assert_eq!(call(json!(4), "isOdd", vec![]), json!(false));
        assert_eq!(call(json!(3), "min", vec![json!(5)]), json!(3));
        assert_eq!(call(json!(3), "max", vec![json!(5)]), json!(5));
        assert_eq!(call(json!(0), "toBoolean", vec![]), json!(false));
    }

    #[test]
    fn object_and_null_extensions() {
        assert_eq!(call(json!({}), "isEmpty", vec![]), json!(true));
        assert_eq!(call(json!({"a": 1}), "length", vec![]), json!(1));
        assert_eq!(
            call(json!({"a": 1}), "toString", vec![]),
            json!("[object Object]")
        );
        assert_eq!(call(Value::Null, "isEmpty", vec![]), json!(true));
        assert_eq!(call(Value::Null, "isNotEmpty", vec![]), json!(false));
    }

    #[test]
    fn unknown_methods_fail_closed() {
        let err = call_method(&json!("x"), "hack", &[]).unwrap_err();
        match err {
            ExpressionError::TypeError { actual, .. } => assert!(actual.contains("hack")),
            other => panic!("expected TypeError, got {other:?}"),
        }
        // wrong arity
        assert!(call_method(&json!("x"), "contains", &[]).is_err());
        // wrong arg type
        assert!(call_method(&json!("x"), "contains", &[json!(1)]).is_err());
    }

    #[test]
    fn extended_functions() {
        assert_eq!(
            eval_extended_function("$if", &[json!(true), json!("y"), json!("n")]).unwrap(),
            json!("y")
        );
        assert_eq!(
            eval_extended_function("$if", &[json!(0), json!("y"), json!("n")]).unwrap(),
            json!("n")
        );
        assert_eq!(
            eval_extended_function("$min", &[json!(4), json!(2), json!(9)]).unwrap(),
            json!(2)
        );
        assert_eq!(
            eval_extended_function("$max", &[json!([4, 2, 9])]).unwrap(),
            json!(9)
        );
        assert_eq!(
            eval_extended_function("$average", &[json!([2, 4])]).unwrap(),
            json!(3)
        );
        assert_eq!(
            eval_extended_function("$not", &[json!(false)]).unwrap(),
            json!(true)
        );
        assert_eq!(
            eval_extended_function("$ifEmpty", &[json!(""), json!("fallback")]).unwrap(),
            json!("fallback")
        );
        assert_eq!(
            eval_extended_function("$ifEmpty", &[json!("v"), json!("fallback")]).unwrap(),
            json!("v")
        );
        assert!(eval_extended_function("$hack", &[]).is_err());
        assert!(eval_extended_function("$if", &[json!(true)]).is_err());
    }

    #[test]
    fn js_stringify_semantics() {
        assert_eq!(js_stringify(&json!(null)), "null");
        assert_eq!(js_stringify(&json!(true)), "true");
        assert_eq!(js_stringify(&json!(45)), "45");
        assert_eq!(js_stringify(&json!(2.6)), "2.6");
        assert_eq!(js_stringify(&json!({"a": 1})), "[object Object]");
        assert_eq!(
            js_stringify(&json!([1, "a", null, {"x": 1}])),
            "1,a,,[object Object]"
        );
    }
}
