use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use thiserror::Error;

/// Exact marker constant used by official n8n to redact non-empty secret values at API boundaries.
pub const CREDENTIAL_BLANKING_VALUE: &str = "__n8n_BLANK_VALUE_e5362baf-c777-4d57-a609-6eaf1f9e87f6";

/// Exact marker constant used by official n8n to redact empty secret values at API boundaries.
pub const CREDENTIAL_EMPTY_VALUE: &str = "__n8n_EMPTY_VALUE_7b1af746-3729-4c60-9b9b-e08eb29e58da";

#[derive(Error, Debug, Clone, PartialEq, Eq)]
pub enum CredentialsError {
    #[error("No data is set on this credentials.")]
    NoData,

    #[error("Credentials could not be decrypted. The likely reason is that a different \"encryptionKey\" was used to encrypt the data.")]
    DecryptionFailed,

    #[error("Decrypted credentials data is not valid JSON.")]
    InvalidJson,

    #[error("Credential with ID \"{0}\" could not be found.")]
    CredentialNotFound(String),

    #[error("Credential with ID \"{0}\" does not exist for type \"{1}\".")]
    CredentialNotFoundForType(String, String),

    #[error("Node does not have credential type \"{0}\"")]
    NodeOperationError(String),

    #[error("Node does not have any credentials set for \"{0}\"")]
    NodeMissingCredentials(String),

    #[error("Credential payload authentication failed: invalid auth tag or corrupted ciphertext")]
    InvalidAuthTag,

    #[error("Tamper detected: authentication verification failed")]
    TamperDetected,

    #[error("Invalid key length: expected 32 bytes, got {0}")]
    InvalidKeyLength(usize),

    #[error("Invalid IV length: expected 12 bytes, got {0}")]
    InvalidIvLength(usize),

    #[error("Invalid auth tag length: expected 16 bytes, got {0}")]
    InvalidAuthTagLength(usize),

    #[error("Credential encrypted payload is malformed: {0}")]
    MalformedPayload(String),

    #[error("Key rotation error: {0}")]
    KeyRotationError(String),

    #[error("Crypto error: {0}")]
    CryptoError(String),
}

/// Ciphertext representation compatible with official n8n database storage (table credentials_entity).
/// Carries the 96-bit (12-byte) IV, encrypted ciphertext, and 128-bit (16-byte) authentication tag.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EncryptedPayload {
    /// 12-byte initialization vector (base64 encoded).
    pub iv: String,
    /// Encrypted ciphertext bytes (base64 encoded).
    #[serde(alias = "ct")]
    pub ciphertext: String,
    /// 16-byte GCM authentication tag (base64 encoded).
    #[serde(alias = "tag", alias = "authTag")]
    pub auth_tag: String,
}

impl EncryptedPayload {
    pub fn new(
        iv: impl Into<String>,
        ciphertext: impl Into<String>,
        auth_tag: impl Into<String>,
    ) -> Self {
        Self {
            iv: iv.into(),
            ciphertext: ciphertext.into(),
            auth_tag: auth_tag.into(),
        }
    }

    /// Serialize payload to JSON string (stored in database column `credentials_entity.data`).
    pub fn to_json_string(&self) -> Result<String, CredentialsError> {
        serde_json::to_string(self)
            .map_err(|e| CredentialsError::MalformedPayload(e.to_string()))
    }

    /// Parse payload from JSON string or colon-separated representation.
    pub fn from_str_repr(s: &str) -> Result<Self, CredentialsError> {
        let trimmed = s.trim();
        if trimmed.starts_with('{') {
            serde_json::from_str::<Self>(trimmed)
                .map_err(|e| CredentialsError::MalformedPayload(e.to_string()))
        } else if trimmed.contains(':') {
            let parts: Vec<&str> = trimmed.split(':').collect();
            if parts.len() == 3 {
                Ok(Self {
                    iv: parts[0].to_string(),
                    ciphertext: parts[1].to_string(),
                    auth_tag: parts[2].to_string(),
                })
            } else {
                Err(CredentialsError::MalformedPayload(
                    "Invalid colon-separated payload format (expected iv:ciphertext:auth_tag)".to_string(),
                ))
            }
        } else {
            Err(CredentialsError::MalformedPayload(
                "Unrecognized ciphertext payload format".to_string(),
            ))
        }
    }
}

/// Direct mapping of `credentials_entity` database table in n8n.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CredentialEntity {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    /// Ciphertext text payload storing serialized `EncryptedPayload`.
    pub data: String,
    #[serde(default, rename = "isManaged")]
    pub is_managed: bool,
    #[serde(default, rename = "isGlobal")]
    pub is_global: bool,
    #[serde(default, rename = "isResolvable")]
    pub is_resolvable: bool,
    #[serde(default, rename = "resolvableAllowFallback")]
    pub resolvable_allow_fallback: bool,
    #[serde(default, rename = "resolverId")]
    pub resolver_id: Option<String>,
    #[serde(default = "Utc::now", rename = "createdAt")]
    pub created_at: DateTime<Utc>,
    #[serde(default = "Utc::now", rename = "updatedAt")]
    pub updated_at: DateTime<Utc>,
}

impl CredentialEntity {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        credential_type: impl Into<String>,
        data: impl Into<String>,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: id.into(),
            name: name.into(),
            credential_type: credential_type.into(),
            data: data.into(),
            is_managed: false,
            is_global: false,
            is_resolvable: false,
            resolvable_allow_fallback: false,
            resolver_id: None,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn with_payload(
        id: impl Into<String>,
        name: impl Into<String>,
        credential_type: impl Into<String>,
        payload: &EncryptedPayload,
    ) -> Result<Self, CredentialsError> {
        let json_data = payload.to_json_string()?;
        Ok(Self::new(id, name, credential_type, json_data))
    }

    /// Parse the `data` column into structured `EncryptedPayload`.
    pub fn get_encrypted_payload(&self) -> Result<EncryptedPayload, CredentialsError> {
        if self.data.trim().is_empty() {
            return Err(CredentialsError::NoData);
        }
        EncryptedPayload::from_str_repr(&self.data)
    }

    /// Set and serialize a new `EncryptedPayload` into `data`.
    pub fn set_encrypted_payload(&mut self, payload: &EncryptedPayload) -> Result<(), CredentialsError> {
        self.data = payload.to_json_string()?;
        self.updated_at = Utc::now();
        Ok(())
    }

    /// Read IV directly from payload.
    pub fn iv(&self) -> Result<String, CredentialsError> {
        self.get_encrypted_payload().map(|p| p.iv)
    }

    /// Read ciphertext directly from payload.
    pub fn ciphertext(&self) -> Result<String, CredentialsError> {
        self.get_encrypted_payload().map(|p| p.ciphertext)
    }

    /// Read auth tag directly from payload.
    pub fn auth_tag(&self) -> Result<String, CredentialsError> {
        self.get_encrypted_payload().map(|p| p.auth_tag)
    }
}

/// Decrypted credential in-memory representation.
/// Plaintext secrets exist only transiently and are never logged or stored on disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DecryptedCredential {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub credential_type: String,
    pub data: serde_json::Value,
    #[serde(default, rename = "createdAt")]
    pub created_at: Option<DateTime<Utc>>,
    #[serde(default, rename = "updatedAt")]
    pub updated_at: Option<DateTime<Utc>>,
}

impl DecryptedCredential {
    pub fn new(
        id: impl Into<String>,
        name: impl Into<String>,
        credential_type: impl Into<String>,
        data: serde_json::Value,
    ) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            credential_type: credential_type.into(),
            data,
            created_at: Some(Utc::now()),
            updated_at: Some(Utc::now()),
        }
    }

    pub fn get(&self, key: &str) -> Option<&serde_json::Value> {
        self.data.get(key)
    }

    pub fn set(&mut self, key: impl Into<String>, val: serde_json::Value) {
        if let serde_json::Value::Object(ref mut map) = self.data {
            map.insert(key.into(), val);
        } else {
            let mut map = serde_json::Map::new();
            map.insert(key.into(), val);
            self.data = serde_json::Value::Object(map);
        }
    }

    /// Redact credential secrets for external REST API delivery according to n8n specifications.
    /// Password-typed properties (and oauthTokenData, csrfSecret) are blanked with
    /// `CREDENTIAL_BLANKING_VALUE` or `CREDENTIAL_EMPTY_VALUE`.
    pub fn redact(&self, descriptor: Option<&CredentialTypeDescriptor>) -> serde_json::Value {
        let serde_json::Value::Object(map) = &self.data else {
            return self.data.clone();
        };

        let mut redacted = serde_json::Map::new();
        for (key, val) in map {
            let is_secret = if let Some(desc) = descriptor {
                desc.is_secret_field(key)
            } else {
                key.to_lowercase().contains("password")
                    || key.to_lowercase().contains("token")
                    || key.to_lowercase().contains("secret")
                    || key == "oauthTokenData"
                    || key == "csrfSecret"
            };

            if is_secret {
                match val {
                    serde_json::Value::String(s) => {
                        // Expression values (={{ ... }}) are not redacted unless explicitly configured
                        if s.starts_with("={{") {
                            redacted.insert(key.clone(), val.clone());
                        } else if s.is_empty() {
                            redacted.insert(
                                key.clone(),
                                serde_json::Value::String(CREDENTIAL_EMPTY_VALUE.to_string()),
                            );
                        } else {
                            redacted.insert(
                                key.clone(),
                                serde_json::Value::String(CREDENTIAL_BLANKING_VALUE.to_string()),
                            );
                        }
                    }
                    serde_json::Value::Object(o) if o.is_empty() => {
                        redacted.insert(
                            key.clone(),
                            serde_json::Value::String(CREDENTIAL_EMPTY_VALUE.to_string()),
                        );
                    }
                    _ => {
                        redacted.insert(
                            key.clone(),
                            serde_json::Value::String(CREDENTIAL_BLANKING_VALUE.to_string()),
                        );
                    }
                }
            } else {
                redacted.insert(key.clone(), val.clone());
            }
        }

        serde_json::Value::Object(redacted)
    }

    /// Unredact incoming payload on update: restore blanked marker values from stored plaintext.
    pub fn unredact(
        updated: &serde_json::Value,
        stored_plaintext: &serde_json::Value,
    ) -> serde_json::Value {
        let (serde_json::Value::Object(updated_map), serde_json::Value::Object(stored_map)) =
            (updated, stored_plaintext)
        else {
            return updated.clone();
        };

        let mut result = updated_map.clone();
        for (key, val) in updated_map {
            if let serde_json::Value::String(s) = val {
                if s == CREDENTIAL_BLANKING_VALUE || s == CREDENTIAL_EMPTY_VALUE {
                    if let Some(original_val) = stored_map.get(key) {
                        result.insert(key.clone(), original_val.clone());
                    }
                }
            }
        }

        serde_json::Value::Object(result)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct PropertyTypeOptions {
    #[serde(default)]
    pub password: bool,
    #[serde(default, rename = "multipleValues")]
    pub multiple_values: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CredentialPropertyDescriptor {
    pub name: String,
    #[serde(default, rename = "displayName")]
    pub display_name: String,
    pub r#type: String,
    #[serde(default, rename = "typeOptions")]
    pub type_options: Option<PropertyTypeOptions>,
    #[serde(default)]
    pub default: Option<serde_json::Value>,
    #[serde(default)]
    pub required: bool,
    pub description: Option<String>,
}

impl CredentialPropertyDescriptor {
    pub fn new_password(name: impl Into<String>, display_name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            display_name: display_name.into(),
            r#type: "string".to_string(),
            type_options: Some(PropertyTypeOptions {
                password: true,
                multiple_values: false,
            }),
            default: None,
            required: true,
            description: None,
        }
    }

    pub fn new_plain(name: impl Into<String>, display_name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            display_name: display_name.into(),
            r#type: "string".to_string(),
            type_options: None,
            default: None,
            required: false,
            description: None,
        }
    }

    pub fn is_password(&self) -> bool {
        self.r#type == "password"
            || self
                .type_options
                .as_ref()
                .map(|opt| opt.password)
                .unwrap_or(false)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct CredentialTypeDescriptor {
    pub name: String,
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(default)]
    pub extends: Vec<String>,
    #[serde(default)]
    pub properties: Vec<CredentialPropertyDescriptor>,
}

impl CredentialTypeDescriptor {
    pub fn new(name: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            display_name: None,
            extends: Vec::new(),
            properties: Vec::new(),
        }
    }

    pub fn with_property(mut self, prop: CredentialPropertyDescriptor) -> Self {
        self.properties.push(prop);
        self
    }

    pub fn is_secret_field(&self, field_name: &str) -> bool {
        if field_name == "oauthTokenData" || field_name == "csrfSecret" {
            return true;
        }

        if let Some(prop) = self.properties.iter().find(|p| p.name == field_name) {
            return prop.is_password();
        }

        false
    }

    pub fn secret_field_names(&self) -> HashSet<String> {
        let mut set = HashSet::new();
        set.insert("oauthTokenData".to_string());
        set.insert("csrfSecret".to_string());
        for prop in &self.properties {
            if prop.is_password() {
                set.insert(prop.name.clone());
            }
        }
        set
    }
}

/// Status of credential key rotation operation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum KeyRotationStatus {
    Idle,
    InProgress {
        from_key_ref: String,
        to_key_ref: String,
        started_at: DateTime<Utc>,
    },
    Completed {
        retired_key_ref: Option<String>,
        completed_at: DateTime<Utc>,
    },
    Aborted {
        rolled_back_to: String,
        aborted_at: DateTime<Utc>,
    },
}

/// State tracking for zero-downtime key rotation across credentials.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct KeyRotationState {
    pub current_key_ref: String,
    pub previous_key_ref: Option<String>,
    pub status: KeyRotationStatus,
    pub total_credentials: usize,
    pub rotated_credentials: usize,
    pub pending_credentials: usize,
}

impl KeyRotationState {
    pub fn new(current_key_ref: impl Into<String>) -> Self {
        Self {
            current_key_ref: current_key_ref.into(),
            previous_key_ref: None,
            status: KeyRotationStatus::Idle,
            total_credentials: 0,
            rotated_credentials: 0,
            pending_credentials: 0,
        }
    }

    pub fn is_in_progress(&self) -> bool {
        matches!(self.status, KeyRotationStatus::InProgress { .. })
    }

    pub fn is_completed(&self) -> bool {
        matches!(self.status, KeyRotationStatus::Completed { .. })
    }

    pub fn progress_percentage(&self) -> f32 {
        if self.total_credentials == 0 {
            100.0
        } else {
            (self.rotated_credentials as f32 / self.total_credentials as f32) * 100.0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypted_payload_serialization_roundtrip() {
        let payload = EncryptedPayload::new("dGVzdC1pdi0xMg==", "Y2lwaGVydGV4dC1kYXRh", "YXV0aC10YWctMTY=");
        let json_str = payload.to_json_string().unwrap();
        let parsed = EncryptedPayload::from_str_repr(&json_str).unwrap();
        assert_eq!(payload, parsed);

        // Also test colon-separated format
        let colon = "iv-b64:ct-b64:tag-b64";
        let parsed_colon = EncryptedPayload::from_str_repr(colon).unwrap();
        assert_eq!(parsed_colon.iv, "iv-b64");
        assert_eq!(parsed_colon.ciphertext, "ct-b64");
        assert_eq!(parsed_colon.auth_tag, "tag-b64");
    }

    #[test]
    fn test_credential_entity_payload_interaction() {
        let payload = EncryptedPayload::new("iv123", "ct456", "tag789");
        let mut entity = CredentialEntity::with_payload("c1", "My Credential", "httpHeaderAuth", &payload).unwrap();

        assert_eq!(entity.iv().unwrap(), "iv123");
        assert_eq!(entity.ciphertext().unwrap(), "ct456");
        assert_eq!(entity.auth_tag().unwrap(), "tag789");

        let updated_payload = EncryptedPayload::new("new-iv", "new-ct", "new-tag");
        entity.set_encrypted_payload(&updated_payload).unwrap();
        assert_eq!(entity.ciphertext().unwrap(), "new-ct");
    }

    #[test]
    fn test_redaction_and_unredaction() {
        let desc = CredentialTypeDescriptor::new("httpHeaderAuth")
            .with_property(CredentialPropertyDescriptor::new_plain("name", "Header Name"))
            .with_property(CredentialPropertyDescriptor::new_password("value", "Header Value"));

        let plain = serde_json::json!({
            "name": "Authorization",
            "value": "Bearer secret-token-xyz"
        });

        let cred = DecryptedCredential::new("c1", "Test", "httpHeaderAuth", plain.clone());
        let redacted = cred.redact(Some(&desc));

        assert_eq!(redacted["name"], "Authorization");
        assert_eq!(redacted["value"], CREDENTIAL_BLANKING_VALUE);

        // Client echoes back redacted data during PATCH
        let incoming_patch = serde_json::json!({
            "name": "X-Custom-Auth",
            "value": CREDENTIAL_BLANKING_VALUE
        });

        let restored = DecryptedCredential::unredact(&incoming_patch, &plain);
        assert_eq!(restored["name"], "X-Custom-Auth");
        assert_eq!(restored["value"], "Bearer secret-token-xyz");
    }
}
