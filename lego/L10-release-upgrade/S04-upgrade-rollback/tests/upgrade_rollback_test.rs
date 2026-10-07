//! Unit tests for L10.S04 Upgrade/rollback

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_upgrade_lifecycle_success_path() {
        let service = UpgradeRollbackService::new();
        let plan = service.init_upgrade("upg-1", "1.0.0", "1.1.0", 1000).unwrap();
        assert_eq!(plan.current_stage, UpgradeStage::PreflightCheck);
        assert_eq!(plan.stage_offset, 1);

        // Advance: Preflight -> WorkerDrain
        let p2 = service.advance_stage("upg-1", 1100).unwrap();
        assert_eq!(p2.current_stage, UpgradeStage::WorkerDrain);
        assert_eq!(p2.stage_offset, 2);

        // Advance: WorkerDrain -> MigrationApply
        let p3 = service.advance_stage("upg-1", 1200).unwrap();
        assert_eq!(p3.current_stage, UpgradeStage::MigrationApply);
        assert_eq!(p3.stage_offset, 3);

        // Advance: MigrationApply -> HealthVerification
        let p4 = service.advance_stage("upg-1", 1300).unwrap();
        assert_eq!(p4.current_stage, UpgradeStage::HealthVerification);
        assert_eq!(p4.stage_offset, 4);

        // Advance: HealthVerification -> Completed
        let p5 = service.advance_stage("upg-1", 1400).unwrap();
        assert_eq!(p5.current_stage, UpgradeStage::Completed);
        assert_eq!(p5.stage_offset, 5);
        assert!(p5.completed_at_ms.is_some());
    }

    #[test]
    fn test_empty_identifiers_fails_closed() {
        let service = UpgradeRollbackService::new();
        let err = service.init_upgrade("", "1.0.0", "1.1.0", 1000);
        assert_eq!(err.unwrap_err(), UpgradeError::EmptyIdentifier);
    }

    #[test]
    fn test_trigger_rollback_sequence() {
        let service = UpgradeRollbackService::new();
        service.init_upgrade("upg-fail", "1.0.0", "1.1.0", 1000).unwrap();
        service.advance_stage("upg-fail", 1100).unwrap(); // WorkerDrain
        service.advance_stage("upg-fail", 1200).unwrap(); // MigrationApply

        // Migration or health check fails -> trigger rollback
        let rolled_back = service
            .trigger_rollback("upg-fail", "Database index creation lock timeout", 1300)
            .unwrap();

        assert_eq!(rolled_back.current_stage, UpgradeStage::RolledBack);
        assert_eq!(rolled_back.stage_offset, 0);
        assert_eq!(rolled_back.error_log.len(), 1);
        assert!(rolled_back.error_log[0].contains("Database index creation"));
    }

    #[test]
    fn test_advance_after_completed_fails_closed() {
        let service = UpgradeRollbackService::new();
        service.init_upgrade("upg-done", "1.0", "1.1", 1000).unwrap();
        service.advance_stage("upg-done", 1100).unwrap();
        service.advance_stage("upg-done", 1200).unwrap();
        service.advance_stage("upg-done", 1300).unwrap();
        service.advance_stage("upg-done", 1400).unwrap(); // Completed

        let err = service.advance_stage("upg-done", 1500).unwrap_err();
        assert_eq!(err, UpgradeError::InvalidStageTransition(UpgradeStage::Completed));
    }
}
