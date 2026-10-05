use std::net::SocketAddr;
use tokio::sync::broadcast;

use n8n_rust_core::db::Database;
use n8n_rust_core::events::ExecutionEvent;
use n8n_rust_core::scheduler::WorkflowScheduler;
use n8n_rust_core::server::{create_router, AppState};
use n8n_rust_core::workflow::{Connection, Node, Workflow};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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
    };
    let app = create_router(app_state);

    let host = [0, 0, 0, 0];
    let port = 5678;
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
