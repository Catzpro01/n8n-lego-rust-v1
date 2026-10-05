use crate::job::{
    JobDescriptor, JobPriority, JobResult, JobState, QUEUE_NAME,
};
use crate::lease::{JobLease, JobLeaseManager, LeaseError};
use chrono::{Duration as ChronoDuration, Utc};
use serde::{Deserialize, Serialize};
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::future::Future;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;
use thiserror::Error;
use tokio::sync::{watch, OwnedSemaphorePermit, Semaphore};
use tokio::task::JoinHandle;

/// Errors produced during queue operations.
#[derive(Debug, Error)]
pub enum QueueError {
    #[error("Job validation failed: {0}")]
    ValidationError(String),

    #[error("Job '{0}' not found")]
    JobNotFound(String),

    #[error("Invalid state transition for job '{job_id}': from {from:?} to {to:?}")]
    InvalidStateTransition {
        job_id: String,
        from: JobState,
        to: JobState,
    },

    #[error("Concurrency ceiling of {0} reached")]
    ConcurrencyLimitReached(usize),

    #[error("Lease error: {0}")]
    LeaseError(#[from] LeaseError),

    #[error("Queue engine has stopped")]
    QueueStopped,
}

/// Retry policy with exponential backoff configuration.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    pub max_attempts: u32,
    pub initial_interval: Duration,
    pub backoff_multiplier: f64,
    pub max_interval: Option<Duration>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 3,
            initial_interval: Duration::from_millis(200),
            backoff_multiplier: 2.0,
            max_interval: Some(Duration::from_secs(60)),
        }
    }
}

impl RetryPolicy {
    pub fn no_retry() -> Self {
        Self {
            max_attempts: 1,
            initial_interval: Duration::ZERO,
            backoff_multiplier: 1.0,
            max_interval: None,
        }
    }

    /// Computes backoff delay for the given attempt number.
    ///
    /// For attempt 1, returns initial_interval.
    /// For attempt 2, returns initial_interval * multiplier.
    pub fn compute_delay(&self, attempts_made: u32) -> Duration {
        if attempts_made == 0 || self.max_attempts <= 1 {
            return Duration::ZERO;
        }
        let exponent = (attempts_made.saturating_sub(1)) as f64;
        let factor = self.backoff_multiplier.powf(exponent);
        let delay_ms = (self.initial_interval.as_millis() as f64 * factor) as u64;
        let computed = Duration::from_millis(delay_ms);
        if let Some(max) = self.max_interval {
            computed.min(max)
        } else {
            computed
        }
    }
}

/// Internal queue entry for ordering waiting jobs.
#[derive(Debug, Clone, PartialEq, Eq)]
struct QueueEntry {
    job_id: String,
    priority: JobPriority,
    sequence: u64,
}

impl Ord for QueueEntry {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Higher priority weight first
        self.priority
            .cmp(&other.priority)
            // If equal priority, lower sequence first (FIFO)
            .then_with(|| other.sequence.cmp(&self.sequence))
    }
}

impl PartialOrd for QueueEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Metrics summary for the queue (Invariant Q14).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QueueMetrics {
    pub queue_name: String,
    pub waiting: usize,
    pub active: usize,
    pub completed: usize,
    pub failed: usize,
    pub delayed: usize,
    pub total: usize,
}

struct InnerQueueState {
    jobs: HashMap<String, JobDescriptor>,
    waiting_heap: BinaryHeap<QueueEntry>,
    delayed_job_ids: HashSet<String>,
    active_job_ids: HashSet<String>,
    completed_counter: usize,
    failed_counter: usize,
}

/// In-memory concurrency queue engine with priority scheduling,
/// concurrency ceiling, retry policy, and worker dispatching.
pub struct JobQueueEngine {
    name: String,
    max_concurrency: usize,
    lease_ttl: Duration,
    retry_policy: RetryPolicy,
    state: RwLock<InnerQueueState>,
    lease_manager: JobLeaseManager,
    semaphore: Arc<Semaphore>,
    active_permits: Mutex<HashMap<String, OwnedSemaphorePermit>>,
    sequence_counter: AtomicU64,
    is_running: AtomicBool,
}

impl JobQueueEngine {
    /// Creates a new JobQueueEngine with specified concurrency ceiling and defaults.
    pub fn new(max_concurrency: usize) -> Arc<Self> {
        Self::with_options(
            QUEUE_NAME,
            max_concurrency,
            Duration::from_secs(30),
            RetryPolicy::default(),
        )
    }

    /// Creates a new JobQueueEngine with full configuration options.
    pub fn with_options(
        name: impl Into<String>,
        max_concurrency: usize,
        lease_ttl: Duration,
        retry_policy: RetryPolicy,
    ) -> Arc<Self> {
        let max_concurrency = max_concurrency.max(1);
        Arc::new(Self {
            name: name.into(),
            max_concurrency,
            lease_ttl,
            retry_policy,
            state: RwLock::new(InnerQueueState {
                jobs: HashMap::new(),
                waiting_heap: BinaryHeap::new(),
                delayed_job_ids: HashSet::new(),
                active_job_ids: HashSet::new(),
                completed_counter: 0,
                failed_counter: 0,
            }),
            lease_manager: JobLeaseManager::new(),
            semaphore: Arc::new(Semaphore::new(max_concurrency)),
            active_permits: Mutex::new(HashMap::new()),
            sequence_counter: AtomicU64::new(0),
            is_running: AtomicBool::new(true),
        })
    }

    /// Returns queue name.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Returns the concurrency ceiling.
    pub fn max_concurrency(&self) -> usize {
        self.max_concurrency
    }

    /// Returns lease TTL duration.
    pub fn lease_ttl(&self) -> Duration {
        self.lease_ttl
    }

    /// Pushes a new job into the queue.
    ///
    /// Validates job data (Invariant Q9).
    /// If job has delay or run_at in future, puts into delayed set.
    /// Otherwise pushes to priority waiting heap with FIFO sequence.
    pub fn push(&self, mut job: JobDescriptor) -> Result<String, QueueError> {
        if !self.is_running.load(Ordering::SeqCst) {
            return Err(QueueError::QueueStopped);
        }

        // Q9: validate job data
        if let Err(err_msg) = job.validate() {
            return Err(QueueError::ValidationError(err_msg.to_string()));
        }

        let job_id = job.id.clone();
        let now = Utc::now();

        let mut state = self.state.write().unwrap();

        if job.is_delayed(now) || job.state == JobState::Delayed {
            job.state = JobState::Delayed;
            state.delayed_job_ids.insert(job_id.clone());
        } else {
            job.state = JobState::Waiting;
            let seq = self.sequence_counter.fetch_add(1, Ordering::Relaxed);
            state.waiting_heap.push(QueueEntry {
                job_id: job_id.clone(),
                priority: job.priority,
                sequence: seq,
            });
        }

        state.jobs.insert(job_id.clone(), job);
        Ok(job_id)
    }

    /// Fetches a copy of a job by ID.
    pub fn get_job(&self, job_id: &str) -> Option<JobDescriptor> {
        let state = self.state.read().unwrap();
        state.jobs.get(job_id).cloned()
    }

    /// Checks and promotes delayed jobs whose `run_at` has elapsed to the waiting heap.
    pub fn promote_delayed_jobs(&self) -> usize {
        let mut state = self.state.write().unwrap();
        let now = Utc::now();

        let ready_ids: Vec<String> = state
            .delayed_job_ids
            .iter()
            .filter(|id| {
                if let Some(job) = state.jobs.get(*id) {
                    !job.is_delayed(now)
                } else {
                    true
                }
            })
            .cloned()
            .collect();

        let mut promoted_count = 0;
        for id in ready_ids {
            state.delayed_job_ids.remove(&id);
            let priority = if let Some(job) = state.jobs.get_mut(&id) {
                job.state = JobState::Waiting;
                job.run_at = None;
                Some(job.priority)
            } else {
                None
            };

            if let Some(priority) = priority {
                let seq = self.sequence_counter.fetch_add(1, Ordering::Relaxed);
                state.waiting_heap.push(QueueEntry {
                    job_id: id,
                    priority,
                    sequence: seq,
                });
                promoted_count += 1;
            }
        }

        promoted_count
    }

    /// Attempts to poll the next highest-priority waiting job for a worker.
    ///
    /// Respects the concurrency ceiling: will return `Ok(None)` if maximum concurrent jobs are active.
    /// Acquires an exclusive job lease for the worker.
    pub fn poll_job(
        self: &Arc<Self>,
        worker_id: &str,
    ) -> Result<Option<JobDescriptor>, QueueError> {
        if !self.is_running.load(Ordering::SeqCst) {
            return Err(QueueError::QueueStopped);
        }

        // Try to acquire permit from concurrency semaphore
        let permit = match self.semaphore.clone().try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                // Concurrency ceiling reached
                return Ok(None);
            }
        };

        // First promote any delayed jobs
        self.promote_delayed_jobs();

        let mut state = self.state.write().unwrap();

        while let Some(entry) = state.waiting_heap.pop() {
            let is_waiting = state
                .jobs
                .get(&entry.job_id)
                .map(|j| j.state == JobState::Waiting)
                .unwrap_or(false);

            if !is_waiting {
                continue;
            }

            // Acquire exclusive lease for this worker
            let lease = match self
                .lease_manager
                .acquire_lease(&entry.job_id, worker_id, self.lease_ttl)
            {
                Ok(l) => l,
                Err(e) => {
                    drop(permit);
                    return Err(QueueError::LeaseError(e));
                }
            };

            state.active_job_ids.insert(entry.job_id.clone());

            let job_clone = if let Some(job) = state.jobs.get_mut(&entry.job_id) {
                let now = Utc::now();
                job.state = JobState::Active;
                job.worker_id = Some(worker_id.to_string());
                job.lock_token = Some(lease.token);
                job.processed_at = Some(now);
                job.attempts_made += 1;
                job.clone()
            } else {
                continue;
            };

            // Store permit so it is held until job finishes
            let mut permits = self.active_permits.lock().unwrap();
            permits.insert(entry.job_id.clone(), permit);

            return Ok(Some(job_clone));
        }

        // No waiting jobs available, permit is dropped here
        drop(permit);
        Ok(None)
    }

    /// Marks an active job as completed.
    ///
    /// Releases the worker lease and releases concurrency permit.
    pub fn complete_job(
        &self,
        job_id: &str,
        worker_id: &str,
        token: &str,
        result: JobResult,
    ) -> Result<(), QueueError> {
        // Release lease first
        self.lease_manager.release_lease(job_id, worker_id, token)?;

        // Free concurrency permit
        {
            let mut permits = self.active_permits.lock().unwrap();
            permits.remove(job_id);
        }

        let mut state = self.state.write().unwrap();
        state.active_job_ids.remove(job_id);
        state.completed_counter += 1;

        let job = state
            .jobs
            .get_mut(job_id)
            .ok_or_else(|| QueueError::JobNotFound(job_id.to_string()))?;

        job.state = JobState::Completed;
        job.result = Some(result);
        job.finished_at = Some(Utc::now());
        job.lock_token = None;

        Ok(())
    }

    /// Reports that an active job has failed.
    ///
    /// Applies retry policy with exponential backoff:
    /// - If attempts_made < max_attempts: transitions to Delayed with backoff interval.
    /// - If attempts_made >= max_attempts: transitions to Failed.
    pub fn fail_job(
        &self,
        job_id: &str,
        worker_id: &str,
        token: &str,
        error_msg: String,
    ) -> Result<JobState, QueueError> {
        // Release lease
        self.lease_manager.release_lease(job_id, worker_id, token)?;

        // Free concurrency permit
        {
            let mut permits = self.active_permits.lock().unwrap();
            permits.remove(job_id);
        }

        let mut state = self.state.write().unwrap();
        state.active_job_ids.remove(job_id);

        let (attempts_made, max_attempts) = {
            let job = state
                .jobs
                .get(job_id)
                .ok_or_else(|| QueueError::JobNotFound(job_id.to_string()))?;
            let limit = if job.max_attempts > 0 {
                job.max_attempts
            } else {
                self.retry_policy.max_attempts
            };
            (job.attempts_made, limit)
        };

        if attempts_made < max_attempts {
            // Retry with exponential backoff
            let delay = self.retry_policy.compute_delay(attempts_made);
            let chrono_delay = ChronoDuration::from_std(delay).unwrap_or(ChronoDuration::seconds(1));
            let run_at = Utc::now() + chrono_delay;

            state.delayed_job_ids.insert(job_id.to_string());

            if let Some(job) = state.jobs.get_mut(job_id) {
                job.state = JobState::Delayed;
                job.run_at = Some(run_at);
                job.error = Some(error_msg);
                job.lock_token = None;
                job.worker_id = None;
            }

            Ok(JobState::Delayed)
        } else {
            // Max attempts exhausted -> Failed
            state.failed_counter += 1;

            if let Some(job) = state.jobs.get_mut(job_id) {
                job.state = JobState::Failed;
                job.error = Some(error_msg.clone());
                job.result = Some(JobResult::err(error_msg));
                job.finished_at = Some(Utc::now());
                job.lock_token = None;
                job.worker_id = None;
            }

            Ok(JobState::Failed)
        }
    }

    /// Aborts a job regardless of its current state.
    pub fn abort_job(&self, job_id: &str) -> Result<(), QueueError> {
        self.lease_manager.force_release(job_id);

        {
            let mut permits = self.active_permits.lock().unwrap();
            permits.remove(job_id);
        }

        let mut state = self.state.write().unwrap();
        state.active_job_ids.remove(job_id);
        state.delayed_job_ids.remove(job_id);
        state.failed_counter += 1;

        let job = state
            .jobs
            .get_mut(job_id)
            .ok_or_else(|| QueueError::JobNotFound(job_id.to_string()))?;

        job.state = JobState::Failed;
        job.error = Some("Job aborted".to_string());
        job.finished_at = Some(Utc::now());
        job.lock_token = None;
        job.worker_id = None;

        Ok(())
    }

    /// Renews lease for a long-running active job.
    pub fn renew_job_lease(
        &self,
        job_id: &str,
        worker_id: &str,
        token: &str,
        extension: Duration,
    ) -> Result<JobLease, QueueError> {
        let lease = self
            .lease_manager
            .renew_lease(job_id, worker_id, token, extension)?;
        Ok(lease)
    }

    /// Evicts dead worker and recovers or fails its jobs.
    pub fn evict_dead_worker(&self, worker_id: &str) -> Vec<String> {
        let evicted_leases = self.lease_manager.evict_worker(worker_id);
        let mut affected = Vec::new();

        for lease in evicted_leases {
            let job_id = lease.job_id;
            affected.push(job_id.clone());

            {
                let mut permits = self.active_permits.lock().unwrap();
                permits.remove(&job_id);
            }

            let mut state = self.state.write().unwrap();
            state.active_job_ids.remove(&job_id);

            let (should_retry, priority) = if let Some(job) = state.jobs.get_mut(&job_id) {
                let max_attempts = job.max_attempts.max(self.retry_policy.max_attempts);
                if job.attempts_made < max_attempts {
                    job.state = JobState::Waiting;
                    job.worker_id = None;
                    job.lock_token = None;
                    (true, Some(job.priority))
                } else {
                    job.state = JobState::Failed;
                    job.error = Some("Worker died".to_string());
                    job.finished_at = Some(Utc::now());
                    job.worker_id = None;
                    job.lock_token = None;
                    (false, None)
                }
            } else {
                (false, None)
            };

            if should_retry {
                if let Some(priority) = priority {
                    let seq = self.sequence_counter.fetch_add(1, Ordering::Relaxed);
                    state.waiting_heap.push(QueueEntry {
                        job_id: job_id.clone(),
                        priority,
                        sequence: seq,
                    });
                }
            } else {
                state.failed_counter += 1;
            }
        }

        affected
    }

    /// Recovers stalled jobs whose leases have expired (Invariant Q8 / dead worker recovery).
    pub fn recover_stalled_jobs(&self) -> Vec<String> {
        let expired_leases = self.lease_manager.evict_expired();
        let mut affected = Vec::new();

        for lease in expired_leases {
            let job_id = lease.job_id;
            affected.push(job_id.clone());

            {
                let mut permits = self.active_permits.lock().unwrap();
                permits.remove(&job_id);
            }

            let mut state = self.state.write().unwrap();
            state.active_job_ids.remove(&job_id);

            let (should_retry, priority) = if let Some(job) = state.jobs.get_mut(&job_id) {
                let max_attempts = job.max_attempts.max(self.retry_policy.max_attempts);
                if job.attempts_made < max_attempts {
                    job.state = JobState::Waiting;
                    job.worker_id = None;
                    job.lock_token = None;
                    (true, Some(job.priority))
                } else {
                    job.state = JobState::Failed;
                    job.error = Some("Job stalled: lease expired".to_string());
                    job.finished_at = Some(Utc::now());
                    job.worker_id = None;
                    job.lock_token = None;
                    (false, None)
                }
            } else {
                (false, None)
            };

            if should_retry {
                if let Some(priority) = priority {
                    let seq = self.sequence_counter.fetch_add(1, Ordering::Relaxed);
                    state.waiting_heap.push(QueueEntry {
                        job_id: job_id.clone(),
                        priority,
                        sequence: seq,
                    });
                }
            } else {
                state.failed_counter += 1;
            }
        }

        affected
    }

    /// Obtains current queue metrics (Invariant Q14).
    pub fn get_metrics(&self) -> QueueMetrics {
        let state = self.state.read().unwrap();
        QueueMetrics {
            queue_name: self.name.clone(),
            waiting: state.waiting_heap.len(),
            active: state.active_job_ids.len(),
            completed: state.completed_counter,
            failed: state.failed_counter,
            delayed: state.delayed_job_ids.len(),
            total: state.jobs.len(),
        }
    }

    /// Resets completed and failed metric counters (Invariant Q14).
    pub fn reset_completed_failed_counters(&self) {
        let mut state = self.state.write().unwrap();
        state.completed_counter = 0;
        state.failed_counter = 0;
    }

    /// Stops the queue engine.
    pub fn stop(&self) {
        self.is_running.store(false, Ordering::SeqCst);
    }
}

/// Handle to a running worker task.
pub struct WorkerHandle {
    stop_tx: watch::Sender<bool>,
    join_handle: JoinHandle<()>,
}

impl WorkerHandle {
    /// Signals the worker to stop and waits for it to finish gracefully.
    pub async fn stop(self) {
        let _ = self.stop_tx.send(true);
        let _ = self.join_handle.await;
    }
}

/// Spawns a background worker on the queue engine.
pub fn spawn_worker<F, Fut>(
    queue: Arc<JobQueueEngine>,
    worker_id: String,
    poll_interval: Duration,
    handler: F,
) -> WorkerHandle
where
    F: Fn(JobDescriptor) -> Fut + Send + Sync + 'static,
    Fut: Future<Output = JobResult> + Send + 'static,
{
    let (stop_tx, mut stop_rx) = watch::channel(false);
    let handler = Arc::new(handler);

    let join_handle = tokio::spawn(async move {
        loop {
            if *stop_rx.borrow() {
                break;
            }

            match queue.poll_job(&worker_id) {
                Ok(Some(job)) => {
                    let job_id = job.id.clone();
                    let token = job.lock_token.clone().unwrap_or_default();
                    let handler_res = handler(job).await;

                    if handler_res.success {
                        let _ = queue.complete_job(&job_id, &worker_id, &token, handler_res);
                    } else {
                        let err_msg = handler_res
                            .error
                            .clone()
                            .unwrap_or_else(|| "Unknown failure".to_string());
                        let _ = queue.fail_job(&job_id, &worker_id, &token, err_msg);
                    }
                }
                Ok(None) => {
                    tokio::select! {
                        _ = stop_rx.changed() => {
                            if *stop_rx.borrow() { break; }
                        }
                        _ = tokio::time::sleep(poll_interval) => {}
                    }
                }
                Err(_) => {
                    tokio::select! {
                        _ = stop_rx.changed() => {
                            if *stop_rx.borrow() { break; }
                        }
                        _ = tokio::time::sleep(poll_interval) => {}
                    }
                }
            }
        }
    });

    WorkerHandle {
        stop_tx,
        join_handle,
    }
}
