#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lifecycle_heartbeat_and_quarantine() {
        let mgr = LifecycleManager::new();
        let comp = "sublego_h02_auth";

        // Initial state is runnable
        assert!(mgr.is_runnable(comp));

        // Record 3 failures -> Degraded
        mgr.record_heartbeat(comp, false);
        mgr.record_heartbeat(comp, false);
        mgr.record_heartbeat(comp, false);

        let probe1 = mgr.probe(comp).expect("Must exist");
        assert_eq!(probe1.status, ComponentHealthStatus::Degraded);
        assert!(mgr.is_runnable(comp)); // Degraded is still runnable

        // Quarantine component -> strictly isolated
        mgr.quarantine(comp, "Cascading error threshold exceeded").unwrap();
        let probe2 = mgr.probe(comp).expect("Must exist");
        assert_eq!(probe2.status, ComponentHealthStatus::Quarantined);
        assert!(!mgr.is_runnable(comp)); // Quarantined cannot run work
    }
}
