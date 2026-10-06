//! Unit tests for L04.S06 Code/polyglot runtime contracts

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_execute_javascript_code_in_sandbox() {
        let service = PolyglotSandboxService::new();
        let input = serde_json::json!({ "foo": "bar" });
        let budget = SandboxBudget::default();

        let res = service
            .execute("exec-js-1", PolyglotLanguage::JavaScript, "return $input.all();", input, budget)
            .unwrap();

        assert_eq!(res.execution_id, "exec-js-1");
        assert_eq!(res.language, PolyglotLanguage::JavaScript);
        assert!(res.success);
        assert_eq!(res.output_data["foo"], "bar");
        assert_eq!(res.output_data["transformed_by"], "js_sandbox");
    }

    #[test]
    fn test_execute_python_code_in_sandbox() {
        let service = PolyglotSandboxService::new();
        let input = serde_json::json!({ "val": 42 });
        let budget = SandboxBudget::default();

        let res = service
            .execute("exec-py-1", PolyglotLanguage::Python, "return _input", input, budget)
            .unwrap();

        assert_eq!(res.execution_id, "exec-py-1");
        assert_eq!(res.language, PolyglotLanguage::Python);
        assert!(res.success);
        assert_eq!(res.output_data["val"], 42);
        assert_eq!(res.output_data["transformed_by"], "py_sandbox");
    }

    #[test]
    fn test_empty_code_rejected_with_syntax_error() {
        let service = PolyglotSandboxService::new();
        let res = service.execute(
            "exec-fail",
            PolyglotLanguage::JavaScript,
            "   ",
            serde_json::json!({}),
            SandboxBudget::default(),
        );

        assert!(matches!(res, Err(PolyglotError::SyntaxError(_))));
    }

    #[test]
    fn test_host_escape_blocked_by_sandbox() {
        let service = PolyglotSandboxService::new();
        let res = service.execute(
            "exec-escape",
            PolyglotLanguage::JavaScript,
            "const cp = require('child_process');",
            serde_json::json!({}),
            SandboxBudget::default(),
        );

        assert!(matches!(res, Err(PolyglotError::ExecutionFailed(_))));
    }

    #[test]
    fn test_port_handler_polyglot_execution() {
        let service = PolyglotSandboxService::new();

        let req = serde_json::json!({
            "action": "execute",
            "execution_id": "test-port-exec",
            "language": "javascript",
            "code": "return $json;",
            "input": { "status": "active" }
        });

        let resp = service.handle_port_polyglot_execute(&req).unwrap();
        assert_eq!(resp["success"], true);
        assert_eq!(resp["execution_id"], "test-port-exec");
        assert_eq!(resp["output"]["status"], "active");
    }
}
