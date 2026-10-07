//! Unit tests for L09.S06 Frontend migration/decommission plan

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_sample_milestone(id: &str) -> SurfaceMigrationMilestone {
        SurfaceMigrationMilestone {
            milestone_id: id.to_string(),
            surface_name: "Workflow Canvas REST API".to_string(),
            legacy_endpoint: "/rest/workflows".to_string(),
            native_replacement: "port.ui.rest.dispatch.v1".to_string(),
            status: DecommissionStatus::Planned,
            deprecation_version: "1.0.0".to_string(),
            sunset_version: "2.0.0".to_string(),
            traffic_shifted_percent: 0,
            last_audited_ms: 1000,
        }
    }

    #[test]
    fn test_register_and_audit_lifecycle() {
        let service = FrontendDecommissionService::new();
        let m = create_sample_milestone("m-rest");

        let registered = service.register_milestone(m).unwrap();
        assert_eq!(registered.milestone_id, "m-rest");
        assert_eq!(registered.status, DecommissionStatus::Planned);

        let report = service.audit_decommission();
        assert_eq!(report.total_surfaces, 1);
        assert_eq!(report.planned_count, 1);
        assert_eq!(report.overall_parity_percent, 0.0);
    }

    #[test]
    fn test_empty_id_fails_closed() {
        let service = FrontendDecommissionService::new();
        let mut m = create_sample_milestone("");
        m.milestone_id = "  ".to_string();

        let err = service.register_milestone(m).unwrap_err();
        assert_eq!(err, DecommissionError::EmptyIdentifier);
    }

    #[test]
    fn test_progress_shift_transitions_status() {
        let service = FrontendDecommissionService::new();
        service.register_milestone(create_sample_milestone("m-shift")).unwrap();

        // Shift 50% traffic -> InFlight
        let updated = service.update_progress("m-shift", 50, 2000).unwrap();
        assert_eq!(updated.status, DecommissionStatus::InFlight);
        assert_eq!(updated.traffic_shifted_percent, 50);

        // Shift 100% traffic -> Decommissioned
        let completed = service.update_progress("m-shift", 100, 3000).unwrap();
        assert_eq!(completed.status, DecommissionStatus::Decommissioned);
        assert_eq!(completed.traffic_shifted_percent, 100);

        let report = service.audit_decommission();
        assert_eq!(report.decommissioned_count, 1);
        assert_eq!(report.overall_parity_percent, 100.0);
    }

    #[test]
    fn test_invalid_traffic_percent_fails_closed() {
        let service = FrontendDecommissionService::new();
        service.register_milestone(create_sample_milestone("m-inv")).unwrap();

        let err = service.update_progress("m-inv", 150, 1000).unwrap_err();
        assert_eq!(err, DecommissionError::InvalidTrafficPercent(150));
    }

    #[test]
    fn test_direct_100_percent_shift_from_planned_transitions_to_decommissioned() {
        let service = FrontendDecommissionService::new();
        service.register_milestone(create_sample_milestone("m-direct")).unwrap();

        // Direct 100% shift from Planned status
        let updated = service.update_progress("m-direct", 100, 2000).unwrap();
        assert_eq!(updated.status, DecommissionStatus::Decommissioned);
        assert_eq!(updated.traffic_shifted_percent, 100);
    }
}
