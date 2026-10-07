//! Unit tests for L05.S06 Snapshot/backup/restore

use super::*;
use serde_json::json;

#[test]
fn test_create_snapshot_success() {
    let service = BackupSnapshotMetadataService::new();
    let snap = service.create_snapshot("corp_a", SnapshotKind::Full, 250, Some(1000)).unwrap();
    assert_eq!(snap.tenant_id, "corp_a");
    assert_eq!(snap.kind, SnapshotKind::Full);
    assert_eq!(snap.status, SnapshotStatus::Ready);
    assert!(snap.checksum_sha256.starts_with("sha256:"));
    assert_eq!(snap.entity_count, 250);
}

#[test]
fn test_create_snapshot_empty_tenant_fails() {
    let service = BackupSnapshotMetadataService::new();
    let res = service.create_snapshot("   ", SnapshotKind::Full, 10, None);
    assert!(res.is_err());
}

#[test]
fn test_verify_checksum() {
    let service = BackupSnapshotMetadataService::new();
    let snap = service.create_snapshot("corp_b", SnapshotKind::Incremental, 100, None).unwrap();
    let valid = service.verify_checksum(&snap.snapshot_id, &snap.checksum_sha256).unwrap();
    assert!(valid);

    let invalid = service.verify_checksum(&snap.snapshot_id, "sha256:corrupted").unwrap();
    assert!(!invalid);
}

#[test]
fn test_restore_snapshot_tenant_boundary() {
    let service = BackupSnapshotMetadataService::new();
    let snap = service.create_snapshot("tenant_alpha", SnapshotKind::Full, 50, None).unwrap();

    // Cross-tenant restore attempt should fail
    let bad_restore = service.restore_snapshot(&snap.snapshot_id, "staging", "tenant_beta", None);
    assert!(bad_restore.is_err());
    match bad_restore.unwrap_err() {
        BackupError::TenantMismatch(msg) => assert!(msg.contains("Tenant mismatch")),
        other => panic!("Expected TenantMismatch, got {:?}", other),
    }

    // Authorized restore should succeed
    let good_restore = service.restore_snapshot(&snap.snapshot_id, "staging", "tenant_alpha", None).unwrap();
    assert_eq!(good_restore.status, "SUCCESS");
    assert_eq!(good_restore.restored_count, 50);
}

#[test]
fn test_delete_and_prevent_restore() {
    let service = BackupSnapshotMetadataService::new();
    let snap = service.create_snapshot("tenant_del", SnapshotKind::Differential, 10, None).unwrap();
    service.delete_snapshot(&snap.snapshot_id).unwrap();

    let restore_err = service.restore_snapshot(&snap.snapshot_id, "prod", "tenant_del", None);
    assert!(restore_err.is_err());
}

#[test]
fn test_port_backup_handlers() {
    let service = BackupSnapshotMetadataService::new();

    // Create port
    let create_payload = json!({
        "tenant_id": "tenant_port",
        "kind": "full",
        "entity_count": 80
    });
    let create_resp = service.handle_port_backup_create(&create_payload).unwrap();
    assert_eq!(create_resp["success"], true);
    let snap_id = create_resp["snapshot_id"].as_str().unwrap();

    // Snapshot query port
    let snap_payload = json!({
        "action": "get",
        "snapshot_id": snap_id
    });
    let snap_resp = service.handle_port_backup_snapshot(&snap_payload).unwrap();
    assert_eq!(snap_resp["success"], true);

    // Restore port
    let restore_payload = json!({
        "snapshot_id": snap_id,
        "tenant_id": "tenant_port",
        "target_env": "recovery-env"
    });
    let restore_resp = service.handle_port_backup_restore(&restore_payload).unwrap();
    assert_eq!(restore_resp["success"], true);
    assert_eq!(restore_resp["status"], "SUCCESS");
}
