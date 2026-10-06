//! Implementation of L00.S02 Runtime Registry
//! Provides dynamic registry lookup and registration for Sub-LEGOs and ports.

use n8n_port_contract::{PortDeclarations, SubLegoMetadata};
use std::collections::HashMap;
use std::sync::RwLock;

/// Thread-safe in-process Runtime Registry Manager
#[derive(Debug, Default)]
pub struct RuntimeRegistryManager {
    sublegos: RwLock<HashMap<String, SubLegoMetadata>>,
    port_providers: RwLock<HashMap<String, String>>, // port_id -> sublego_id
}

impl RuntimeRegistryManager {
    pub fn new() -> Self {
        Self {
            sublegos: RwLock::new(HashMap::new()),
            port_providers: RwLock::new(HashMap::new()),
        }
    }

    /// Registers a new Sub-LEGO. Enforces uniqueness of Sub-LEGO ID and provided ports.
    pub fn register(&self, metadata: SubLegoMetadata) -> Result<(), &'static str> {
        let mut sublegos = self.sublegos.write().map_err(|_| "Lock poisoned")?;
        let mut port_providers = self.port_providers.write().map_err(|_| "Lock poisoned")?;

        if sublegos.contains_key(&metadata.id) {
            return Err("Sub-LEGO ID already registered");
        }

        // Check duplicate port claims
        for port in &metadata.ports.provided {
            if let Some(existing_provider) = port_providers.get(port) {
                if existing_provider != &metadata.id {
                    return Err("Port ID already claimed by another Sub-LEGO");
                }
            }
        }

        // Index provided ports
        for port in &metadata.ports.provided {
            port_providers.insert(port.clone(), metadata.id.clone());
        }

        sublegos.insert(metadata.id.clone(), metadata);
        Ok(())
    }

    /// Looks up a Sub-LEGO by its unique ID (e.g., "L00.S01")
    pub fn lookup_sublego(&self, id: &str) -> Option<SubLegoMetadata> {
        let sublegos = self.sublegos.read().ok()?;
        sublegos.get(id).cloned()
    }

    /// Finds the provider Sub-LEGO ID for a given port ID
    pub fn lookup_port_provider(&self, port_id: &str) -> Option<String> {
        let port_providers = self.port_providers.read().ok()?;
        port_providers.get(port_id).cloned()
    }

    /// Returns the total count of registered Sub-LEGOs
    pub fn count(&self) -> usize {
        self.sublegos.read().map(|s| s.len()).unwrap_or(0)
    }
}
