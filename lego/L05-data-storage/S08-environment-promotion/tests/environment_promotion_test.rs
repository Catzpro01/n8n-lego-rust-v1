//! Unit tests for L05.S08 Environment promotion

use super::*;
use serde_json::json;

#[test]
fn test_export_bundle_with_secret_sanitization() {
    let service = PromotionManifestStoreService::new();
    let workflows = vec![
        json!({
            "id": "wf-1",
            "name": "Production ETL",
            "credentials": { "user": "admin", "token": "secret-token-123" }
        })
    ];

    let bundle = service.export_bundle("dev", "staging", workflows, true, "alice", Some(1000)).unwrap();
    assert_eq!(bundle.manifest.source_env, "dev");
    assert_eq!(bundle.manifest.target_env, "staging");
    assert_eq!(bundle.manifest.status, PromotionStatus::Exported);
    assert_eq!(bundle.items.len(), 1);

    // Verify credential redaction
    let creds = &bundle.items[0]["credentials"];
    assert_eq!(creds["redacted"], true);
}

#[test]
fn test_export_bundle_fails_on_raw_secret_leak() {
    let service = PromotionManifestStoreService::new();
    let workflows = vec![
        json!({
            "id": "wf-bad",
            "api_key": "unmasked-private-key"
        })
    ];

    let err = service.export_bundle("dev", "staging", workflows, true, "bob", None);
    assert!(err.is_err());
    match err.unwrap_err() {
        PromotionError::SecretLeakageDetected(msg) => assert!(msg.contains("Secret leakage")),
        other => panic!("Expected SecretLeakageDetected, got {:?}", other),
    }
}

#[test]
fn test_validate_and_import_bundle() {
    let service = PromotionManifestStoreService::new();
    let workflows = vec![json!({ "id": "wf-ok", "nodes": [] })];
    let bundle = service.export_bundle("dev", "prod", workflows, true, "carol", None).unwrap();

    assert!(service.validate_bundle(&bundle, "prod").unwrap());

    // Mismatched environment validation fails
    assert!(service.validate_bundle(&bundle, "staging").is_err());

    // Import bundle
    let imported = service.import_bundle(&bundle.manifest.manifest_id, "prod", None).unwrap();
    assert_eq!(imported.status, PromotionStatus::Imported);
}

#[test]
fn test_rollback_promotion() {
    let service = PromotionManifestStoreService::new();
    let workflows = vec![json!({ "id": "wf-rb" })];
    let bundle = service.export_bundle("staging", "prod", workflows, true, "dave", None).unwrap();
    service.import_bundle(&bundle.manifest.manifest_id, "prod", None).unwrap();

    let rolled_back = service.rollback_promotion(&bundle.manifest.manifest_id).unwrap();
    assert_eq!(rolled_back.status, PromotionStatus::RolledBack);
}

#[test]
fn test_port_promotion_handlers() {
    let service = PromotionManifestStoreService::new();

    // Export port
    let export_payload = json!({
        "source_env": "dev",
        "target_env": "staging",
        "workflows": [{ "id": "wf-port", "name": "Test" }]
    });
    let exp_res = service.handle_port_promotion_export(&export_payload).unwrap();
    assert_eq!(exp_res["success"], true);
    let manifest_id = exp_res["manifest_id"].as_str().unwrap();

    // Import port
    let import_payload = json!({
        "manifest_id": manifest_id,
        "target_env": "staging"
    });
    let imp_res = service.handle_port_promotion_import(&import_payload).unwrap();
    assert_eq!(imp_res["success"], true);
    assert_eq!(imp_res["status"], "imported");

    // Promote port
    let promote_payload = json!({
        "action": "promote",
        "source_env": "staging",
        "target_env": "production"
    });
    let prom_res = service.handle_port_environment_promote(&promote_payload).unwrap();
    assert_eq!(prom_res["success"], true);
    assert_eq!(prom_res["status"], "promoted");
}

#[test]
fn test_nested_secret_leakage_detected() {
    let service = PromotionManifestStoreService::new();
    let workflows = vec![
        json!({
            "id": "wf-nested",
            "nodes": [
                {
                    "name": "HTTP Request",
                    "parameters": {
                        "api_key": "super-secret-api-key"
                    }
                }
            ]
        })
    ];

    let err = service.export_bundle("dev", "staging", workflows, true, "auditor", None);
    assert!(err.is_err());
    match err.unwrap_err() {
        PromotionError::SecretLeakageDetected(msg) => assert!(msg.contains("api_key")),
        other => panic!("Expected SecretLeakageDetected, got {:?}", other),
    }
}

#[test]
fn test_rollback_unimported_manifest_fails() {
    let service = PromotionManifestStoreService::new();
    let workflows = vec![json!({ "id": "wf-draft" })];
    let bundle = service.export_bundle("dev", "staging", workflows, true, "auditor", None).unwrap();

    // Rollback without importing should fail
    let err = service.rollback_promotion(&bundle.manifest.manifest_id);
    assert!(err.is_err());
    match err.unwrap_err() {
        PromotionError::ValidationFailed(msg) => assert!(msg.contains("must be Imported")),
        other => panic!("Expected ValidationFailed, got {:?}", other),
    }
}

