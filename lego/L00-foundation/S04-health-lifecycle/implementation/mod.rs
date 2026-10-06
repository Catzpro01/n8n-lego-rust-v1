//! Implementation of L00.S04 Health and Lifecycle
//! Tracks component liveness, degradation, and enforces quarantine isolation.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComponentHealthStatus {
    Healthy,
    Degraded,
    Quarantined,
    Terminated,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ComponentHealthRecord {
    pub component_id: String,
    pub status: ComponentHealthStatus,
    pub consecutive_failures: u32,
    pub quarantine_reason: Option<String>,
}

#[derive(Debug, Default)]
pub struct LifecycleManager {
    records: RwLock<HashMap<String, ComponentHealthRecord>>,
}

impl LifecycleManager {
    pub fn new() -> Self {
        Self {
            records: RwLock::new(HashMap::new()),
        }
    }

    /// Records heartbeat result. If failures exceed threshold (e.g. 3), auto-degrades component.
    pub fn record_heartbeat(&self, component_id: &str, is_ok: bool) {
        let mut map = match self.records.write() {
            Ok(m) => m,
            Err(_) => return,
        };

        let rec = map.entry(component_id.to_string()).or_insert_with(|| ComponentHealthRecord {
            component_id: component_id.to_string(),
            status: ComponentHealthStatus::Healthy,
            consecutive_failures: 0,
            quarantine_reason: None,
        });

        // Don't auto-revive quarantined or terminated components without manual intervention
        if rec.status == ComponentHealthStatus::Quarantined || rec.status == ComponentHealthStatus::Terminated {
            return;
        }

        if is_ok {
            rec.consecutive_failures = 0;
            rec.status = ComponentHealthStatus::Healthy;
        } else {
            rec.consecutive_failures += 1;
            if rec.consecutive_failures >= 3 {
                rec.status = ComponentHealthStatus::Degraded;
            }
        }
    }

    /// Returns the current health record of the component
    pub fn probe(&self, component_id: &str) -> Option<ComponentHealthRecord> {
        let map = self.records.read().ok()?;
        map.get(component_id).cloned()
    }

    /// Quarantines an anomalous component, isolating it from further task dispatches
    pub fn quarantine(&self, component_id: &str, reason: &str) -> Result<(), &'static str> {
        let mut map = self.records.write().map_err(|_| "Lock poisoned")?;
        let rec = map.entry(component_id.to_string()).or_insert_with(|| ComponentHealthRecord {
            component_id: component_id.to_string(),
            status: ComponentHealthStatus::Healthy,
            consecutive_failures: 0,
            quarantine_reason: None,
        });

        rec.status = ComponentHealthStatus::Quarantined;
        rec.quarantine_reason = Some(reason.to_string());
        Ok(())
    }

    /// Returns true if component is allowed to process work (not Quarantined or Terminated)
    pub fn is_runnable(&self, component_id: &str) -> bool {
        let map = match self.records.read() {
            Ok(m) => m,
            Err(_) => return false,
        };

        match map.get(component_id) {
            Some(rec) => rec.status == ComponentHealthStatus::Healthy || rec.status == ComponentHealthStatus::Degraded,
            None => true, // unprobed component starts runnable
        }
    }
}
