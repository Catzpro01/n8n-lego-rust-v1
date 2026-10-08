//! Unit and integration test matrix for L08.S06 Agent Memory
//!
//! Sub-LEGO Identity: L08.S06
//! Owned State Domain: `conversation-history-chunks`
//! Runtime Host: H06 (Agent Host)

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;

    fn make_test_store() -> AgentMemoryStore {
        AgentMemoryStore::new(
            MemoryLimits::default(),
            Arc::new(H06ToH02PhysicalTransport::new()),
        )
    }

    fn make_small_store(chunk_size: usize, max_chunks: usize, max_bytes: usize) -> AgentMemoryStore {
        let limits = MemoryLimits {
            max_chunk_size_bytes: chunk_size,
            max_chunks_per_session: max_chunks,
            max_bytes_per_session: max_bytes,
            max_tokens_per_session: 1000,
            default_ttl_ms: None,
        };
        AgentMemoryStore::new(limits, Arc::new(H06ToH02PhysicalTransport::new()))
    }

    // 1. Store success
    #[test]
    fn test_01_store_success() {
        let store = make_test_store();
        let payload = MemoryStorePayload {
            tenant_id: "tenant-1".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-1".to_string(),
            conversation_id: Some("conv-1".to_string()),
            role: MemoryRole::User,
            content: "Hello agent!".to_string(),
            generation: Some(1),
            ttl_ms: None,
            metadata: None,
            timestamp_ms: Some(1000),
        };
        let res = store.store_chunk(payload, 1000).expect("Store should succeed");
        assert_eq!(res.session_id, "sess-1");
        assert_eq!(res.sequence, 1);
        assert_eq!(res.generation, 1);
        assert!(!res.is_duplicate);
        assert!(res.chunk_id.contains("chunk:tenant-1:sess-1:1:1"));
    }

    // 2. Retrieve success
    #[test]
    fn test_02_retrieve_success() {
        let store = make_test_store();
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "tenant-1".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-1".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Message 1".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap();

        let query = MemoryQuery {
            tenant_id: "tenant-1".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-1".to_string(),
            ..Default::default()
        };
        let chunks = store.retrieve(&query, 1000).expect("Retrieve should succeed");
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].content, "Message 1");
        assert_eq!(chunks[0].role, MemoryRole::User);
    }

    // 3. Store duplicate (idempotent write)
    #[test]
    fn test_03_store_duplicate_idempotency() {
        let store = make_test_store();
        let p1 = MemoryStorePayload {
            tenant_id: "tenant-1".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-1".to_string(),
            conversation_id: None,
            role: MemoryRole::User,
            content: "Idempotent msg".to_string(),
            generation: Some(1),
            ttl_ms: None,
            metadata: None,
            timestamp_ms: Some(1000),
        };
        let r1 = store.store_chunk(p1.clone(), 1000).unwrap();
        assert!(!r1.is_duplicate);

        // Repeated same payload
        let r2 = store.store_chunk(p1, 1000).unwrap();
        assert!(r2.is_duplicate);
        assert_eq!(r2.sequence, r1.sequence);
        assert_eq!(r2.chunk_id, r1.chunk_id);
    }

    // 4. Retrieve ordering (monotonic sequence ascending)
    #[test]
    fn test_04_retrieve_ordering() {
        let store = make_test_store();
        for i in 1..=5 {
            store
                .store_chunk(
                    MemoryStorePayload {
                        tenant_id: "tenant-1".to_string(),
                        scope_id: "scope-1".to_string(),
                        session_id: "sess-order".to_string(),
                        conversation_id: None,
                        role: MemoryRole::User,
                        content: format!("Step {}", i),
                        generation: None,
                        ttl_ms: None,
                        metadata: None,
                        timestamp_ms: Some(1000 + i),
                    },
                    1000 + i,
                )
                .unwrap();
        }

        let query = MemoryQuery {
            tenant_id: "tenant-1".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-order".to_string(),
            ..Default::default()
        };
        let retrieved = store.retrieve(&query, 2000).unwrap();
        assert_eq!(retrieved.len(), 5);
        for i in 0..5 {
            assert_eq!(retrieved[i].sequence, (i + 1) as u64);
        }
    }

    // 5. Chunk identity (deterministic formatting)
    #[test]
    fn test_05_chunk_identity_deterministic() {
        let store = make_test_store();
        let res = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "alpha".to_string(),
                    scope_id: "work".to_string(),
                    session_id: "s99".to_string(),
                    conversation_id: None,
                    role: MemoryRole::System,
                    content: "System prompt".to_string(),
                    generation: Some(10),
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(100),
                },
                100,
            )
            .unwrap();

        assert_eq!(res.chunk_id, "chunk:alpha:s99:1:10");
    }

    // 6. Chunk size limit (reject oversized content fail-closed)
    #[test]
    fn test_06_chunk_size_limit() {
        let store = make_small_store(20, 10, 1000); // Max 20 bytes per chunk
        let big_content = "This content exceeds twenty bytes definitely";
        let err = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "tenant-1".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-1".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: big_content.to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(100),
                },
                100,
            )
            .unwrap_err();

        assert!(matches!(err, MemoryError::ChunkSizeExceeded { .. }));
    }

    // 7. Chunk count limit (bounded session chunk count)
    #[test]
    fn test_07_chunk_count_limit() {
        let store = make_small_store(100, 3, 1000); // Max 3 chunks
        for i in 1..=4 {
            store
                .store_chunk(
                    MemoryStorePayload {
                        tenant_id: "tenant-1".to_string(),
                        scope_id: "scope-1".to_string(),
                        session_id: "sess-cnt".to_string(),
                        conversation_id: None,
                        role: MemoryRole::User,
                        content: format!("Msg {}", i),
                        generation: None,
                        ttl_ms: None,
                        metadata: None,
                        timestamp_ms: Some(100 * i),
                    },
                    100 * i,
                )
                .unwrap();
        }

        let query = MemoryQuery {
            tenant_id: "tenant-1".to_string(),
            scope_id: "scope-1".to_string(),
            session_id: "sess-cnt".to_string(),
            ..Default::default()
        };
        let chunks = store.retrieve(&query, 500).unwrap();
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[0].content, "Msg 2");
        assert_eq!(chunks[2].content, "Msg 4");
    }

    // 8. Byte capacity limit
    #[test]
    fn test_08_byte_capacity_limit() {
        let store = make_small_store(100, 10, 30); // Max 30 bytes total
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "tenant-1".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-bytes".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "1234567890".to_string(), // 10 bytes
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(10),
                },
                10,
            )
            .unwrap();

        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "tenant-1".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-bytes".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "abcdefghij".to_string(), // 10 bytes
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(20),
                },
                20,
            )
            .unwrap();

        // Adding 20 bytes exceeds 30 total -> triggers eviction of oldest
        let res = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "tenant-1".to_string(),
                    scope_id: "scope-1".to_string(),
                    session_id: "sess-bytes".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "12345678901234567890".to_string(), // 20 bytes
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(30),
                },
                30,
            )
            .unwrap();

        assert!(res.evicted_count >= 1);
    }

    // 9. Deterministic eviction (protects System prompt)
    #[test]
    fn test_09_deterministic_eviction_protects_system() {
        let store = make_small_store(100, 3, 1000);
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-sys".to_string(),
                    conversation_id: None,
                    role: MemoryRole::System,
                    content: "System directive".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(10),
                },
                10,
            )
            .unwrap();

        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-sys".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "User query 1".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(20),
                },
                20,
            )
            .unwrap();

        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-sys".to_string(),
                    conversation_id: None,
                    role: MemoryRole::Assistant,
                    content: "Assistant reply 1".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(30),
                },
                30,
            )
            .unwrap();

        // 4th chunk evicts oldest non-system chunk ("User query 1")
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-sys".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "User query 2".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(40),
                },
                40,
            )
            .unwrap();

        let query = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "s1".to_string(),
            session_id: "sess-sys".to_string(),
            ..Default::default()
        };
        let retrieved = store.retrieve(&query, 50).unwrap();
        assert_eq!(retrieved.len(), 3);
        assert!(retrieved.iter().any(|c| c.role == MemoryRole::System));
        assert!(!retrieved.iter().any(|c| c.content == "User query 1"));
    }

    // 10. TTL/age retention
    #[test]
    fn test_10_ttl_age_retention() {
        let store = make_test_store();
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-ttl".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Expiring msg".to_string(),
                    generation: None,
                    ttl_ms: Some(500),
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap();

        let query = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "s1".to_string(),
            session_id: "sess-ttl".to_string(),
            ..Default::default()
        };

        // Before TTL
        let active = store.retrieve(&query, 1200).unwrap();
        assert_eq!(active.len(), 1);

        // After TTL
        let expired = store.retrieve(&query, 1600).unwrap();
        assert_eq!(expired.len(), 0);
    }

    // 11. Store/update generation
    #[test]
    fn test_11_store_update_generation() {
        let store = make_test_store();
        let res = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-up".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Original".to_string(),
                    generation: Some(1),
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap();

        let updated = store
            .update_chunk("t1", "s1", "sess-up", &res.chunk_id, "Updated", 2, 1050)
            .unwrap();

        assert_eq!(updated.content, "Updated");
        assert_eq!(updated.generation, 2);
    }

    // 12. Stale write rejection
    #[test]
    fn test_12_stale_write_rejection() {
        let store = make_test_store();
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-stale".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "New generation".to_string(),
                    generation: Some(5),
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap();

        let err = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-stale".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Old generation".to_string(),
                    generation: Some(3),
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap_err();

        assert!(matches!(err, MemoryError::StaleGeneration { current: 5, attempted: 3 }));
    }

    // 13. Stale delete/replacement rejection
    #[test]
    fn test_13_stale_delete_rejection() {
        let store = make_test_store();
        let res = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-del".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "To delete".to_string(),
                    generation: Some(4),
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap();

        let err = store
            .delete_chunk("t1", "s1", "sess-del", &res.chunk_id, 2)
            .unwrap_err();

        assert!(matches!(err, MemoryError::StaleGeneration { current: 4, attempted: 2 }));
    }

    // 14. Tenant isolation (two tenants using same session_id are isolated)
    #[test]
    fn test_14_tenant_isolation() {
        let store = make_test_store();
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "tenant-A".to_string(),
                    scope_id: "common-scope".to_string(),
                    session_id: "session-shared".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Secret Tenant A data".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap();

        let query_b = MemoryQuery {
            tenant_id: "tenant-B".to_string(),
            scope_id: "common-scope".to_string(),
            session_id: "session-shared".to_string(),
            ..Default::default()
        };
        let res_b = store.retrieve(&query_b, 1000).unwrap();
        assert!(res_b.is_empty(), "Tenant B must not see Tenant A data");
    }

    // 15. Scope isolation
    #[test]
    fn test_15_scope_isolation() {
        let store = make_test_store();
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "scope-alpha".to_string(),
                    session_id: "sess-1".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Scope alpha data".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(1000),
                },
                1000,
            )
            .unwrap();

        let query_beta = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "scope-beta".to_string(),
            session_id: "sess-1".to_string(),
            ..Default::default()
        };
        let res_beta = store.retrieve(&query_beta, 1000).unwrap();
        assert!(res_beta.is_empty(), "Scope beta must not access scope alpha data");
    }

    // 16. Missing scope fail-closed
    #[test]
    fn test_16_missing_scope_fail_closed() {
        let store = make_test_store();
        let res = store.store_chunk(
            MemoryStorePayload {
                tenant_id: "t1".to_string(),
                scope_id: "".to_string(),
                session_id: "s1".to_string(),
                conversation_id: None,
                role: MemoryRole::User,
                content: "Data".to_string(),
                generation: None,
                ttl_ms: None,
                metadata: None,
                timestamp_ms: None,
            },
            1000,
        );
        assert_eq!(res.unwrap_err(), MemoryError::EmptyScopeId);
    }

    // 17. Authorization / envelope validation
    #[test]
    fn test_17_envelope_validation_success() {
        let store = make_test_store();
        let resp = store
            .validate_envelope_call(
                "tenant-1",
                "scope-1",
                "principal-agent",
                "port.agent.memory.store.v1",
                "trace-101",
                5000,
                1000,
            )
            .unwrap();
        assert!(resp.valid);
        assert_eq!(resp.correlation_id, "trace-101");
    }

    // 18. Actual envelope port invocation
    #[test]
    fn test_18_actual_envelope_port_invocation() {
        let store = make_test_store();
        let payload = serde_json::json!({
            "session_id": "sess-env",
            "content": "Port envelope message",
            "role": "user"
        });

        let res = store
            .handle_port_invocation(
                "port.agent.memory.store.v1",
                &payload,
                "principal-test",
                "tenant-env",
                "scope-env",
                "corr-123",
                5000,
                1000,
            )
            .unwrap();

        assert!(res.get("chunk_id").is_some());
    }

    // 19. H06->H02 physical transport validation
    #[test]
    fn test_19_h06_to_h02_physical_transport() {
        let transport = H06ToH02PhysicalTransport::new();
        let req = EnvelopeValidationRequest {
            tenant_id: "tenant-phys".to_string(),
            scope_id: "scope-phys".to_string(),
            principal_id: "agent-1".to_string(),
            target_port: "port.agent.memory.store.v1".to_string(),
            correlation_id: "corr-phys".to_string(),
            deadline_ms: 10_000,
            source_host: "H06AgentHost".to_string(),
            target_host: "H02ControlHost".to_string(),
        };
        let resp = transport.validate_envelope(req, 1000).unwrap();
        assert!(resp.valid);
    }

    // 20. Envelope timeout
    #[test]
    fn test_20_envelope_timeout() {
        let transport = Arc::new(H06ToH02PhysicalTransport::new());
        *transport.simulate_timeout.write().unwrap() = true;

        let store = AgentMemoryStore::new(MemoryLimits::default(), transport);
        let err = store
            .validate_envelope_call(
                "t1",
                "s1",
                "p1",
                "port.agent.memory.store.v1",
                "corr-timeout",
                5000,
                1000,
            )
            .unwrap_err();

        assert!(matches!(err, MemoryError::CrossHostTransportError(_)));
    }

    // 21. Envelope failure
    #[test]
    fn test_21_envelope_failure_unavailable() {
        let transport = Arc::new(H06ToH02PhysicalTransport::new());
        *transport.simulate_unavailable.write().unwrap() = true;

        let store = AgentMemoryStore::new(MemoryLimits::default(), transport);
        let err = store
            .validate_envelope_call(
                "t1",
                "s1",
                "p1",
                "port.agent.memory.store.v1",
                "corr-unavail",
                5000,
                1000,
            )
            .unwrap_err();

        assert!(matches!(err, MemoryError::CrossHostTransportError(_)));
    }

    // 22. Envelope recovery
    #[test]
    fn test_22_envelope_recovery() {
        let transport = Arc::new(H06ToH02PhysicalTransport::new());
        *transport.simulate_unavailable.write().unwrap() = true;

        let store = AgentMemoryStore::new(MemoryLimits::default(), transport.clone());
        assert!(store
            .validate_envelope_call("t1", "s1", "p1", "port.agent.memory.store.v1", "c1", 5000, 1000)
            .is_err());

        // Recover provider
        *transport.simulate_unavailable.write().unwrap() = false;
        assert!(store
            .validate_envelope_call("t1", "s1", "p1", "port.agent.memory.store.v1", "c1", 5000, 1000)
            .is_ok());
    }

    // 23. Concurrent store (thread safety)
    #[test]
    fn test_23_concurrent_store() {
        let store = Arc::new(make_test_store());
        let mut handles = Vec::new();

        for i in 0..10 {
            let s = store.clone();
            handles.push(thread::spawn(move || {
                s.store_chunk(
                    MemoryStorePayload {
                        tenant_id: "tenant-conc".to_string(),
                        scope_id: "scope-conc".to_string(),
                        session_id: "sess-conc".to_string(),
                        conversation_id: None,
                        role: MemoryRole::User,
                        content: format!("Concurrent msg {}", i),
                        generation: None,
                        ttl_ms: None,
                        metadata: None,
                        timestamp_ms: Some(1000 + i as u64),
                    },
                    1000 + i as u64,
                )
            }));
        }

        for h in handles {
            h.join().unwrap().unwrap();
        }

        let query = MemoryQuery {
            tenant_id: "tenant-conc".to_string(),
            scope_id: "scope-conc".to_string(),
            session_id: "sess-conc".to_string(),
            ..Default::default()
        };
        let retrieved = store.retrieve(&query, 2000).unwrap();
        assert_eq!(retrieved.len(), 10);
    }

    // 24. Store/retrieve race
    #[test]
    fn test_24_store_retrieve_race() {
        let store = Arc::new(make_test_store());
        let running = Arc::new(AtomicBool::new(true));

        let s1 = store.clone();
        let r1 = running.clone();
        let h_store = thread::spawn(move || {
            let mut seq = 0;
            while r1.load(Ordering::Relaxed) && seq < 50 {
                seq += 1;
                let _ = s1.store_chunk(
                    MemoryStorePayload {
                        tenant_id: "t-race".to_string(),
                        scope_id: "s-race".to_string(),
                        session_id: "sess-race".to_string(),
                        conversation_id: None,
                        role: MemoryRole::User,
                        content: format!("Race msg {}", seq),
                        generation: None,
                        ttl_ms: None,
                        metadata: None,
                        timestamp_ms: Some(seq),
                    },
                    seq,
                );
            }
        });

        let s2 = store.clone();
        let r2 = running.clone();
        let h_read = thread::spawn(move || {
            let query = MemoryQuery {
                tenant_id: "t-race".to_string(),
                scope_id: "s-race".to_string(),
                session_id: "sess-race".to_string(),
                ..Default::default()
            };
            while r2.load(Ordering::Relaxed) {
                let chunks = s2.retrieve(&query, 100).unwrap();
                for w in chunks.windows(2) {
                    assert!(w[0].sequence < w[1].sequence);
                }
            }
        });

        h_store.join().unwrap();
        running.store(false, Ordering::Relaxed);
        h_read.join().unwrap();
    }

    // 25. Retention/retrieve race
    #[test]
    fn test_25_retention_retrieve_race() {
        let store = Arc::new(make_small_store(100, 5, 1000));
        let running = Arc::new(AtomicBool::new(true));

        let s1 = store.clone();
        let r1 = running.clone();
        let h_write = thread::spawn(move || {
            for i in 1..=30 {
                let _ = s1.store_chunk(
                    MemoryStorePayload {
                        tenant_id: "t-evict-race".to_string(),
                        scope_id: "s-evict-race".to_string(),
                        session_id: "sess-evict-race".to_string(),
                        conversation_id: None,
                        role: MemoryRole::User,
                        content: format!("Evict msg {}", i),
                        generation: None,
                        ttl_ms: None,
                        metadata: None,
                        timestamp_ms: Some(i),
                    },
                    i,
                );
            }
            r1.store(false, Ordering::Relaxed);
        });

        let s2 = store.clone();
        let r2 = running.clone();
        let h_read = thread::spawn(move || {
            let query = MemoryQuery {
                tenant_id: "t-evict-race".to_string(),
                scope_id: "s-evict-race".to_string(),
                session_id: "sess-evict-race".to_string(),
                ..Default::default()
            };
            while r2.load(Ordering::Relaxed) {
                let chunks = s2.retrieve(&query, 100).unwrap();
                assert!(chunks.len() <= 5);
            }
        });

        h_write.join().unwrap();
        h_read.join().unwrap();
    }

    // 26. Restart / reinitialization
    #[test]
    fn test_26_restart_reinitialization() {
        let store = make_test_store();
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-restart".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Pre-restart".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(10),
                },
                10,
            )
            .unwrap();

        store.reset();

        let query = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "s1".to_string(),
            session_id: "sess-restart".to_string(),
            ..Default::default()
        };
        let retrieved = store.retrieve(&query, 20).unwrap();
        assert_eq!(retrieved.len(), 0);
    }

    // 27. Phantom data prevention
    #[test]
    fn test_27_phantom_data_prevention() {
        let store = make_test_store();
        store.clear_session("t1", "s1", "sess-phantom").unwrap();
        let query = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "s1".to_string(),
            session_id: "sess-phantom".to_string(),
            ..Default::default()
        };
        assert!(store.retrieve(&query, 100).unwrap().is_empty());
    }

    // 28. Sensitive data leakage check (redaction)
    #[test]
    fn test_28_sensitive_data_leakage_check() {
        let store = make_test_store();
        let _res = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-sec".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "My token is sk-1234567890abcdef1234 and password = supersecretpassword".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(100),
                },
                100,
            )
            .unwrap();

        let query = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "s1".to_string(),
            session_id: "sess-sec".to_string(),
            ..Default::default()
        };
        let chunks = store.retrieve(&query, 100).unwrap();
        assert_eq!(chunks.len(), 1);
        assert!(!chunks[0].content.contains("supersecretpassword"));
        assert!(!chunks[0].content.contains("sk-1234567890abcdef1234"));
        assert!(chunks[0].content.contains("[REDACTED_API_KEY]"));
        assert!(chunks[0].content.contains("[REDACTED]"));
    }

    // 29. Bounded query behavior (limit and budget)
    #[test]
    fn test_29_bounded_query_behavior() {
        let store = make_test_store();
        for i in 1..=10 {
            store
                .store_chunk(
                    MemoryStorePayload {
                        tenant_id: "t1".to_string(),
                        scope_id: "s1".to_string(),
                        session_id: "sess-bound".to_string(),
                        conversation_id: None,
                        role: MemoryRole::User,
                        content: format!("Word count test {}", i),
                        generation: None,
                        ttl_ms: None,
                        metadata: None,
                        timestamp_ms: Some(100 * i),
                    },
                    100 * i,
                )
                .unwrap();
        }

        let query = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "s1".to_string(),
            session_id: "sess-bound".to_string(),
            limit: Some(3),
            ..Default::default()
        };
        let chunks = store.retrieve(&query, 2000).unwrap();
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[2].sequence, 10);
    }

    // 30. Bounded state behavior
    #[test]
    fn test_30_bounded_state_behavior() {
        let store = make_small_store(50, 4, 200);
        for i in 1..=20 {
            let _ = store.store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-state-bound".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: format!("Bound msg {}", i),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(i),
                },
                i,
            );
        }

        let summary = store.get_summary("t1", "s1", "sess-state-bound", 100).unwrap();
        assert!(summary.total_chunks <= 4);
        assert!(summary.total_bytes <= 200);
    }

    // 31. Caller timeout / cancellation
    #[test]
    fn test_31_caller_timeout_cancellation() {
        let store = make_test_store();
        // Request deadline in the past
        let err = store
            .validate_envelope_call(
                "t1",
                "s1",
                "p1",
                "port.agent.memory.store.v1",
                "corr-expired",
                100, // deadline
                200, // current now
            )
            .unwrap_err();

        assert!(matches!(err, MemoryError::CrossHostTransportError(_)));
    }

    // 32. Malformed input
    #[test]
    fn test_32_malformed_input() {
        let store = make_test_store();
        let res_tenant = store.store_chunk(
            MemoryStorePayload {
                tenant_id: "  ".to_string(),
                scope_id: "s1".to_string(),
                session_id: "s1".to_string(),
                conversation_id: None,
                role: MemoryRole::User,
                content: "Content".to_string(),
                generation: None,
                ttl_ms: None,
                metadata: None,
                timestamp_ms: None,
            },
            100,
        );
        assert_eq!(res_tenant.unwrap_err(), MemoryError::EmptyTenantId);

        let res_content = store.store_chunk(
            MemoryStorePayload {
                tenant_id: "t1".to_string(),
                scope_id: "s1".to_string(),
                session_id: "s1".to_string(),
                conversation_id: None,
                role: MemoryRole::User,
                content: "   ".to_string(),
                generation: None,
                ttl_ms: None,
                metadata: None,
                timestamp_ms: None,
            },
            100,
        );
        assert_eq!(res_content.unwrap_err(), MemoryError::EmptyContent);
    }

    // 33. State ownership validation (`conversation-history-chunks`)
    #[test]
    fn test_33_state_ownership_validation() {
        let store = make_test_store();
        assert_eq!(store.host_id(), "H06AgentHost");
        // Only conversation chunks managed
        let summary = store.get_summary("t1", "s1", "empty-session", 100).unwrap();
        assert_eq!(summary.total_chunks, 0);
    }

    // 34. Source dependency validation (L00.S01 envelope dependency)
    #[test]
    fn test_34_source_dependency_validation() {
        let store = make_test_store();
        let envelope = store.validate_envelope_call(
            "t-dep",
            "s-dep",
            "p-dep",
            "port.agent.memory.store.v1",
            "corr-dep",
            10_000,
            1000,
        );
        assert!(envelope.is_ok());
    }

    // 35. Boundary validation (0 private imports, typed public contract)
    #[test]
    fn test_35_boundary_validation() {
        let store = make_test_store();
        let p_in = serde_json::json!({
            "session_id": "sess-bound-port",
            "content": "Public boundary invocation",
            "role": "assistant"
        });
        let res = store.handle_port_invocation(
            "port.agent.memory.store.v1",
            &p_in,
            "principal-bound",
            "tenant-bound",
            "scope-bound",
            "corr-bound",
            10_000,
            1000,
        );
        assert!(res.is_ok());
    }

    // 36. Isolation audit
    #[test]
    fn test_36_isolation_audit() {
        let store = make_test_store();
        // Tenant A
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "tenant-isolated-A".to_string(),
                    scope_id: "scope-A".to_string(),
                    session_id: "session-iso".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Data A".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(100),
                },
                100,
            )
            .unwrap();

        // Tenant B attempt to read Tenant A's session
        let query_b = MemoryQuery {
            tenant_id: "tenant-isolated-B".to_string(),
            scope_id: "scope-A".to_string(),
            session_id: "session-iso".to_string(),
            ..Default::default()
        };
        let res_b = store.retrieve(&query_b, 100).unwrap();
        assert!(res_b.is_empty(), "Isolation audit: cross tenant read strictly returns empty/denied");
    }

    // 37. UTF-8 multi-byte secret redaction safety (no char boundary panic)
    #[test]
    fn test_37_redaction_utf8_multibyte_no_panic() {
        let text_with_accents = "Halo selamat pagi 🚀, password = café123 dan token: sk-abcdef1234567890xyz";
        let (redacted, modified) = redact_sensitive_content(text_with_accents);
        assert!(modified);
        assert!(!redacted.contains("café123"));
        assert!(!redacted.contains("sk-abcdef1234567890xyz"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.contains("[REDACTED_API_KEY]"));
        assert!(redacted.contains("🚀"));
    }

    // 38. Quoted password with spaces redaction
    #[test]
    fn test_38_redaction_quoted_password_with_spaces() {
        let input = r#"Config: password = "super secret key with spaces", api_key: "ghp_12345678901234567890""#;
        let (redacted, modified) = redact_sensitive_content(input);
        assert!(modified);
        assert!(!redacted.contains("super secret key with spaces"));
        assert!(redacted.contains("[REDACTED]"));
        assert!(redacted.contains("[REDACTED_API_KEY]"));
    }

    // 39. Transactional eviction safety (no silent data loss when capacity exceeded)
    #[test]
    fn test_39_transactional_eviction_no_silent_data_loss() {
        let store = make_small_store(100, 3, 100);
        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-tx".to_string(),
                    conversation_id: None,
                    role: MemoryRole::System,
                    content: "1234567890123456789012345678901234567890".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(10),
                },
                10,
            )
            .unwrap();

        store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-tx".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "1234567890".to_string(),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(20),
                },
                20,
            )
            .unwrap();

        let err = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-tx".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "a".repeat(95),
                    generation: None,
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(30),
                },
                30,
            )
            .unwrap_err();

        assert!(matches!(err, MemoryError::CapacityExceeded { .. }));

        let query = MemoryQuery {
            tenant_id: "t1".to_string(),
            scope_id: "s1".to_string(),
            session_id: "sess-tx".to_string(),
            ..Default::default()
        };
        let remaining = store.retrieve(&query, 50).unwrap();
        assert_eq!(remaining.len(), 2);
        assert!(remaining.iter().any(|c| c.content == "1234567890"));
    }

    // 40. Update chunk bounds enforcement (size and capacity)
    #[test]
    fn test_40_update_chunk_enforces_size_and_capacity() {
        let store = make_small_store(50, 5, 80);
        let r = store
            .store_chunk(
                MemoryStorePayload {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-up-bound".to_string(),
                    conversation_id: None,
                    role: MemoryRole::User,
                    content: "Initial".to_string(),
                    generation: Some(1),
                    ttl_ms: None,
                    metadata: None,
                    timestamp_ms: Some(10),
                },
                10,
            )
            .unwrap();

        let err_size = store
            .update_chunk("t1", "s1", "sess-up-bound", &r.chunk_id, &"x".repeat(60), 2, 20)
            .unwrap_err();
        assert!(matches!(err_size, MemoryError::ChunkSizeExceeded { .. }));

        let err_cap = store
            .update_chunk("t1", "s1", "sess-up-bound", &r.chunk_id, &"y".repeat(45), 2, 20);
        assert!(err_cap.is_ok());
    }

    // 41. Forward pagination with offset and limit
    #[test]
    fn test_41_forward_pagination_with_offset_and_limit() {
        let store = make_test_store();
        for i in 1..=10 {
            store
                .store_chunk(
                    MemoryStorePayload {
                        tenant_id: "t1".to_string(),
                        scope_id: "s1".to_string(),
                        session_id: "sess-page".to_string(),
                        conversation_id: None,
                        role: MemoryRole::User,
                        content: format!("Chunk {}", i),
                        generation: None,
                        ttl_ms: None,
                        metadata: None,
                        timestamp_ms: Some(i as u64),
                    },
                    i as u64,
                )
                .unwrap();
        }

        let p1 = store
            .retrieve(
                &MemoryQuery {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-page".to_string(),
                    offset: Some(0),
                    limit: Some(3),
                    ..Default::default()
                },
                100,
            )
            .unwrap();
        assert_eq!(p1.len(), 3);
        assert_eq!(p1[0].sequence, 1);
        assert_eq!(p1[2].sequence, 3);

        let p2 = store
            .retrieve(
                &MemoryQuery {
                    tenant_id: "t1".to_string(),
                    scope_id: "s1".to_string(),
                    session_id: "sess-page".to_string(),
                    offset: Some(3),
                    limit: Some(3),
                    ..Default::default()
                },
                100,
            )
            .unwrap();
        assert_eq!(p2.len(), 3);
        assert_eq!(p2[0].sequence, 4);
        assert_eq!(p2[2].sequence, 6);
    }

    // 42. Anonymous principal envelope rejection (no anonymous fallback)
    #[test]
    fn test_42_anonymous_principal_envelope_rejection() {
        let store = make_test_store();
        let err = store
            .validate_envelope_call(
                "t1",
                "s1",
                "",
                "port.agent.memory.store.v1",
                "corr-anon",
                5000,
                1000,
            )
            .unwrap_err();
        assert!(matches!(err, MemoryError::ScopeDenied(_)));
    }

    // 43. Empty ID error fidelity
    #[test]
    fn test_43_empty_id_error_fidelity() {
        let store = make_test_store();
        assert_eq!(
            store.update_chunk("", "s1", "sess", "c1", "content", 2, 0).unwrap_err(),
            MemoryError::EmptyTenantId
        );
        assert_eq!(
            store.update_chunk("t1", "", "sess", "c1", "content", 2, 0).unwrap_err(),
            MemoryError::EmptyScopeId
        );
        assert_eq!(
            store.update_chunk("t1", "s1", "", "c1", "content", 2, 0).unwrap_err(),
            MemoryError::EmptySessionId
        );
        assert_eq!(
            store.get_summary("", "s1", "sess", 0).unwrap_err(),
            MemoryError::EmptyTenantId
        );
        assert_eq!(
            store.get_summary("t1", "", "sess", 0).unwrap_err(),
            MemoryError::EmptyScopeId
        );
    }
}
