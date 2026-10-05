#![recursion_limit = "256"]
#![deny(clippy::all)]

pub mod db;
pub mod evaluator;
pub mod events;
pub mod executor;
pub mod nodes;
pub mod parser;
pub mod scheduler;
pub mod server;
pub mod runtime_registry;
pub mod workflow;

pub use db::Database;
pub use evaluator::JsEvaluator;
pub use events::ExecutionEvent;
pub use executor::WorkflowExecutor;
pub use parser::WorkflowGraph;
pub use scheduler::WorkflowScheduler;
pub use server::{create_router, AppState};
pub use workflow::{Connection, Node, Workflow};

#[cfg(feature = "napi-binding")]
#[macro_use]
extern crate napi_derive;

#[cfg(feature = "napi-binding")]
use napi::bindgen_prelude::*;

#[cfg(feature = "napi-binding")]
#[napi(js_name = "executeN8nWorkflow")]
pub async fn execute_n8n_workflow(workflow_json: String) -> Result<String> {
    let workflow: Workflow = match serde_json::from_str(&workflow_json) {
        Ok(w) => w,
        Err(e) => return Err(Error::new(Status::InvalidArg, format!("Failed to parse workflow JSON: {}", e))),
    };

    let graph = WorkflowGraph::build(&workflow);
    let executor = WorkflowExecutor::new(graph);
    match executor.execute().await {
        Ok(results) => {
            let res_json = serde_json::to_string(&results)
                .unwrap_or_else(|_| "{\"status\":\"success\"}".to_string());
            Ok(res_json)
        }
        Err(e) => Err(Error::new(Status::GenericFailure, format!("Execution failed: {}", e))),
    }
}
#[cfg(test)] mod integration_test;
