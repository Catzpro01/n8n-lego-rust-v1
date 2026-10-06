//! Unit tests for L04.S05 Community/private/custom node compatibility

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_load_existing_package_node() {
        let service = CustomNodeLoaderService::new();
        let desc = service.load_node("n8n-nodes-slack-enhanced", "SlackEnhanced").unwrap();

        assert_eq!(desc.package_name, "n8n-nodes-slack-enhanced");
        assert_eq!(desc.node_name, "SlackEnhanced");
        assert_eq!(desc.version, "1.2.0");
        assert!(desc.is_executable);
    }

    #[test]
    fn test_load_nonexistent_package_fails() {
        let service = CustomNodeLoaderService::new();
        let err = service.load_node("nonexistent-package", "SomeNode");

        assert!(matches!(err, Err(CustomNodeError::PackageNotFound(_))));
    }

    #[test]
    fn test_disable_package_prevents_loading() {
        let service = CustomNodeLoaderService::new();
        service.disable_package("n8n-nodes-slack-enhanced").unwrap();

        let err = service.load_node("n8n-nodes-slack-enhanced", "SlackEnhanced");
        assert!(matches!(err, Err(CustomNodeError::PackageDisabled(_))));
    }

    #[test]
    fn test_tarball_checksum_verification() {
        let service = CustomNodeLoaderService::new();

        assert!(service.verify_checksum("n8n-nodes-slack-enhanced", "sha256_slack_enhanced_v1").unwrap());

        let err = service.verify_checksum("n8n-nodes-slack-enhanced", "tampered_checksum");
        assert!(matches!(err, Err(CustomNodeError::ChecksumMismatch { .. })));
    }

    #[test]
    fn test_port_handler_custom_load() {
        let service = CustomNodeLoaderService::new();

        let req = serde_json::json!({
            "action": "load",
            "package_name": "n8n-nodes-slack-enhanced",
            "node_name": "SlackEnhanced"
        });

        let resp = service.handle_port_custom_load(&req).unwrap();
        assert_eq!(resp["success"], true);
        assert_eq!(resp["package_name"], "n8n-nodes-slack-enhanced");
        assert_eq!(resp["version"], "1.2.0");
    }
}
