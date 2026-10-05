use std::fmt;
use zeroize::{Zeroize, ZeroizeOnDrop};
use sha2::{Digest, Sha256};
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use base64::Engine;
use crate::types::CredentialsError;

/// 32-byte secret key with guaranteed zeroization on drop.
/// Key material is never printed in Debug or Display implementations.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretKey {
    bytes: [u8; 32],
}

impl SecretKey {
    /// Create a secret key from exact 32 bytes.
    pub fn new(bytes: [u8; 32]) -> Self {
        Self { bytes }
    }

    /// Create a secret key from a slice, returning an error if length != 32.
    pub fn from_slice(slice: &[u8]) -> Result<Self, CredentialsError> {
        if slice.len() != 32 {
            return Err(CredentialsError::InvalidKeyLength(slice.len()));
        }
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(slice);
        Ok(Self { bytes })
    }

    /// Derive a 32-byte secret key from an arbitrary passphrase using SHA-256.
    pub fn from_passphrase(passphrase: &str) -> Self {
        let hash = Sha256::digest(passphrase.as_bytes());
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&hash);
        Self { bytes }
    }

    /// Parse a base64 encoded 32-byte key.
    pub fn from_base64(encoded: &str) -> Result<Self, CredentialsError> {
        let decoded = BASE64_STANDARD
            .decode(encoded.trim())
            .map_err(|e| CredentialsError::CryptoError(format!("Invalid base64 key: {e}")))?;
        Self::from_slice(&decoded)
    }

    /// Generate a fresh cryptographically secure random 32-byte key.
    pub fn generate() -> Result<Self, CredentialsError> {
        let mut bytes = [0u8; 32];
        getrandom::getrandom(&mut bytes)
            .map_err(|e| CredentialsError::CryptoError(format!("OS RNG failed: {e}")))?;
        Ok(Self { bytes })
    }

    /// Expose the underlying 32-byte slice for crypto operations.
    #[inline]
    pub fn expose_secret(&self) -> &[u8; 32] {
        &self.bytes
    }

    /// Encode key bytes as base64 string.
    pub fn to_base64(&self) -> String {
        BASE64_STANDARD.encode(&self.bytes)
    }
}

impl fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKey([REDACTED])")
    }
}

impl fmt::Display for SecretKey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretKey([REDACTED])")
    }
}

impl PartialEq for SecretKey {
    fn eq(&self, other: &Self) -> bool {
        // Constant-time comparison
        let mut diff = 0u8;
        for (a, b) in self.bytes.iter().zip(other.bytes.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }
}

impl Eq for SecretKey {}

/// Arbitrary-length byte vector that zeroizes memory on drop.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct SecretBytes {
    bytes: Vec<u8>,
}

impl SecretBytes {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self { bytes }
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.bytes
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("SecretBytes([REDACTED])")
    }
}

impl From<Vec<u8>> for SecretBytes {
    fn from(bytes: Vec<u8>) -> Self {
        Self::new(bytes)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_secret_key_creation_and_redaction() {
        let raw = [42u8; 32];
        let key = SecretKey::new(raw);
        assert_eq!(key.expose_secret(), &raw);

        // Verify Debug and Display redact key material
        let debug_str = format!("{key:?}");
        let display_str = format!("{key}");
        assert_eq!(debug_str, "SecretKey([REDACTED])");
        assert_eq!(display_str, "SecretKey([REDACTED])");
        assert!(!debug_str.contains("42"));
    }

    #[test]
    fn test_secret_key_from_passphrase() {
        let key1 = SecretKey::from_passphrase("n8n-master-password-123");
        let key2 = SecretKey::from_passphrase("n8n-master-password-123");
        let key3 = SecretKey::from_passphrase("different-password");

        assert_eq!(key1, key2);
        assert_ne!(key1, key3);
    }

    #[test]
    fn test_secret_key_base64_roundtrip() {
        let key = SecretKey::generate().expect("Failed to generate key");
        let b64 = key.to_base64();
        let restored = SecretKey::from_base64(&b64).expect("Failed to restore key");
        assert_eq!(key, restored);
    }

    #[test]
    fn test_invalid_key_length() {
        let short = [1u8; 16];
        let res = SecretKey::from_slice(&short);
        assert!(res.is_err());
    }
}
