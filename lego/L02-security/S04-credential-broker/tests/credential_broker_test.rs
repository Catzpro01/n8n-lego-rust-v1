#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_ref_release_security_boundary() {
        let vault = CredentialVault::new();
        let secret = serde_json::json!({"apiKey": "super_secret_token_123"});
        let s_ref = vault.store("cred_1".to_string(), secret);

        // Correct audience releases the credential
        let released = vault.release_verified(&s_ref, "n8n_execution").unwrap();
        assert_eq!(released["apiKey"], "super_secret_token_123");

        // Wrong audience is strictly rejected
        let denied = vault.release_verified(&s_ref, "untrusted_public_client");
        assert!(denied.is_err());
    }
}
