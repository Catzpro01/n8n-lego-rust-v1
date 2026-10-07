//! Unit tests for L05.S07 Disaster recovery

use super::*;
use serde_json::json;

#[test]
fn test_default_primary_registration() {
    let service = DisasterRecoveryService::new();
    let nodes = service.nodes.read().unwrap();
    let primary = nodes.get("node-primary-us-east").expect("Default primary must be seeded");
    assert_eq!(primary.role, NodeRole::Primary);
    assert_eq!(primary.region, "us-east-1");
    assert_eq!(primary.health, NodeHealth::Healthy);
}

#[test]
fn test_heartbeat_and_lag_degradation() {
    let service = DisasterRecoveryService::new();
    let replica = DrReplicaNode {
        node_id: "replica-eu-west".to_string(),
        region: "eu-west-1".to_string(),
        role: NodeRole::HotStandby,
        replication_lag_ms: 50,
        last_heartbeat_ms: 1000,
        last_applied_lsn: 500,
        health: NodeHealth::Healthy,
    };
    service.register_replica(replica).unwrap();

    // Minor lag: still healthy
    service.record_heartbeat("replica-eu-west", 600, 100, Some(2000)).unwrap();
    {
        let nodes = service.nodes.read().unwrap();
        assert_eq!(nodes["replica-eu-west"].health, NodeHealth::Healthy);
        assert_eq!(nodes["replica-eu-west"].last_applied_lsn, 600);
    }

    // High lag (> 60s): degraded
    service.record_heartbeat("replica-eu-west", 650, 75_000, Some(3000)).unwrap();
    {
        let nodes = service.nodes.read().unwrap();
        assert_eq!(nodes["replica-eu-west"].health, NodeHealth::Degraded);
    }
}

#[test]
fn test_replicate_batch_updates_target() {
    let service = DisasterRecoveryService::new();
    let replica = DrReplicaNode {
        node_id: "replica-ap-southeast".to_string(),
        region: "ap-southeast-1".to_string(),
        role: NodeRole::HotStandby,
        replication_lag_ms: 500,
        last_heartbeat_ms: 1000,
        last_applied_lsn: 100,
        health: NodeHealth::Healthy,
    };
    service.register_replica(replica).unwrap();

    let batch = service.replicate_batch(
        "node-primary-us-east",
        "replica-ap-southeast",
        101,
        200,
        100,
        Some(1500),
    ).unwrap();

    assert_eq!(batch.start_lsn, 101);
    assert_eq!(batch.end_lsn, 200);
    assert!(batch.checksum.starts_with("crc32:"));

    let nodes = service.nodes.read().unwrap();
    assert_eq!(nodes["replica-ap-southeast"].last_applied_lsn, 200);
}

#[test]
fn test_initiate_failover_promotion() {
    let service = DisasterRecoveryService::new();
    let standby = DrReplicaNode {
        node_id: "replica-failover-target".to_string(),
        region: "eu-central-1".to_string(),
        role: NodeRole::HotStandby,
        replication_lag_ms: 10,
        last_heartbeat_ms: 1000,
        last_applied_lsn: 10_000,
        health: NodeHealth::Healthy,
    };
    service.register_replica(standby).unwrap();

    let plan = service.initiate_failover("replica-failover-target", "admin-failover-tool", Some(2000)).unwrap();
    assert_eq!(plan.target_primary, "replica-failover-target");
    assert_eq!(plan.status, "SUCCEEDED");

    let nodes = service.nodes.read().unwrap();
    assert_eq!(nodes["replica-failover-target"].role, NodeRole::Primary);
    assert_eq!(nodes["node-primary-us-east"].role, NodeRole::ColdStandby);
}

#[test]
fn test_port_dr_sync_and_replicate_handlers() {
    let service = DisasterRecoveryService::new();
    let replica = DrReplicaNode {
        node_id: "rep-port-test".to_string(),
        region: "us-west-2".to_string(),
        role: NodeRole::HotStandby,
        replication_lag_ms: 5,
        last_heartbeat_ms: 1000,
        last_applied_lsn: 50,
        health: NodeHealth::Healthy,
    };
    service.register_replica(replica).unwrap();

    // Heartbeat port
    let hb_payload = json!({
        "action": "heartbeat",
        "node_id": "rep-port-test",
        "applied_lsn": 75,
        "lag_ms": 12
    });
    let hb_res = service.handle_port_dr_sync(&hb_payload).unwrap();
    assert_eq!(hb_res["success"], true);

    // Replicate port
    let rep_payload = json!({
        "action": "replicate",
        "target_id": "rep-port-test",
        "start_lsn": 76,
        "end_lsn": 90,
        "events_count": 15
    });
    let rep_res = service.handle_port_dr_replicate(&rep_payload).unwrap();
    assert_eq!(rep_res["success"], true);
    assert_eq!(rep_res["end_lsn"], 90);
}
