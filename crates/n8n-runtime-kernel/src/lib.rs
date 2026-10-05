//! n8n-runtime-kernel — Core execution engine uniting the LEGO Rust ecosystem.
//!
//! Provides the execution context, stack frames, topological DAG planning,
//! composite node execution, asynchronous parallel scheduling, and durable state journaling.

pub mod compat_worker;
pub mod context;
pub mod executor;
pub mod frame;
pub mod integration_ir;
pub mod journal;
pub mod plan;
pub mod scheduler;

pub use compat_worker::{NodeCompatibilityWorker, NodeJob, NodeOutput, WorkerError};

pub use context::{ExecutionContext, ExecutionMode};
pub use executor::{KernelExecutionError, KernelNodeExecutor, NodeExecutor};
pub use frame::{ExecutionFrame, NodeExecutionStatus};
pub use integration_ir::{
    AuthResolver, AuthSpec, IntegrationError, IntegrationExecutor, IntegrationSpec,
    NetworkPolicy, NetworkPolicyError, PaginationPolicy, RateLimitPolicy, ResolvedAuth,
    ResponseExtractor,
};
pub use journal::{
    DurabilityPolicy, ExecutionJournal, FileAppendJournalStorage, InMemoryJournalStorage,
    JournalEntry, JournalError, JournalStepType, JournalStorage,
};
pub use plan::{ExecutionPlan, ExecutionStage, PlanEdge, PlanError};
pub use scheduler::{
    KernelScheduler, SchedulerOptions, WorkflowExecutionResult, WorkflowExecutionStatus,
};

#[cfg(test)]
mod tests {
    use super::*;
    use n8n_common::INodeExecutionData;
    use n8n_error_recovery::{CircuitBreaker, CircuitBreakerConfig};
    use n8n_events::{EventBus, EventType};
    use n8n_node_model::INode;
    use n8n_realtime::SessionRegistry;
    use n8n_subworkflow::{
        FnSubworkflowHandler, SubworkflowConfig, SubworkflowExecutor,
    };
    use n8n_workflow::{Connections, Workflow};
    use serde_json::json;
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc;

    fn make_test_node(
        name: &str,
        node_type: &str,
        params: serde_json::Value,
        extra: serde_json::Value,
    ) -> INode {
        let mut extra_map = serde_json::Map::new();
        if let Some(obj) = extra.as_object() {
            for (k, v) in obj {
                extra_map.insert(k.clone(), v.clone());
            }
        }

        INode {
            id: format!("id-{}", name),
            name: name.to_string(),
            node_type: node_type.to_string(),
            type_version: 1.0,
            position: [0.0, 0.0],
            parameters: n8n_node_model::INodeParameters(params),
            disabled: Some(false),
            extra: extra_map,
        }
    }

    #[tokio::test]
    async fn test_single_node_set_execution() {
        let node_start = make_test_node("Start", "n8n-nodes-base.start", json!({}), json!({}));
        let node_set = make_test_node(
            "SetValues",
            "n8n-nodes-base.set",
            json!({
                "values": { "kernel_status": "READY", "version": 1 }
            }),
            json!({}),
        );

        let connections: Connections = serde_json::from_value(json!({
            "Start": { "main": [[{ "node": "SetValues", "type": "main", "index": 0 }]] }
        }))
        .unwrap();

        let workflow = Workflow::new(
            Some("wf-single".into()),
            Some("Single Set Test".into()),
            vec![node_start, node_set],
            connections,
            true,
            None,
            None,
            None,
        );

        let context = Arc::new(ExecutionContext::new("wf-single", ExecutionMode::Manual));
        let executor = Arc::new(KernelNodeExecutor::new());
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::default();

        let input_item = INodeExecutionData {
            json: json!({ "user": "alice" }),
            binary: None,
            paired_item: None,
        };

        let result = scheduler
            .execute_workflow(
                &workflow,
                Some(vec![input_item]),
                context,
                executor,
                journal.clone(),
            )
            .await
            .expect("Execution must succeed");

        assert_eq!(result.status, WorkflowExecutionStatus::Success);
        assert_eq!(result.frames.len(), 2);

        let set_frame = result.frames.get("SetValues").unwrap();
        assert_eq!(set_frame.status, NodeExecutionStatus::Completed);
        let output = set_frame.output_data.as_ref().unwrap();
        assert_eq!(output.len(), 1);
        assert_eq!(output[0].len(), 1);
        assert_eq!(output[0][0].json["user"], "alice");
        assert_eq!(output[0][0].json["kernel_status"], "READY");
        assert_eq!(output[0][0].json["version"], 1);

        // Journal inspection
        assert!(journal.is_node_completed("SetValues").await);
        let entries = journal.get_entries().await;
        assert!(entries.iter().any(|e| e.step_type == JournalStepType::WorkflowCompleted));
    }

    #[tokio::test]
    async fn test_sequential_pipeline_execution() {
        let node_a = make_test_node("Start", "n8n-nodes-base.start", json!({}), json!({}));
        let node_b = make_test_node(
            "Step1",
            "n8n-nodes-base.set",
            json!({ "values": { "step1": true } }),
            json!({}),
        );
        let node_c = make_test_node(
            "Step2",
            "n8n-nodes-base.set",
            json!({ "values": { "step2": true } }),
            json!({}),
        );

        let connections: Connections = serde_json::from_value(json!({
            "Start": { "main": [[{ "node": "Step1", "type": "main", "index": 0 }]] },
            "Step1": { "main": [[{ "node": "Step2", "type": "main", "index": 0 }]] }
        }))
        .unwrap();

        let workflow = Workflow::new(
            Some("wf-seq".into()),
            Some("Sequential".into()),
            vec![node_a, node_b, node_c],
            connections,
            true,
            None,
            None,
            None,
        );

        let context = Arc::new(ExecutionContext::new("wf-seq", ExecutionMode::Manual));
        let executor = Arc::new(KernelNodeExecutor::new());
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::default();

        let result = scheduler
            .execute_workflow(&workflow, None, context, executor, journal)
            .await
            .unwrap();

        assert_eq!(result.status, WorkflowExecutionStatus::Success);
        let step2_frame = result.frames.get("Step2").unwrap();
        let out = step2_frame.output_data.as_ref().unwrap();
        assert_eq!(out[0][0].json["step1"], true);
        assert_eq!(out[0][0].json["step2"], true);
    }

    #[tokio::test]
    async fn test_parallel_diamond_dag_execution() {
        let node_start = make_test_node("Start", "n8n-nodes-base.start", json!({}), json!({}));
        let node_left = make_test_node(
            "Left",
            "n8n-nodes-base.set",
            json!({ "values": { "path_left": "OK" } }),
            json!({}),
        );
        let node_right = make_test_node(
            "Right",
            "n8n-nodes-base.set",
            json!({ "values": { "path_right": "OK" } }),
            json!({}),
        );
        let node_join = make_test_node(
            "Join",
            "n8n-nodes-base.set",
            json!({ "values": { "joined": true } }),
            json!({}),
        );

        // Start forks to Left and Right; Left and Right both connect to Join
        let connections: Connections = serde_json::from_value(json!({
            "Start": {
                "main": [[
                    { "node": "Left", "type": "main", "index": 0 },
                    { "node": "Right", "type": "main", "index": 0 }
                ]]
            },
            "Left": { "main": [[{ "node": "Join", "type": "main", "index": 0 }]] },
            "Right": { "main": [[{ "node": "Join", "type": "main", "index": 0 }]] }
        }))
        .unwrap();

        let workflow = Workflow::new(
            Some("wf-diamond".into()),
            Some("Diamond DAG".into()),
            vec![node_start, node_left, node_right, node_join],
            connections,
            true,
            None,
            None,
            None,
        );

        let plan = ExecutionPlan::from_workflow(&workflow).unwrap();
        // Root is Start (stage 0), Left & Right in parallel (stage 1), Join (stage 2)
        assert_eq!(plan.stages.len(), 3);
        assert_eq!(plan.stages[1].nodes.len(), 2);
        assert!(plan.stages[1].nodes.contains(&"Left".to_string()));
        assert!(plan.stages[1].nodes.contains(&"Right".to_string()));

        let context = Arc::new(ExecutionContext::new("wf-diamond", ExecutionMode::Trigger));
        let executor = Arc::new(KernelNodeExecutor::new());
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::new(SchedulerOptions {
            max_concurrency: 4,
            ..Default::default()
        });

        let result = scheduler
            .execute_workflow(&workflow, None, context, executor, journal)
            .await
            .unwrap();

        assert_eq!(result.status, WorkflowExecutionStatus::Success);
        let join_frame = result.frames.get("Join").unwrap();
        assert_eq!(join_frame.status, NodeExecutionStatus::Completed);
        assert!(join_frame.input_data[0].len() >= 2);
    }

    #[tokio::test]
    async fn test_conditional_if_branching() {
        let node_start = make_test_node("Start", "n8n-nodes-base.start", json!({}), json!({}));
        let node_if = make_test_node(
            "CheckActive",
            "n8n-nodes-base.if",
            json!({ "key": "isActive" }),
            json!({}),
        );
        let node_true = make_test_node(
            "TrueBranch",
            "n8n-nodes-base.set",
            json!({ "values": { "route": "PASSED" } }),
            json!({}),
        );
        let node_false = make_test_node(
            "FalseBranch",
            "n8n-nodes-base.set",
            json!({ "values": { "route": "BLOCKED" } }),
            json!({}),
        );

        // IfNode outputs[0] is true, outputs[1] is false
        let connections: Connections = serde_json::from_value(json!({
            "Start": { "main": [[{ "node": "CheckActive", "type": "main", "index": 0 }]] },
            "CheckActive": {
                "main": [
                    [{ "node": "TrueBranch", "type": "main", "index": 0 }],
                    [{ "node": "FalseBranch", "type": "main", "index": 0 }]
                ]
            }
        }))
        .unwrap();

        let workflow = Workflow::new(
            Some("wf-if".into()),
            Some("If Branching".into()),
            vec![node_start, node_if, node_true, node_false],
            connections,
            true,
            None,
            None,
            None,
        );

        let input_item = INodeExecutionData {
            json: json!({ "isActive": true, "name": "active_user" }),
            binary: None,
            paired_item: None,
        };

        let context = Arc::new(ExecutionContext::new("wf-if", ExecutionMode::Manual));
        let executor = Arc::new(KernelNodeExecutor::new());
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::default();

        let result = scheduler
            .execute_workflow(&workflow, Some(vec![input_item]), context, executor, journal)
            .await
            .unwrap();

        assert_eq!(result.status, WorkflowExecutionStatus::Success);
        let true_frame = result.frames.get("TrueBranch").unwrap();
        assert_eq!(true_frame.status, NodeExecutionStatus::Completed);
        let out = true_frame.output_data.as_ref().unwrap();
        assert_eq!(out[0][0].json["route"], "PASSED");

        // False branch should be skipped
        let false_frame = result.frames.get("FalseBranch").unwrap();
        assert_eq!(false_frame.status, NodeExecutionStatus::Skipped);
    }

    #[tokio::test]
    async fn test_circuit_breaker_protection() {
        let cb_config = CircuitBreakerConfig::new(2, Duration::from_secs(60), 2);
        let cb = Arc::new(CircuitBreaker::new("test-breaker", cb_config));

        // Trip the circuit breaker by recording failures
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), n8n_error_recovery::CircuitBreakerState::Open);

        let node = make_test_node(
            "GuardedNode",
            "n8n-nodes-base.set",
            json!({ "values": {} }),
            json!({}),
        );
        let executor = KernelNodeExecutor::new().with_circuit_breaker(cb);
        let context = ExecutionContext::new("wf-cb", ExecutionMode::Manual);

        let res = executor.execute(&node, vec![], &context).await;
        assert!(res.is_err());
        match res.unwrap_err() {
            KernelExecutionError::CircuitBreakerOpen { name, .. } => {
                assert_eq!(name, "test-breaker");
            }
            other => panic!("Expected CircuitBreakerOpen, got {:?}", other),
        }
    }

    #[tokio::test]
    async fn test_cancellation_token_halts_execution() {
        let node_a = make_test_node("Start", "n8n-nodes-base.start", json!({}), json!({}));
        let node_b = make_test_node(
            "Step1",
            "n8n-nodes-base.set",
            json!({ "values": { "v": 1 } }),
            json!({}),
        );

        let connections: Connections = serde_json::from_value(json!({
            "Start": { "main": [[{ "node": "Step1", "type": "main", "index": 0 }]] }
        }))
        .unwrap();

        let workflow = Workflow::new(
            Some("wf-cancel".into()),
            None,
            vec![node_a, node_b],
            connections,
            true,
            None,
            None,
            None,
        );

        let token = Arc::new(AtomicBool::new(true)); // Pre-cancelled
        let context = Arc::new(
            ExecutionContext::new("wf-cancel", ExecutionMode::Manual)
                .with_cancellation_token(token),
        );

        let executor = Arc::new(KernelNodeExecutor::new());
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::default();

        let result = scheduler
            .execute_workflow(&workflow, None, context, executor, journal)
            .await
            .unwrap();

        assert_eq!(result.status, WorkflowExecutionStatus::Cancelled);
    }

    #[tokio::test]
    async fn test_event_bus_and_realtime_emission() {
        let bus = Arc::new(EventBus::new(32));
        let mut sub_events = bus.subscribe();

        let registry = Arc::new(SessionRegistry::new());
        let (tx, mut rx_realtime) = mpsc::unbounded_channel();
        registry.register("push-sess-1".to_string(), "user-1".to_string(), tx).await;

        let node_start = make_test_node("Start", "n8n-nodes-base.start", json!({}), json!({}));
        let workflow = Workflow::new(
            Some("wf-events".into()),
            None,
            vec![node_start],
            Connections::new(),
            true,
            None,
            None,
            None,
        );

        let context = Arc::new(
            ExecutionContext::new("wf-events", ExecutionMode::Manual)
                .with_event_bus(bus)
                .with_realtime_sessions(registry)
                .with_push_ref("push-sess-1"),
        );

        let executor = Arc::new(KernelNodeExecutor::new());
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::default();

        let result = scheduler
            .execute_workflow(&workflow, None, context, executor, journal)
            .await
            .unwrap();

        assert_eq!(result.status, WorkflowExecutionStatus::Success);

        // Verify EventBus published events
        let ev1 = sub_events.recv().await.unwrap();
        assert_eq!(ev1.event_type, EventType::WorkflowStarted);
        let ev2 = sub_events.recv().await.unwrap();
        assert_eq!(ev2.event_type, EventType::NodeExecuted);

        // Verify Realtime push messages streamed to WebSocket session
        let rt_msg = rx_realtime.recv().await.unwrap();
        assert!(rt_msg.contains("executionStarted"));
    }

    #[tokio::test]
    async fn test_subworkflow_execution_delegation() {
        let sub_config = SubworkflowConfig::default();
        let sub_executor = Arc::new(SubworkflowExecutor::new(sub_config));

        // Register echo handler for child subworkflow
        let handler = Arc::new(FnSubworkflowHandler::new(|_id, input, _ctx| {
            Box::pin(async move {
                let modified: Vec<serde_json::Value> = input
                    .into_iter()
                    .map(|item| json!({ "child_processed": true, "original": item }))
                    .collect();
                Ok(modified)
            })
        }));
        sub_executor.register_handler("child-wf-abc", handler).await;

        // Parent workflow node invoking child
        let node_sub = make_test_node(
            "InvokeChild",
            "n8n-nodes-base.executeWorkflow",
            json!({
                "workflowId": {
                    "__rl": true,
                    "value": "child-wf-abc",
                    "mode": "id"
                }
            }),
            json!({}),
        );

        let workflow = Workflow::new(
            Some("wf-parent".into()),
            None,
            vec![node_sub],
            Connections::new(),
            true,
            None,
            None,
            None,
        );

        let context = Arc::new(
            ExecutionContext::new("wf-parent", ExecutionMode::Manual)
                .with_subworkflow_executor(sub_executor.clone()),
        );

        let executor =
            Arc::new(KernelNodeExecutor::new().with_subworkflow_executor(sub_executor));
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::default();

        let input_data = vec![INodeExecutionData {
            json: json!({ "task": "calculate_tax" }),
            binary: None,
            paired_item: None,
        }];

        let result = scheduler
            .execute_workflow(&workflow, Some(input_data), context, executor, journal)
            .await
            .unwrap();

        assert_eq!(result.status, WorkflowExecutionStatus::Success);
        let frame = result.frames.get("InvokeChild").unwrap();
        let out = frame.output_data.as_ref().unwrap();
        assert_eq!(out[0][0].json["child_processed"], true);
        assert_eq!(out[0][0].json["original"]["task"], "calculate_tax");
    }

    #[tokio::test]
    async fn test_execution_journal_persistence_and_replay() {
        let journal = ExecutionJournal::new();
        journal.record_workflow_started("wf-100", "run-200").await.unwrap();
        journal
            .record_node_completed("Start", vec![vec![]], 12)
            .await
            .unwrap();
        journal
            .record_node_completed(
                "SetData",
                vec![vec![INodeExecutionData {
                    json: json!({ "score": 99 }),
                    binary: None,
                    paired_item: None,
                }]],
                45,
            )
            .await
            .unwrap();

        assert_eq!(journal.count().await, 3);
        assert!(journal.is_node_completed("SetData").await);

        let out = journal.get_node_output("SetData").await.unwrap();
        assert_eq!(out[0][0].json["score"], 99);

        // Serialize to JSON and restore into new journal instance
        let json_str = journal.to_json().await.unwrap();
        let restored = ExecutionJournal::from_json(&json_str).unwrap();

        assert_eq!(restored.count().await, 3);
        assert!(restored.is_node_completed("Start").await);
        let restored_out = restored.get_node_output("SetData").await.unwrap();
        assert_eq!(restored_out[0][0].json["score"], 99);
    }

    #[test]
    fn test_execution_frame_item_buffer_bridge() {
        let mut frame = ExecutionFrame::new("id-1", "TestNode", "n8n-nodes-base.set");
        let item1 = INodeExecutionData {
            json: json!({ "id": 1 }),
            binary: None,
            paired_item: None,
        };
        let item2 = INodeExecutionData {
            json: json!({ "id": 2 }),
            binary: None,
            paired_item: None,
        };

        frame.mark_completed(vec![vec![item1, item2]]);
        let buffer = frame.to_item_buffer(0);
        assert_eq!(buffer.len(), 2);
        assert_eq!(buffer.get(0).unwrap().json["id"], 1);

        let converted_back = ExecutionFrame::from_item_buffer(&buffer);
        assert_eq!(converted_back.len(), 2);
        assert_eq!(converted_back[1].json["id"], 2);
    }

    #[test]
    fn test_dag_cycle_rejection() {
        let n1 = make_test_node("A", "n8n-nodes-base.noOp", json!({}), json!({}));
        let n2 = make_test_node("B", "n8n-nodes-base.noOp", json!({}), json!({}));

        let connections: Connections = serde_json::from_value(json!({
            "A": { "main": [[{ "node": "B", "type": "main", "index": 0 }]] },
            "B": { "main": [[{ "node": "A", "type": "main", "index": 0 }]] }
        }))
        .unwrap();

        let workflow = Workflow::new(
            Some("wf-cycle".into()),
            None,
            vec![n1, n2],
            connections,
            true,
            None,
            None,
            None,
        );

        let plan_res = ExecutionPlan::from_workflow(&workflow);
        assert!(plan_res.is_err());
    }

    #[tokio::test]
    async fn test_compatibility_worker_queue_execution() {
        let queue = n8n_queue::JobQueueEngine::new(5);
        let executor = Arc::new(KernelNodeExecutor::new().with_queue(queue.clone()));

        // External compatibility node not in native registry
        let node = make_test_node(
            "ExternalApi",
            "n8n-nodes-base.customLegacyWorkerNode",
            json!({}),
            json!({}),
        );

        let context = ExecutionContext::new("wf-queue", ExecutionMode::Manual);
        let input_item = INodeExecutionData {
            json: json!({ "payload": "from_queue" }),
            binary: None,
            paired_item: None,
        };

        let result = executor.execute(&node, vec![input_item], &context).await;
        assert!(result.is_ok());
        let metrics = queue.get_metrics();
        assert_eq!(metrics.completed, 1);
    }

    #[tokio::test]
    async fn test_node_retry_settings_handling() {
        // Node configured with retry settings
        let node = make_test_node(
            "RetryNode",
            "n8n-nodes-base.set",
            json!({
                "values": { "done": true },
                "retryOnFail": true,
                "maxTries": 3,
                "waitBetweenTries": 10
            }),
            json!({}),
        );

        let executor = KernelNodeExecutor::new();
        let context = ExecutionContext::new("wf-retry", ExecutionMode::Manual);

        let input_item = INodeExecutionData {
            json: json!({}),
            binary: None,
            paired_item: None,
        };
        let res = executor.execute(&node, vec![input_item], &context).await;
        assert!(res.is_ok());
        let outputs = res.unwrap();
        assert_eq!(outputs[0][0].json["done"], true);
    }

    #[tokio::test]
    async fn test_declarative_http_request_node_integration() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await.unwrap();

            let body = serde_json::to_string(&json!([
                { "id": 1, "name": "Item One" },
                { "id": 2, "name": "Item Two" }
            ])).unwrap();

            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(resp.as_bytes()).await.unwrap();
        });

        let node = make_test_node(
            "FetchItems",
            "n8n-nodes-base.httpRequest",
            json!({
                "url": format!("http://127.0.0.1:{}/api/items", port),
                "method": "GET"
            }),
            json!({}),
        );

        let executor = KernelNodeExecutor::new().with_network_policy(NetworkPolicy::permissive());
        let context = ExecutionContext::new("wf-http", ExecutionMode::Manual);
        let input_item = INodeExecutionData {
            json: json!({}),
            binary: None,
            paired_item: None,
        };

        let result = executor.execute(&node, vec![input_item], &context).await;
        assert!(result.is_ok());
        let outputs = result.unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].len(), 2);
        assert_eq!(outputs[0][0].json["name"], "Item One");
        assert_eq!(outputs[0][1].json["name"], "Item Two");
    }

    #[tokio::test]
    async fn test_declarative_integration_spec_node_execution() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();

        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 2048];
            let n = socket.read(&mut buf).await.unwrap();
            let req_str = String::from_utf8_lossy(&buf[..n]);

            // Verify Bearer token was injected
            assert!(req_str.contains("Authorization: Bearer secret-token-xyz") || req_str.contains("authorization: Bearer secret-token-xyz"));
            // Verify path parameter was interpolated
            assert!(req_str.contains("/users/user-42/profile"));

            let body = serde_json::to_string(&json!({
                "profile": {
                    "userId": "user-42",
                    "status": "active"
                }
            })).unwrap();

            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket.write_all(resp.as_bytes()).await.unwrap();
        });

        let spec = IntegrationSpec::new("GET", format!("http://127.0.0.1:{}/users/{{userId}}/profile", port))
            .with_auth(AuthSpec::Bearer { token_template: "{{authToken}}".to_string() })
            .with_response_extractor(ResponseExtractor::new().with_root_path("profile"));

        let node = make_test_node(
            "UserProfile",
            "custom.declarativeNode",
            json!({
                "integrationSpec": serde_json::to_value(spec).unwrap()
            }),
            json!({}),
        );

        let executor = KernelNodeExecutor::new().with_network_policy(NetworkPolicy::permissive());
        let context = ExecutionContext::new("wf-spec", ExecutionMode::Manual);
        let input_item = INodeExecutionData {
            json: json!({
                "userId": "user-42",
                "authToken": "secret-token-xyz"
            }),
            binary: None,
            paired_item: None,
        };

        let result = executor.execute(&node, vec![input_item], &context).await;
        assert!(result.is_ok());
        let outputs = result.unwrap();
        assert_eq!(outputs[0][0].json["userId"], "user-42");
        assert_eq!(outputs[0][0].json["status"], "active");
    }

    #[tokio::test]
    async fn test_durable_journal_wal_recovery_after_restart() {
        let temp_dir = std::env::temp_dir().join(format!("n8n_test_wal_restart_{}", uuid::Uuid::new_v4()));
        let wal_path = temp_dir.join("execution.wal");

        // 1. Initial process session: record steps and crash/drop
        {
            let journal = ExecutionJournal::open_file(&wal_path).await.unwrap();
            journal.record_workflow_started("wf-restart", "run-101").await.unwrap();
            journal
                .record_node_started("Compute", vec![vec![INodeExecutionData {
                    json: json!({ "x": 10 }),
                    binary: None,
                    paired_item: None,
                }]])
                .await
                .unwrap();
            journal
                .record_node_completed("Compute", vec![vec![INodeExecutionData {
                    json: json!({ "x": 10, "result": 100 }),
                    binary: None,
                    paired_item: None,
                }]], 25)
                .await
                .unwrap();
            journal.checkpoint().await.unwrap();
        }

        // 2. Second process session: recovers entire journal state from WAL file
        {
            let restored = ExecutionJournal::open_file(&wal_path).await.unwrap();
            assert_eq!(restored.count().await, 3);
            assert!(restored.is_node_completed("Compute").await);

            let out = restored.get_node_output("Compute").await.unwrap();
            assert_eq!(out[0][0].json["result"], 100);

            // Replay sequence: next step must follow monotonically
            let complete_entry = restored.record_workflow_completed(120).await.expect("Record succeeds");
            assert_eq!(complete_entry.step_id, 4);
            assert_eq!(restored.count().await, 4);
        }

        let _ = tokio::fs::remove_dir_all(&temp_dir).await;
    }

    #[tokio::test]
    async fn test_workflow_execution_with_real_compatibility_worker_fallback() {
        let node_start = make_test_node("Start", "n8n-nodes-base.start", json!({}), json!({}));
        let node_compat = make_test_node(
            "ComputeJs",
            "n8n-nodes-base.unportedCommunityNode",
            json!({
                "jsCode": "return [{ json: { calc: 10 * 5, tag: 'node_processed' } }];"
            }),
            json!({}),
        );

        let connections: Connections = serde_json::from_value(json!({
            "Start": { "main": [[{ "node": "ComputeJs", "type": "main", "index": 0 }]] }
        }))
        .unwrap();

        let workflow = Workflow::new(
            Some("wf-real-worker".into()),
            Some("Real Worker Test".into()),
            vec![node_start, node_compat],
            connections,
            true,
            None,
            None,
            None,
        );

        let context = Arc::new(ExecutionContext::new("wf-real-worker", ExecutionMode::Manual));
        let executor = Arc::new(KernelNodeExecutor::new());
        let journal = Arc::new(ExecutionJournal::new());
        let scheduler = KernelScheduler::default();

        let input_item = INodeExecutionData {
            json: json!({ "seed": 42 }),
            binary: None,
            paired_item: None,
        };

        let result = scheduler
            .execute_workflow(
                &workflow,
                Some(vec![input_item]),
                context,
                executor,
                journal.clone(),
            )
            .await
            .expect("Workflow execution must succeed with real Node.js compatibility worker");

        assert_eq!(result.status, WorkflowExecutionStatus::Success);
        let code_frame = result.frames.get("ComputeJs").expect("ComputeJs frame must exist");
        assert_eq!(code_frame.status, NodeExecutionStatus::Completed);

        let output = code_frame.output_data.as_ref().expect("Output data must exist");
        assert_eq!(output[0][0].json["calc"], 50);
        assert_eq!(output[0][0].json["tag"], "node_processed");
        assert!(journal.is_node_completed("ComputeJs").await);
    }
}
