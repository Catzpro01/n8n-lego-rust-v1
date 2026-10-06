#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_store_and_read_handle_roundtrip() {
        let service = ExecutionDataPlaneService::new();

        let items = json!([
            { "id": 1, "customer": "Alice", "amount": 100 },
            { "id": 2, "customer": "Bob", "amount": 250 }
        ]);

        let store_res = service
            .store_handle("tenant-alpha", "exec-101", "Node_Database", items.clone())
            .expect("Storing items should succeed");

        assert!(store_res.success);
        assert!(store_res.handle_id.starts_with("edp:tenant-alpha:exec-101:blob-"));
        assert_eq!(store_res.item_count, 2);
        assert!(store_res.byte_size > 0);
        assert!(store_res.checksum.starts_with("fnv1a:"));

        // Read handle
        let read_res = service
            .read_handle("tenant-alpha", &store_res.handle_id)
            .expect("Reading handle should succeed");

        assert!(read_res.success);
        assert_eq!(read_res.execution_id, "exec-101");
        assert_eq!(read_res.node_name, "Node_Database");
        assert_eq!(read_res.items, items);
        assert_eq!(read_res.checksum, store_res.checksum);
    }

    #[test]
    fn test_tenant_boundary_isolation() {
        let service = ExecutionDataPlaneService::new();

        let store_res = service
            .store_handle("tenant-owner", "exec-202", "Secret_Node", json!([{ "secret": "xyz" }]))
            .expect("Store succeeds");

        // Attacker tenant cannot read owner's blob handle
        let err = service
            .read_handle("tenant-attacker", &store_res.handle_id)
            .unwrap_err();

        assert!(matches!(err, DataPlaneError::TenantMismatch { .. }));
    }

    #[test]
    fn test_nonexistent_handle_fail_closed() {
        let service = ExecutionDataPlaneService::new();

        let err = service
            .read_handle("tenant-alpha", "edp:tenant-alpha:exec-999:blob-missing")
            .unwrap_err();

        assert!(matches!(err, DataPlaneError::BlobNotFound(_)));
    }

    #[test]
    fn test_empty_tenant_validation() {
        let service = ExecutionDataPlaneService::new();

        let err = service
            .store_handle("", "exec-1", "Node", json!([]))
            .unwrap_err();

        assert!(matches!(err, DataPlaneError::InvalidRequest(_)));
    }

    #[test]
    fn test_port_store_and_read_dispatchers() {
        let service = ExecutionDataPlaneService::new();

        let items = json!([{ "status": "approved" }]);

        let store_payload = json!({
            "tenant_id": "tenant-port",
            "execution_id": "exec-port-1",
            "node_name": "Approval_Node",
            "items": items
        });

        let store_out = service
            .handle_port_store_handle(&store_payload)
            .expect("Port store must succeed");

        assert_eq!(store_out["success"], true);
        let handle_id = store_out["handle_id"].as_str().unwrap();

        let read_payload = json!({
            "tenant_id": "tenant-port",
            "handle_id": handle_id
        });

        let read_out = service
            .handle_port_read_handle(&read_payload)
            .expect("Port read must succeed");

        assert_eq!(read_out["success"], true);
        assert_eq!(read_out["items"], items);
    }
}
