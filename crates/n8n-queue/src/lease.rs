use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::Duration;
use thiserror::Error;

/// Error type for job lease operations.
#[derive(Debug, Error, PartialEq, Eq, Clone)]
pub enum LeaseError {
    #[error("Job '{0}' is already leased by worker '{1}'")]
    AlreadyLeased(String, String),

    #[error("Lease for job '{0}' not found")]
    NotFound(String),

    #[error("Invalid lease token for job '{0}'")]
    InvalidToken(String),

    #[error("Worker mismatch: expected '{expected}', got '{actual}'")]
    WorkerMismatch { expected: String, actual: String },

    #[error("Lease for job '{0}' has expired")]
    Expired(String),
}

/// Represents an exclusive worker lease on a job.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobLease {
    pub job_id: String,
    pub worker_id: String,
    pub token: String,
    pub acquired_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}

impl JobLease {
    /// Checks if this lease has expired at the given time.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }

    /// Remaining time on the lease, or None if expired.
    pub fn remaining_time(&self, now: DateTime<Utc>) -> Option<Duration> {
        if self.is_expired(now) {
            None
        } else {
            let diff = self.expires_at - now;
            diff.to_std().ok()
        }
    }
}

/// In-memory manager for exclusive worker job leases.
///
/// Ensures mutual exclusion across workers, supports lease heartbeats/renewal,
/// detects timeouts, and evicts dead workers.
#[derive(Debug, Default)]
pub struct JobLeaseManager {
    leases: RwLock<HashMap<String, JobLease>>,
}

impl JobLeaseManager {
    /// Creates a new empty JobLeaseManager.
    pub fn new() -> Self {
        Self {
            leases: RwLock::new(HashMap::new()),
        }
    }

    /// Acquires an exclusive lease on a job for the given worker.
    ///
    /// If an existing lease is active and not expired, returns `LeaseError::AlreadyLeased`.
    /// If an existing lease was expired, it is automatically overridden.
    pub fn acquire_lease(
        &self,
        job_id: &str,
        worker_id: &str,
        ttl: Duration,
    ) -> Result<JobLease, LeaseError> {
        let mut map = self.leases.write().unwrap();
        let now = Utc::now();

        if let Some(existing) = map.get(job_id) {
            if !existing.is_expired(now) {
                return Err(LeaseError::AlreadyLeased(
                    job_id.to_string(),
                    existing.worker_id.clone(),
                ));
            }
        }

        let token = uuid::Uuid::new_v4().to_string();
        let chrono_ttl = ChronoDuration::from_std(ttl).unwrap_or(ChronoDuration::seconds(30));
        let expires_at = now + chrono_ttl;

        let lease = JobLease {
            job_id: job_id.to_string(),
            worker_id: worker_id.to_string(),
            token,
            acquired_at: now,
            expires_at,
        };

        map.insert(job_id.to_string(), lease.clone());
        Ok(lease)
    }

    /// Renews an existing lease by extending its expiration time.
    pub fn renew_lease(
        &self,
        job_id: &str,
        worker_id: &str,
        token: &str,
        extension: Duration,
    ) -> Result<JobLease, LeaseError> {
        let mut map = self.leases.write().unwrap();
        let now = Utc::now();

        let lease = map.get_mut(job_id).ok_or_else(|| LeaseError::NotFound(job_id.to_string()))?;

        if lease.worker_id != worker_id {
            return Err(LeaseError::WorkerMismatch {
                expected: lease.worker_id.clone(),
                actual: worker_id.to_string(),
            });
        }

        if lease.token != token {
            return Err(LeaseError::InvalidToken(job_id.to_string()));
        }

        if lease.is_expired(now) {
            return Err(LeaseError::Expired(job_id.to_string()));
        }

        let chrono_ext = ChronoDuration::from_std(extension).unwrap_or(ChronoDuration::seconds(30));
        lease.expires_at = now + chrono_ext;

        Ok(lease.clone())
    }

    /// Releases an existing lease voluntarily when a worker finishes or cancels.
    pub fn release_lease(
        &self,
        job_id: &str,
        worker_id: &str,
        token: &str,
    ) -> Result<JobLease, LeaseError> {
        let mut map = self.leases.write().unwrap();

        let lease = map.get(job_id).ok_or_else(|| LeaseError::NotFound(job_id.to_string()))?;

        if lease.worker_id != worker_id {
            return Err(LeaseError::WorkerMismatch {
                expected: lease.worker_id.clone(),
                actual: worker_id.to_string(),
            });
        }

        if lease.token != token {
            return Err(LeaseError::InvalidToken(job_id.to_string()));
        }

        let removed = map.remove(job_id).unwrap();
        Ok(removed)
    }

    /// Forcibly releases a lease without checking tokens (e.g. administrative abort).
    pub fn force_release(&self, job_id: &str) -> Option<JobLease> {
        let mut map = self.leases.write().unwrap();
        map.remove(job_id)
    }

    /// Retrieves the current lease for a job, if present.
    pub fn get_lease(&self, job_id: &str) -> Option<JobLease> {
        let map = self.leases.read().unwrap();
        map.get(job_id).cloned()
    }

    /// Checks if a job currently has a non-expired lease.
    pub fn is_leased(&self, job_id: &str) -> bool {
        let map = self.leases.read().unwrap();
        let now = Utc::now();
        map.get(job_id).map(|l| !l.is_expired(now)).unwrap_or(false)
    }

    /// Evicts all expired leases and returns them.
    pub fn evict_expired(&self) -> Vec<JobLease> {
        let mut map = self.leases.write().unwrap();
        let now = Utc::now();

        let expired_ids: Vec<String> = map
            .iter()
            .filter(|(_, lease)| lease.is_expired(now))
            .map(|(id, _)| id.clone())
            .collect();

        let mut evicted = Vec::new();
        for id in expired_ids {
            if let Some(lease) = map.remove(&id) {
                evicted.push(lease);
            }
        }
        evicted
    }

    /// Evicts all leases held by a specific worker (dead worker eviction).
    pub fn evict_worker(&self, worker_id: &str) -> Vec<JobLease> {
        let mut map = self.leases.write().unwrap();

        let worker_job_ids: Vec<String> = map
            .iter()
            .filter(|(_, lease)| lease.worker_id == worker_id)
            .map(|(id, _)| id.clone())
            .collect();

        let mut evicted = Vec::new();
        for id in worker_job_ids {
            if let Some(lease) = map.remove(&id) {
                evicted.push(lease);
            }
        }
        evicted
    }

    /// Returns all currently active (non-expired) leases.
    pub fn active_leases(&self) -> Vec<JobLease> {
        let map = self.leases.read().unwrap();
        let now = Utc::now();
        map.values().filter(|l| !l.is_expired(now)).cloned().collect()
    }

    /// Total count of tracked leases (including un-evicted expired ones).
    pub fn count(&self) -> usize {
        let map = self.leases.read().unwrap();
        map.len()
    }
}
