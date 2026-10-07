//! Unit tests for L07.S06 HA control plane

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_initial_leader_lease_and_query() {
        let service = HaControlPlaneService::new();
        let leader = service.get_leader(1500).unwrap();

        assert_eq!(leader.leader_id, "controller-node-0");
        assert_eq!(leader.term_epoch, 2);
        assert!(leader.expires_at_ms > 1500);
    }

    #[test]
    fn test_leader_lease_renewal_preserves_epoch() {
        let service = HaControlPlaneService::new();
        let renewed = service.acquire_or_renew_lease("controller-node-0", 2000, 20_000).unwrap();

        assert_eq!(renewed.leader_id, "controller-node-0");
        assert_eq!(renewed.term_epoch, 2);
        assert_eq!(renewed.expires_at_ms, 22_000);
    }

    #[test]
    fn test_conflicting_candidate_rejected_while_lease_valid() {
        let service = HaControlPlaneService::new();
        // Leased by node-0 until 31_000
        let res = service.acquire_or_renew_lease("controller-node-1", 5000, 10_000);

        assert!(matches!(res, Err(HaError::LeaseHeldByOther { .. })));
    }

    #[test]
    fn test_expired_lease_allows_new_leader_with_epoch_increment() {
        let service = HaControlPlaneService::new();
        // Time past 31_000, say 35_000
        let new_lease = service.acquire_or_renew_lease("controller-node-1", 35_000, 15_000).unwrap();

        assert_eq!(new_lease.leader_id, "controller-node-1");
        assert_eq!(new_lease.term_epoch, 3); // advanced from 2 to 3
        assert_eq!(new_lease.expires_at_ms, 50_000);
    }

    #[test]
    fn test_step_down_and_re_election() {
        let service = HaControlPlaneService::new();
        service.step_down("controller-node-0", 2).unwrap();

        assert!(service.get_leader(2000).is_none());

        let new_lease = service.acquire_or_renew_lease("controller-node-2", 2000, 10_000).unwrap();
        assert_eq!(new_lease.leader_id, "controller-node-2");
        assert_eq!(new_lease.term_epoch, 3);
    }

    #[test]
    fn test_stale_epoch_step_down_rejected() {
        let service = HaControlPlaneService::new();
        let err = service.step_down("controller-node-0", 1);
        assert!(matches!(err, Err(HaError::StaleEpoch { .. })));
    }

    #[test]
    fn test_port_ha_election_handler() {
        let service = HaControlPlaneService::new();
        let query_req = serde_json::json!({
            "action": "query_leader",
            "now_ms": 2000
        });
        let q_res = service.handle_port_ha_election(&query_req).unwrap();
        assert_eq!(q_res["success"], true);
        assert_eq!(q_res["has_leader"], true);

        let renew_req = serde_json::json!({
            "action": "renew_lease",
            "candidate_id": "controller-node-0",
            "now_ms": 3000,
            "ttl_ms": 25_000
        });
        let r_res = service.handle_port_ha_election(&renew_req).unwrap();
        assert_eq!(r_res["success"], true);
        assert_eq!(r_res["leader_id"], "controller-node-0");
    }
}
