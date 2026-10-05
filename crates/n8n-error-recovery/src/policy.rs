//! Retry Policy & Error Semantics (LEGO `error-recovery`).
//!
//! Port & implementasi Rust penuh yang mematuhi kontrak `contracts/error-recovery.contract.md`:
//! - Exponential backoff calculation dengan jitter & max retries
//! - Error type filtering
//! - Resolusi n8n standard retry policy (fallback `0 -> 3/1000ms`, clamp `2..5` & `0..5000ms`)
//! - Resolusi outcome (`stop-workflow`, `continue-regular-output`, `continue-error-output`)
//! - Deteksi item-level error (`is_error_item`) & perutean (`split_error_output`)

use n8n_common::INodeExecutionData;
use serde::{Deserialize, Serialize};
use std::future::Future;

/// Konfigurasi kebijakan retry berstandar industri dengan exponential backoff dan jitter.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RetryPolicy {
    /// Batas maksimum percobaan ulang (di luar percobaan awal).
    pub max_retries: u32,
    /// Interval awal dalam milidetik.
    pub initial_interval_ms: u64,
    /// Batas atas interval dalam milidetik (cap).
    pub max_interval_ms: u64,
    /// Pengali backoff untuk setiap percobaan (misal 2.0).
    pub backoff_factor: f64,
    /// Apakah jitter diaktifkan untuk menghindari thundering herd.
    pub jitter: bool,
    /// Tipe error tertentu yang diizinkan untuk di-retry (kosong = semua error).
    pub retry_on_error_types: Vec<String>,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            initial_interval_ms: 1000,
            max_interval_ms: 30_000,
            backoff_factor: 2.0,
            jitter: false,
            retry_on_error_types: Vec::new(),
        }
    }
}

impl RetryPolicy {
    pub fn new(
        max_retries: u32,
        initial_interval_ms: u64,
        max_interval_ms: u64,
        backoff_factor: f64,
        jitter: bool,
    ) -> Self {
        Self {
            max_retries,
            initial_interval_ms,
            max_interval_ms,
            backoff_factor,
            jitter,
            retry_on_error_types: Vec::new(),
        }
    }

    pub fn with_error_types(mut self, error_types: Vec<String>) -> Self {
        self.retry_on_error_types = error_types;
        self
    }

    /// Menghitung delay (dalam milidetik) untuk attempt ke-N (0-indexed).
    /// Menggunakan exponential backoff: initial * (factor ^ attempt), di-cap pada max_interval.
    /// Jika jitter aktif, menerapkan pseudorandom full jitter: `[0, calculated_delay]`.
    pub fn calculate_delay(&self, attempt: u32) -> u64 {
        let base_delay = self.calculate_raw_exponential_delay(attempt);
        if !self.jitter {
            base_delay
        } else {
            // Pseudorandom deterministic jitter berbasis attempt dan base_delay
            let seed = (attempt as u64)
                .wrapping_mul(6364136223846793005)
                .wrapping_add(base_delay)
                .wrapping_add(1442695040888963407);
            let pseudo_ratio = ((seed >> 32) as u32 as f64) / (u32::MAX as f64);
            // Full jitter: rentang 50% - 100% dari base delay agar tidak pernah 0 drastis
            let jittered = (base_delay as f64 * (0.5 + 0.5 * pseudo_ratio)).round() as u64;
            jittered.min(self.max_interval_ms)
        }
    }

    /// Menghitung delay dengan rasio jitter eksternal (0.0 .. 1.0) untuk deterministic testing.
    pub fn calculate_delay_with_jitter_ratio(&self, attempt: u32, jitter_ratio: f64) -> u64 {
        let base_delay = self.calculate_raw_exponential_delay(attempt);
        if !self.jitter {
            return base_delay;
        }
        let clamped_ratio = jitter_ratio.clamp(0.0, 1.0);
        let jittered = (base_delay as f64 * (0.5 + 0.5 * clamped_ratio)).round() as u64;
        jittered.min(self.max_interval_ms)
    }

    fn calculate_raw_exponential_delay(&self, attempt: u32) -> u64 {
        let factor = self.backoff_factor.powi(attempt as i32);
        let calculated = (self.initial_interval_ms as f64 * factor).round();
        if calculated.is_infinite() || calculated > self.max_interval_ms as f64 {
            self.max_interval_ms
        } else {
            (calculated as u64).min(self.max_interval_ms)
        }
    }

    /// Mengecek apakah percobaan ulang harus dilakukan pada attempt ke-N dan tipe error tertentu.
    pub fn should_retry(&self, attempt: u32, error_type: Option<&str>) -> bool {
        if attempt >= self.max_retries {
            return false;
        }

        if self.retry_on_error_types.is_empty() {
            return true;
        }

        if let Some(err) = error_type {
            self.retry_on_error_types
                .iter()
                .any(|t| t.eq_ignore_ascii_case(err))
        } else {
            false
        }
    }
}

// ---------------------------------------------------------------------------
// n8n Contract Compatibility Layer (§2 & §4 dari error-recovery.contract.md)
// ---------------------------------------------------------------------------

/// Pengaturan retry pada node n8n.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct NodeRetrySettings {
    #[serde(default)]
    pub retry_on_fail: Option<bool>,
    #[serde(default)]
    pub max_tries: Option<u32>,
    #[serde(default)]
    pub wait_between_tries: Option<u64>,
}

/// Hasil resolusi retry policy n8n (1:1 parity dengan `workflow-execute.ts` L1600-L1613).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedRetryPolicy {
    pub max_tries: u32,
    pub wait_between_tries: u64,
}

/// Resolusi kebijakan retry n8n (§4.1):
/// - `retryOnFail !== true` => `{ maxTries: 1, waitBetweenTries: 0 }`.
/// - Jika true: `maxTries = min(5, max(2, maxTries || 3))`
///   dan `waitBetweenTries = min(5000, max(0, waitBetweenTries || 1000))`.
///   Nilai 0 jatuh ke default (3 / 1000 ms).
pub fn resolve_retry_policy(node: &NodeRetrySettings) -> ResolvedRetryPolicy {
    if node.retry_on_fail != Some(true) {
        return ResolvedRetryPolicy {
            max_tries: 1,
            wait_between_tries: 0,
        };
    }

    let raw_max = match node.max_tries {
        Some(0) | None => 3,
        Some(n) => n,
    };
    let max_tries = raw_max.clamp(2, 5);

    let raw_wait = match node.wait_between_tries {
        Some(0) | None => 1000,
        Some(w) => w,
    };
    let wait_between_tries = raw_wait.clamp(0, 5000);

    ResolvedRetryPolicy {
        max_tries,
        wait_between_tries,
    }
}

/// Aksi onError pada node n8n.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OnErrorAction {
    StopWorkflow,
    ContinueRegularOutput,
    ContinueErrorOutput,
}

/// Pengaturan penanganan error pada node n8n.
#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeErrorSettings {
    #[serde(default)]
    pub continue_on_fail: Option<bool>,
    #[serde(default)]
    pub on_error: Option<OnErrorAction>,
}

/// Hasil keputusan error outcome (§4.5):
/// - 'stop-workflow'
/// - 'continue-regular-output'
/// - 'continue-error-output'
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ErrorOutcome {
    StopWorkflow,
    ContinueRegularOutput,
    ContinueErrorOutput,
}

/// Memetakan pengaturan node ke ErrorOutcome sesuai aturan §4.5:
/// continue iff `continueOnFail === true` or `onError in { continueRegularOutput, continueErrorOutput }`;
/// `onError === 'continueErrorOutput'` => `continue-error-output`,
/// selain itu jika continue => `continue-regular-output`,
/// lainnya => `stop-workflow`.
pub fn resolve_error_outcome(node: &NodeErrorSettings) -> ErrorOutcome {
    let continues = node.continue_on_fail == Some(true)
        || matches!(
            node.on_error,
            Some(OnErrorAction::ContinueRegularOutput | OnErrorAction::ContinueErrorOutput)
        );

    if !continues {
        return ErrorOutcome::StopWorkflow;
    }

    if node.on_error == Some(OnErrorAction::ContinueErrorOutput) {
        ErrorOutcome::ContinueErrorOutput
    } else {
        ErrorOutcome::ContinueRegularOutput
    }
}

/// Struktur Execution Error terstandarisasi n8n (§4.4).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NodeExecutionError {
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stack: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub http_code: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub node_name: Option<String>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

impl NodeExecutionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            stack: None,
            description: None,
            http_code: None,
            node_name: None,
            extra: serde_json::Map::new(),
        }
    }
}

/// Mendeteksi apakah item eksekusi adalah error item (§4.8):
/// item-level errors:
/// `item.error` terdefinisi, atau `json.error` adalah satu-satunya key,
/// atau `json.error` + `json.message`.
pub fn is_error_item(item: &INodeExecutionData) -> bool {
    // 1. Cek paired item atau metadata jika ada indikasi error
    if let Some(err_val) = item.json.get("error") {
        if !err_val.is_null() {
            if let Some(obj) = item.json.as_object() {
                // key hanya "error"
                if obj.len() == 1 {
                    return true;
                }
                // keys adalah "error" dan "message"
                if obj.len() == 2 && obj.contains_key("message") {
                    return true;
                }
                // Jika error adalah object yang berisi message atau stack
                if err_val.is_object() {
                    return true;
                }
            }
        }
    }

    false
}

/// Hasil pemisahan error output.
#[derive(Debug, Clone, PartialEq)]
pub struct SplitErrorOutputResult {
    pub data: Vec<Vec<INodeExecutionData>>,
    pub error_items: Vec<INodeExecutionData>,
}

/// Memisahkan item-level error ke output terakhir (last main output) (§4.8).
/// Dengan `continueErrorOutput`, error items dari outputs `0..main_output_count-2`
/// dipindahkan keluar menuju output terakhir (`main_output_count - 1`).
pub fn split_error_output(
    outputs: &[Vec<INodeExecutionData>],
    main_output_count: usize,
) -> SplitErrorOutputResult {
    if main_output_count == 0 || outputs.is_empty() {
        return SplitErrorOutputResult {
            data: outputs.to_vec(),
            error_items: Vec::new(),
        };
    }

    let mut new_outputs = vec![Vec::new(); outputs.len().max(main_output_count)];
    let last_index = main_output_count - 1;
    let mut collected_errors = Vec::new();

    for (out_idx, branch) in outputs.iter().enumerate() {
        if out_idx < last_index {
            for item in branch {
                if is_error_item(item) {
                    collected_errors.push(item.clone());
                } else {
                    new_outputs[out_idx].push(item.clone());
                }
            }
        } else {
            // Output terakhir atau output melebihi main output
            new_outputs[out_idx].extend(branch.clone());
        }
    }

    // Masukkan collected errors ke output terakhir
    new_outputs[last_index].extend(collected_errors.clone());

    SplitErrorOutputResult {
        data: new_outputs,
        error_items: collected_errors,
    }
}

/// Hasil eksekusi retry.
#[derive(Debug, Clone, PartialEq)]
pub enum RetryExecutionOutcome<T, E> {
    Success {
        data: T,
        tries: u32,
        waited_ms: u64,
    },
    Error {
        error: E,
        tries: u32,
        waited_ms: u64,
    },
}

/// Menjalankan async task dengan kebijakan retry (§4.1, §4.2, §4.3, §4.4):
/// - Tidak ada sleep sebelum attempt pertama (`waited_ms == 0` untuk attempt 0).
/// - Sleep hanya diaplikasikan di antara tries.
/// - Soft failures retry: jika `is_soft_failure` mengembalikan true, task di-retry
///   sampai `tries == max_tries - 1`, lalu dikembalikan as-is.
/// - Tidak pernah panic/throw; mengembalikan `RetryExecutionOutcome`.
pub async fn run_with_retry<F, Fut, T, E, S>(
    mut task: F,
    policy: &ResolvedRetryPolicy,
    is_soft_failure: Option<S>,
) -> RetryExecutionOutcome<T, E>
where
    F: FnMut(u32) -> Fut,
    Fut: Future<Output = Result<T, E>>,
    S: Fn(&T) -> bool,
{
    let mut last_error: Option<E> = None;
    let mut total_waited_ms = 0u64;

    for try_index in 0..policy.max_tries {
        if try_index > 0 && policy.wait_between_tries > 0 {
            tokio::time::sleep(tokio::time::Duration::from_millis(
                policy.wait_between_tries,
            ))
            .await;
            total_waited_ms += policy.wait_between_tries;
        }

        match task(try_index).await {
            Ok(result) => {
                // Cek soft failure
                if let Some(ref checker) = is_soft_failure {
                    if checker(&result) && try_index + 1 < policy.max_tries {
                        // Soft failure terdeteksi dan masih ada sisa retry
                        continue;
                    }
                }
                return RetryExecutionOutcome::Success {
                    data: result,
                    tries: try_index + 1,
                    waited_ms: total_waited_ms,
                };
            }
            Err(err) => {
                last_error = Some(err);
            }
        }
    }

    RetryExecutionOutcome::Error {
        error: last_error.expect("at least one try must have executed"),
        tries: policy.max_tries,
        waited_ms: total_waited_ms,
    }
}
