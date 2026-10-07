//! Unit tests for L10.S05 Release certification

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_all_gates_passed() {
        let service = ReleaseCertificationService::new();
        let gates = vec![
            QualityGateResult {
                gate_name: "UnitTestsGate".to_string(),
                status: GateStatus::Passed,
                duration_ms: 1200,
                details: "140/140 unit tests pass".to_string(),
            },
            QualityGateResult {
                gate_name: "ArchitectureDAGCheck".to_string(),
                status: GateStatus::Passed,
                duration_ms: 300,
                details: "0 DAG cycles detected".to_string(),
            },
        ];

        let report = service.evaluate_gates("1.0.0-rc1", gates, 1000).unwrap();
        assert!(report.all_passed);
        assert_eq!(report.passed_gates, 2);
        assert_eq!(report.failed_gates, 0);

        let retrieved = service.get_report("1.0.0-rc1").unwrap();
        assert_eq!(retrieved.candidate_version, "1.0.0-rc1");
    }

    #[test]
    fn test_gate_failure_fails_closed() {
        let service = ReleaseCertificationService::new();
        let gates = vec![
            QualityGateResult {
                gate_name: "UnitTestsGate".to_string(),
                status: GateStatus::Passed,
                duration_ms: 1200,
                details: "140/140 pass".to_string(),
            },
            QualityGateResult {
                gate_name: "SecurityScanGate".to_string(),
                status: GateStatus::Failed,
                duration_ms: 450,
                details: "Detected unauthenticated port access".to_string(),
            },
        ];

        let err = service.evaluate_gates("1.0.0-rc2", gates, 1000).unwrap_err();
        assert!(matches!(err, CertificationError::GateFailed(_)));

        // Report was still persisted for audit
        let report = service.get_report("1.0.0-rc2").unwrap();
        assert!(!report.all_passed);
        assert_eq!(report.failed_gates, 1);
    }

    #[test]
    fn test_empty_version_fails_closed() {
        let service = ReleaseCertificationService::new();
        let err = service.evaluate_gates("   ", vec![], 1000).unwrap_err();
        assert_eq!(err, CertificationError::EmptyVersion);
    }

    #[test]
    fn test_skipped_gate_fails_closed() {
        let service = ReleaseCertificationService::new();
        let gates = vec![
            QualityGateResult {
                gate_name: "UnitTestsGate".to_string(),
                status: GateStatus::Passed,
                duration_ms: 1000,
                details: "Pass".to_string(),
            },
            QualityGateResult {
                gate_name: "StressLoadGate".to_string(),
                status: GateStatus::Skipped,
                duration_ms: 0,
                details: "Skipped due to time limits".to_string(),
            },
        ];

        let err = service.evaluate_gates("1.0.0-rc3", gates, 1000).unwrap_err();
        assert!(matches!(err, CertificationError::GateFailed(_)));

        let report = service.get_report("1.0.0-rc3").unwrap();
        assert!(!report.all_passed);
        assert_eq!(report.passed_gates, 1);
        assert_eq!(report.total_gates, 2);
    }
}
