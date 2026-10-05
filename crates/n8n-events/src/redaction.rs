use crate::types::EventEnvelope;
use std::collections::HashSet;

/// Default replacement mask for redacted values.
pub const DEFAULT_REDACTION_MASK: &str = "[REDACTED]";

/// Sanitizer/Redactor for removing PII, passwords, API tokens, and credentials.
#[derive(Debug, Clone)]
pub struct Redactor {
    mask: String,
    sensitive_keys: HashSet<String>,
}

impl Default for Redactor {
    fn default() -> Self {
        Self::new()
    }
}

impl Redactor {
    /// Creates a new Redactor initialized with standard sensitive key names.
    pub fn new() -> Self {
        let default_keys = vec![
            "password",
            "passwd",
            "pass",
            "secret",
            "client_secret",
            "webhook_secret",
            "app_secret",
            "token",
            "access_token",
            "refresh_token",
            "api_token",
            "id_token",
            "bearer_token",
            "api_key",
            "apikey",
            "key",
            "private_key",
            "credential",
            "credentials",
            "auth",
            "authorization",
            "authenticity_token",
            "cookie",
            "cookies",
            "set-cookie",
            "session",
            "session_id",
            "session_token",
            "x-api-key",
            "jwt",
            "pin",
            "ssn",
            "credit_card",
            "cvv",
        ];

        let mut sensitive_keys = HashSet::new();
        for k in default_keys {
            sensitive_keys.insert(k.to_ascii_lowercase());
        }

        Self {
            mask: DEFAULT_REDACTION_MASK.to_string(),
            sensitive_keys,
        }
    }

    /// Creates a Redactor with a custom mask string.
    pub fn with_mask(mask: impl Into<String>) -> Self {
        let mut r = Self::new();
        r.mask = mask.into();
        r
    }

    /// Adds additional sensitive keys to the redactor.
    pub fn add_sensitive_key(&mut self, key: impl AsRef<str>) {
        self.sensitive_keys
            .insert(key.as_ref().to_ascii_lowercase());
    }

    /// Adds multiple sensitive keys to the redactor.
    pub fn with_additional_keys(mut self, keys: &[&str]) -> Self {
        for k in keys {
            self.add_sensitive_key(k);
        }
        self
    }

    /// Checks if a JSON object field key is sensitive.
    pub fn is_sensitive_key(&self, key: &str) -> bool {
        let lower = key.to_ascii_lowercase();
        // Exact match against sensitive keys set
        if self.sensitive_keys.contains(&lower) {
            return true;
        }

        // Substring checks for critical security indicators
        let critical_substrings = [
            "password",
            "passwd",
            "secret",
            "private_key",
            "credential",
            "apikey",
            "api_key",
            "access_token",
            "refresh_token",
        ];

        for sub in critical_substrings {
            if lower.contains(sub) {
                return true;
            }
        }

        // Token or Auth key heuristics
        if (lower.ends_with("token") || lower.starts_with("token_"))
            && !lower.contains("tokenizer")
        {
            return true;
        }

        if lower == "authorization" || lower == "proxy-authorization" {
            return true;
        }

        false
    }

    /// Redacts string contents that match known secret patterns
    /// such as Bearer tokens, private key blocks, or JWTs.
    pub fn redact_string(&self, text: &str) -> String {
        let mut result = text.to_string();

        // 1. Redact Private Key blocks
        if result.contains("BEGIN ") && result.contains("PRIVATE KEY") {
            if let Some(start_idx) = result.find("-----BEGIN") {
                if let Some(end_marker_idx) = result.find("-----END") {
                    if let Some(end_nl) = result[end_marker_idx..].find("-----") {
                        let final_idx = end_marker_idx + end_nl + 5;
                        if final_idx <= result.len() && start_idx < final_idx {
                            result.replace_range(
                                start_idx..final_idx,
                                "[REDACTED_PRIVATE_KEY]",
                            );
                        }
                    }
                }
            }
        }

        // 2. Redact Bearer tokens: "Bearer <token>"
        let bearer_lower = result.to_ascii_lowercase();
        if let Some(pos) = bearer_lower.find("bearer ") {
            let token_start = pos + 7;
            let token_end = result[token_start..]
                .find(|c: char| c.is_whitespace() || c == '"' || c == ',' || c == '&')
                .map(|p| token_start + p)
                .unwrap_or(result.len());

            if token_end > token_start {
                result.replace_range(token_start..token_end, &self.mask);
            }
        }

        // 3. Redact Basic Auth URL credentials: http://user:pass@host
        if let Some(scheme_pos) = result.find("://") {
            let after_scheme = scheme_pos + 3;
            if let Some(at_pos) = result[after_scheme..].find('@') {
                let userinfo_end = after_scheme + at_pos;
                let userinfo = &result[after_scheme..userinfo_end];
                if let Some(colon_pos) = userinfo.find(':') {
                    let secret_start = after_scheme + colon_pos + 1;
                    if secret_start < userinfo_end {
                        result.replace_range(secret_start..userinfo_end, &self.mask);
                    }
                }
            }
        }

        // 4. Redact common API key prefixes (ghp_, sk-, xoxb-)
        for prefix in &["ghp_", "gho_", "sk-", "xoxb-", "xoxp-"] {
            if let Some(idx) = result.find(prefix) {
                let key_start = idx + prefix.len();
                let key_end = result[key_start..]
                    .find(|c: char| !c.is_alphanumeric() && c != '_' && c != '-')
                    .map(|p| key_start + p)
                    .unwrap_or(result.len());
                if key_end > key_start {
                    result.replace_range(key_start..key_end, &self.mask);
                }
            }
        }

        result
    }

    /// Redacts a `serde_json::Value` in-place, masking sensitive object keys and secret patterns.
    pub fn redact_value(&self, value: &mut serde_json::Value) {
        match value {
            serde_json::Value::Object(map) => {
                for (k, v) in map.iter_mut() {
                    if self.is_sensitive_key(k) {
                        if v.is_object() {
                            self.redact_value(v);
                        } else if let serde_json::Value::Array(arr) = v {
                            for item in arr.iter_mut() {
                                if item.is_object() || item.is_array() {
                                    self.redact_value(item);
                                } else {
                                    *item = serde_json::Value::String(self.mask.clone());
                                }
                            }
                        } else {
                            *v = serde_json::Value::String(self.mask.clone());
                        }
                    } else {
                        self.redact_value(v);
                    }
                }
            }
            serde_json::Value::Array(arr) => {
                for item in arr.iter_mut() {
                    self.redact_value(item);
                }
            }
            serde_json::Value::String(s) => {
                *s = self.redact_string(s);
            }
            _ => {}
        }
    }

    /// Returns a new redacted copy of a `serde_json::Value`.
    pub fn redact_json(&self, value: &serde_json::Value) -> serde_json::Value {
        let mut copy = value.clone();
        self.redact_value(&mut copy);
        copy
    }

    /// Returns a redacted copy of the entire `EventEnvelope`.
    pub fn redact_envelope(&self, envelope: &EventEnvelope) -> EventEnvelope {
        let mut copy = envelope.clone();
        self.redact_value(&mut copy.payload);
        if let Some(ref mut meta) = copy.metadata {
            self.redact_value(meta);
        }
        copy
    }
}
