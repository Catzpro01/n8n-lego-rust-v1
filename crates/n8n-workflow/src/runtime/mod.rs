pub mod context;
pub mod error;
pub mod executor;
pub mod frame;
pub mod ir;
pub mod loop_manager;
pub mod runner;
pub mod subworkflow;

pub use context::{
    CredentialsProvider, ExecutionContext, InMemoryCredentialsProvider, MemoryBudget,
};
pub use error::ExecutionError;
pub use executor::NodeExecutor;
pub use frame::ExecutionFrame;
pub use ir::{NodeIndex, PortIndex, RuntimeEdge, RuntimeGraph, RuntimeNode};
pub use loop_manager::{LoopBatch, LoopError, LoopManager};
pub use runner::{
    NodeExecutorRegistry, PassThroughExecutor, SetNodeExecutor, WorkflowExecutionResult,
    WorkflowRunner,
};
pub use subworkflow::{
    isolated_child_context, SubworkflowError, SubworkflowInvoker, SubworkflowOutcome,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Connections, NodeOutputs, OrderedMap, Workflow};
    use n8n_execution_data::{DataRecord, ItemBuffer};
    use n8n_node_model::INode;
    use serde_json::json;

    #[test]
    fn test_memory_budget_limits() {
        let budget = MemoryBudget::new(100);
        assert!(budget.allocate(50).is_ok());
        assert_eq!(budget.current_usage(), 50);
        assert!(budget.allocate(40).is_ok());
        assert_eq!(budget.current_usage(), 90);

        // Exceed limit
        let err = budget.allocate(20);
        assert!(err.is_err());
        assert_eq!(budget.current_usage(), 90);

        // Deallocate
        budget.deallocate(40);
        assert_eq!(budget.current_usage(), 50);
        assert!(budget.allocate(20).is_ok());
    }

    #[test]
    fn test_workflow_lowering_to_runtime_graph() {
        let node1 = INode {
            id: "1".to_string(),
            name: "Start".to_string(),
            node_type: "n8n-nodes-base.manualTrigger".to_string(),
            type_version: 1.0,
            position: [100.0, 100.0],
            parameters: Default::default(),
            disabled: Some(false),
            extra: Default::default(),
        };

        let node2 = INode {
            id: "2".to_string(),
            name: "Set".to_string(),
            node_type: "n8n-nodes-base.set".to_string(),
            type_version: 1.0,
            position: [300.0, 100.0],
            parameters: Default::default(),
            disabled: Some(false),
            extra: Default::default(),
        };

        let mut connections: Connections = OrderedMap::new();
        let mut outputs: NodeOutputs = OrderedMap::new();
        outputs.insert(
            "main".to_string(),
            vec![Some(vec![crate::Connection {
                node: "Set".to_string(),
                connection_type: "main".to_string(),
                index: 0,
            }])],
        );
        connections.insert("Start".to_string(), outputs);

        let workflow = Workflow::new(
            Some("wf-test".to_string()),
            Some("Test Flow".to_string()),
            vec![node1, node2],
            connections,
            true,
            None,
            None,
            None,
        );

        let graph = RuntimeGraph::from_workflow(&workflow).expect("Lowering should succeed");
        assert_eq!(graph.nodes.len(), 2);
        assert_eq!(graph.execution_order.len(), 2);

        // Start (index 0) must execute before Set (index 1)
        assert_eq!(graph.execution_order, vec![0, 1]);
        assert_eq!(graph.outgoing(0).len(), 1);
        assert_eq!(graph.incoming(1).len(), 1);
    }

    #[test]
    fn test_execution_frame_data_flow() {
        let mut input_buf = ItemBuffer::new();
        input_buf.push(DataRecord::new(json!({"val": 10})));
        let inputs = vec![input_buf];

        let mut frame = ExecutionFrame::new(0, &inputs, 1);
        assert_eq!(frame.main_input().unwrap().len(), 1);

        frame
            .push_output(0, DataRecord::new(json!({"val": 20})))
            .unwrap();
        let outputs = frame.take_outputs();
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].len(), 1);
        assert_eq!(outputs[0].get(0).unwrap().json["val"], 20);
    }

    #[test]
    fn test_execution_frame_memory_governor_backpressure() {
        let inputs = vec![];
        let budget = std::sync::Arc::new(MemoryBudget::new(150));
        let mut frame = ExecutionFrame::new(0, &inputs, 1).with_memory_budget(budget);

        // First item fits
        let res1 = frame.push_output(0, DataRecord::new(json!({"a": 1})));
        assert!(res1.is_ok());

        // Second large item triggers MemoryBudgetExceeded backpressure
        let res2 = frame.push_output(
            0,
            DataRecord::new(json!({"large_payload": "overflow_test_overflow_test_overflow"})),
        );
        assert!(res2.is_err());
        match res2.unwrap_err() {
            ExecutionError::MemoryBudgetExceeded { limit, attempted } => {
                assert_eq!(limit, 150);
                assert!(attempted > 50);
            }
            other => panic!("Expected MemoryBudgetExceeded, got: {:?}", other),
        }
    }
}
