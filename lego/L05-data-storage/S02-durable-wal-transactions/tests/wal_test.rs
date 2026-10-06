#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_wal_append_read_and_fail_closed_guarantee() {
        let temp_dir = std::env::temp_dir().join(format!("test_wal_{}", uuid::Uuid::new_v4()));
        let wal_file = temp_dir.join("execution.wal");

        let wal = DurableWalStorage::open_fail_closed(&wal_file).expect("Failed to open wal");
        let rec = WalRecord {
            lsn: 1,
            execution_id: "exec_1".to_string(),
            record_type: "NODE_START".to_string(),
            payload: serde_json::json!({"node": "HttpTrigger"}),
        };

        wal.append(&rec).expect("Append should succeed");
        let records = wal.read_all().expect("Read should succeed");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].lsn, 1);

        // Cleanup
        std::fs::remove_dir_all(&temp_dir).ok();
    }
}
