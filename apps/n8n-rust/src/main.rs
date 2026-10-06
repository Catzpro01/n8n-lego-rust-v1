use std::io::Write;
use std::net::SocketAddr;
use tokio::io::AsyncReadExt;
use tokio::sync::broadcast;

use n8n_common::INodeExecutionData;
use n8n_runtime_kernel::{
    ExecutionContext, ExecutionMode, KernelScheduler, NodeExecutionStatus,
    SchedulerOptions, WorkflowExecutionStatus,
};
use n8n_rust_core::db::Database;
use n8n_rust_core::events::ExecutionEvent;
use n8n_rust_core::parse_kernel_workflow;
use n8n_rust_core::scheduler::WorkflowScheduler;
use n8n_rust_core::server::{create_router, AppState};
use n8n_rust_core::workflow::{Connection, Node, Workflow};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Mode Deteksi Argumen: CLI Execution / IPC via Stdin-Stdout
    let args: Vec<String> = std::env::args().collect();
    let is_ipc_mode = args.iter().any(|arg| arg == "execute" || arg == "--ipc" || arg == "-e");
    if is_ipc_mode {
        run_ipc_execution().await;
        return Ok(());
    }

    println!("============================================================");
    println!("       ⚡ N8N RUST FULL SERVER (STANDALONE ENGINE) ⚡       ");
    println!("============================================================\n");

    // 1. Inisialisasi Database SQLite (Pilihan B)
    let db_path = "sqlite://n8n.sqlite";
    println!("📦 Menginisialisasi Database SQLite: {}", db_path);
    let db = Database::init(db_path).await?;

    // Seed default workflow contoh ke database jika kosong
    let existing_workflows = db.list_workflows().await?;
    if existing_workflows.is_empty() {
        println!("🌱 Menyemai workflow percontohan (E-Commerce Webhook & Cron Sync)...");
        let sample_wf = Workflow {
            id: Some("ecommerce_sync".to_string()),
            name: "E-Commerce Webhook & Sync Pipeline".to_string(),
            active: true,
            created_at: None,
            updated_at: None,
            tags: vec![],
            nodes: vec![
                Node {
                    id: "node_1".to_string(),
                    name: "Webhook Trigger".to_string(),
                    type_version: 1.0,
                    node_type: "n8n-nodes-base.webhook".to_string(),
                    position: (0.0, 0.0),
                    disabled: None,
                    parameters: serde_json::json!({ "path": "ecommerce_sync" }),
                    credentials: None,
                },
                Node {
                    id: "node_2".to_string(),
                    name: "Calculate Discount".to_string(),
                    type_version: 1.0,
                    node_type: "n8n-nodes-base.set".to_string(),
                    position: (250.0, 0.0),
                    disabled: None,
                    parameters: serde_json::json!({
                        "orderId": "=$json[0].json.orderId || 'ORD-DEFAULT-99'",
                        "finalAmount": "=$json[0].json.amount * 0.9",
                        "processedAt": chrono::Utc::now().to_rfc3339(),
                        "engine": "100% Rust Axum Server"
                    }),
                    credentials: None,
                },
                Node {
                    id: "node_3".to_string(),
                    name: "Notify Webhook Endpoint".to_string(),
                    type_version: 1.0,
                    node_type: "n8n-nodes-base.httpRequest".to_string(),
                    position: (500.0, 0.0),
                    disabled: None,
                    parameters: serde_json::json!({
                        "url": "https://httpbin.org/post",
                        "method": "POST",
                        "headerParameters": {
                            "X-Engine": "n8n-rust-full",
                            "Content-Type": "application/json"
                        },
                        "body": {
                            "orderSync": "=$json[0].json"
                        }
                    }),
                    credentials: None,
                },
            ],
            connections: {
                let mut conn = std::collections::HashMap::new();
                let mut node_1_out = std::collections::HashMap::new();
                node_1_out.insert(
                    "main".to_string(),
                    vec![vec![Connection {
                        node: "Calculate Discount".to_string(),
                        connection_type: "main".to_string(),
                        index: 0,
                    }]],
                );
                conn.insert("Webhook Trigger".to_string(), node_1_out);

                let mut node_2_out = std::collections::HashMap::new();
                node_2_out.insert(
                    "main".to_string(),
                    vec![vec![Connection {
                        node: "Notify Webhook Endpoint".to_string(),
                        connection_type: "main".to_string(),
                        index: 0,
                    }]],
                );
                conn.insert("Calculate Discount".to_string(), node_2_out);
                conn
            },
        };

        db.save_workflow(&sample_wf).await?;
        println!("✅ Workflow contoh berhasil disimpan ke database.");
    }

    // 2. Inisialisasi Real-Time Event Bus (Pilihan D)
    let (event_sender, _) = broadcast::channel::<ExecutionEvent>(200);

    // 3. Mulai Background Scheduler Engine (Pilihan C)
    let scheduler = WorkflowScheduler::new(db.clone(), event_sender.clone());
    let _sched_handle = scheduler.start().await?;

    // 4. Inisialisasi Axum Web Server & Webhook Listener (Pilihan A & D)
    let app_state = AppState {
        db,
        event_sender,
        realtime_registry: n8n_realtime::SessionRegistry::new(),
    };
    let app = create_router(app_state);

    let host = [0, 0, 0, 0];
    let port = std::env::var("N8N_RUST_PORT")
        .or_else(|_| std::env::var("PORT"))
        .unwrap_or_else(|_| "5678".to_string())
        .parse::<u16>()
        .unwrap_or(5678);
    let addr = SocketAddr::from((host, port));

    println!("\n🌐 N8N Rust Web Server aktif!");
    println!("   -> Health Check      : http://localhost:{}/health", port);
    println!("   -> Webhook Endpoint  : http://localhost:{}/webhook/:id (POST/GET)", port);
    println!("   -> Workflows REST    : http://localhost:{}/rest/workflows", port);
    println!("   -> Executions REST   : http://localhost:{}/rest/executions", port);
    println!("   -> WebSocket Stream  : ws://localhost:{}/ws", port);
    println!("\n🚀 Menunggu incoming requests...");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

/// Mode Eksekusi IPC Headless (Stdin -> Rust Kernel Engine -> Stdout)
/// Tanpa membutuhkan server Axum HTTP port 5678 aktif!
async fn run_ipc_execution() {
    let mut stdin_bytes = Vec::new();
    let mut stdin = tokio::io::stdin();
    if let Err(e) = stdin.read_to_end(&mut stdin_bytes).await {
        let err_json = serde_json::json!({
            "error": format!("Gagal membaca data dari stdin: {}", e),
            "status": "error",
            "finished": true,
            "data": {
                "resultData": {
                    "runData": {}
                }
            }
        });
        println!("{}", serde_json::to_string(&err_json).unwrap_or_default());
        std::io::stdout().flush().ok();
        std::process::exit(1);
    }

    if stdin_bytes.is_empty() {
        let err_json = serde_json::json!({
            "error": "Input stdin kosong. Payload workflow JSON dibutuhkan.",
            "status": "error",
            "finished": true,
            "data": {
                "resultData": {
                    "runData": {}
                }
            }
        });
        println!("{}", serde_json::to_string(&err_json).unwrap_or_default());
        std::io::stdout().flush().ok();
        std::process::exit(1);
    }

    let payload: serde_json::Value = match serde_json::from_slice(&stdin_bytes) {
        Ok(val) => val,
        Err(e) => {
            let err_json = serde_json::json!({
                "error": format!("Format JSON payload dari stdin tidak valid: {}", e),
                "status": "error",
                "finished": true,
                "data": {
                    "resultData": {
                        "runData": {}
                    }
                }
            });
            println!("{}", serde_json::to_string(&err_json).unwrap_or_default());
            std::io::stdout().flush().ok();
            std::process::exit(1);
        }
    };

    let workflow_val = payload
        .get("workflowData")
        .or_else(|| payload.get("workflow"))
        .cloned()
        .unwrap_or_else(|| payload.clone());

    let exec_id = payload
        .get("executionId")
        .or_else(|| payload.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let wf_id = workflow_val
        .get("id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| exec_id.clone());

    let workflow = match parse_kernel_workflow(workflow_val, &wf_id) {
        Ok(w) => w,
        Err(err) => {
            let err_json = serde_json::json!({
                "id": exec_id,
                "error": format!("Gagal parsing workflow ke KernelWorkflow: {}", err),
                "status": "error",
                "finished": true,
                "data": {
                    "resultData": {
                        "runData": {}
                    }
                }
            });
            println!("{}", serde_json::to_string(&err_json).unwrap_or_default());
            std::io::stdout().flush().ok();
            std::process::exit(1);
        }
    };

    let initial_data: Option<Vec<INodeExecutionData>> = payload
        .get("inputData")
        .or_else(|| payload.get("triggerData"))
        .or_else(|| payload.get("data"))
        .and_then(|dv| {
            if dv.is_null() {
                None
            } else if let Some(arr) = dv.as_array() {
                if arr.is_empty() {
                    None
                } else {
                    Some(
                        arr.iter()
                            .map(|item| {
                                if item.get("json").is_some() {
                                    serde_json::from_value(item.clone()).unwrap_or_else(|_| {
                                        INodeExecutionData {
                                            json: item.clone(),
                                            binary: None,
                                            paired_item: None,
                                        }
                                    })
                                } else {
                                    INodeExecutionData {
                                        json: item.clone(),
                                        binary: None,
                                        paired_item: None,
                                    }
                                }
                            })
                            .collect(),
                    )
                }
            } else {
                Some(vec![INodeExecutionData {
                    json: dv.clone(),
                    binary: None,
                    paired_item: None,
                }])
            }
        });

    let mode_str = payload
        .get("mode")
        .and_then(|m| m.as_str())
        .unwrap_or("manual");

    let exec_mode = match mode_str.to_lowercase().as_str() {
        "trigger" => ExecutionMode::Trigger,
        "webhook" => ExecutionMode::Webhook,
        "retry" => ExecutionMode::Retry,
        "evaluation" => ExecutionMode::Evaluation,
        "subworkflow" => ExecutionMode::Subworkflow,
        _ => ExecutionMode::Manual,
    };

    let start_time = chrono::Utc::now();
    let start_str = start_time.to_rfc3339();

    let mut ctx = ExecutionContext::new(wf_id.clone(), exec_mode).with_run_id(exec_id.clone());
    if let Some(push_ref) = payload
        .get("pushRef")
        .or_else(|| payload.get("push_ref"))
        .and_then(|v| v.as_str())
    {
        ctx = ctx.with_push_ref(push_ref);
    }
    let context = std::sync::Arc::new(ctx);

    // Tentukan direktori WAL: Ambil dari env N8N_WAL_DIR atau N8N_RUST_DATA_DIR/wal, atau fallback ke data/rust/wal
    let wal_dir = if let Ok(val) = std::env::var("N8N_WAL_DIR") {
        std::path::PathBuf::from(val)
    } else if let Ok(data_dir) = std::env::var("N8N_RUST_DATA_DIR") {
        std::path::PathBuf::from(data_dir).join("wal")
    } else {
        std::path::PathBuf::from("data/rust/wal")
    };

    if let Err(err) = tokio::fs::create_dir_all(&wal_dir).await {
        let err_msg = format!("Durable WAL Directory Failure: Gagal membuat direktori WAL di {:?}: {}", wal_dir, err);
        eprintln!("[WAL-FAIL-CLOSED] {}", err_msg);
        let err_json = serde_json::json!({
            "id": exec_id,
            "status": "error",
            "finished": true,
            "error": err_msg,
            "walPath": wal_dir.to_string_lossy().to_string(),
            "data": {
                "resultData": {
                    "runData": {}
                }
            }
        });
        println!("{}", serde_json::to_string(&err_json).unwrap_or_default());
        std::io::stdout().flush().ok();
        std::process::exit(1);
    }

    let wal_file = wal_dir.join(format!("{}.wal", exec_id));
    let wal_path_str = wal_file.to_string_lossy().to_string();

    let scheduler = match KernelScheduler::new_with_durable_wal(SchedulerOptions::default(), &wal_file).await {
        Ok(s) => s,
        Err(err) => {
            let err_msg = format!("Durable WAL Initialization Failure: Gagal inisialisasi durable WAL di {:?}: {}", wal_file, err);
            eprintln!("[WAL-FAIL-CLOSED] {}", err_msg);
            let err_json = serde_json::json!({
                "id": exec_id,
                "status": "error",
                "finished": true,
                "error": err_msg,
                "walPath": wal_path_str,
                "data": {
                    "resultData": {
                        "runData": {}
                    }
                }
            });
            println!("{}", serde_json::to_string(&err_json).unwrap_or_default());
            std::io::stdout().flush().ok();
            std::process::exit(1);
        }
    };

    let exec_res = scheduler.execute(&workflow, initial_data, &context).await;

    match exec_res {
        Ok(result) => {
            let mut first_error_msg = result.error.clone();
            if first_error_msg.is_none() {
                for frame in result.frames.values() {
                    if let Some(ref err) = frame.error {
                        first_error_msg = Some(err.clone());
                        break;
                    }
                    if frame.status == NodeExecutionStatus::Failed {
                        first_error_msg = Some("Node execution failed".to_string());
                        break;
                    }
                }
            }

            let has_error = result.status != WorkflowExecutionStatus::Success
                || first_error_msg.is_some()
                || result.frames.values().any(|f| f.status == NodeExecutionStatus::Failed || f.error.is_some());

            let status_str = if has_error {
                "error"
            } else {
                match result.status {
                    WorkflowExecutionStatus::Success => "success",
                    WorkflowExecutionStatus::Failed => "error",
                    WorkflowExecutionStatus::Cancelled => "crashed",
                }
            };

            let mut run_data = serde_json::Map::new();
            for (name, frame) in &result.frames {
                let mut task_run = serde_json::Map::new();
                if let Some(st) = frame.start_time {
                    task_run.insert(
                        "startTime".to_string(),
                        serde_json::json!(st.timestamp_millis()),
                    );
                }
                if let Some(dur) = frame.execution_time_ms {
                    task_run.insert("executionTime".to_string(), serde_json::json!(dur));
                }
                task_run.insert("executionIndex".to_string(), serde_json::json!(0));
                let exec_status = if frame.status == NodeExecutionStatus::Completed {
                    "success"
                } else {
                    "error"
                };
                task_run.insert("executionStatus".to_string(), serde_json::json!(exec_status));

                let mut data_map = serde_json::Map::new();
                if let Some(ref out_data) = frame.output_data {
                    data_map.insert(
                        "main".to_string(),
                        serde_json::to_value(out_data).unwrap_or(serde_json::json!([])),
                    );
                } else {
                    data_map.insert("main".to_string(), serde_json::json!([[]]));
                }
                task_run.insert("data".to_string(), serde_json::Value::Object(data_map));
                if let Some(ref err) = frame.error {
                    task_run.insert("error".to_string(), serde_json::json!({ "message": err }));
                }
                run_data.insert(name.clone(), serde_json::json!([task_run]));
            }

            let stop_str = result.end_time.to_rfc3339();

            let mut result_data = serde_json::json!({
                "runData": run_data,
                "walPath": wal_path_str,
            });

            if has_error {
                let err_msg = first_error_msg.unwrap_or_else(|| "Workflow execution failed".to_string());
                result_data.as_object_mut().unwrap().insert(
                    "error".to_string(),
                    serde_json::json!({
                        "name": "NodeExecutionError",
                        "message": err_msg,
                    }),
                );
            }

            let response_payload = serde_json::json!({
                "id": result.execution_id,
                "executionId": result.execution_id,
                "workflowId": result.workflow_id,
                "status": status_str,
                "finished": true,
                "mode": mode_str,
                "startedAt": start_str,
                "stoppedAt": stop_str,
                "durationMs": result.duration_ms,
                "walPath": wal_path_str,
                "data": {
                    "resultData": result_data
                }
            });

            println!("{}", serde_json::to_string(&response_payload).unwrap_or_default());
            std::io::stdout().flush().ok();
            std::process::exit(0);
        }
        Err(err) => {
            let err_json = serde_json::json!({
                "id": exec_id,
                "status": "error",
                "finished": true,
                "error": format!("DAG Execution Plan Error: {}", err),
                "walPath": wal_path_str,
                "data": {
                    "resultData": {
                        "runData": {},
                        "walPath": wal_path_str,
                    }
                }
            });
            println!("{}", serde_json::to_string(&err_json).unwrap_or_default());
            std::io::stdout().flush().ok();
            std::process::exit(1);
        }
    }
}
