//! L09.S06 — Frontend migration/decommission plan
//!
//! Provides the milestone ledger, route audit engine, and retirement verification
//! for migrating legacy frontend/compatibility surfaces to native Rust endpoints.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DecommissionStatus {
    Planned,
    InFlight,
    Decommissioned,
    Archived,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SurfaceMigrationMilestone {
    pub milestone_id: String,
    pub surface_name: String,
    pub legacy_endpoint: String,
    pub native_replacement: String,
    pub status: DecommissionStatus,
    pub deprecation_version: String,
    pub sunset_version: String,
    pub traffic_shifted_percent: u8,
    pub last_audited_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DecommissionAuditReport {
    pub total_surfaces: usize,
    pub planned_count: usize,
    pub in_flight_count: usize,
    pub decommissioned_count: usize,
    pub archived_count: usize,
    pub overall_parity_percent: f64,
}

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum DecommissionError {
    #[error("Empty milestone ID or surface name")]
    EmptyIdentifier,
    #[error("Invalid traffic percentage: {0} (must be 0..=100)")]
    InvalidTrafficPercent(u8),
    #[error("Milestone not found: {0}")]
    NotFound(String),
    #[error("Invalid status transition from {from:?} to {to:?}")]
    InvalidTransition { from: DecommissionStatus, to: DecommissionStatus },
}

pub struct FrontendDecommissionService {
    milestones: Arc<RwLock<HashMap<String, SurfaceMigrationMilestone>>>,
}

impl Default for FrontendDecommissionService {
    fn default() -> Self {
        Self::new()
    }
}

impl FrontendDecommissionService {
    pub fn new() -> Self {
        Self {
            milestones: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Registers a new frontend decommission milestone
    pub fn register_milestone(
        &self,
        milestone: SurfaceMigrationMilestone,
    ) -> Result<SurfaceMigrationMilestone, DecommissionError> {
        let mid = milestone.milestone_id.trim();
        let sname = milestone.surface_name.trim();
        if mid.is_empty() || sname.is_empty() {
            return Err(DecommissionError::EmptyIdentifier);
        }

        if milestone.traffic_shifted_percent > 100 {
            return Err(DecommissionError::InvalidTrafficPercent(milestone.traffic_shifted_percent));
        }

        let mut map = self.milestones.write().unwrap();
        map.insert(mid.to_string(), milestone.clone());
        Ok(milestone)
    }

    /// Updates traffic shift percentage and transitions status safely
    pub fn update_progress(
        &self,
        milestone_id: &str,
        traffic_shifted: u8,
        now_ms: u64,
    ) -> Result<SurfaceMigrationMilestone, DecommissionError> {
        let mid = milestone_id.trim();
        if mid.is_empty() {
            return Err(DecommissionError::EmptyIdentifier);
        }
        if traffic_shifted > 100 {
            return Err(DecommissionError::InvalidTrafficPercent(traffic_shifted));
        }

        let mut map = self.milestones.write().unwrap();
        let m = map.get_mut(mid).ok_or_else(|| DecommissionError::NotFound(mid.to_string()))?;

        m.traffic_shifted_percent = traffic_shifted;
        m.last_audited_ms = now_ms;

        if traffic_shifted == 100 && (m.status == DecommissionStatus::InFlight || m.status == DecommissionStatus::Planned) {
            m.status = DecommissionStatus::Decommissioned;
        } else if traffic_shifted > 0 && m.status == DecommissionStatus::Planned {
            m.status = DecommissionStatus::InFlight;
        }

        Ok(m.clone())
    }

    /// Generates audit report of all tracked decommission milestones
    pub fn audit_decommission(&self) -> DecommissionAuditReport {
        let map = self.milestones.read().unwrap();
        let total = map.len();

        let mut planned = 0;
        let mut in_flight = 0;
        let mut decommissioned = 0;
        let mut archived = 0;
        let mut total_traffic = 0usize;

        for m in map.values() {
            match m.status {
                DecommissionStatus::Planned => planned += 1,
                DecommissionStatus::InFlight => in_flight += 1,
                DecommissionStatus::Decommissioned => decommissioned += 1,
                DecommissionStatus::Archived => archived += 1,
            }
            total_traffic += m.traffic_shifted_percent as usize;
        }

        let parity = if total > 0 {
            total_traffic as f64 / (total as f64)
        } else {
            100.0
        };

        DecommissionAuditReport {
            total_surfaces: total,
            planned_count: planned,
            in_flight_count: in_flight,
            decommissioned_count: decommissioned,
            archived_count: archived,
            overall_parity_percent: parity,
        }
    }
}

#[cfg(test)]
#[path = "../tests/decommission_test.rs"]
mod tests;
