//! Unit tests for L05.S05 Retention/compaction

use super::*;
use serde_json::json;

#[test]
fn test_default_policies_seeded() {
    let service = RetentionPolicyIndexService::new();
    let exec_pol = service.get_policy("execution").expect("Default execution policy must exist");
    assert_eq!(exec_pol.entity_type, "execution");
    assert!(exec_pol.ttl_seconds > 0);

    let bin_pol = service.get_policy("binary_data").expect("Default binary_data policy must exist");
    assert_eq!(bin_pol.entity_type, "binary_data");
}

#[test]
fn test_register_policy_validation() {
    let service = RetentionPolicyIndexService::new();
    let invalid = RetentionPolicy {
        policy_id: "pol-zero".to_string(),
        entity_type: "logs".to_string(),
        ttl_seconds: 0,
        max_retained_records: 100,
        active: true,
    };
    assert!(service.register_policy(invalid).is_err());

    let valid = RetentionPolicy {
        policy_id: "pol-logs".to_string(),
        entity_type: "logs".to_string(),
        ttl_seconds: 3600,
        max_retained_records: 500,
        active: true,
    };
    assert!(service.register_policy(valid).is_ok());
    assert!(service.get_policy("logs").is_some());
}

#[test]
fn test_record_tombstone_and_compaction_pass() {
    let service = RetentionPolicyIndexService::new();
    let t1 = service.record_tombstone("exec-101", "execution", Some(1000)).unwrap();
    let t2 = service.record_tombstone("exec-102", "execution", Some(1005)).unwrap();
    assert!(t1.contains("exec-101"));
    assert!(t2.contains("exec-102"));

    // Dry run compaction
    let dry_summary = service.execute_compaction(Some("execution"), true, Some(1100)).unwrap();
    assert_eq!(dry_summary.records_scanned, 2);
    assert_eq!(dry_summary.records_purged, 2);
    assert!(dry_summary.dry_run);

    // Real compaction pass
    let real_summary = service.execute_compaction(Some("execution"), false, Some(1200)).unwrap();
    assert_eq!(real_summary.records_scanned, 2);
    assert_eq!(real_summary.tombstones_compacted, 2);
    assert!(!real_summary.dry_run);

    // Second compaction should find 0 unpurged
    let second_summary = service.execute_compaction(Some("execution"), false, Some(1300)).unwrap();
    assert_eq!(second_summary.tombstones_compacted, 0);
}

#[test]
fn test_port_retention_compact_handler() {
    let service = RetentionPolicyIndexService::new();
    let tomb_payload = json!({
        "action": "tombstone",
        "entity_id": "item-999",
        "entity_type": "binary_data"
    });
    let tomb_res = service.handle_port_retention_compact(&tomb_payload).unwrap();
    assert_eq!(tomb_res["success"], true);

    let compact_payload = json!({
        "action": "compact",
        "entity_type": "binary_data",
        "dry_run": false
    });
    let compact_res = service.handle_port_retention_compact(&compact_payload).unwrap();
    assert_eq!(compact_res["success"], true);
    assert_eq!(compact_res["records_purged"], 1);
}
