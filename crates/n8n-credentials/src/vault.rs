use aes_gcm::{
    aead::{Aead, KeyInit},
    Aes256Gcm, Key, Nonce,
};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use chrono::Utc;
use zeroize::Zeroize;

use crate::types::{
    CredentialEntity, CredentialsError, DecryptedCredential, EncryptedPayload,
    KeyRotationState, KeyRotationStatus,
};
use crate::zeroize::SecretKey;

pub const IV_LENGTH: usize = 12; // 96 bits standard GCM IV
pub const TAG_LENGTH: usize = 16; // 128 bits standard GCM tag

/// Encrypt raw bytes using AES-256-GCM.
/// Generates a fresh 12-byte random IV for each operation.
pub fn encrypt_bytes(plaintext: &[u8], key: &SecretKey) -> Result<EncryptedPayload, CredentialsError> {
    let mut iv = [0u8; IV_LENGTH];
    getrandom::getrandom(&mut iv)
        .map_err(|e| CredentialsError::CryptoError(format!("Failed to generate IV: {e}")))?;

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.expose_secret()));
    let nonce = Nonce::from_slice(&iv);

    let encrypted = cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| CredentialsError::CryptoError(format!("AES-256-GCM encryption failed: {e}")))?;

    if encrypted.len() < TAG_LENGTH {
        return Err(CredentialsError::CryptoError("Ciphertext shorter than authentication tag".to_string()));
    }

    let ct_len = encrypted.len() - TAG_LENGTH;
    let ct_bytes = &encrypted[..ct_len];
    let tag_bytes = &encrypted[ct_len..];

    Ok(EncryptedPayload {
        iv: BASE64_STANDARD.encode(iv),
        ciphertext: BASE64_STANDARD.encode(ct_bytes),
        auth_tag: BASE64_STANDARD.encode(tag_bytes),
    })
}

/// Encrypt a string slice using AES-256-GCM.
pub fn encrypt_str(plaintext: &str, key: &SecretKey) -> Result<EncryptedPayload, CredentialsError> {
    encrypt_bytes(plaintext.as_bytes(), key)
}

/// Encrypt a JSON Value using AES-256-GCM.
pub fn encrypt_value(value: &serde_json::Value, key: &SecretKey) -> Result<EncryptedPayload, CredentialsError> {
    let json_bytes = serde_json::to_vec(value)
        .map_err(|e| CredentialsError::CryptoError(format!("JSON serialization failed: {e}")))?;
    let mut sensitive_bytes = json_bytes;
    let result = encrypt_bytes(&sensitive_bytes, key);
    sensitive_bytes.zeroize();
    result
}

/// Encrypt credential data and build a `CredentialEntity` ready for database persistence.
pub fn encrypt_entity(
    id: &str,
    name: &str,
    credential_type: &str,
    value: &serde_json::Value,
    key: &SecretKey,
) -> Result<CredentialEntity, CredentialsError> {
    let payload = encrypt_value(value, key)?;
    CredentialEntity::with_payload(id, name, credential_type, &payload)
}

/// Decrypt an `EncryptedPayload` into raw bytes.
/// Fails closed if the key is wrong, or if ciphertext, IV, or auth_tag were tampered with.
pub fn decrypt_bytes(payload: &EncryptedPayload, key: &SecretKey) -> Result<Vec<u8>, CredentialsError> {
    let iv_bytes = BASE64_STANDARD
        .decode(payload.iv.trim())
        .map_err(|_| CredentialsError::MalformedPayload("Invalid base64 in IV".to_string()))?;

    if iv_bytes.len() != IV_LENGTH {
        return Err(CredentialsError::InvalidIvLength(iv_bytes.len()));
    }

    let ct_bytes = BASE64_STANDARD
        .decode(payload.ciphertext.trim())
        .map_err(|_| CredentialsError::MalformedPayload("Invalid base64 in ciphertext".to_string()))?;

    let tag_bytes = BASE64_STANDARD
        .decode(payload.auth_tag.trim())
        .map_err(|_| CredentialsError::MalformedPayload("Invalid base64 in auth_tag".to_string()))?;

    if tag_bytes.len() != TAG_LENGTH {
        return Err(CredentialsError::InvalidAuthTagLength(tag_bytes.len()));
    }

    // In aes-gcm crate, tag is appended to ciphertext for decrypt
    let mut combined = Vec::with_capacity(ct_bytes.len() + tag_bytes.len());
    combined.extend_from_slice(&ct_bytes);
    combined.extend_from_slice(&tag_bytes);

    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key.expose_secret()));
    let nonce = Nonce::from_slice(&iv_bytes);

    cipher.decrypt(nonce, combined.as_ref()).map_err(|_| {
        // Fail-closed: both wrong key and data tampering result in authentication failure.
        // In n8n contract: wrong key maps to DecryptionFailed error message.
        CredentialsError::DecryptionFailed
    })
}

/// Decrypt an `EncryptedPayload` into a UTF-8 string.
pub fn decrypt_str(payload: &EncryptedPayload, key: &SecretKey) -> Result<String, CredentialsError> {
    let mut bytes = decrypt_bytes(payload, key)?;
    let result = String::from_utf8(bytes.clone())
        .map_err(|_| CredentialsError::InvalidJson);
    bytes.zeroize();
    result
}

/// Decrypt an `EncryptedPayload` into a JSON Value.
pub fn decrypt_value(payload: &EncryptedPayload, key: &SecretKey) -> Result<serde_json::Value, CredentialsError> {
    let mut bytes = decrypt_bytes(payload, key)?;
    let result = serde_json::from_slice(&bytes).map_err(|_| CredentialsError::InvalidJson);
    bytes.zeroize();
    result
}

/// Decrypt a database `CredentialEntity` into an in-memory `DecryptedCredential`.
pub fn decrypt_entity(entity: &CredentialEntity, key: &SecretKey) -> Result<DecryptedCredential, CredentialsError> {
    let payload = entity.get_encrypted_payload()?;
    let value = decrypt_value(&payload, key)?;

    Ok(DecryptedCredential {
        id: entity.id.clone(),
        name: entity.name.clone(),
        credential_type: entity.credential_type.clone(),
        data: value,
        created_at: Some(entity.created_at),
        updated_at: Some(entity.updated_at),
    })
}

/// Decrypt a raw database string value from `credentials_entity.data`.
pub fn decrypt_raw_data(data: &str, key: &SecretKey) -> Result<serde_json::Value, CredentialsError> {
    if data.trim().is_empty() {
        return Err(CredentialsError::NoData);
    }
    let payload = EncryptedPayload::from_str_repr(data)?;
    decrypt_value(&payload, key)
}

/// Re-encrypt a payload under a new secret key.
/// Verifies that the new ciphertext decrypts cleanly BEFORE returning (verify-before-write).
pub fn rotate_payload(
    payload: &EncryptedPayload,
    old_key: &SecretKey,
    new_key: &SecretKey,
) -> Result<EncryptedPayload, CredentialsError> {
    let mut decrypted = decrypt_bytes(payload, old_key)?;
    let new_payload = encrypt_bytes(&decrypted, new_key)?;

    // Verify-before-write: confirm new key can decrypt cleanly
    let mut verify_bytes = decrypt_bytes(&new_payload, new_key).map_err(|_| {
        CredentialsError::KeyRotationError("Verification of rotated payload failed".to_string())
    })?;

    if verify_bytes != decrypted {
        decrypted.zeroize();
        verify_bytes.zeroize();
        return Err(CredentialsError::KeyRotationError(
            "Rotated payload plaintext mismatch".to_string(),
        ));
    }

    decrypted.zeroize();
    verify_bytes.zeroize();
    Ok(new_payload)
}

/// Rotate a `CredentialEntity` from old_key to new_key in-place with verify-before-write guarantee.
pub fn rotate_entity(
    entity: &mut CredentialEntity,
    old_key: &SecretKey,
    new_key: &SecretKey,
) -> Result<(), CredentialsError> {
    let current_payload = entity.get_encrypted_payload()?;
    let rotated_payload = rotate_payload(&current_payload, old_key, new_key)?;
    entity.set_encrypted_payload(&rotated_payload)?;
    entity.updated_at = Utc::now();
    Ok(())
}

/// VaultManager provides lifecycle custody over active encryption keys and zero-downtime key rotation.
pub struct VaultManager {
    current_key_ref: String,
    current_key: SecretKey,
    previous_key_ref: Option<String>,
    previous_key: Option<SecretKey>,
    state: KeyRotationState,
}

impl VaultManager {
    /// Initialize VaultManager with a single active primary key.
    pub fn new(current_key_ref: impl Into<String>, current_key: SecretKey) -> Self {
        let key_ref = current_key_ref.into();
        let state = KeyRotationState::new(key_ref.clone());
        Self {
            current_key_ref: key_ref,
            current_key,
            previous_key_ref: None,
            previous_key: None,
            state,
        }
    }

    pub fn current_key_ref(&self) -> &str {
        &self.current_key_ref
    }

    pub fn current_key(&self) -> &SecretKey {
        &self.current_key
    }

    pub fn previous_key_ref(&self) -> Option<&str> {
        self.previous_key_ref.as_deref()
    }

    pub fn state(&self) -> &KeyRotationState {
        &self.state
    }

    /// Begin zero-downtime key rotation: the existing primary becomes `previous`,
    /// and the new key becomes `current`. During rotation, reading from either key is supported.
    pub fn begin_rotation(
        &mut self,
        new_key_ref: impl Into<String>,
        new_key: SecretKey,
    ) -> Result<(), CredentialsError> {
        if self.state.is_in_progress() {
            return Err(CredentialsError::KeyRotationError(
                "A key rotation is already in progress".to_string(),
            ));
        }

        let new_ref = new_key_ref.into();
        let old_ref = self.current_key_ref.clone();
        let old_key = self.current_key.clone();

        self.previous_key_ref = Some(old_ref.clone());
        self.previous_key = Some(old_key);
        self.current_key_ref = new_ref.clone();
        self.current_key = new_key;

        self.state.current_key_ref = new_ref.clone();
        self.state.previous_key_ref = Some(old_ref.clone());
        self.state.status = KeyRotationStatus::InProgress {
            from_key_ref: old_ref,
            to_key_ref: new_ref,
            started_at: Utc::now(),
        };

        Ok(())
    }

    /// Encrypt an entity using the current primary key.
    pub fn encrypt_entity(
        &self,
        id: &str,
        name: &str,
        credential_type: &str,
        value: &serde_json::Value,
    ) -> Result<CredentialEntity, CredentialsError> {
        encrypt_entity(id, name, credential_type, value, &self.current_key)
    }

    /// Decrypt an entity: tries the current key first, and if in rotation, falls back to the previous key.
    pub fn decrypt_entity(&self, entity: &CredentialEntity) -> Result<DecryptedCredential, CredentialsError> {
        let payload = entity.get_encrypted_payload()?;

        // 1. Try current key
        if let Ok(value) = decrypt_value(&payload, &self.current_key) {
            return Ok(DecryptedCredential {
                id: entity.id.clone(),
                name: entity.name.clone(),
                credential_type: entity.credential_type.clone(),
                data: value,
                created_at: Some(entity.created_at),
                updated_at: Some(entity.updated_at),
            });
        }

        // 2. If rotation in progress, try previous key
        if let Some(ref prev_key) = self.previous_key {
            if let Ok(value) = decrypt_value(&payload, prev_key) {
                return Ok(DecryptedCredential {
                    id: entity.id.clone(),
                    name: entity.name.clone(),
                    credential_type: entity.credential_type.clone(),
                    data: value,
                    created_at: Some(entity.created_at),
                    updated_at: Some(entity.updated_at),
                });
            }
        }

        Err(CredentialsError::DecryptionFailed)
    }

    /// Rotate a single entity from previous key to current key.
    pub fn rotate_single_entity(&mut self, entity: &mut CredentialEntity) -> Result<(), CredentialsError> {
        let Some(ref prev_key) = self.previous_key else {
            return Err(CredentialsError::KeyRotationError(
                "No previous key available for rotation".to_string(),
            ));
        };

        rotate_entity(entity, prev_key, &self.current_key)?;
        self.state.rotated_credentials += 1;
        if self.state.pending_credentials > 0 {
            self.state.pending_credentials -= 1;
        }
        Ok(())
    }

    /// Rotate a batch of credentials from previous key to current key.
    pub fn rotate_batch(
        &mut self,
        entities: &mut [CredentialEntity],
    ) -> Result<KeyRotationState, CredentialsError> {
        let Some(ref prev_key) = self.previous_key else {
            return Err(CredentialsError::KeyRotationError(
                "No previous key available for rotation".to_string(),
            ));
        };

        self.state.total_credentials = entities.len();
        self.state.pending_credentials = entities.len();
        self.state.rotated_credentials = 0;

        for entity in entities.iter_mut() {
            // Only rotate if entity was encrypted with previous key
            let payload = entity.get_encrypted_payload()?;
            if decrypt_value(&payload, &self.current_key).is_err() {
                rotate_entity(entity, prev_key, &self.current_key)?;
                self.state.rotated_credentials += 1;
                self.state.pending_credentials -= 1;
            } else {
                // Already on current key
                self.state.rotated_credentials += 1;
                self.state.pending_credentials -= 1;
            }
        }

        Ok(self.state.clone())
    }

    /// Complete key rotation: retire the previous key permanently, destroying its memory.
    pub fn finish_rotation(&mut self) -> Result<KeyRotationState, CredentialsError> {
        if !self.state.is_in_progress() {
            return Err(CredentialsError::KeyRotationError(
                "No rotation in progress to finish".to_string(),
            ));
        }

        let retired = self.previous_key_ref.take();
        self.previous_key = None; // Dropped and zeroized automatically

        self.state.previous_key_ref = None;
        self.state.status = KeyRotationStatus::Completed {
            retired_key_ref: retired,
            completed_at: Utc::now(),
        };

        Ok(self.state.clone())
    }

    /// Abort key rotation: rollback current key back to the previous key.
    pub fn abort_rotation(&mut self) -> Result<KeyRotationState, CredentialsError> {
        let (Some(prev_ref), Some(prev_key)) = (self.previous_key_ref.take(), self.previous_key.take()) else {
            return Err(CredentialsError::KeyRotationError(
                "No previous key available to abort rotation to".to_string(),
            ));
        };

        let rolled_back_to = prev_ref.clone();
        self.current_key_ref = prev_ref;
        self.current_key = prev_key;

        self.state.current_key_ref = self.current_key_ref.clone();
        self.state.previous_key_ref = None;
        self.state.status = KeyRotationStatus::Aborted {
            rolled_back_to,
            aborted_at: Utc::now(),
        };

        Ok(self.state.clone())
    }
}
