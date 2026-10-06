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
/// - Menggunakan `kill_on_drop(true)` untuk mencegah proses zombie
/// - Membaca `stdout` dan `stderr` secara bersamaan (concurrent) untuk mencegah buffer deadlock
/// - Mempertahankan `paired_item`
/// - Mendukung mode `runOnceForAllItems` dan `runOnceForEachItem`
/// - Mendukung JavaScript ($input, items, item, $json) dan Python (_input, items, _items, item, _json)
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

        let mode = context
            .parameters
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("runOnceForAllItems");

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

        // 2. Format input payload ke memory bytes (dengan pairedItem preservation & mode)
        let input_envelope = json!({
            "mode": mode,
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
process.stdin.on('end', async () => {
    try {
        const payload = JSON.parse(buf);
        const rawItems = payload.items || [];
        const mode = payload.mode || 'runOnceForAllItems';
        let results = [];

        if (mode === 'runOnceForEachItem') {
            const userFn = new Function('item', '$json', '$input', __USER_CODE__);
            for (let idx = 0; idx < rawItems.length; idx++) {
                const wrapper = rawItems[idx];
                const item = wrapper.json;
                const $json = item;
                const $input = {
                    item: wrapper,
                    all: () => rawItems,
                    first: () => rawItems[0] || null,
                    last: () => rawItems[rawItems.length - 1] || null
                };
                let res = await userFn(item, $json, $input);
                if (res === undefined) {
                    results.push({
                        json: item,
                        pairedItem: wrapper.pairedItem
                    });
                } else if (Array.isArray(res)) {
                    for (const r of res) {
                        if (r && typeof r === 'object' && 'json' in r) {
                            results.push({
                                json: r.json,
                                pairedItem: r.pairedItem !== undefined ? r.pairedItem : wrapper.pairedItem
                            });
                        } else if (r && typeof r === 'object') {
                            results.push({
                                json: r,
                                pairedItem: wrapper.pairedItem
                            });
                        } else {
                            results.push({
                                json: { value: r },
                                pairedItem: wrapper.pairedItem
                            });
                        }
                    }
                } else if (res && typeof res === 'object' && 'json' in res) {
                    results.push({
                        json: res.json,
                        pairedItem: res.pairedItem !== undefined ? res.pairedItem : wrapper.pairedItem
                    });
                } else if (res && typeof res === 'object') {
                    results.push({
                        json: res,
                        pairedItem: wrapper.pairedItem
                    });
                } else {
                    results.push({
                        json: { value: res },
                        pairedItem: wrapper.pairedItem
                    });
                }
            }
        } else {
            const allItems = rawItems;
            const $input = {
                all: () => allItems,
                first: () => allItems[0] || null,
                last: () => allItems[allItems.length - 1] || null,
                item: allItems[0] || null
            };
            const items = allItems;
            const firstItem = allItems[0] ? (allItems[0].json || {}) : {};
            const userFn = new Function('$input', 'items', 'item', '$json', __USER_CODE__);
            let res = await userFn($input, items, firstItem, firstItem);

            if (res === undefined) {
                res = allItems;
            }

            if (Array.isArray(res)) {
                for (let idx = 0; idx < res.length; idx++) {
                    const entry = res[idx];
                    const defaultPaired = (allItems[idx] && allItems[idx].pairedItem) ? allItems[idx].pairedItem : { item: idx };
                    if (entry && typeof entry === 'object' && 'json' in entry) {
                        results.push({
                            json: entry.json,
                            pairedItem: entry.pairedItem !== undefined ? entry.pairedItem : defaultPaired
                        });
                    } else if (entry && typeof entry === 'object') {
                        results.push({
                            json: entry,
                            pairedItem: defaultPaired
                        });
                    } else {
                        results.push({
                            json: { value: entry },
                            pairedItem: defaultPaired
                        });
                    }
                }
            } else if (res && typeof res === 'object' && 'json' in res) {
                results.push({
                    json: res.json,
                    pairedItem: res.pairedItem !== undefined ? res.pairedItem : ((allItems[0] && allItems[0].pairedItem) || { item: 0 })
                });
            } else if (res && typeof res === 'object') {
                results.push({
                    json: res,
                    pairedItem: (allItems[0] && allItems[0].pairedItem) || { item: 0 }
                });
            } else if (res !== null && res !== undefined) {
                results.push({
                    json: { value: res },
                    pairedItem: (allItems[0] && allItems[0].pairedItem) || { item: 0 }
                });
            }
        }

        process.stdout.write(JSON.stringify(results));
    } catch (err) {
        process.stderr.write(err.stack || err.message || String(err));
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
    raw_items = payload.get('items', [])
    mode = payload.get('mode', 'runOnceForAllItems')
    results = []

    class InputHelper:
        def __init__(self, items_list, current_item=None):
            self._items = items_list
            self.item = current_item if current_item is not None else (items_list[0] if items_list else None)
        def all(self):
            return self._items
        def first(self):
            return self._items[0] if self._items else None
        def last(self):
            return self._items[-1] if self._items else None

    if mode == 'runOnceForEachItem':
        def execute_user_fn(item, _item, _input, _json):
__PYTHON_CODE_FOR_EACH__

        for idx, wrapper in enumerate(raw_items):
            it = wrapper.get('json', {})
            _input_helper = InputHelper(raw_items, wrapper)
            res = execute_user_fn(it, it, _input_helper, it)
            paired = wrapper.get('pairedItem') or {'item': idx}
            if res is None:
                results.append({'json': it, 'pairedItem': paired})
            elif isinstance(res, list):
                for r in res:
                    if isinstance(r, dict) and 'json' in r:
                        results.append({'json': r['json'], 'pairedItem': r.get('pairedItem', paired)})
                    elif isinstance(r, dict):
                        results.append({'json': r, 'pairedItem': paired})
                    else:
                        results.append({'json': {'value': r}, 'pairedItem': paired})
            elif isinstance(res, dict) and 'json' in res:
                results.append({'json': res['json'], 'pairedItem': res.get('pairedItem', paired)})
            elif isinstance(res, dict):
                results.append({'json': res, 'pairedItem': paired})
            else:
                results.append({'json': {'value': res}, 'pairedItem': paired})
    else:
        all_items = raw_items
        _input_helper = InputHelper(all_items)
        first_item = all_items[0].get('json', {}) if all_items else {}
        def execute_user_fn(_input, items, _items, item=None, _item=None, _json=None):
__PYTHON_CODE_FOR_ALL__

        res = execute_user_fn(_input_helper, all_items, all_items, first_item, first_item, first_item)
        if res is None:
            res = all_items

        if isinstance(res, list):
            for idx, entry in enumerate(res):
                default_paired = all_items[idx].get('pairedItem') if idx < len(all_items) else {'item': idx}
                if isinstance(entry, dict) and 'json' in entry:
                    results.append({'json': entry['json'], 'pairedItem': entry.get('pairedItem', default_paired)})
                elif isinstance(entry, dict):
                    results.append({'json': entry, 'pairedItem': default_paired})
                else:
                    results.append({'json': {'value': entry}, 'pairedItem': default_paired})
        elif isinstance(res, dict) and 'json' in res:
            paired = res.get('pairedItem') or (all_items[0].get('pairedItem') if all_items else {'item': 0})
            results.append({'json': res['json'], 'pairedItem': paired})
        elif isinstance(res, dict):
            paired = all_items[0].get('pairedItem') if all_items else {'item': 0}
            results.append({'json': res, 'pairedItem': paired})
        elif res is not None:
            paired = all_items[0].get('pairedItem') if all_items else {'item': 0}
            results.append({'json': {'value': res}, 'pairedItem': paired})

    sys.stdout.write(json.dumps(results))
except Exception as e:
    import traceback
    sys.stderr.write(traceback.format_exc())
    sys.exit(1)
"#;
                let clean_py_code = code
                    .replace("$input", "_input")
                    .replace("$json", "_json");
                let mut indented_code = clean_py_code
                    .lines()
                    .map(|l| {
                        if l.trim().is_empty() {
                            String::new()
                        } else {
                            format!("            {}", l)
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                if indented_code.trim().is_empty() {
                    indented_code = "            pass".to_string();
                }

                let harness = template
                    .replace("__PYTHON_CODE_FOR_EACH__", &indented_code)
                    .replace("__PYTHON_CODE_FOR_ALL__", &indented_code);
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
            .kill_on_drop(true);

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
