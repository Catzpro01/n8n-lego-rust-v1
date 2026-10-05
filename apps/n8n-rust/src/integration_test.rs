use crate::evaluator::JsEvaluator;
use crate::parser::WorkflowGraph;
use crate::workflow::{Connection, Node, Workflow};
use crate::WorkflowExecutor;
use crate::nodes;
use crate::nodes::INodeExecutionData;
use std::collections::HashMap;

#[test]
fn test_workflow_parsing() {
    let raw_json = r#"{
        "id": "wf_test_1",
        "name": "Unit Test Flow",
        "active": true,
        "nodes": [
            {
                "id": "node_1",
                "name": "Node A",
                "typeVersion": 1.0,
                "type": "n8n-nodes-base.set",
                "position": [0.0, 0.0],
                "parameters": {
                    "hello": "world"
                }
            }
        ],
        "connections": {}
    }"#;

    let workflow: Workflow = serde_json::from_str(raw_json).expect("Harus berhasil parsing");
    assert_eq!(workflow.name, "Unit Test Flow");
    assert_eq!(workflow.nodes.len(), 1);
}

#[test]
fn test_expression_evaluator() {
    let context = serde_json::json!({
        "item": {
            "title": "smartphone",
            "price": 500,
            "taxRate": 0.1
        }
    });

    let expr = "$json.item.title.toUpperCase() + ' $' + ($json.item.price * (1 + $json.item.taxRate))";
    let result = JsEvaluator::evaluate_expression(expr, &context);
    assert!(result.is_ok(), "Evaluator ekspresi JS harus berhasil");
    assert_eq!(
        result.unwrap(),
        serde_json::Value::String("SMARTPHONE $550".to_string())
    );
}

#[tokio::test]
async fn test_dag_execution_pipeline() {
    let mut connections = HashMap::new();
    let mut node_a_out = HashMap::new();
    node_a_out.insert(
        "main".to_string(),
        vec![vec![Connection {
            node: "Node B".to_string(),
            connection_type: "main".to_string(),
            index: 0,
        }]],
    );
    connections.insert("Node A".to_string(), node_a_out);

    let workflow = Workflow {
        id: Some("test_dag".to_string()),
        name: "Test DAG Execution".to_string(),
        active: true,
        nodes: vec![
            Node {
                id: "1".to_string(),
                name: "Node A".to_string(),
                type_version: 1.0,
                node_type: "n8n-nodes-base.set".to_string(),
                position: (0.0, 0.0),
                disabled: None,
                parameters: serde_json::json!({
                    "score": 100
                }),
                credentials: None,
            },
            Node {
                id: "2".to_string(),
                name: "Node B".to_string(),
                type_version: 1.0,
                node_type: "n8n-nodes-base.set".to_string(),
                position: (100.0, 0.0),
                disabled: None,
                parameters: serde_json::json!({
                    "bonusScore": "=$json[0].json.score + 50"
                }),
                credentials: None,
            },
        ],
        connections,
        created_at: None,
        updated_at: None,
        tags: vec![],
    };

    let dag = WorkflowGraph::build(&workflow);
    let executor = WorkflowExecutor::new(dag);
    let results = executor.execute().await.expect("DAG execution harus sukses");

    let node_b_output = results.get("Node B").expect("Node B harus memiliki output");
    let bonus_score = node_b_output[0]["json"]["bonusScore"].as_i64().unwrap_or(0);
    assert_eq!(bonus_score, 150, "Skor bonus harus 150");
}

#[tokio::test]
async fn test_modular_crypto_node() {
    let registry = nodes::create_default_registry();
    let crypto_node = registry.get("n8n-nodes-base.crypto").expect("Crypto node harus terdaftar");

    // Test UUID v4
    let ctx_uuid = nodes::NodeExecutionContext {
        workflow_id: "test".to_string(),
        execution_id: "exec".to_string(),
        node_name: "CryptoTest".to_string(),
        parameters: serde_json::json!({ "action": "uuid" }).as_object().unwrap().clone(),
    };
    let out = crypto_node.execute(&ctx_uuid, vec![]).await.expect("Crypto UUID execute harus sukses");
    let uuid_str = out[0][0].json["uuid"].as_str().unwrap_or("");
    assert_eq!(uuid_str.len(), 36, "UUID harus 36 karakter");

    // Test SHA256 Hash
    let ctx_hash = nodes::NodeExecutionContext {
        workflow_id: "test".to_string(),
        execution_id: "exec".to_string(),
        node_name: "CryptoTest".to_string(),
        parameters: serde_json::json!({
            "action": "hash",
            "type": "SHA256",
            "targetField": "text"
        }).as_object().unwrap().clone(),
    };
    let input = vec![INodeExecutionData::from_json(serde_json::json!({
        "text": "hello"
    }))];
    let out_hash = crypto_node.execute(&ctx_hash, input).await.expect("Crypto SHA256 harus sukses");
    let hash_str = out_hash[0][0].json["hash"].as_str().unwrap_or("");
    assert_eq!(hash_str, "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
}

#[tokio::test]
async fn test_modular_sqlite_node() {
    let registry = nodes::create_default_registry();
    let sqlite_node = registry.get("n8n-nodes-base.sqlite").expect("SQLite node harus terdaftar");

    let db_path = "target/test_modular.db";
    let _ = std::fs::remove_file(db_path);

    // 1. Create table
    let ctx_create = nodes::NodeExecutionContext {
        workflow_id: "test".to_string(),
        execution_id: "exec".to_string(),
        node_name: "SqliteCreate".to_string(),
        parameters: serde_json::json!({
            "databaseFile": db_path,
            "query": "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL)"
        }).as_object().unwrap().clone(),
    };
    let out_create = sqlite_node.execute(&ctx_create, vec![]).await.expect("Create table harus sukses");
    assert!(out_create[0][0].json["success"].as_bool().unwrap_or(false));

    // 2. Insert data
    let ctx_insert = nodes::NodeExecutionContext {
        workflow_id: "test".to_string(),
        execution_id: "exec".to_string(),
        node_name: "SqliteInsert".to_string(),
        parameters: serde_json::json!({
            "databaseFile": db_path,
            "query": "INSERT INTO products (name, price) VALUES ('High Speed Rust Router', 199.99)"
        }).as_object().unwrap().clone(),
    };
    let out_insert = sqlite_node.execute(&ctx_insert, vec![]).await.expect("Insert harus sukses");
    assert_eq!(out_insert[0][0].json["rowsAffected"].as_i64().unwrap_or(0), 1);

    // 3. Query data
    let ctx_select = nodes::NodeExecutionContext {
        workflow_id: "test".to_string(),
        execution_id: "exec".to_string(),
        node_name: "SqliteSelect".to_string(),
        parameters: serde_json::json!({
            "databaseFile": db_path,
            "query": "SELECT id, name, price FROM products WHERE price > 100"
        }).as_object().unwrap().clone(),
    };
    let out_select = sqlite_node.execute(&ctx_select, vec![]).await.expect("Select query harus sukses");
    assert_eq!(out_select[0].len(), 1);
    assert_eq!(out_select[0][0].json["name"].as_str().unwrap_or(""), "High Speed Rust Router");
    assert_eq!(out_select[0][0].json["price"].as_f64().unwrap_or(0.0), 199.99);

    let _ = std::fs::remove_file(db_path);
}

#[tokio::test]
async fn test_kernel_workflow_execution_via_server_router() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;
    use tokio::sync::mpsc;
    use tokio::sync::broadcast;

    let db = crate::db::Database::init("sqlite::memory:")
        .await
        .expect("Database memory init harus sukses");
    let (event_sender, _) = broadcast::channel(32);
    let realtime_registry = n8n_realtime::SessionRegistry::new();

    // Daftarkan sesi realtime client dengan pushRef 'sess-kernel-test'
    let (tx_realtime, mut rx_realtime) = mpsc::unbounded_channel();
    realtime_registry
        .register("sess-kernel-test".to_string(), "user-test".to_string(), tx_realtime)
        .await;

    let state = crate::server::AppState {
        db,
        event_sender,
        realtime_registry,
    };

    let router = crate::server::create_router(state);

    let payload = serde_json::json!({
        "pushRef": "sess-kernel-test",
        "workflowData": {
            "id": "wf-kernel-exec-1",
            "name": "Kernel End-to-End Test",
            "nodes": [
                {
                    "id": "node-start",
                    "name": "Start",
                    "type": "n8n-nodes-base.start",
                    "position": [0.0, 0.0]
                },
                {
                    "id": "node-set",
                    "name": "SetValues",
                    "type": "n8n-nodes-base.set",
                    "position": [100.0, 0.0],
                    "parameters": {
                        "values": {
                            "service": "n8n-runtime-kernel",
                            "engine": "rust-async-dag"
                        }
                    }
                }
            ],
            "connections": {
                "Start": {
                    "main": [[{ "node": "SetValues", "type": "main", "index": 0 }]]
                }
            }
        }
    });

    let request = Request::builder()
        .method("POST")
        .uri("/rest/workflows/wf-kernel-exec-1/run")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();

    let response = router.clone().oneshot(request).await.expect("Request execution harus sukses");
    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("Membaca response body");
    let json_resp: serde_json::Value = serde_json::from_slice(&body_bytes)
        .expect("Response harus valid JSON");

    // Verifikasi struktur JSON n8n-compatible
    let data = &json_resp["data"];
    assert_eq!(data["status"], "success");
    assert_eq!(data["finished"], true);
    assert_eq!(data["workflowId"], "wf-kernel-exec-1");
    assert!(data["durationMs"].is_number());
    assert_eq!(data["frames"]["SetValues"]["status"], "completed");

    let run_data = &data["data"]["resultData"]["runData"];
    assert!(run_data["SetValues"].is_array());
    let set_output = &run_data["SetValues"][0]["data"]["main"][0][0]["json"];
    assert_eq!(set_output["service"], "n8n-runtime-kernel");
    assert_eq!(set_output["engine"], "rust-async-dag");

    // Verifikasi event realtime yang terkirim melalui SessionRegistry
    let mut realtime_events = Vec::new();
    while let Ok(msg) = rx_realtime.try_recv() {
        realtime_events.push(msg);
    }

    assert!(
        realtime_events.iter().any(|msg| msg.contains("executionStarted")),
        "Harus ada event realtime executionStarted"
    );
    assert!(
        realtime_events.iter().any(|msg| msg.contains("nodeExecuteBefore")),
        "Harus ada event realtime nodeExecuteBefore"
    );
    assert!(
        realtime_events.iter().any(|msg| msg.contains("executionFinished")),
        "Harus ada event realtime executionFinished"
    );
}

#[tokio::test]
async fn test_kernel_workflow_execution_via_api_v1_executions() {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;
    use tokio::sync::broadcast;

    let db = crate::db::Database::init("sqlite::memory:")
        .await
        .expect("Database memory init harus sukses");
    let (event_sender, _) = broadcast::channel(32);
    let realtime_registry = n8n_realtime::SessionRegistry::new();

    let state = crate::server::AppState {
        db,
        event_sender,
        realtime_registry,
    };

    let router = crate::server::create_router(state);

    let payload = serde_json::json!({
        "workflowId": "wf-v1-api",
        "workflowData": {
            "id": "wf-v1-api",
            "name": "API v1 Endpoint Test",
            "nodes": [
                {
                    "id": "v1-start",
                    "name": "Start",
                    "type": "n8n-nodes-base.start",
                    "position": [0.0, 0.0]
                }
            ],
            "connections": {}
        }
    });

    let request = Request::builder()
        .method("POST")
        .uri("/api/v1/executions")
        .header("content-type", "application/json")
        .body(Body::from(serde_json::to_vec(&payload).unwrap()))
        .unwrap();

    let response = router.oneshot(request).await.expect("Request api/v1/executions harus sukses");
    assert_eq!(response.status(), StatusCode::OK);

    let body_bytes = axum::body::to_bytes(response.into_body(), 1024 * 1024)
        .await
        .expect("Membaca response body");
    let json_resp: serde_json::Value = serde_json::from_slice(&body_bytes)
        .expect("Response harus valid JSON");

    assert_eq!(json_resp["data"]["status"], "success");
    assert_eq!(json_resp["data"]["finished"], true);
    assert_eq!(json_resp["data"]["workflowId"], "wf-v1-api");
}

