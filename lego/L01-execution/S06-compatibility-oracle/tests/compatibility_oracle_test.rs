#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_oracle_exact_match_passes() {
        let expected = json!({
            "items": [
                { "id": 1, "name": "WebhookEvent", "active": true }
            ],
            "status": "success",
            "code": 200
        });

        let actual = expected.clone();

        let report = CompatibilityOracleEngine::verify_inline(
            "test_exact",
            &expected,
            &actual,
            &ToleranceRules::default(),
        );

        assert!(report.is_match);
        assert_eq!(report.mismatch_count, 0);
        assert!(report.mismatches.is_empty());
    }

    #[test]
    fn test_oracle_field_mismatches_detected() {
        let expected = json!({
            "user": "alice",
            "role": "admin",
            "age": 30,
            "tags": ["core", "security"]
        });

        let actual = json!({
            "user": "alice",
            // missing 'role'
            "age": "30", // type mismatch: string vs number
            "extra_field": 12345, // extra field
            "tags": ["core", "auditor"] // value mismatch inside array
        });

        let report = CompatibilityOracleEngine::verify_inline(
            "test_diff",
            &expected,
            &actual,
            &ToleranceRules::default(),
        );

        assert!(!report.is_match);
        assert!(report.mismatch_count >= 4);

        let kinds: Vec<MismatchKind> = report.mismatches.iter().map(|m| m.kind).collect();
        assert!(kinds.contains(&MismatchKind::MissingField));
        assert!(kinds.contains(&MismatchKind::TypeMismatch));
        assert!(kinds.contains(&MismatchKind::ExtraField));
        assert!(kinds.contains(&MismatchKind::ValueMismatch));
    }

    #[test]
    fn test_oracle_tolerance_rules_ignore_and_epsilon() {
        let expected = json!({
            "execution_id": "exec_golden_123",
            "timestamp": 1600000000,
            "score": 98.5001,
            "name": "IntegrationRun"
        });

        let actual = json!({
            "execution_id": "exec_live_999", // differs, but will be ignored
            "timestamp": 1700000000,       // differs, but will be ignored
            "score": 98.5002,              // delta 0.0001, within epsilon 0.001
            "name": "IntegrationRun"
        });

        let tolerance = ToleranceRules {
            ignore_fields: vec!["execution_id".to_string(), "timestamp".to_string()],
            numeric_epsilon: Some(0.001),
            ignore_array_order: false,
        };

        let report = CompatibilityOracleEngine::verify_inline(
            "test_tolerance",
            &expected,
            &actual,
            &tolerance,
        );

        assert!(report.is_match);
        assert_eq!(report.mismatch_count, 0);
    }

    #[test]
    fn test_oracle_corpus_registration_and_retrieval() {
        let engine = CompatibilityOracleEngine::new();

        let fixture = GoldenFixture {
            corpus_id: "corpus_node_set_v1".to_string(),
            target_node_or_workflow: "n8n-nodes-base.set".to_string(),
            expected_output: json!({ "result": [1, 2, 3] }),
            tolerance_rules: ToleranceRules::default(),
            description: "Golden output for Set node".to_string(),
            created_at_ms: 1000,
        };

        engine.register_fixture(fixture).expect("Register should succeed");

        let registered = engine.get_fixture("corpus_node_set_v1");
        assert!(registered.is_some());
        assert_eq!(registered.unwrap().target_node_or_workflow, "n8n-nodes-base.set");

        let list = engine.list_fixtures();
        assert_eq!(list, vec!["corpus_node_set_v1"]);

        // Differential verification against registered fixture
        let actual = json!({ "result": [1, 2, 3] });
        let report = engine
            .verify_differential("corpus_node_set_v1", &actual)
            .expect("Verification must succeed");

        assert!(report.is_match);
    }

    #[test]
    fn test_oracle_port_dispatch_roundtrip() {
        let engine = CompatibilityOracleEngine::new();

        // 1. Dispatch register
        let reg_payload = json!({
            "action": "register",
            "corpus_id": "port_corpus_1",
            "target": "HttpRequestNode",
            "expected_output": { "status": 200, "data": "pong" },
            "tolerance": {
                "ignore_fields": ["trace_id"]
            }
        });

        let reg_val = engine.handle_port_oracle_verify(&reg_payload).expect("Register dispatch");
        assert_eq!(reg_val["status"], "registered");

        // 2. Dispatch verify
        let verify_payload = json!({
            "action": "verify",
            "corpus_id": "port_corpus_1",
            "actual_output": { "status": 200, "data": "pong", "trace_id": "tr_123" }
        });

        let ver_val = engine.handle_port_oracle_verify(&verify_payload).expect("Verify dispatch");
        assert_eq!(ver_val["is_match"], true);
        assert_eq!(ver_val["mismatch_count"], 0);

        // 3. Dispatch list
        let list_payload = json!({ "action": "list" });
        let list_val = engine.handle_port_oracle_verify(&list_payload).expect("List dispatch");
        assert_eq!(list_val["fixtures"], json!(["port_corpus_1"]));
    }

    #[test]
    fn test_oracle_port_inline_verify_with_ignore_array_order() {
        let engine = CompatibilityOracleEngine::new();

        let verify_payload = json!({
            "action": "verify",
            "expected_output": { "tags": ["alpha", "beta", "gamma"] },
            "actual_output": { "tags": ["gamma", "alpha", "beta"] },
            "tolerance": {
                "ignore_array_order": true
            }
        });

        let ver_val = engine.handle_port_oracle_verify(&verify_payload).expect("Verify inline dispatch");
        assert_eq!(ver_val["is_match"], true, "Array order should be ignored when configured");
        assert_eq!(ver_val["mismatch_count"], 0);
    }

    #[test]
    fn test_oracle_64bit_integer_precision_preserved() {
        // Values differing in the 54th bit that would be equal in f64
        let n1 = 9007199254740993i64;
        let n2 = 9007199254740992i64;

        let expected = json!({ "id": n1 });
        let actual = json!({ "id": n2 });

        let report = CompatibilityOracleEngine::verify_inline(
            "test_precision",
            &expected,
            &actual,
            &ToleranceRules::default(),
        );

        assert!(!report.is_match, "64-bit integer mismatch must not be lost to f64 precision loss");
        assert_eq!(report.mismatch_count, 1);
        assert_eq!(report.mismatches[0].kind, MismatchKind::ValueMismatch);
    }
}

