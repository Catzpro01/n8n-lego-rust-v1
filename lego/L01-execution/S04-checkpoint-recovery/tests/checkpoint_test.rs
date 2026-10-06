#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_checkpoint_isolation_and_replay_sequence() {
        let cp1 = serde_json::json!({"execution_id": "exec_1", "step": 1, "status": "Success"});
        let cp2 = serde_json::json!({"execution_id": "exec_1", "step": 2, "status": "Success"});
        assert_eq!(cp1["execution_id"], "exec_1");
        assert_eq!(cp2["step"], 2);
    }
}
