//! Implementation of L02.S04 Credential Broker

use n8n_port_contract::security::SecretRef;
use std::collections::HashMap;
use std::sync::RwLock;

pub struct CredentialVault {
    secrets: RwLock<HashMap<String, serde_json::Value>>,
}

impl CredentialVault {
    pub fn new() -> Self {
        Self {
            secrets: RwLock::new(HashMap::new()),
        }
    }

    pub fn store(&self, secret_id: String, secret_val: serde_json::Value) -> SecretRef {
        let mut map = self.secrets.write().unwrap();
        map.insert(secret_id.clone(), secret_val);
        SecretRef::new(secret_id, "generic_oauth", "tenant_default", "n8n_execution")
    }

    pub fn release_verified(
        &self,
        secret_ref: &SecretRef,
        audience: &str,
    ) -> Result<serde_json::Value, &'static str> {
        if secret_ref.audience != audience {
            return Err("Audience mismatch: unauthorized secret access");
        }
        let map = self.secrets.read().unwrap();
        map.get(&secret_ref.secret_id)
            .cloned()
            .ok_or("Secret not found in vault")
    }
}
