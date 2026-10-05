use async_trait::async_trait;
use serde_json::{json, Value};
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::time::{timeout, Duration};

use crate::runtime_registry::RuntimeRegistry;
use crate::traits::{
    INodeExecutionData, N8nNode, NodeExecutionContext, NodeExecutionError, NodeTypeDescription,
};

/// Polyglot Code Node dengan Piped In-Memory IPC
/// Sesuai audit ChatGPT:
/// - Menggunakan `kill_on_drop(true)` untuk mencegah proses zombie
/// - Membaca `stdout` dan `stderr` secara bersamaan (concurrent) untuk mencegah buffer deadlock
/// - Mempertahankan `paired_item`
pub struct CodePolyglotNode {
    registry: Arc<RuntimeRegistry>,
}

impl CodePolyglotNode {
    pub fn new(registry: Arc<RuntimeRegistry>) -> Self {
        Self { registry }
    }
}

impl Default for CodePolyglotNode {
    fn default() -> Self {
        Self::new(Arc::new(RuntimeRegistry::new()))
    }
}

#[async_trait]
impl N8nNode for CodePolyglotNode {
    fn description(&self) -> NodeTypeDescription {
        NodeTypeDescription {
            name: "n8n-nodes-base.code".to_string(),
            display_name: "Code (Polyglot Fast-IPC)".to_string(),
            description: "Execute JavaScript or Python using in-memory piped IPC".to_string(),
            version: 1.0,
            inputs: vec!["main".to_string()],
            outputs: vec!["main".to_string()],
            translation: None,
        }
    }

    async fn execute(
        &self,
        context: &NodeExecutionContext,
        input_data: Vec<INodeExecutionData>,
    ) -> Result<Vec<Vec<INodeExecutionData>>, NodeExecutionError> {
        let items = if input_data.is_empty() {
            vec![INodeExecutionData::from_json(json!({}))]
        } else {
            input_data
        };

        let language = context
            .parameters
            .get("language")
            .and_then(|v| v.as_str())
            .unwrap_or("javaScript");

        let language_version = context
            .parameters
            .get("languageVersion")
            .and_then(|v| v.as_str())
            .unwrap_or("default");

        let code = context
            .parameters
            .get("jsCode")
            .or_else(|| context.parameters.get("pythonCode"))
            .and_then(|v| v.as_str())
            .unwrap_or("return item;");

        // 1. Resolusi biner secara deterministik via RuntimeRegistry
        let lang_key = match language {
            "javaScript" | "javascript" => "javascript",
            "python" | "pythonNative" => "python",
            other => other,
        };

        let binary_path = self
            .registry
            .resolve_binary(lang_key, language_version)
            .ok_or_else(|| {
                NodeExecutionError::ExecutionFailed(format!(
                    "Runtime biner untuk bahasa '{}' versi '{}' tidak ditemukan / tidak tersedia!",
                    language, language_version
                ))
            })?;

        // 2. Format input payload ke memory bytes (dengan pairedItem preservation)
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

        // 3. Bangun child process dengan kill_on_drop(true)
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
                let indented_code = code
                    .lines()
                    .map(|l| format!("        {}", l))
                    .collect::<Vec<_>>()
                    .join("\n");
                let harness = template.replace("        __PYTHON_CODE__", &indented_code);
                c.args(["-c", &harness]);
                c
            }
            _ => {
                return Err(NodeExecutionError::ExecutionFailed(format!(
                    "Bahasa runtime '{}' belum didukung untuk eksekusi langsung!",
                    language
                )));
            }
        };

        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true); // Perlindungan proses zombie

        let mut child = cmd.spawn().map_err(|e| {
            NodeExecutionError::ExecutionFailed(format!(
                "Gagal spawn proses {}: {}",
                binary_path.display(),
                e
            ))
        })?;

        // 4. Kirim input melalui stdin pipe & tutup pipe
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(&input_bytes)
                .await
                .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Gagal menulis ke stdin child: {}", e)))?;
            drop(stdin);
        }

        // 5. Baca stdout dan stderr secara CONCURRENT menggunakan tokio::join! (Mencegah Deadlock Buffer Pipe)
        let execution_future = async {
            let mut stdout_buf = Vec::new();
            let mut stderr_buf = String::new();

            let mut stdout = child.stdout.take();
            let mut stderr = child.stderr.take();

            let read_stdout = async {
                if let Some(ref mut out) = stdout {
                    let _ = out.read_to_end(&mut stdout_buf).await;
                }
            };

            let read_stderr = async {
                if let Some(ref mut err) = stderr {
                    let _ = err.read_to_string(&mut stderr_buf).await;
                }
            };

            tokio::join!(read_stdout, read_stderr);

            let status = child.wait().await?;
            Ok::<(std::process::ExitStatus, Vec<u8>, String), std::io::Error>((status, stdout_buf, stderr_buf))
        };

        let (status, stdout_bytes, stderr_str) = timeout(Duration::from_secs(10), execution_future)
            .await
            .map_err(|_| NodeExecutionError::ExecutionFailed("Code execution timeout (>10 detik)!".to_string()))?
            .map_err(|e| NodeExecutionError::ExecutionFailed(format!("Kesalahan I/O eksekusi: {}", e)))?;

        if !status.success() {
            return Err(NodeExecutionError::ExecutionFailed(format!(
                "Kode gagal dieksekusi:\n{}",
                stderr_str
            )));
        }

        // 6. Parse hasil stdout menjadi INodeExecutionData
        let raw_results: Value = serde_json::from_slice(&stdout_bytes).map_err(|e| {
            NodeExecutionError::ExecutionFailed(format!(
                "Gagal mem-parse output JSON dari runtime: {}\nRaw output: {}",
                e,
                String::from_utf8_lossy(&stdout_bytes)
            ))
        })?;

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
    }
}
