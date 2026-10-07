//! Unit tests for L10.S06 Security/performance certification

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_passing_benchmark() -> BenchmarkMetrics {
        BenchmarkMetrics {
            p50_latency_ms: 2.5,
            p95_latency_ms: 8.0,
            p99_latency_ms: 18.0,
            throughput_rps: 4500.0,
            max_rss_mb: 128,
        }
    }

    #[test]
    fn test_audit_evaluation_passing_path() {
        let service = SecurityPerfCertificationService::new(50.0);
        let bench = create_passing_benchmark();
        let findings = vec![SecurityFinding {
            cve_id: "CVE-2024-TEST".to_string(),
            title: "Minor information disclosure in debug header".to_string(),
            severity: VulnerabilitySeverity::Low,
            component: "http-logger".to_string(),
        }];

        let record = service
            .evaluate_audit("audit-pass-1", "1.0.0", bench, findings, 1000)
            .unwrap();

        assert!(record.passed);
        assert_eq!(record.release_version, "1.0.0");
    }

    #[test]
    fn test_critical_vulnerability_fails_closed() {
        let service = SecurityPerfCertificationService::new(50.0);
        let bench = create_passing_benchmark();
        let findings = vec![SecurityFinding {
            cve_id: "CVE-2024-CRIT".to_string(),
            title: "Remote code execution in unescaped template".to_string(),
            severity: VulnerabilitySeverity::Critical,
            component: "template-engine".to_string(),
        }];

        let err = service
            .evaluate_audit("audit-crit", "1.0.0", bench, findings, 1000)
            .unwrap_err();

        assert!(matches!(err, SecurityPerfError::CriticalVulnerability(_)));
        let record = service.get_audit("audit-crit").unwrap();
        assert!(!record.passed);
    }

    #[test]
    fn test_latency_threshold_exceeded_fails_closed() {
        let service = SecurityPerfCertificationService::new(50.0);
        let mut bench = create_passing_benchmark();
        bench.p99_latency_ms = 75.0; // Exceeds 50.0

        let err = service
            .evaluate_audit("audit-lat", "1.0.0", bench, vec![], 1000)
            .unwrap_err();

        assert!(matches!(err, SecurityPerfError::LatencyExceeded { .. }));
        let record = service.get_audit("audit-lat").unwrap();
        assert!(!record.passed);
    }

    #[test]
    fn test_empty_identifiers_fails_closed() {
        let service = SecurityPerfCertificationService::new(50.0);
        let err = service.evaluate_audit("", "1.0", create_passing_benchmark(), vec![], 1000);
        assert_eq!(err.unwrap_err(), SecurityPerfError::EmptyIdentifier);
    }

    #[test]
    fn test_nan_latency_fails_closed() {
        let service = SecurityPerfCertificationService::new(50.0);
        let mut bench = create_passing_benchmark();
        bench.p99_latency_ms = f64::NAN;

        let err = service
            .evaluate_audit("audit-nan", "1.0.0", bench, vec![], 1000)
            .unwrap_err();

        assert!(matches!(err, SecurityPerfError::LatencyExceeded { .. }));
        let record = service.get_audit("audit-nan").unwrap();
        assert!(!record.passed);
    }
}
