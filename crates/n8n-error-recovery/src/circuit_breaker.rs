//! Circuit Breaker State Machine & Protection (LEGO `error-recovery`).
//!
//! Melindungi sistem dari cascading failures dengan pola Fail-Closed:
//! - State: `Closed` (normal), `Open` (tripped/fail-closed), `HalfOpen` (probing).
//! - Failure threshold & consecutive failure tracking.
//! - Cooldown window timeout untuk auto-probing.
//! - Success threshold recovery saat berada di HalfOpen.
//! - Thread-safe melalui synchronization primitives.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;
use std::time::Duration;
use thiserror::Error;

/// Status kondisi Circuit Breaker.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CircuitBreakerState {
    /// Operasi berjalan normal, request diizinkan lewat.
    Closed,
    /// Breaker tripped akibat error berulang; request ditolak seketika (Fail-Closed).
    Open,
    /// Masa pendinginan selesai; mengizinkan request uji coba terbatas untuk verifikasi recovery.
    HalfOpen,
}

/// Kesalahan yang dihasilkan oleh Circuit Breaker.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum CircuitBreakerError {
    #[error("Circuit breaker '{name}' is OPEN: requests rejected (cooldown active, retry after {retry_after_ms}ms)")]
    Open {
        name: String,
        retry_after_ms: u64,
    },
    #[error("Circuit breaker '{name}' is HALF-OPEN: trial probe concurrency limit reached")]
    HalfOpenLimitExceeded { name: String },
    #[error("Circuit breaker execution failed: {0}")]
    ExecutionFailed(String),
}

/// Konfigurasi Circuit Breaker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CircuitBreakerConfig {
    /// Ambang batas kegagalan berturut-turut sebelum breaker trip ke Open.
    pub failure_threshold: u32,
    /// Durasi pendinginan saat Open sebelum transisi ke HalfOpen (dalam milidetik).
    pub cooldown_duration_ms: u64,
    /// Jumlah keberhasilan berturut-turut di HalfOpen sebelum kembali Closed.
    pub success_threshold: u32,
    /// Kuota maksimum pemanggilan probe simultan saat HalfOpen.
    pub half_open_max_trials: u32,
}

impl Default for CircuitBreakerConfig {
    fn default() -> Self {
        Self {
            failure_threshold: 5,
            cooldown_duration_ms: 10_000,
            success_threshold: 2,
            half_open_max_trials: 1,
        }
    }
}

impl CircuitBreakerConfig {
    pub fn new(failure_threshold: u32, cooldown: Duration, success_threshold: u32) -> Self {
        Self {
            failure_threshold,
            cooldown_duration_ms: cooldown.as_millis() as u64,
            success_threshold,
            half_open_max_trials: 1,
        }
    }

    pub fn with_half_open_trials(mut self, trials: u32) -> Self {
        self.half_open_max_trials = trials.max(1);
        self
    }
}

/// Snapshot statistik performa Circuit Breaker.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CircuitBreakerStats {
    pub name: String,
    pub state: CircuitBreakerState,
    pub total_calls: u64,
    pub successful_calls: u64,
    pub failed_calls: u64,
    pub rejected_calls: u64,
    pub consecutive_failures: u32,
    pub consecutive_successes: u32,
    pub last_state_change: DateTime<Utc>,
    pub last_failure_at: Option<DateTime<Utc>>,
}

struct InnerState {
    state: CircuitBreakerState,
    consecutive_failures: u32,
    consecutive_successes: u32,
    half_open_active_trials: u32,
    last_failure_timestamp_ms: Option<u64>,
    last_state_change: DateTime<Utc>,
    last_failure_at: Option<DateTime<Utc>>,
}

/// Circuit Breaker thread-safe dengan perlindungan fail-closed.
pub struct CircuitBreaker {
    name: String,
    config: CircuitBreakerConfig,
    inner: RwLock<InnerState>,
    total_calls: AtomicU64,
    successful_calls: AtomicU64,
    failed_calls: AtomicU64,
    rejected_calls: AtomicU64,
}

impl CircuitBreaker {
    pub fn new(name: impl Into<String>, config: CircuitBreakerConfig) -> Self {
        let now = Utc::now();
        Self {
            name: name.into(),
            config,
            inner: RwLock::new(InnerState {
                state: CircuitBreakerState::Closed,
                consecutive_failures: 0,
                consecutive_successes: 0,
                half_open_active_trials: 0,
                last_failure_timestamp_ms: None,
                last_state_change: now,
                last_failure_at: None,
            }),
            total_calls: AtomicU64::new(0),
            successful_calls: AtomicU64::new(0),
            failed_calls: AtomicU64::new(0),
            rejected_calls: AtomicU64::new(0),
        }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn config(&self) -> &CircuitBreakerConfig {
        &self.config
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Memeriksa apakah operasi diizinkan berjalan.
    /// Pola Fail-Closed:
    /// - Jika Open dan cooldown belum selesai -> Error ditolak seketika.
    /// - Jika Open dan cooldown selesai -> Transisi ke HalfOpen, izinkan probe.
    /// - Jika HalfOpen dan trial quota habis -> Ditolak.
    /// - Jika Closed -> Diizinkan.
    pub fn can_execute(&self) -> Result<(), CircuitBreakerError> {
        let now = Self::now_ms();
        let mut inner = self.inner.write().unwrap();

        match inner.state {
            CircuitBreakerState::Closed => {
                self.total_calls.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
            CircuitBreakerState::Open => {
                if let Some(tripped_at) = inner.last_failure_timestamp_ms {
                    let elapsed = now.saturating_sub(tripped_at);
                    if elapsed >= self.config.cooldown_duration_ms {
                        // Cooldown selesai -> beralih ke HalfOpen
                        inner.state = CircuitBreakerState::HalfOpen;
                        inner.consecutive_successes = 0;
                        inner.half_open_active_trials = 1;
                        inner.last_state_change = Utc::now();

                        self.total_calls.fetch_add(1, Ordering::Relaxed);
                        return Ok(());
                    } else {
                        // Masih dalam masa cooldown: FAIL-CLOSED
                        self.rejected_calls.fetch_add(1, Ordering::Relaxed);
                        let remaining = self.config.cooldown_duration_ms.saturating_sub(elapsed);
                        return Err(CircuitBreakerError::Open {
                            name: self.name.clone(),
                            retry_after_ms: remaining,
                        });
                    }
                }

                // Fallback jika tidak ada timestamp
                self.rejected_calls.fetch_add(1, Ordering::Relaxed);
                Err(CircuitBreakerError::Open {
                    name: self.name.clone(),
                    retry_after_ms: self.config.cooldown_duration_ms,
                })
            }
            CircuitBreakerState::HalfOpen => {
                if inner.half_open_active_trials >= self.config.half_open_max_trials {
                    self.rejected_calls.fetch_add(1, Ordering::Relaxed);
                    return Err(CircuitBreakerError::HalfOpenLimitExceeded {
                        name: self.name.clone(),
                    });
                }
                inner.half_open_active_trials += 1;
                self.total_calls.fetch_add(1, Ordering::Relaxed);
                Ok(())
            }
        }
    }

    /// Mencatat eksekusi yang sukses.
    pub fn record_success(&self) {
        self.successful_calls.fetch_add(1, Ordering::Relaxed);
        let mut inner = self.inner.write().unwrap();

        match inner.state {
            CircuitBreakerState::Closed => {
                inner.consecutive_failures = 0;
            }
            CircuitBreakerState::HalfOpen => {
                if inner.half_open_active_trials > 0 {
                    inner.half_open_active_trials -= 1;
                }
                inner.consecutive_successes += 1;
                if inner.consecutive_successes >= self.config.success_threshold {
                    // Berhasil pulih -> beralih kembali ke Closed
                    inner.state = CircuitBreakerState::Closed;
                    inner.consecutive_failures = 0;
                    inner.consecutive_successes = 0;
                    inner.last_state_change = Utc::now();
                }
            }
            CircuitBreakerState::Open => {
                // Tidak ada aksi untuk Open
            }
        }
    }

    /// Mencatat eksekusi yang gagal.
    pub fn record_failure(&self) {
        let now_ms = Self::now_ms();
        let now_utc = Utc::now();
        self.failed_calls.fetch_add(1, Ordering::Relaxed);

        let mut inner = self.inner.write().unwrap();
        inner.last_failure_timestamp_ms = Some(now_ms);
        inner.last_failure_at = Some(now_utc);

        match inner.state {
            CircuitBreakerState::Closed => {
                inner.consecutive_failures += 1;
                if inner.consecutive_failures >= self.config.failure_threshold {
                    // Melampaui batas toleransi error -> Trip ke Open!
                    inner.state = CircuitBreakerState::Open;
                    inner.last_state_change = now_utc;
                }
            }
            CircuitBreakerState::HalfOpen => {
                // Gagal saat fase uji coba -> Langsung Trip kembali ke Open!
                if inner.half_open_active_trials > 0 {
                    inner.half_open_active_trials -= 1;
                }
                inner.state = CircuitBreakerState::Open;
                inner.consecutive_successes = 0;
                inner.last_state_change = now_utc;
            }
            CircuitBreakerState::Open => {
                // Perbarui waktu kegagalan terakhir
                inner.last_failure_timestamp_ms = Some(now_ms);
            }
        }
    }

    /// Memaksa circuit breaker menjadi Open (manual trip).
    pub fn trip(&self) {
        let now_ms = Self::now_ms();
        let now_utc = Utc::now();
        let mut inner = self.inner.write().unwrap();
        inner.state = CircuitBreakerState::Open;
        inner.last_failure_timestamp_ms = Some(now_ms);
        inner.last_failure_at = Some(now_utc);
        inner.last_state_change = now_utc;
    }

    /// Memaksa circuit breaker menjadi Closed (manual reset).
    pub fn reset(&self) {
        let now_utc = Utc::now();
        let mut inner = self.inner.write().unwrap();
        inner.state = CircuitBreakerState::Closed;
        inner.consecutive_failures = 0;
        inner.consecutive_successes = 0;
        inner.half_open_active_trials = 0;
        inner.last_failure_timestamp_ms = None;
        inner.last_state_change = now_utc;
    }

    /// Mendapatkan state terkini dari circuit breaker.
    pub fn state(&self) -> CircuitBreakerState {
        let inner = self.inner.read().unwrap();
        inner.state
    }

    /// Mendapatkan snapshot statistik eksekusi.
    pub fn stats(&self) -> CircuitBreakerStats {
        let inner = self.inner.read().unwrap();
        CircuitBreakerStats {
            name: self.name.clone(),
            state: inner.state,
            total_calls: self.total_calls.load(Ordering::Relaxed),
            successful_calls: self.successful_calls.load(Ordering::Relaxed),
            failed_calls: self.failed_calls.load(Ordering::Relaxed),
            rejected_calls: self.rejected_calls.load(Ordering::Relaxed),
            consecutive_failures: inner.consecutive_failures,
            consecutive_successes: inner.consecutive_successes,
            last_state_change: inner.last_state_change,
            last_failure_at: inner.last_failure_at,
        }
    }

    /// Menjalankan callable dengan perlindungan Circuit Breaker otomatis.
    pub fn call<F, R, E>(&self, operation: F) -> Result<R, CircuitBreakerError>
    where
        F: FnOnce() -> Result<R, E>,
        E: std::fmt::Display,
    {
        self.can_execute()?;
        match operation() {
            Ok(val) => {
                self.record_success();
                Ok(val)
            }
            Err(err) => {
                self.record_failure();
                Err(CircuitBreakerError::ExecutionFailed(err.to_string()))
            }
        }
    }
}
