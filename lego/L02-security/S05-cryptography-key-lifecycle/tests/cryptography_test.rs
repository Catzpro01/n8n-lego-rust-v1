#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_crypto_encrypt_decrypt_roundtrip() {
        let service = KeyLifecycleCryptoService::new("key-1", b"secret-passphrase-32-bytes-long!");

        let secret_message = "database_password_super_secret_12345";
        let encrypted = service
            .encrypt(secret_message.as_bytes(), None)
            .expect("Encryption should succeed");

        assert!(encrypted.starts_with("enc:v1:key-1:"));

        let decrypted_bytes = service
            .decrypt(&encrypted)
            .expect("Decryption should succeed");
        let decrypted_str = String::from_utf8(decrypted_bytes).expect("Valid utf-8");

        assert_eq!(decrypted_str, secret_message);
    }

    #[test]
    fn test_crypto_key_rotation_seamless_decrypt() {
        let service = KeyLifecycleCryptoService::new("key-v1", b"v1-secret-bytes-for-encrypt-32!");

        // 1. Encrypt with v1
        let text_v1 = "payload_under_key_v1";
        let encrypted_v1 = service.encrypt(text_v1.as_bytes(), None).unwrap();
        assert!(encrypted_v1.contains("key-v1"));

        // 2. Rotate to v2
        service
            .rotate_key("key-v2", b"v2-secret-bytes-for-encrypt-32!")
            .expect("Key rotation should succeed");

        assert_eq!(service.active_key_id(), "key-v2");

        // 3. Encrypt new payload: uses key-v2
        let text_v2 = "payload_under_key_v2";
        let encrypted_v2 = service.encrypt(text_v2.as_bytes(), None).unwrap();
        assert!(encrypted_v2.contains("key-v2"));

        // 4. Decrypt v1 payload under rotated service: still works (deprecated key)
        let dec_v1 = service.decrypt(&encrypted_v1).unwrap();
        assert_eq!(String::from_utf8(dec_v1).unwrap(), text_v1);

        // 5. Decrypt v2 payload: works
        let dec_v2 = service.decrypt(&encrypted_v2).unwrap();
        assert_eq!(String::from_utf8(dec_v2).unwrap(), text_v2);
    }

    #[test]
    fn test_crypto_revoked_key_rejection() {
        let service = KeyLifecycleCryptoService::new("key-old", b"secret-for-old-key-32-bytes-long");

        let encrypted = service.encrypt(b"secret_data", None).unwrap();

        // Revoke key-old
        service.revoke_key("key-old").expect("Revocation should succeed");

        // Attempt decrypt with revoked key -> fail closed
        let err = service.decrypt(&encrypted).unwrap_err();
        match err {
            CryptoError::KeyRevoked(k) => assert_eq!(k, "key-old"),
            other => panic!("Expected KeyRevoked, got {other:?}"),
        }

        // Attempt encrypt with revoked key -> fail closed
        let err_enc = service.encrypt(b"new_data", Some("key-old")).unwrap_err();
        match err_enc {
            CryptoError::KeyRevoked(k) => assert_eq!(k, "key-old"),
            other => panic!("Expected KeyRevoked, got {other:?}"),
        }
    }

    #[test]
    fn test_crypto_tampered_ciphertext_detection() {
        let service = KeyLifecycleCryptoService::new("key-tamper", b"secret-passphrase-32-bytes-long!");

        let encrypted = service.encrypt(b"untampered_secret_data", None).unwrap();

        // Tamper with the ciphertext component
        let mut parts: Vec<&str> = encrypted.split(':').collect();
        // parts: ["enc", "v1", "key-tamper", iv, ciphertext, hmac]
        let mut tampered_bytes = parts[4].as_bytes().to_vec();
        // Flip first char
        tampered_bytes[0] = if tampered_bytes[0] == b'a' { b'b' } else { b'a' };
        let tampered_ct = String::from_utf8(tampered_bytes).unwrap();
        parts[4] = &tampered_ct;
        let tampered_envelope = parts.join(":");

        let err = service.decrypt(&tampered_envelope).unwrap_err();
        match err {
            CryptoError::DecryptionFailed(msg) => {
                assert!(msg.contains("HMAC verification failed"));
            }
            other => panic!("Expected DecryptionFailed, got {other:?}"),
        }
    }

    #[test]
    fn test_crypto_empty_plaintext_rejection() {
        let service = KeyLifecycleCryptoService::new("key-empty", b"secret-passphrase-32-bytes-long!");

        let err = service.encrypt(b"", None).unwrap_err();
        assert_eq!(err, CryptoError::EmptyPlaintext);
    }

    #[test]
    fn test_crypto_envelope_format_parsing() {
        let env = EncryptedEnvelope {
            envelope_version: 1,
            key_id: "test-k".to_string(),
            iv_hex: "010203".to_string(),
            ciphertext_hex: "040506".to_string(),
            hmac_hex: "070809".to_string(),
        };

        let s = env.to_serialized_string();
        assert_eq!(s, "enc:v1:test-k:010203:040506:070809");

        let parsed = EncryptedEnvelope::parse(&s).expect("Parsing should succeed");
        assert_eq!(parsed, env);

        // Invalid envelope string
        assert!(EncryptedEnvelope::parse("invalid:format").is_err());
    }

    #[test]
    fn test_crypto_port_encrypt_and_decrypt_dispatchers() {
        let service = KeyLifecycleCryptoService::new("key-port", b"secret-passphrase-32-bytes-long!");

        let enc_payload = json!({
            "plaintext": "my-api-token-xyz-987"
        });

        let enc_resp = service
            .handle_port_encrypt(&enc_payload)
            .expect("Port encrypt should succeed");

        assert_eq!(enc_resp["success"], true);
        let ciphertext = enc_resp["encrypted"].as_str().expect("Ciphertext string");
        assert!(ciphertext.starts_with("enc:v1:key-port:"));

        let dec_payload = json!({
            "encrypted": ciphertext
        });

        let dec_resp = service
            .handle_port_decrypt(&dec_payload)
            .expect("Port decrypt should succeed");

        assert_eq!(dec_resp["success"], true);
        assert_eq!(dec_resp["plaintext"], "my-api-token-xyz-987");
    }

    #[test]
    fn test_crypto_rotate_fail_closed_empty_inputs() {
        let service = KeyLifecycleCryptoService::new("key-active", b"initial-secret-material-32-bytes!");

        // Empty key id
        let err1 = service.rotate_key("", b"valid-secret-material-bytes-32!").unwrap_err();
        assert_eq!(err1, CryptoError::EmptyKeySpec("new_key_id"));

        let err2 = service.rotate_key("   ", b"valid-secret-material-bytes-32!").unwrap_err();
        assert_eq!(err2, CryptoError::EmptyKeySpec("new_key_id"));

        // Empty secret material
        let err3 = service.rotate_key("key-new", b"").unwrap_err();
        assert_eq!(err3, CryptoError::EmptyKeySpec("new_secret"));

        // Revoke with empty key id
        let err4 = service.revoke_key("").unwrap_err();
        assert_eq!(err4, CryptoError::EmptyKeySpec("key_id"));

        // Encrypt with empty explicit key id
        let err5 = service.encrypt(b"hello", Some("   ")).unwrap_err();
        assert_eq!(err5, CryptoError::EmptyKeySpec("key_id"));
    }

    #[test]
    fn test_crypto_active_key_revocation_fail_closed_encrypt() {
        let service = KeyLifecycleCryptoService::new("key-single", b"initial-secret-material-32-bytes!");

        // Revoke active key
        service.revoke_key("key-single").expect("Revocation of key-single should succeed");

        // Attempting to encrypt with revoked active key must fail closed
        let err = service.encrypt(b"sensitive_data", None).unwrap_err();
        match err {
            CryptoError::KeyRevoked(k) => assert_eq!(k, "key-single"),
            other => panic!("Expected KeyRevoked, got {other:?}"),
        }
    }

    #[test]
    fn test_crypto_decrypt_missing_key_rejection() {
        let service = KeyLifecycleCryptoService::new("key-known", b"initial-secret-material-32-bytes!");

        // Envelope pointing to non-existent key
        let unknown_envelope = "enc:v1:key-non-existent:0102030405060708:deadbeef:1234567890abcdef";
        let err = service.decrypt(unknown_envelope).unwrap_err();
        match err {
            CryptoError::KeyNotFound(k) => assert_eq!(k, "key-non-existent"),
            other => panic!("Expected KeyNotFound, got {other:?}"),
        }
    }
}

