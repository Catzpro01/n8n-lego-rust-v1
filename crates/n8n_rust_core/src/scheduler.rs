use tokio::sync::broadcast;
use tokio_cron_scheduler::{Job, JobScheduler};

use crate::db::Database;
use crate::events::ExecutionEvent;
use crate::parser::WorkflowGraph;
use crate::WorkflowExecutor;

pub struct WorkflowScheduler {
    db: Database,
    event_sender: broadcast::Sender<ExecutionEvent>,
}

impl WorkflowScheduler {
    pub fn new(db: Database, event_sender: broadcast::Sender<ExecutionEvent>) -> Self {
        Self { db, event_sender }
    }

    pub async fn start(&self) -> Result<JobScheduler, Box<dyn std::error::Error + Send + Sync>> {
        let sched = JobScheduler::new().await?;

        let db_clone = self.db.clone();
        let event_sender_clone = self.event_sender.clone();

        // Background recurring job: periksa setiap 30 detik apakah ada workflow bertipe scheduleTrigger yang aktif
        let job = Job::new_async("1/30 * * * * *", move |_uuid, _lock| {
            let db = db_clone.clone();
            let event_sender = event_sender_clone.clone();

            Box::pin(async move {
                if let Ok(workflows) = db.list_workflows().await {
                    for wf in workflows {
                        if !wf.active {
                            continue;
                        }

                        // Cek apakah workflow memiliki node bertipe scheduleTrigger
                        let has_schedule = wf.nodes.iter().any(|n| n.node_type == "n8n-nodes-base.scheduleTrigger");
                        if has_schedule {
                            let wf_id = wf.id.clone().unwrap_or_else(|| "scheduled_wf".to_string());
                            let exec_id = uuid::Uuid::new_v4().to_string();
                            let start_time = chrono::Utc::now();
                            let start_str = start_time.to_rfc3339();

                            println!("🚀 [Scheduler Trigger] Memulai eksekusi otomatis: {} ({})", wf.name, wf_id);

                            let _ = event_sender.send(ExecutionEvent::WorkflowStarted {
                                workflow_id: wf_id.clone(),
                                execution_id: exec_id.clone(),
                                started_at: start_str.clone(),
                            });

                            let dag = WorkflowGraph::build(&wf);
                            let executor = WorkflowExecutor::new(dag)
                                .with_events(event_sender.clone(), wf_id.clone(), exec_id.clone());

                            let exec_res = executor.execute().await;
                            let stop_time = chrono::Utc::now();
                            let duration = (stop_time - start_time).num_milliseconds() as u64;

                            match exec_res {
                                Ok(results) => {
                                    let results_val = serde_json::to_value(&results).unwrap_or_default();
                                    let _ = db.save_execution(&exec_id, &wf_id, "success", &results_val, &start_str, Some(&stop_time.to_rfc3339())).await;
                                    let _ = event_sender.send(ExecutionEvent::WorkflowCompleted {
                                        workflow_id: wf_id,
                                        execution_id: exec_id,
                                        status: "success".to_string(),
                                        duration_ms: duration,
                                        results: results_val,
                                    });
                                }
                                Err(err) => {
                                    let err_val = serde_json::json!({ "error": err });
                                    let _ = db.save_execution(&exec_id, &wf_id, "failed", &err_val, &start_str, Some(&stop_time.to_rfc3339())).await;
                                    let _ = event_sender.send(ExecutionEvent::WorkflowFailed {
                                        workflow_id: wf_id,
                                        execution_id: exec_id,
                                        error: err,
                                    });
                                }
                            }
                        }
                    }
                }
            })
        })?;

        sched.add(job).await?;
        sched.start().await?;
        println!("⏱️ Scheduler Engine (Pilihan C) aktif di background.");

        Ok(sched)
    }
}
