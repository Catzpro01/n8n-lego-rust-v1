//! n8n Error Recovery LEGO (`n8n-error-recovery`).
//!
//! Mengimplementasikan sistem pemulihan kegagalan modular:
//! 1. `policy`: Retry policy dengan exponential backoff, jitter, filtering tipe error,
//!    dan resolusi 1:1 parity dengan kontrak n8n (`error-recovery.contract.md`).
//! 2. `circuit_breaker`: Circuit breaker state machine (`Closed`, `Open`, `HalfOpen`)
//!    dengan ambang batas kegagalan, cooldown window, dan perlindungan Fail-Closed.
//! 3. `handler`: Error trigger dispatcher untuk memetakan error eksekusi workflow/node
//!    ke target error workflow n8n.

pub mod circuit_breaker;
pub mod handler;
pub mod policy;

// Re-exports
pub use circuit_breaker::{
    CircuitBreaker, CircuitBreakerConfig, CircuitBreakerError, CircuitBreakerState,
    CircuitBreakerStats,
};
pub use handler::{
    DispatchResult, ErrorTriggerDispatcher, ErrorTriggerEvent, ErrorWorkflowBinding,
    WorkflowErrorPayload,
};
pub use policy::{
    is_error_item, resolve_error_outcome, resolve_retry_policy, run_with_retry, split_error_output,
    ErrorOutcome, NodeErrorSettings, NodeExecutionError, NodeRetrySettings, OnErrorAction,
    ResolvedRetryPolicy, RetryExecutionOutcome, RetryPolicy, SplitErrorOutputResult,
};

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;
    use n8n_common::INodeExecutionData;
    use serde_json::json;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    // =========================================================================
    // 1. UJI RETRY EXPONENTIAL BACKOFF CALCULATION & JITTER
    // =========================================================================

    #[test]
    fn test_retry_exponential_backoff_calculation() {
        let policy = RetryPolicy::new(5, 1000, 10000, 2.0, false);

        // Attempt 0: 1000 * 2^0 = 1000 ms
        assert_eq!(policy.calculate_delay(0), 1000);
        // Attempt 1: 1000 * 2^1 = 2000 ms
        assert_eq!(policy.calculate_delay(1), 2000);
        // Attempt 2: 1000 * 2^2 = 4000 ms
        assert_eq!(policy.calculate_delay(2), 4000);
        // Attempt 3: 1000 * 2^3 = 8000 ms
        assert_eq!(policy.calculate_delay(3), 8000);
        // Attempt 4: 1000 * 2^4 = 16000 ms -> Capped pada max_interval 10000 ms
        assert_eq!(policy.calculate_delay(4), 10000);
        // Attempt 10: Sangat besar -> Tetap di-cap pada 10000 ms
        assert_eq!(policy.calculate_delay(10), 10000);
    }

    #[test]
    fn test_retry_jitter_behavior() {
        let policy = RetryPolicy::new(3, 1000, 10000, 2.0, true);

        // Uji dengan rasio deterministik
        // Base delay attempt 1 = 2000 ms
        // Jitter ratio 0.0 -> delay * 0.5 = 1000 ms
        assert_eq!(policy.calculate_delay_with_jitter_ratio(1, 0.0), 1000);
        // Jitter ratio 1.0 -> delay * 1.0 = 2000 ms
        assert_eq!(policy.calculate_delay_with_jitter_ratio(1, 1.0), 2000);
        // Jitter ratio 0.5 -> delay * (0.5 + 0.25) = 1500 ms
        assert_eq!(policy.calculate_delay_with_jitter_ratio(1, 0.5), 1500);

        // Uji pseudorandom internal jitter berada dalam rentang [50% * base, base]
        for attempt in 0..4 {
            let base = 1000u64 * 2u64.pow(attempt);
            let calculated = policy.calculate_delay(attempt);
            assert!(
                calculated >= (base as f64 * 0.5) as u64,
                "delay {} must be >= 50% base {}",
                calculated,
                base
            );
            assert!(
                calculated <= base,
                "delay {} must be <= base {}",
                calculated,
                base
            );
        }
    }

    #[test]
    fn test_retry_on_error_types_filtering() {
        let policy = RetryPolicy::default().with_error_types(vec![
            "NetworkTimeout".into(),
            "ConnectionReset".into(),
        ]);

        // Error tipe yang cocok boleh di-retry jika attempt masih di bawah max_retries
        assert!(policy.should_retry(0, Some("NetworkTimeout")));
        assert!(policy.should_retry(1, Some("connectionreset"))); // case-insensitive
        // Error tipe yang tidak cocok ditolak
        assert!(!policy.should_retry(0, Some("InvalidJson")));
        assert!(!policy.should_retry(0, None));
        // Melebihi max_retries ditolak
        assert!(!policy.should_retry(3, Some("NetworkTimeout")));
    }

    // =========================================================================
    // 2. UJI CIRCUIT BREAKER: TRIP, RESET, FAIL-CLOSED, HALF-OPEN
    // =========================================================================

    #[test]
    fn test_circuit_breaker_trip_and_reset() {
        let config = CircuitBreakerConfig::new(3, Duration::from_millis(500), 2);
        let cb = CircuitBreaker::new("api-breaker", config);

        assert_eq!(cb.state(), CircuitBreakerState::Closed);
        assert!(cb.can_execute().is_ok());

        // 2 kali failure, masih di bawah threshold 3 -> tetap Closed
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitBreakerState::Closed);

        // Failure ke-3 mencapai threshold -> Breaker TRIP ke Open!
        cb.record_failure();
        assert_eq!(cb.state(), CircuitBreakerState::Open);

        // Manual reset -> kembali ke Closed
        cb.reset();
        assert_eq!(cb.state(), CircuitBreakerState::Closed);

        // Manual trip -> langsung Open
        cb.trip();
        assert_eq!(cb.state(), CircuitBreakerState::Open);
    }

    #[test]
    fn test_circuit_breaker_fail_closed_handling() {
        let config = CircuitBreakerConfig::new(2, Duration::from_secs(60), 1);
        let cb = CircuitBreaker::new("db-breaker", config);

        // Picu failure hingga trip
        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitBreakerState::Open);

        // Pola FAIL-CLOSED: Semua eksekusi downstream wajib ditolak seketika
        let res = cb.can_execute();
        assert!(res.is_err());
        match res.unwrap_err() {
            CircuitBreakerError::Open {
                name,
                retry_after_ms,
            } => {
                assert_eq!(name, "db-breaker");
                assert!(retry_after_ms > 0);
            }
            other => panic!("Expected Open error, got: {:?}", other),
        }

        // Operasi via helper call() juga harus gagal tanpa mengeksekusi closure
        let executed = Arc::new(AtomicU32::new(0));
        let executed_clone = executed.clone();
        let call_res = cb.call(|| {
            executed_clone.fetch_add(1, Ordering::SeqCst);
            Ok::<_, String>("done")
        });

        assert!(call_res.is_err());
        // Closure TIDAK PERNAH dipanggil (fail-closed terbukti)
        assert_eq!(executed.load(Ordering::SeqCst), 0);
        assert_eq!(cb.stats().rejected_calls, 2);
    }

    #[tokio::test]
    async fn test_circuit_breaker_half_open_transition_and_recovery() {
        // Cooldown cepat 50ms untuk pengujian
        let config = CircuitBreakerConfig::new(2, Duration::from_millis(50), 2);
        let cb = CircuitBreaker::new("probe-breaker", config);

        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitBreakerState::Open);

        // Tunggu cooldown selesai
        tokio::time::sleep(Duration::from_millis(60)).await;

        // Panggilan pertama setelah cooldown harus memicu transisi ke HalfOpen
        assert!(cb.can_execute().is_ok());
        assert_eq!(cb.state(), CircuitBreakerState::HalfOpen);

        // Success ke-1: belum cukup untuk recover (success_threshold = 2)
        cb.record_success();
        assert_eq!(cb.state(), CircuitBreakerState::HalfOpen);

        // Panggilan probe ke-2 diizinkan
        assert!(cb.can_execute().is_ok());
        // Success ke-2: mencapai threshold -> kembali ke Closed!
        cb.record_success();
        assert_eq!(cb.state(), CircuitBreakerState::Closed);
    }

    #[tokio::test]
    async fn test_circuit_breaker_half_open_retrip_on_failure() {
        let config = CircuitBreakerConfig::new(2, Duration::from_millis(40), 2);
        let cb = CircuitBreaker::new("retrip-breaker", config);

        cb.record_failure();
        cb.record_failure();
        assert_eq!(cb.state(), CircuitBreakerState::Open);

        tokio::time::sleep(Duration::from_millis(50)).await;

        // Masuk ke HalfOpen
        assert!(cb.can_execute().is_ok());
        assert_eq!(cb.state(), CircuitBreakerState::HalfOpen);

        // Gagal saat fase probe -> Seketika re-trip ke Open!
        cb.record_failure();
        assert_eq!(cb.state(), CircuitBreakerState::Open);
        assert!(cb.can_execute().is_err());
    }

    // =========================================================================
    // 3. UJI CONTRACT PARITY (n8n error-recovery.contract.md)
    // =========================================================================

    #[test]
    fn test_n8n_contract_retry_policy_resolution() {
        // §4.1: retryOnFail !== true => maxTries: 1, waitBetweenTries: 0
        let disabled = NodeRetrySettings {
            retry_on_fail: Some(false),
            max_tries: Some(5),
            wait_between_tries: Some(5000),
        };
        assert_eq!(
            resolve_retry_policy(&disabled),
            ResolvedRetryPolicy {
                max_tries: 1,
                wait_between_tries: 0,
            }
        );

        let none_flag = NodeRetrySettings::default();
        assert_eq!(
            resolve_retry_policy(&none_flag),
            ResolvedRetryPolicy {
                max_tries: 1,
                wait_between_tries: 0,
            }
        );

        // §4.1: Nilai 0 jatuh ke default 3 / 1000 ms
        let zero_values = NodeRetrySettings {
            retry_on_fail: Some(true),
            max_tries: Some(0),
            wait_between_tries: Some(0),
        };
        assert_eq!(
            resolve_retry_policy(&zero_values),
            ResolvedRetryPolicy {
                max_tries: 3,
                wait_between_tries: 1000,
            }
        );

        // §4.1: Clamping maxTries min 2, max 5; waitBetweenTries min 0, max 5000
        let clamped_low = NodeRetrySettings {
            retry_on_fail: Some(true),
            max_tries: Some(1),
            wait_between_tries: Some(100),
        };
        assert_eq!(
            resolve_retry_policy(&clamped_low),
            ResolvedRetryPolicy {
                max_tries: 2, // clamped min 2
                wait_between_tries: 100,
            }
        );

        let clamped_high = NodeRetrySettings {
            retry_on_fail: Some(true),
            max_tries: Some(10),
            wait_between_tries: Some(99999),
        };
        assert_eq!(
            resolve_retry_policy(&clamped_high),
            ResolvedRetryPolicy {
                max_tries: 5,            // clamped max 5
                wait_between_tries: 5000, // clamped max 5000
            }
        );
    }

    #[test]
    fn test_n8n_contract_error_outcome_resolution() {
        // §4.5: default -> stop-workflow
        let default_node = NodeErrorSettings::default();
        assert_eq!(
            resolve_error_outcome(&default_node),
            ErrorOutcome::StopWorkflow
        );

        // continueOnFail === true -> continue-regular-output
        let continue_on_fail = NodeErrorSettings {
            continue_on_fail: Some(true),
            on_error: None,
        };
        assert_eq!(
            resolve_error_outcome(&continue_on_fail),
            ErrorOutcome::ContinueRegularOutput
        );

        // onError === continueRegularOutput -> continue-regular-output
        let reg_output = NodeErrorSettings {
            continue_on_fail: Some(false),
            on_error: Some(OnErrorAction::ContinueRegularOutput),
        };
        assert_eq!(
            resolve_error_outcome(&reg_output),
            ErrorOutcome::ContinueRegularOutput
        );

        // onError === continueErrorOutput -> continue-error-output
        let err_output = NodeErrorSettings {
            continue_on_fail: Some(false),
            on_error: Some(OnErrorAction::ContinueErrorOutput),
        };
        assert_eq!(
            resolve_error_outcome(&err_output),
            ErrorOutcome::ContinueErrorOutput
        );

        // continueOnFail === true DAN onError === continueErrorOutput -> continue-error-output
        let combo = NodeErrorSettings {
            continue_on_fail: Some(true),
            on_error: Some(OnErrorAction::ContinueErrorOutput),
        };
        assert_eq!(
            resolve_error_outcome(&combo),
            ErrorOutcome::ContinueErrorOutput
        );
    }

    #[test]
    fn test_is_error_item_detection() {
        // Normal item -> false
        let normal = INodeExecutionData {
            json: json!({"id": 123, "name": "alpha"}),
            binary: None,
            paired_item: None,
        };
        assert!(!is_error_item(&normal));

        // Key hanya "error" -> true
        let err_only = INodeExecutionData {
            json: json!({"error": "Unauthorized"}),
            binary: None,
            paired_item: None,
        };
        assert!(is_error_item(&err_only));

        // Keys "error" dan "message" -> true
        let err_and_msg = INodeExecutionData {
            json: json!({"error": "Bad Request", "message": "Missing param"}),
            binary: None,
            paired_item: None,
        };
        assert!(is_error_item(&err_and_msg));

        // Error sebagai object -> true
        let err_obj = INodeExecutionData {
            json: json!({
                "error": { "code": 500, "details": "Internal server error" },
                "extra": "value"
            }),
            binary: None,
            paired_item: None,
        };
        assert!(is_error_item(&err_obj));
    }

    #[test]
    fn test_split_error_output() {
        let normal_item1 = INodeExecutionData {
            json: json!({"data": "ok1"}),
            ..Default::default()
        };
        let normal_item2 = INodeExecutionData {
            json: json!({"data": "ok2"}),
            ..Default::default()
        };
        let error_item = INodeExecutionData {
            json: json!({"error": "failed item"}),
            ..Default::default()
        };

        // Output dengan 2 branch (index 0 = main output biasa, index 1 = error output)
        let outputs = vec![
            vec![normal_item1.clone(), error_item.clone()], // branch 0
            vec![normal_item2.clone()],                     // branch 1
        ];

        let split = split_error_output(&outputs, 2);
        // Error item harus dipindahkan dari branch 0 ke branch 1
        assert_eq!(split.data[0], vec![normal_item1]);
        assert_eq!(split.data[1], vec![normal_item2, error_item.clone()]);
        assert_eq!(split.error_items, vec![error_item]);
    }

    #[tokio::test]
    async fn test_run_with_retry_execution() {
        let policy = ResolvedRetryPolicy {
            max_tries: 3,
            wait_between_tries: 10,
        };

        let attempts = Arc::new(AtomicU32::new(0));
        let attempts_clone = attempts.clone();

        // Task gagal 2 kali, sukses pada percobaan ke-3
        let outcome = run_with_retry(
            move |_| {
                let curr = attempts_clone.fetch_add(1, Ordering::SeqCst);
                async move {
                    if curr < 2 {
                        Err("transient network issue")
                    } else {
                        Ok("payload-success")
                    }
                }
            },
            &policy,
            None::<fn(&&str) -> bool>,
        )
        .await;

        match outcome {
            RetryExecutionOutcome::Success {
                data,
                tries,
                waited_ms,
            } => {
                assert_eq!(data, "payload-success");
                assert_eq!(tries, 3);
                assert_eq!(waited_ms, 20); // 2 kali wait @ 10ms
            }
            _ => panic!("Expected retry success!"),
        }
    }

    // =========================================================================
    // 4. UJI ERROR TRIGGER DISPATCHER MAPPING & NOTIFICATION
    // =========================================================================

    #[tokio::test]
    async fn test_error_trigger_dispatcher_mapping() {
        let dispatcher = ErrorTriggerDispatcher::new();
        let mut rx = dispatcher.subscribe();

        // Daftarkan relasi workflow
        dispatcher.register_error_workflow("wf_checkout_source", "wf_error_handler_target");

        let payload = WorkflowErrorPayload {
            execution_id: "exec-999".into(),
            workflow_id: "wf_checkout_source".into(),
            workflow_name: Some("Checkout Workflow".into()),
            failed_node_name: Some("Stripe Charge".into()),
            failed_node_type: Some("n8n-nodes-base.stripe".into()),
            error_message: "Card declined".into(),
            error_stack: Some("Error at stripe.js:42".into()),
            error_details: Some(json!({"code": "card_declined"})),
            mode: Some("manual".into()),
            retry_of: None,
            timestamp: Utc::now(),
        };

        // Dispatch kegagalan
        let result = dispatcher.dispatch(&payload);
        match result {
            DispatchResult::Dispatched {
                error_workflow_id,
                payload: json_body,
                execution_data,
            } => {
                assert_eq!(error_workflow_id, "wf_error_handler_target");
                // Verifikasi bentuk payload kompatibel dengan n8n Error Trigger
                assert_eq!(json_body["execution"]["id"], "exec-999");
                assert_eq!(json_body["execution"]["lastNodeExecuted"], "Stripe Charge");
                assert_eq!(
                    json_body["execution"]["error"]["message"],
                    "Card declined"
                );
                assert_eq!(
                    json_body["execution"]["error"]["node"]["type"],
                    "n8n-nodes-base.stripe"
                );
                assert_eq!(json_body["workflow"]["id"], "wf_checkout_source");
                assert_eq!(
                    execution_data.json["execution"]["id"],
                    json_body["execution"]["id"]
                );
            }
            other => panic!("Expected Dispatched result, got {:?}", other),
        }

        // Verifikasi listener asinkron menerima event
        let event = rx.recv().await.expect("Must receive error trigger event");
        assert_eq!(event.target_workflow_id, "wf_error_handler_target");
        assert_eq!(event.payload.error_message, "Card declined");
    }

    #[test]
    fn test_error_trigger_dispatcher_global_fallback() {
        let dispatcher = ErrorTriggerDispatcher::new();
        dispatcher.set_global_fallback_workflow(Some("wf_global_alert".into()));

        let payload = WorkflowErrorPayload::new("exec-unmapped", "wf_unmapped", "Out of memory");
        let result = dispatcher.dispatch(&payload);

        match result {
            DispatchResult::Dispatched {
                error_workflow_id, ..
            } => {
                assert_eq!(error_workflow_id, "wf_global_alert");
            }
            other => panic!("Expected Dispatched via global fallback, got {:?}", other),
        }

        // Hapus fallback
        dispatcher.set_global_fallback_workflow(None);
        let result2 = dispatcher.dispatch(&payload);
        assert_eq!(
            result2,
            DispatchResult::NoHandlerConfigured {
                source_workflow_id: "wf_unmapped".into()
            }
        );
    }
}
