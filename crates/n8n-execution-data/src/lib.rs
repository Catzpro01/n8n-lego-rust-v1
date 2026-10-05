//! Execution Data Plane — LEGO `execution_data` (owner: agent-04).
//!
//! Contract: `contracts/execution-data.contract.md`.
//!
//! This crate is the facade; the zero-copy item buffer required by
//! `data-plane/m3-01-item-buffer` lives in [`buffer`].

mod buffer;

pub use buffer::{estimate_binary_bytes, estimate_json_bytes, DataRecord, ItemBuffer, Iter};

use n8n_common::INodeExecutionData;
use serde_json::Value;

// Backward-compatible utility functions
pub fn wrap_data(value: Value) -> Vec<INodeExecutionData> {
    match value {
        Value::Array(arr) => arr
            .into_iter()
            .map(|item| INodeExecutionData {
                json: item,
                binary: None,
                paired_item: None,
            })
            .collect(),
        single => vec![INodeExecutionData {
            json: single,
            binary: None,
            paired_item: None,
        }],
    }
}

pub fn extract_json(data: &[INodeExecutionData]) -> Vec<Value> {
    data.iter().map(|d| d.json.clone()).collect()
}

pub fn pair_items(source_count: usize, dest_count: usize) -> Vec<usize> {
    if source_count == 0 {
        return vec![];
    }
    (0..dest_count).map(|i| i % source_count).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::buffer::DataRecord;
    use serde_json::json;
    use std::sync::Arc;

    #[test]
    fn test_wrap_and_extract() {
        let input = json!([{"id": 1, "name": "foo"}, {"id": 2, "name": "bar"}]);
        let wrapped = wrap_data(input);
        assert_eq!(wrapped.len(), 2);
        assert_eq!(wrapped[0].json["name"], "foo");

        let extracted = extract_json(&wrapped);
        assert_eq!(extracted.len(), 2);
        assert_eq!(extracted[1]["name"], "bar");
    }

    #[test]
    fn test_pairing() {
        let pairs = pair_items(2, 4);
        assert_eq!(pairs, vec![0, 1, 0, 1]);
    }

    #[test]
    fn test_item_buffer_minimal_copy() {
        let mut buf = ItemBuffer::new();
        buf.push(DataRecord::new(json!({"count": 42})));
        buf.push(DataRecord::new(json!({"count": 99})));

        assert_eq!(buf.len(), 2);
        assert_eq!(buf.get(0).unwrap().json["count"], 42);

        let cloned_buf = buf.shallow_clone();
        assert_eq!(cloned_buf.len(), 2);
        assert!(Arc::ptr_eq(
            &buf.get(0).unwrap().json,
            &cloned_buf.get(0).unwrap().json
        ));

        // Test memory estimation
        assert!(buf.estimated_bytes() > 50);
    }
}
