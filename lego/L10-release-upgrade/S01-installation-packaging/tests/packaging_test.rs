//! Unit tests for L10.S01 Installation and packaging

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_sample_artifact(id: &str, ver: &str) -> PackageArtifact {
        PackageArtifact {
            artifact_id: id.to_string(),
            release_version: ver.to_string(),
            platform: TargetPlatform::LinuxX86_64,
            filename: format!("n8n-rust-{}-x86_64.tar.gz", ver),
            sha256_checksum: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855".to_string(),
            size_bytes: 42_000_000,
            built_at_ms: 1000,
            metadata: HashMap::new(),
        }
    }

    #[test]
    fn test_register_artifact_and_retrieve_manifest() {
        let service = InstallationPackagingService::new();
        let art = create_sample_artifact("art-1", "1.0.0");

        service.register_artifact(art, "commit-sha-123").unwrap();

        let manifest = service.get_manifest("1.0.0").unwrap();
        assert_eq!(manifest.release_version, "1.0.0");
        assert_eq!(manifest.artifacts.len(), 1);
        assert!(manifest.verified);
    }

    #[test]
    fn test_empty_id_fails_closed() {
        let service = InstallationPackagingService::new();
        let mut art = create_sample_artifact("", "1.0.0");
        art.artifact_id = "   ".to_string();

        let err = service.register_artifact(art, "commit-1").unwrap_err();
        assert_eq!(err, PackagingError::EmptyIdentifier);
    }

    #[test]
    fn test_invalid_sha256_fails_closed() {
        let service = InstallationPackagingService::new();
        let mut art = create_sample_artifact("art-bad-hash", "1.0.0");
        art.sha256_checksum = "short-invalid-hash".to_string();

        let err = service.register_artifact(art, "commit-1").unwrap_err();
        assert!(matches!(err, PackagingError::InvalidChecksum(_)));
    }

    #[test]
    fn test_zero_size_fails_closed() {
        let service = InstallationPackagingService::new();
        let mut art = create_sample_artifact("art-zero", "1.0.0");
        art.size_bytes = 0;

        let err = service.register_artifact(art, "commit-1").unwrap_err();
        assert!(matches!(err, PackagingError::ZeroSizeBytes(_)));
    }
}
