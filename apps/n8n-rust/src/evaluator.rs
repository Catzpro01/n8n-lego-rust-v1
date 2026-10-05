use boa_engine::{Context, Source};
use serde_json::Value;

pub struct JsEvaluator;

impl JsEvaluator {
    /// Evaluates dynamic expressions like `{{ $json.field }}` or `=$json.field`
    pub fn evaluate_expression(expression: &str, context: &Value) -> Result<Value, String> {
        let mut ctx = Context::default();
        let context_str = serde_json::to_string(context).unwrap_or_else(|_| "{}".to_string());
        
        let code = format!(
            r#"
            (function() {{
                const $json = {context};
                try {{
                    const result = {expr};
                    return JSON.stringify(result);
                }} catch (e) {{
                    return JSON.stringify({{ __error: e.toString() }});
                }}
            }})()
            "#,
            context = context_str,
            expr = expression
        );

        let result = match ctx.eval(Source::from_bytes(code.as_bytes())) {
            Ok(res) => res,
            Err(e) => return Err(format!("JS Error: {}", e.to_string())),
        };

        if let Some(str_val) = result.as_string() {
            let rust_str = str_val.to_std_string_escaped();
            if let Ok(parsed) = serde_json::from_str::<Value>(&rust_str) {
                if let Some(err) = parsed.get("__error") {
                    return Err(err.as_str().unwrap_or("Unknown JS Error").to_string());
                }
                return Ok(parsed);
            }
        }
        
        Err("Failed to parse JS engine output".to_string())
    }

    /// Evaluates full JavaScript code snippets in a sandbox with $input, $json, and items support
    pub fn evaluate_code(js_code: &str, input_items: &Value) -> Result<Value, String> {
        let mut ctx = Context::default();
        let items_str = serde_json::to_string(input_items).unwrap_or_else(|_| "[]".to_string());
        
        // Escape backticks and template string markers in user code
        let safe_code = js_code.replace('\\', "\\\\").replace('`', "\\`").replace("${", "\\${");

        let wrapper = format!(
            r#"
            (function() {{
                const _items = {items};
                const $input = {{
                    all: () => _items,
                    first: () => (_items.length > 0 ? _items[0] : null),
                    item: (_items.length > 0 ? _items[0] : null)
                }};
                const $json = (_items.length > 0 && _items[0].json) ? _items[0].json : (_items.length > 0 ? _items[0] : {{}});
                
                try {{
                    const fn = new Function('$input', '$json', '_items', `{code}`);
                    let res = fn($input, $json, _items);
                    if (res === undefined) {{
                        res = _items;
                    }}
                    return JSON.stringify(res);
                }} catch (e) {{
                    return JSON.stringify({{ __error: e.toString() }});
                }}
            }})()
            "#,
            items = items_str,
            code = safe_code
        );

        let result = match ctx.eval(Source::from_bytes(wrapper.as_bytes())) {
            Ok(res) => res,
            Err(e) => return Err(format!("JS Execution Error: {}", e.to_string())),
        };

        if let Some(str_val) = result.as_string() {
            let rust_str = str_val.to_std_string_escaped();
            if let Ok(parsed) = serde_json::from_str::<Value>(&rust_str) {
                if let Some(err) = parsed.get("__error") {
                    return Err(err.as_str().unwrap_or("Code execution error").to_string());
                }
                
                // Normalisasi hasil agar selalu berupa array item: [{ "json": { ... } }]
                let normalized = if let Some(arr) = parsed.as_array() {
                    let mut norm_arr = Vec::new();
                    for item in arr {
                        if item.is_object() && item.get("json").is_some() {
                            norm_arr.push(item.clone());
                        } else {
                            norm_arr.push(serde_json::json!({ "json": item }));
                        }
                    }
                    Value::Array(norm_arr)
                } else if parsed.is_object() && parsed.get("json").is_some() {
                    Value::Array(vec![parsed])
                } else {
                    Value::Array(vec![serde_json::json!({ "json": parsed })])
                };
                
                return Ok(normalized);
            }
        }

        Err("Gagal memproses hasil eksekusi JS Code".to_string())
    }
}
