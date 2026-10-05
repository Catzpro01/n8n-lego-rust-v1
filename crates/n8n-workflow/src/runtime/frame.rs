use crate::runtime::context::MemoryBudget;
use crate::runtime::error::ExecutionError;
use crate::runtime::ir::NodeIndex;
use n8n_execution_data::{DataRecord, ItemBuffer};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Arc;

/// Dynamic execution frame passed to a node during execution with memory governor integration
pub struct ExecutionFrame<'a> {
    pub node_idx: NodeIndex,
    pub inputs: &'a [ItemBuffer],
    pub outputs: Vec<ItemBuffer>,
    pub item_cursor: usize,
    pub iteration_idx: u32,
    pub memory_budget: Option<Arc<MemoryBudget>>,
    pub parameters: Option<Arc<Value>>,
    pub local_variables: HashMap<String, Value>,
    allocated_bytes: usize,
}

impl<'a> Drop for ExecutionFrame<'a> {
    fn drop(&mut self) {
        if self.allocated_bytes > 0 {
            if let Some(ref budget) = self.memory_budget {
                budget.deallocate(self.allocated_bytes);
            }
            self.allocated_bytes = 0;
        }
    }
}

impl<'a> ExecutionFrame<'a> {
    pub fn new(node_idx: NodeIndex, inputs: &'a [ItemBuffer], output_port_count: usize) -> Self {
        let mut outputs = Vec::with_capacity(output_port_count);
        for _ in 0..output_port_count {
            outputs.push(ItemBuffer::new());
        }
        Self {
            node_idx,
            inputs,
            outputs,
            item_cursor: 0,
            iteration_idx: 0,
            memory_budget: None,
            parameters: None,
            local_variables: HashMap::new(),
            allocated_bytes: 0,
        }
    }

    pub fn with_memory_budget(mut self, budget: Arc<MemoryBudget>) -> Self {
        self.memory_budget = Some(budget);
        self
    }

    pub fn with_parameters(mut self, parameters: Arc<Value>) -> Self {
        self.parameters = Some(parameters);
        self
    }

    pub fn parameters(&self) -> Option<&Value> {
        self.parameters.as_deref()
    }

    pub fn input(&self, port: usize) -> Option<&ItemBuffer> {
        self.inputs.get(port)
    }

    pub fn main_input(&self) -> Option<&ItemBuffer> {
        self.input(0)
    }

    /// Enforces actual memory allocation check on push against MemoryBudget
    pub fn push_output(&mut self, port: usize, record: DataRecord) -> Result<(), ExecutionError> {
        let bytes = record.estimated_bytes();
        if let Some(ref budget) = self.memory_budget {
            budget.allocate(bytes)?;
        }
        self.allocated_bytes += bytes;

        if port >= self.outputs.len() {
            self.outputs.resize_with(port + 1, ItemBuffer::new);
        }
        self.outputs[port].push(record);
        Ok(())
    }

    pub fn set_output(&mut self, port: usize, buffer: ItemBuffer) -> Result<(), ExecutionError> {
        let bytes = buffer.estimated_bytes();
        if let Some(ref budget) = self.memory_budget {
            budget.allocate(bytes)?;
        }
        self.allocated_bytes += bytes;

        if port >= self.outputs.len() {
            self.outputs.resize_with(port + 1, ItemBuffer::new);
        }
        self.outputs[port] = buffer;
        Ok(())
    }

    pub fn take_outputs(mut self) -> Vec<ItemBuffer> {
        // Since we are transferring ownership to the caller,
        // we shouldn't deallocate the memory budget here. The workflow will deallocate it when done.
        // So we clear the allocated_bytes so Drop does not deallocate.
        self.allocated_bytes = 0;
        std::mem::take(&mut self.outputs)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_frame_isolates_local_variables() {
        let inputs = vec![];
        let mut frame = ExecutionFrame::new(1, &inputs, 1);
        frame
            .local_variables
            .insert("key".to_string(), json!("value"));
        assert_eq!(frame.local_variables.get("key"), Some(&json!("value")));
    }

    #[test]
    fn test_dropping_frame_reclaims_intermediate_memory() {
        let budget = Arc::new(MemoryBudget::new(1024 * 1024));
        assert_eq!(budget.current_usage(), 0);

        {
            let inputs = vec![];
            let mut frame = ExecutionFrame::new(2, &inputs, 1).with_memory_budget(budget.clone());
            let record = DataRecord::new(json!({"data": "test"}));
            let bytes = record.estimated_bytes();
            frame.push_output(0, record).unwrap();

            assert_eq!(budget.current_usage(), bytes);
            // Frame is dropped here
        }

        // Memory should be reclaimed
        assert_eq!(budget.current_usage(), 0);
    }

    #[test]
    fn test_take_outputs_does_not_reclaim() {
        let budget = Arc::new(MemoryBudget::new(1024 * 1024));

        let bytes = {
            let inputs = vec![];
            let mut frame = ExecutionFrame::new(3, &inputs, 1).with_memory_budget(budget.clone());
            let record = DataRecord::new(json!({"data": "test"}));
            let bytes = record.estimated_bytes();
            frame.push_output(0, record).unwrap();

            assert_eq!(budget.current_usage(), bytes);
            let _outputs = frame.take_outputs();
            bytes
        };

        // Memory should NOT be reclaimed because outputs were taken out of the frame
        assert_eq!(budget.current_usage(), bytes);
    }
}
