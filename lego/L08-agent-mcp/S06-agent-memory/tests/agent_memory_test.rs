//! Unit tests for L08.S06 Agent memory

#[cfg(test)]
mod tests {
    use crate::*;
    use std::collections::HashMap;

    #[test]
    fn test_store_and_retrieve_basic() {
        let store = AgentMemoryStore::new(1000);
        let chunk = store
            .store_chunk(
                "session-1",
                MemoryRole::User,
                "Hello, can you help me optimize my workflow?",
                HashMap::new(),
                1000,
            )
            .unwrap();

        assert_eq!(chunk.session_id, "session-1");
        assert_eq!(chunk.role, MemoryRole::User);
        assert!(chunk.token_count > 0);

        let query = MemoryQuery {
            session_id: "session-1".to_string(),
            max_tokens: None,
            limit: None,
            roles: None,
        };
        let retrieved = store.retrieve(&query).unwrap();
        assert_eq!(retrieved.len(), 1);
        assert_eq!(retrieved[0].chunk_id, chunk.chunk_id);
    }

    #[test]
    fn test_empty_session_id_fails_closed() {
        let store = AgentMemoryStore::new(1000);
        let res = store.store_chunk("  ", MemoryRole::User, "Hello", HashMap::new(), 1000);
        assert_eq!(res.unwrap_err(), MemoryError::EmptySessionId);

        let query = MemoryQuery {
            session_id: "".to_string(),
            max_tokens: None,
            limit: None,
            roles: None,
        };
        assert_eq!(store.retrieve(&query).unwrap_err(), MemoryError::EmptySessionId);
    }

    #[test]
    fn test_empty_content_fails_closed() {
        let store = AgentMemoryStore::new(1000);
        let res = store.store_chunk("session-1", MemoryRole::User, "   \n\t", HashMap::new(), 1000);
        assert_eq!(res.unwrap_err(), MemoryError::EmptyContent);
    }

    #[test]
    fn test_memory_role_filtering() {
        let store = AgentMemoryStore::new(2000);
        store
            .store_chunk("sess-filter", MemoryRole::System, "You are a helpful assistant.", HashMap::new(), 100)
            .unwrap();
        store
            .store_chunk("sess-filter", MemoryRole::User, "What is 2+2?", HashMap::new(), 200)
            .unwrap();
        store
            .store_chunk("sess-filter", MemoryRole::Assistant, "4", HashMap::new(), 300)
            .unwrap();

        let query_user = MemoryQuery {
            session_id: "sess-filter".to_string(),
            max_tokens: None,
            limit: None,
            roles: Some(vec![MemoryRole::User]),
        };
        let res = store.retrieve(&query_user).unwrap();
        assert_eq!(res.len(), 1);
        assert_eq!(res[0].role, MemoryRole::User);

        let query_assistant = MemoryQuery {
            session_id: "sess-filter".to_string(),
            max_tokens: None,
            limit: None,
            roles: Some(vec![MemoryRole::Assistant]),
        };
        let res_asst = store.retrieve(&query_assistant).unwrap();
        assert_eq!(res_asst.len(), 1);
        assert_eq!(res_asst[0].content, "4");
    }

    #[test]
    fn test_sliding_window_max_tokens_budget() {
        let store = AgentMemoryStore::new(5000);
        // Create 5 chunks each ~10 tokens
        for i in 1..=5 {
            store
                .store_chunk(
                    "sess-budget",
                    MemoryRole::User,
                    &format!("This is message number {} with some text", i),
                    HashMap::new(),
                    i * 100,
                )
                .unwrap();
        }

        // Query with max_tokens budget that fits only the 2 most recent
        let query = MemoryQuery {
            session_id: "sess-budget".to_string(),
            max_tokens: Some(25),
            limit: None,
            roles: None,
        };
        let res = store.retrieve(&query).unwrap();
        assert!(res.len() <= 2);
        let total_tokens: usize = res.iter().map(|c| c.token_count).sum();
        assert!(total_tokens <= 25);
    }

    #[test]
    fn test_capacity_eviction_preserves_system_prompt() {
        let store = AgentMemoryStore::new(40);
        store
            .store_chunk("sess-evict", MemoryRole::System, "System prompt header", HashMap::new(), 100)
            .unwrap();
        store
            .store_chunk("sess-evict", MemoryRole::User, "First user message", HashMap::new(), 200)
            .unwrap();
        store
            .store_chunk("sess-evict", MemoryRole::Assistant, "First response", HashMap::new(), 300)
            .unwrap();
        // Adding more should evict oldest non-system chunk
        store
            .store_chunk("sess-evict", MemoryRole::User, "Second message", HashMap::new(), 400)
            .unwrap();

        let query = MemoryQuery {
            session_id: "sess-evict".to_string(),
            max_tokens: None,
            limit: None,
            roles: None,
        };
        let chunks = store.retrieve(&query).unwrap();
        assert!(chunks.iter().any(|c| c.role == MemoryRole::System));
    }

    #[test]
    fn test_summary_and_clear_lifecycle() {
        let store = AgentMemoryStore::new(1000);
        store
            .store_chunk("sess-sum", MemoryRole::User, "Hello world", HashMap::new(), 100)
            .unwrap();
        store
            .store_chunk("sess-sum", MemoryRole::Assistant, "Hi there", HashMap::new(), 200)
            .unwrap();

        let summary = store.get_summary("sess-sum").unwrap();
        assert_eq!(summary.total_chunks, 2);
        assert_eq!(summary.oldest_timestamp_ms, 100);
        assert_eq!(summary.newest_timestamp_ms, 200);

        let removed = store.clear_session("sess-sum").unwrap();
        assert_eq!(removed, 2);

        let summary_after = store.get_summary("sess-sum").unwrap();
        assert_eq!(summary_after.total_chunks, 0);
    }

    #[test]
    fn test_monotonic_chunk_id_unique_after_eviction() {
        // Capacity for ~5 tokens (approx 20 chars total)
        let store = AgentMemoryStore::new(6);
        let c1 = store
            .store_chunk("sess-seq", MemoryRole::User, "Msg1", HashMap::new(), 10)
            .unwrap();
        let c2 = store
            .store_chunk("sess-seq", MemoryRole::User, "Msg2", HashMap::new(), 20)
            .unwrap();
        let c3 = store
            .store_chunk("sess-seq", MemoryRole::User, "Msg3", HashMap::new(), 30)
            .unwrap();

        // Adding c4 causes eviction of c1
        let c4 = store
            .store_chunk("sess-seq", MemoryRole::User, "Msg4", HashMap::new(), 40)
            .unwrap();

        assert_eq!(c1.chunk_id, "chunk-sess-seq-1");
        assert_eq!(c2.chunk_id, "chunk-sess-seq-2");
        assert_eq!(c3.chunk_id, "chunk-sess-seq-3");
        assert_eq!(c4.chunk_id, "chunk-sess-seq-4");
        // Verify c4 chunk_id did not collide with c3
        assert_ne!(c4.chunk_id, c3.chunk_id);
    }
}
