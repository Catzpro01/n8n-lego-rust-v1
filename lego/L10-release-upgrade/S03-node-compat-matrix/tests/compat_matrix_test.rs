//! Unit tests for L10.S03 Runtime/node compatibility matrix

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_sample_rule(node: &str) -> NodeCompatRule {
        NodeCompatRule {
            node_type: node.to_string(),
            min_runtime_version: "1.0.0".to_string(),
            max_runtime_version: Some("2.5.0".to_string()),
            supported_versions: vec![1, 2],
            breaking_changes_notes: vec!["Version 1 uses deprecated parameter x".to_string()],
        }
    }

    #[test]
    fn test_fully_compatible_evaluation() {
        let service = NodeCompatMatrixService::new();
        service.register_rule(create_sample_rule("n8n-nodes-base.httpRequest")).unwrap();

        let req = CompatEvaluationRequest {
            node_type: "n8n-nodes-base.httpRequest".to_string(),
            node_version: 2,
            target_runtime_version: "1.5.0".to_string(),
        };

        let result = service.evaluate_compatibility(&req).unwrap();
        assert_eq!(result.verdict, CompatibilityVerdict::FullyCompatible);
        assert!(result.recommended_action.is_none());
    }

    #[test]
    fn test_unsupported_node_version_fails_closed() {
        let service = NodeCompatMatrixService::new();
        service.register_rule(create_sample_rule("n8n-nodes-base.webhook")).unwrap();

        let req = CompatEvaluationRequest {
            node_type: "n8n-nodes-base.webhook".to_string(),
            node_version: 99,
            target_runtime_version: "1.0.0".to_string(),
        };

        let result = service.evaluate_compatibility(&req).unwrap();
        assert_eq!(result.verdict, CompatibilityVerdict::IncompatibleBreakingChanges);
    }

    #[test]
    fn test_runtime_below_minimum_fails_closed() {
        let service = NodeCompatMatrixService::new();
        service.register_rule(create_sample_rule("n8n-nodes-base.code")).unwrap();

        let req = CompatEvaluationRequest {
            node_type: "n8n-nodes-base.code".to_string(),
            node_version: 1,
            target_runtime_version: "0.9.0".to_string(),
        };

        let result = service.evaluate_compatibility(&req).unwrap();
        assert_eq!(result.verdict, CompatibilityVerdict::IncompatibleBreakingChanges);
    }

    #[test]
    fn test_exceeding_max_runtime_verdict() {
        let service = NodeCompatMatrixService::new();
        service.register_rule(create_sample_rule("n8n-nodes-base.oldNode")).unwrap();

        let req = CompatEvaluationRequest {
            node_type: "n8n-nodes-base.oldNode".to_string(),
            node_version: 1,
            target_runtime_version: "3.0.0".to_string(),
        };

        let result = service.evaluate_compatibility(&req).unwrap();
        assert_eq!(result.verdict, CompatibilityVerdict::CompatibleWithDeprecations);
    }

    #[test]
    fn test_unknown_node_fails_closed() {
        let service = NodeCompatMatrixService::new();
        let req = CompatEvaluationRequest {
            node_type: "unknown.node".to_string(),
            node_version: 1,
            target_runtime_version: "1.0.0".to_string(),
        };

        let err = service.evaluate_compatibility(&req).unwrap_err();
        assert_eq!(err, CompatMatrixError::RuleNotFound("unknown.node".to_string()));
    }

    #[test]
    fn test_numeric_semver_ordering_handles_multidigit_versions() {
        let service = NodeCompatMatrixService::new();
        let rule = NodeCompatRule {
            node_type: "n8n-nodes-base.multiDigit".to_string(),
            min_runtime_version: "1.2.0".to_string(),
            max_runtime_version: Some("1.9.0".to_string()),
            supported_versions: vec![1],
            breaking_changes_notes: vec![],
        };
        service.register_rule(rule).unwrap();

        // 1.10.0 is numerically greater than 1.9.0 (exceeds max_runtime_version),
        // whereas string comparison would incorrectly judge "1.10.0" < "1.2.0".
        let req = CompatEvaluationRequest {
            node_type: "n8n-nodes-base.multiDigit".to_string(),
            node_version: 1,
            target_runtime_version: "1.10.0".to_string(),
        };

        let result = service.evaluate_compatibility(&req).unwrap();
        assert_eq!(result.verdict, CompatibilityVerdict::CompatibleWithDeprecations);
    }
}
