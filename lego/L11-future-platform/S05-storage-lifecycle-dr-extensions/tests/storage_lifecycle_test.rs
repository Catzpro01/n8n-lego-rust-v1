//! Unit, Durability, & Disaster Recovery Tests for L11.S05

#[cfg(test)]
mod tests {
    use crate::*;
    use std::path::Path;

    fn sample_record(id: &str, tier: StorageTier, created_ms: u64) -> ArchivalRecord {
        ArchivalRecord {
            record_id: id.to_string(),
            tenant_id: "tenant-corp".to_string(),
            tier,
            payload_bytes: 1024,
            created_at_ms: created_ms,
            last_accessed_ms: created_ms,
        }
    }

    #[test]
    fn test_mandatory_wal_rule_fail_closed_on_initialization_failure() {
        // Test forbidden/unwritable path fails closed
        let bad_path = Path::new("Z:\\nonexistent_unwritable_device\\wal_journal");
        let result = StorageLifecycleService::init_durable_storage(bad_path);

        assert!(result.is_err());
        let err = result.unwrap_err();
        assert!(matches!(err, StorageLifecycleError::DurabilityInitFailed { .. }));

        // Empty path also fails closed
        let empty_path = Path::new("");
        let err_empty = StorageLifecycleService::init_durable_storage(empty_path).unwrap_err();
        assert!(matches!(err_empty, StorageLifecycleError::DurabilityInitFailed { .. }));
    }

    #[test]
    fn test_tier_transition_hot_to_cold() {
        let service = StorageLifecycleService::default();
        let rec = sample_record("rec-1", StorageTier::Hot, 1000);
        service.store_record(rec).unwrap();

        let updated = service.transition_tier("rec-1", StorageTier::Cold, 2000).unwrap();
        assert_eq!(updated.tier, StorageTier::Cold);
        assert_eq!(updated.last_accessed_ms, 2000);
    }

    #[test]
    fn test_retention_policy_deletion_safety() {
        let service = StorageLifecycleService::default();
        service.store_record(sample_record("rec-old-1", StorageTier::Warm, 1000)).unwrap();
        service.store_record(sample_record("rec-old-2", StorageTier::Warm, 2000)).unwrap();
        service.store_record(sample_record("rec-recent", StorageTier::Hot, 5000)).unwrap();

        // Cutoff at 3000ms: deletes records before 3000ms (rec-old-1 and rec-old-2)
        let deleted_count = service.apply_retention_policy(3000);
        assert_eq!(deleted_count, 2);

        // Recent record is safely preserved
        let recs = service.records.read().unwrap();
        assert_eq!(recs.len(), 1);
        assert!(recs.contains_key("rec-recent"));
    }

    #[test]
    fn test_snapshot_creation_and_restore_verification() {
        let service = StorageLifecycleService::default();
        service.store_record(sample_record("rec-snap-1", StorageTier::Hot, 1000)).unwrap();
        service.store_record(sample_record("rec-snap-2", StorageTier::Hot, 2000)).unwrap();

        let snap = service.create_snapshot("snap-test-1", None, 3000).unwrap();
        assert_eq!(snap.total_records, 2);
        assert!(snap.checksum_sha256.starts_with("sha256:"));

        // Clear records to test restore
        {
            let mut recs = service.records.write().unwrap();
            recs.clear();
        }

        let restored_count = service.verify_and_restore_snapshot("snap-test-1").unwrap();
        assert_eq!(restored_count, 2);

        let recs = service.records.read().unwrap();
        assert_eq!(recs.len(), 2);
    }

    #[test]
    fn test_corruption_detection_rejects_corrupted_snapshot() {
        let service = StorageLifecycleService::default();
        service.store_record(sample_record("rec-tamper", StorageTier::Hot, 1000)).unwrap();

        service.create_snapshot("snap-tamper", None, 2000).unwrap();

        // Tamper with records in the snapshot
        {
            let mut snaps = service.snapshots.write().unwrap();
            let snap = snaps.get_mut("snap-tamper").unwrap();
            snap.records[0].payload_bytes = 999999; // Corrupted byte size
        }

        let err = service.verify_and_restore_snapshot("snap-tamper").unwrap_err();
        assert!(matches!(err, StorageLifecycleError::IntegrityCorrupted { .. }));
    }

    #[test]
    fn test_port_invocation_store_snapshot_restore() {
        let service = StorageLifecycleService::default();
        let store_payload = serde_json::json!({
            "action": "store",
            "record": {
                "record_id": "port-rec-1",
                "tenant_id": "tenant-corp",
                "tier": "Hot",
                "payload_bytes": 512,
                "created_at_ms": 1000,
                "last_accessed_ms": 1000
            }
        });
        assert!(service.handle_port_invocation(&store_payload).is_ok());

        let snap_payload = serde_json::json!({
            "action": "snapshot",
            "snapshot_id": "port-snap-1",
            "now_ms": 2000
        });
        let snap_res = service.handle_port_invocation(&snap_payload).unwrap();
        assert_eq!(snap_res["snapshot_id"], "port-snap-1");
        assert_eq!(snap_res["total_records"], 1);
    }
}
