//! n8n-credentials: Full Rust implementation of n8n credentials LEGO.
//!
//! Provides AES-256-GCM encryption & decryption engine 100% compatible with
//! official n8n database storage (table credentials_entity: iv, ciphertext, auth_tag),
//! secret memory zeroization on drop, and zero-downtime key rotation.

pub mod types;
pub mod vault;
pub mod zeroize;

// Re-exports
pub use types::{
    CredentialEntity, CredentialPropertyDescriptor, CredentialTypeDescriptor,
    CredentialsError, DecryptedCredential, EncryptedPayload, KeyRotationState,
    KeyRotationStatus, PropertyTypeOptions, CREDENTIAL_BLANKING_VALUE,
    CREDENTIAL_EMPTY_VALUE,
};
pub use vault::{
    decrypt_bytes, decrypt_entity, decrypt_raw_data, decrypt_str, decrypt_value,
    encrypt_bytes, encrypt_entity, encrypt_str, encrypt_value, rotate_entity,
    rotate_payload, VaultManager, IV_LENGTH, TAG_LENGTH,
};
pub use zeroize::{SecretBytes, SecretKey};

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
    use base64::Engine;

    const DUMMY_KEY_1: &str = "n8n-super-secret-key-phase2-001";
    const DUMMY_KEY_2: &str = "n8n-other-secret-key-different-02";

    #[test]
    fn test_encryption_decryption_round_trip() {
        let key = SecretKey::from_passphrase(DUMMY_KEY_1);
        let secret_payload = serde_json::json!({
            "apiKey": "sk-live-123456789abcdef",
            "host": "https://api.example.com",
            "port": 8080,
            "enabled": true
        });

        // 1. Encrypt value
        let encrypted = encrypt_value(&secret_payload, &key).expect("Encryption failed");

        // Verify structure: iv, ciphertext, auth_tag must exist and be valid base64
        assert!(!encrypted.iv.is_empty());
        assert!(!encrypted.ciphertext.is_empty());
        assert!(!encrypted.auth_tag.is_empty());

        let iv_bytes = BASE64_STANDARD.decode(&encrypted.iv).unwrap();
        let tag_bytes = BASE64_STANDARD.decode(&encrypted.auth_tag).unwrap();
        assert_eq!(iv_bytes.len(), IV_LENGTH);
        assert_eq!(tag_bytes.len(), TAG_LENGTH);

        // 2. Decrypt value
        let decrypted = decrypt_value(&encrypted, &key).expect("Decryption failed");
        assert_eq!(decrypted, secret_payload);

        // 3. Round-trip string
        let plain_text = "Top-Secret-Database-Password-42!";
        let enc_str = encrypt_str(plain_text, &key).expect("Encrypt str failed");
        let dec_str = decrypt_str(&enc_str, &key).expect("Decrypt str failed");
        assert_eq!(dec_str, plain_text);

        // 4. Round-trip bytes
        let plain_bytes = b"Binary\x00Token\xFFStream";
        let enc_bytes = encrypt_bytes(plain_bytes, &key).expect("Encrypt bytes failed");
        let dec_bytes = decrypt_bytes(&enc_bytes, &key).expect("Decrypt bytes failed");
        assert_eq!(dec_bytes, plain_bytes);
    }

    #[test]
    fn test_database_credential_entity_compatibility() {
        let key = SecretKey::from_passphrase(DUMMY_KEY_1);
        let secret = serde_json::json!({
            "token": "tok_live_abc123"
        });

        // Create database entity with encrypted payload
        let entity = encrypt_entity("cred-999", "Slack API", "slackOAuth2Api", &secret, &key)
            .expect("Failed to encrypt entity");

        assert_eq!(entity.id, "cred-999");
        assert_eq!(entity.name, "Slack API");
        assert_eq!(entity.credential_type, "slackOAuth2Api");

        // Verify column `data` contains JSON with `iv`, `ciphertext`, and `auth_tag`
        let payload = entity.get_encrypted_payload().expect("Failed to parse payload");
        assert_eq!(entity.iv().unwrap(), payload.iv);
        assert_eq!(entity.ciphertext().unwrap(), payload.ciphertext);
        assert_eq!(entity.auth_tag().unwrap(), payload.auth_tag);

        // Direct JSON serialization test to ensure compatibility with n8n DB schema
        let entity_json = serde_json::to_string(&entity).unwrap();
        assert!(entity_json.contains("\"type\":\"slackOAuth2Api\""));
        assert!(entity_json.contains("\"data\":\""));
        assert!(!entity_json.contains("tok_live_abc123")); // Plaintext never leaked

        // Decrypt entity
        let decrypted_entity = decrypt_entity(&entity, &key).expect("Failed to decrypt entity");
        assert_eq!(decrypted_entity.id, "cred-999");
        assert_eq!(decrypted_entity.data, secret);
    }

    #[test]
    fn test_wrong_password_fails_closed() {
        let correct_key = SecretKey::from_passphrase(DUMMY_KEY_1);
        let wrong_key = SecretKey::from_passphrase(DUMMY_KEY_2);

        let secret = serde_json::json!({ "private_key": "-----BEGIN RSA PRIVATE KEY-----" });
        let encrypted = encrypt_value(&secret, &correct_key).unwrap();

        // Attempt decrypt with wrong key
        let result = decrypt_value(&encrypted, &wrong_key);
        assert!(result.is_err());
        match result {
            Err(CredentialsError::DecryptionFailed) => {}
            other => panic!("Expected DecryptionFailed, got {other:?}"),
        }
    }

    #[test]
    fn test_tamper_detection_auth_tag() {
        let key = SecretKey::from_passphrase(DUMMY_KEY_1);
        let secret = serde_json::json!({ "secret": "confidential" });
        let encrypted = encrypt_value(&secret, &key).unwrap();

        // 1. Corrupt the auth tag bytes
        let mut tag_bytes = BASE64_STANDARD.decode(&encrypted.auth_tag).unwrap();
        tag_bytes[0] ^= 0x55; // Flip bits
        let tampered_payload = EncryptedPayload {
            iv: encrypted.iv.clone(),
            ciphertext: encrypted.ciphertext.clone(),
            auth_tag: BASE64_STANDARD.encode(&tag_bytes),
        };

        let result = decrypt_value(&tampered_payload, &key);
        assert!(result.is_err(), "Decryption must fail when auth tag is tampered");
        assert_eq!(result.unwrap_err(), CredentialsError::DecryptionFailed);
    }

    #[test]
    fn test_tamper_detection_ciphertext() {
        let key = SecretKey::from_passphrase(DUMMY_KEY_1);
        let secret = serde_json::json!({ "user": "admin", "password": "supersecretpassword" });
        let encrypted = encrypt_value(&secret, &key).unwrap();

        // 2. Corrupt ciphertext bytes
        let mut ct_bytes = BASE64_STANDARD.decode(&encrypted.ciphertext).unwrap();
        ct_bytes[0] ^= 0xAA; // Flip bits
        let tampered_payload = EncryptedPayload {
            iv: encrypted.iv.clone(),
            ciphertext: BASE64_STANDARD.encode(&ct_bytes),
            auth_tag: encrypted.auth_tag.clone(),
        };

        let result = decrypt_value(&tampered_payload, &key);
        assert!(result.is_err(), "Decryption must fail when ciphertext is tampered");
        assert_eq!(result.unwrap_err(), CredentialsError::DecryptionFailed);
    }

    #[test]
    fn test_tamper_detection_iv() {
        let key = SecretKey::from_passphrase(DUMMY_KEY_1);
        let secret = serde_json::json!({ "secret": "data" });
        let encrypted = encrypt_value(&secret, &key).unwrap();

        // 3. Corrupt IV bytes
        let mut iv_bytes = BASE64_STANDARD.decode(&encrypted.iv).unwrap();
        iv_bytes[0] ^= 0x01; // Flip bits
        let tampered_payload = EncryptedPayload {
            iv: BASE64_STANDARD.encode(&iv_bytes),
            ciphertext: encrypted.ciphertext.clone(),
            auth_tag: encrypted.auth_tag.clone(),
        };

        let result = decrypt_value(&tampered_payload, &key);
        assert!(result.is_err(), "Decryption must fail when IV is tampered");
        assert_eq!(result.unwrap_err(), CredentialsError::DecryptionFailed);
    }

    #[test]
    fn test_invalid_lengths_fail_closed() {
        let key = SecretKey::from_passphrase(DUMMY_KEY_1);

        // Payload with short IV (8 bytes instead of 12)
        let short_iv_payload = EncryptedPayload {
            iv: BASE64_STANDARD.encode([1u8; 8]),
            ciphertext: BASE64_STANDARD.encode([2u8; 32]),
            auth_tag: BASE64_STANDARD.encode([3u8; 16]),
        };
        let res = decrypt_value(&short_iv_payload, &key);
        assert_eq!(res.unwrap_err(), CredentialsError::InvalidIvLength(8));

        // Payload with short Tag (10 bytes instead of 16)
        let short_tag_payload = EncryptedPayload {
            iv: BASE64_STANDARD.encode([1u8; 12]),
            ciphertext: BASE64_STANDARD.encode([2u8; 32]),
            auth_tag: BASE64_STANDARD.encode([3u8; 10]),
        };
        let res2 = decrypt_value(&short_tag_payload, &key);
        assert_eq!(res2.unwrap_err(), CredentialsError::InvalidAuthTagLength(10));
    }

    #[test]
    fn test_key_rotation_lifecycle() {
        let key1 = SecretKey::from_passphrase(DUMMY_KEY_1);
        let key2 = SecretKey::from_passphrase(DUMMY_KEY_2);

        let mut vault_mgr = VaultManager::new("key-v1", key1.clone());
        assert_eq!(vault_mgr.current_key_ref(), "key-v1");
        assert_eq!(vault_mgr.previous_key_ref(), None);

        // Create 3 entities encrypted with key1
        let mut entities = vec![
            vault_mgr.encrypt_entity("c1", "Cred 1", "httpHeaderAuth", &serde_json::json!({"val": 1})).unwrap(),
            vault_mgr.encrypt_entity("c2", "Cred 2", "httpHeaderAuth", &serde_json::json!({"val": 2})).unwrap(),
            vault_mgr.encrypt_entity("c3", "Cred 3", "httpHeaderAuth", &serde_json::json!({"val": 3})).unwrap(),
        ];

        // 1. Begin rotation to key2
        vault_mgr.begin_rotation("key-v2", key2.clone()).expect("Begin rotation failed");
        assert!(vault_mgr.state().is_in_progress());
        assert_eq!(vault_mgr.current_key_ref(), "key-v2");
        assert_eq!(vault_mgr.previous_key_ref(), Some("key-v1"));

        // During rotation: entities encrypted with old key (key1) can still be decrypted!
        for entity in &entities {
            let dec = vault_mgr.decrypt_entity(entity).expect("Decryption during rotation failed");
            assert!(dec.data.get("val").is_some());
        }

        // 2. Batch rotate entities
        let state = vault_mgr.rotate_batch(&mut entities).expect("Batch rotate failed");
        assert_eq!(state.rotated_credentials, 3);
        assert_eq!(state.pending_credentials, 0);

        // Now every entity can be decrypted directly by key2
        for (i, entity) in entities.iter().enumerate() {
            let dec = decrypt_entity(entity, &key2).expect("Decrypt with key2 failed");
            assert_eq!(dec.data["val"], (i + 1) as i64);

            // Attempting to decrypt with old key1 now fails!
            assert!(decrypt_entity(entity, &key1).is_err());
        }

        // 3. Finish rotation: key1 is retired
        let final_state = vault_mgr.finish_rotation().expect("Finish rotation failed");
        assert!(final_state.is_completed());
        assert_eq!(vault_mgr.previous_key_ref(), None);

        // Verify entities still decrypt with current key
        for entity in &entities {
            let dec = vault_mgr.decrypt_entity(entity).expect("Decrypt after rotation failed");
            assert!(dec.data.get("val").is_some());
        }
    }

    #[test]
    fn test_key_rotation_abort_rollback() {
        let key1 = SecretKey::from_passphrase(DUMMY_KEY_1);
        let key2 = SecretKey::from_passphrase(DUMMY_KEY_2);

        let mut vault_mgr = VaultManager::new("key-v1", key1.clone());
        vault_mgr.begin_rotation("key-v2", key2).unwrap();
        assert_eq!(vault_mgr.current_key_ref(), "key-v2");

        // Abort rotation
        let state = vault_mgr.abort_rotation().expect("Abort rotation failed");
        assert_eq!(vault_mgr.current_key_ref(), "key-v1");
        assert_eq!(vault_mgr.previous_key_ref(), None);
        matches!(state.status, KeyRotationStatus::Aborted { .. });
    }

    #[test]
    fn test_redaction_markers_and_expressions() {
        let desc = CredentialTypeDescriptor::new("apiKeyAuth")
            .with_property(CredentialPropertyDescriptor::new_plain("apiKeyHeader", "Header"))
            .with_property(CredentialPropertyDescriptor::new_password("apiKeyValue", "Value"));

        let cred_data = serde_json::json!({
            "apiKeyHeader": "X-API-Key",
            "apiKeyValue": "secret-12345",
            "emptySecret": "",
            "exprSecret": "={{ $node[\"Init\"].json[\"token\"] }}"
        });

        let cred = DecryptedCredential::new("c1", "API Key", "apiKeyAuth", cred_data.clone());
        let redacted = cred.redact(Some(&desc));

        assert_eq!(redacted["apiKeyHeader"], "X-API-Key");
        assert_eq!(redacted["apiKeyValue"], CREDENTIAL_BLANKING_VALUE);
    }
}
