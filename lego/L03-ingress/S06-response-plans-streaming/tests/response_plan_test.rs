//! Unit tests for L03.S06 Response Plans and Streaming Payloads

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_immediate_ack_returns_instantly() {
        let service = ResponsePlanService::new(30_000);
        let ack_body = json!({ "status": "started", "execution_id": "exec_999" });

        let res = service
            .register_waiter(
                "waiter_ack_1",
                "wf_1",
                "tenant_a",
                ResponsePlanType::ImmediateAck {
                    status_code: 202,
                    ack_payload: ack_body.clone(),
                },
                1000,
            )
            .expect("Registration should succeed");

        assert_eq!(res["status"], "fulfilled");
        assert_eq!(res["status_code"], 202);
        assert_eq!(res["response"], ack_body);
    }

    #[test]
    fn test_wait_for_completion_fulfill_success() {
        let service = ResponsePlanService::new(10_000);

        let res = service
            .register_waiter(
                "waiter_sync_1",
                "wf_sync",
                "tenant_b",
                ResponsePlanType::WaitForCompletion { timeout_ms: 5000 },
                1000,
            )
            .unwrap();
        assert_eq!(res["status"], "pending");

        // Fulfill before timeout
        let payload = json!({ "data": "output from node" });
        service.fulfill_waiter("waiter_sync_1", payload.clone(), 200, 2000).unwrap();

        let poll = service.poll_waiter("waiter_sync_1", 2000).unwrap();
        assert_eq!(poll["status"], "fulfilled");
        assert_eq!(poll["final_response"], payload);
    }

    #[test]
    fn test_wait_for_completion_timeout_handling() {
        let service = ResponsePlanService::new(5000);

        service
            .register_waiter(
                "waiter_timeout_1",
                "wf_slow",
                "tenant_c",
                ResponsePlanType::WaitForCompletion { timeout_ms: 3000 },
                1000,
            )
            .unwrap();

        // Try fulfill at 5000ms (1000 + 3000 = 4000ms timeout expired)
        let res = service.fulfill_waiter("waiter_timeout_1", json!({ "val": 1 }), 200, 5000);
        assert!(res.is_err());
        assert!(res.unwrap_err().contains("timeout exceeded"));

        let poll = service.poll_waiter("waiter_timeout_1", 5000).unwrap();
        assert_eq!(poll["status"], "timed_out");
    }

    #[test]
    fn test_streaming_chunks_delivery_and_completion() {
        let service = ResponsePlanService::new(30_000);

        service
            .register_waiter(
                "waiter_stream_1",
                "wf_llm",
                "tenant_d",
                ResponsePlanType::Streaming {
                    content_type: "text/event-stream".to_string(),
                    timeout_ms: 10_000,
                },
                1000,
            )
            .unwrap();

        // Push chunk 0
        let fin0 = service.push_stream_chunk("waiter_stream_1", 0, "data: chunk 1\n\n", false, 1100).unwrap();
        assert!(!fin0);

        // Push chunk 1 (final)
        let fin1 = service.push_stream_chunk("waiter_stream_1", 1, "data: [DONE]\n\n", true, 1200).unwrap();
        assert!(fin1);

        let poll = service.poll_waiter("waiter_stream_1", 1200).unwrap();
        assert_eq!(poll["status"], "stream_completed");
        assert_eq!(poll["chunks_count"], 2);
    }

    #[test]
    fn test_sweep_timeouts_identifies_all_expired_waiters() {
        let service = ResponsePlanService::new(5000);

        service
            .register_waiter(
                "w1",
                "wf_1",
                "tenant_1",
                ResponsePlanType::WaitForCompletion { timeout_ms: 1000 },
                1000,
            )
            .unwrap();
        service
            .register_waiter(
                "w2",
                "wf_2",
                "tenant_1",
                ResponsePlanType::WaitForCompletion { timeout_ms: 10_000 },
                1000,
            )
            .unwrap();

        let expired = service.sweep_timeouts(2500);
        assert_eq!(expired, vec!["w1".to_string()]);

        let p1 = service.poll_waiter("w1", 2500).unwrap();
        assert_eq!(p1["status"], "timed_out");

        let p2 = service.poll_waiter("w2", 2500).unwrap();
        assert_eq!(p2["status"], "pending");
    }

    #[test]
    fn test_port_handler_response_plan_roundtrip() {
        let service = ResponsePlanService::new(30_000);

        // 1. Register immediate ack via port handler
        let reg_payload = json!({
            "action": "register",
            "waiter_id": "port_ack_1",
            "mode": "immediate_ack",
            "status_code": 200,
            "ack_payload": { "received": true },
            "now_ms": 1000
        });
        let reg_res = service.handle_port_response_plan(&reg_payload).unwrap();
        assert_eq!(reg_res["status"], "fulfilled");

        // 2. Register sync waiter and fulfill
        let sync_reg = json!({
            "action": "register",
            "waiter_id": "port_sync_1",
            "mode": "wait_for_completion",
            "timeout_ms": 5000,
            "now_ms": 1000
        });
        let s_res = service.handle_port_response_plan(&sync_reg).unwrap();
        assert_eq!(s_res["status"], "pending");

        let ful_payload = json!({
            "action": "fulfill",
            "waiter_id": "port_sync_1",
            "response": { "answer": 42 },
            "now_ms": 1500
        });
        let ful_res = service.handle_port_response_plan(&ful_payload).unwrap();
        assert_eq!(ful_res["success"], true);

        // 3. Poll
        let poll_payload = json!({
            "action": "poll",
            "waiter_id": "port_sync_1",
            "now_ms": 1500
        });
        let poll_res = service.handle_port_response_plan(&poll_payload).unwrap();
        assert_eq!(poll_res["status"], "fulfilled");
        assert_eq!(poll_res["final_response"]["answer"], 42);
    }
}
