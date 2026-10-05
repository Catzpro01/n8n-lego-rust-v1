use std::future::Future;
use std::pin::Pin;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::{timeout, Duration};
use serde_json::{json, Value};
use crate::nodes::traits::{INodeExecutionData, NodeExecutionContext, NodeExecutionError, N8nNode};
use crate::runtime_registry::RuntimeRegistry;

/// Polyglot Code Node dengan Piped Stdin/Stdout IPC (Zero-Disk I/O)
pub struct PolyglotCodeNode {
    registry: Arc<RuntimeRegistry>,
}

impl PolyglotCodeNode {
    pub fn new(registry: Arc<RuntimeRegistry>) -> Self {
        Self { registry }
    }
}

impl N8nNode for PolyglotCodeNode {
    fn node_type(&self) -> &'static str {
        "n8n-nodes-base.code"
    }

    fn execute<'a>(
        &'a self,
        ctx: &'a NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Pin<Box<dyn Future<Output = Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError>> + Send + 'a>> {
        Box::pin(async move {
            let items = if input_data.is_empty() {
                vec![INodeExecutionData::from_json(json!({}))]
            } else {
                input_data
            };

            let language = ctx.parameters.get("language")
                .and_then(|v| v.as_str())
                .unwrap_or("javaScript");

            let language_version = ctx.parameters.get("languageVersion")
                .and_then(|v| v.as_str())
                .unwrap_or("default");

            let code = ctx.parameters.get("jsCode")
                .or_else(|| ctx.parameters.get("pythonCode"))
                .and_then(|v| v.as_str())
                .unwrap_or("return item;");

            // 1. Resolve binary via cached RuntimeRegistry (No mise exec overhead)
            let lang_key = match language {
                "javaScript" | "javascript" => "javascript",
                "python" | "pythonNative" => "python",
                other => other,
            };

            let binary_path = self.registry.resolve_binary(lang_key, language_version)
                .ok_or_else(|| NodeExecutionError::ExecutionFailed(format!(
                    "Runtime binary untuk bahasa '{}' versi '{}' tidak ditemukan di sistem!",
                    language, language_version
                )))?;

            // 2. Format input payload serialized to memory (including pairedItem preservation)
            let input_envelope = json!({
                "items": items.iter().enumerate().map(|(idx, it)| {
                    json!({
                        "json": it.json,
                        "pairedItem": it.paired_item.clone().unwrap_or_else(|| json!({ "item": idx }))
                    })
                }).collect::<Vec<_>>()
            });
            let input_bytes = serde_json::to_vec(&input_envelope)
                .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Gagal serialize JSON: {}", e)))?;

            // 3. Construct piped child process
            let mut cmd = match lang_key {
                "javascript" => {
                    let mut c = Command::new(&binary_path);
                    let template = r#"
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { buf += chunk; });
process.stdin.on('end', () => {
    try {
        const payload = JSON.parse(buf);
        const rawItems = payload.items || [];
        const userFn = new Function('item', __USER_CODE__);
        const results = rawItems.map(wrapper => {
            let item = wrapper.json;
            let res = userFn(item);
            return {
                json: res !== undefined ? res : item,
                pairedItem: wrapper.pairedItem
            };
        });
        process.stdout.write(JSON.stringify(results));
    } catch (err) {
        process.stderr.write(err.stack || err.message);
        process.exit(1);
    }
});
"#;
                    let code_str = serde_json::to_string(code).unwrap_or_default();
                    let harness = template.replace("__USER_CODE__", &code_str);
                    c.args(["-e", &harness]);
                    c
                }
                "python" => {
                    let mut c = Command::new(&binary_path);
                    let template = r#"
import sys, json

buf = sys.stdin.read()
try:
    payload = json.loads(buf)
    items = payload.get('items', [])
    results = []
    
    # User Code Scope
    def execute_user_fn(item):
        __PYTHON_CODE__
        return item

    for wrapper in items:
        it = wrapper.get('json', {})
        res = execute_user_fn(it)
        results.append({
            'json': res if res is not None else it,
            'pairedItem': wrapper.get('pairedItem')
        })
    sys.stdout.write(json.dumps(results))
except Exception as e:
    import traceback
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
"#;
                    let indented_code = code.lines().map(|l| format!("        {}", l)).collect::<Vec<_>>().join("\n");
                    let harness = template.replace("        __PYTHON_CODE__", &indented_code);
                    c.args(["-c", &harness]);
                    c
                }
                _ => {
                    return Err(NodeExecutionError::ExecutionFailed(format!(
                        "Bahasa runtime '{}' belum didukung untuk eksekusi langsung!", language
                    )));
                }
            };

            cmd.stdin(Stdio::piped())
               .stdout(Stdio::piped())
               .stderr(Stdio::piped());

            let mut child = cmd.spawn()
                .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Gagal spawn proses {}: {}", binary_path.display(), e)))?;

            // 4. Kirim input melalui stdin pipe & tutup pipe
            if let Some(mut stdin) = child.stdin.take() {
                stdin.write_all(&input_bytes).await
                    .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Gagal menulis ke stdin child: {}", e)))?;
                drop(stdin); // Sinyal EOF agar process mulai mengeksekusi
            }

            // 5. Baca stdout & stderr dengan timeout perlindungan (10 detik)
            let execution_future = async {
                let mut stdout_buf = Vec::new();
                let mut stderr_buf = String::new();

                if let Some(mut stdout) = child.stdout.take() {
                    stdout.read_to_end(&mut stdout_buf).await?;
                }
                if let Some(mut stderr) = child.stderr.take() {
                    stderr.read_to_string(&mut stderr_buf).await?;
                }

                let status = child.wait().await?;
                Ok::<(std::process::ExitStatus, Vec<u8>, String), std::io::Error>((status, stdout_buf, stderr_buf))
            };

            let (status, stdout_bytes, stderr_str) = timeout(Duration::from_secs(10), execution_future)
                .await
                .map_err(|_| NodeExecutionError::ExecutionFailed("Code execution timeout (>10 detik)!".to_string()))?
                .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Kesalahan I/O eksekusi: {}", e)))?;

            if !status.success() {
                return Err(NodeExecutionError::ExecutionFailed(format!(
                    "Kode gagal dieksekusi:\n{}", stderr_str
                )));
            }

            // 6. Parse hasil stdout menjadi INodeExecutionData
            let raw_results: Value = serde_json::from_slice(&stdout_bytes)
                .map_err(|e| NodeExecutionError::ExecutionFailed(format!(
                    "Gagal mem-parse output JSON dari runtime: {}\nRaw output: {}",
                    e, String::from_utf8_lossy(&stdout_bytes)
                )))?;

            let mut out_items = Vec::new();
            if let Some(arr) = raw_results.as_array() {
                for entry in arr {
                    let json_val = entry.get("json").cloned().unwrap_or_else(|| entry.clone());
                    let paired_item = entry.get("pairedItem").cloned();
                    out_items.push(INodeExecutionData {
                        json: json_val,
                        paired_item,
                        binary: None,
                    });
                }
            } else {
                out_items.push(INodeExecutionData::from_json(raw_results));
            }

            Ok(vec![out_items])
        })
    }
}
