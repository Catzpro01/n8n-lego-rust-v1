//! Unit tests for L08.S09 Usage accounting and audit

#[cfg(test)]
mod tests {
    use crate::*;

    fn create_test_record(audit_id: &str, tenant: &str, session: &str) -> TokenAuditRecord {
        TokenAuditRecord {
            audit_id: audit_id.to_string(),
            session_id: session.to_string(),
            tenant_id: tenant.to_string(),
            user_id: "user-42".to_string(),
            model: "claude-3-5-sonnet".to_string(),
            prompt_tokens: 1500,
            completion_tokens: 500,
            total_tokens: 0, // Should be computed
            cost_usd: 0.015,
            latency_ms: 850,
            tool_calls_count: 2,
            timestamp_ms: 1720000000,
        }
    }

    #[test]
    fn test_record_usage_and_total_calculation() {
        let service = UsageAccountingAuditService::new();
        let rec = create_test_record("audit-1", "tenant-alpha", "sess-100");

        let saved = service.record_usage(rec).unwrap();
        assert_eq!(saved.total_tokens, 2000);
        assert_eq!(saved.audit_id, "audit-1");

        let summary = service.summarize_usage(&UsageAuditQuery {
            tenant_id: Some("tenant-alpha".to_string()),
            user_id: None,
            session_id: None,
            from_timestamp_ms: None,
            to_timestamp_ms: None,
        });

        assert_eq!(summary.record_count, 1);
        assert_eq!(summary.total_tokens, 2000);
        assert_eq!(summary.total_tool_calls, 2);
    }

    #[test]
    fn test_empty_identifier_fails_closed() {
        let service = UsageAccountingAuditService::new();
        let mut rec = create_test_record("", "tenant-alpha", "sess-1");
        assert_eq!(service.record_usage(rec).unwrap_err(), UsageAuditError::EmptyIdentifier);

        let mut rec2 = create_test_record("audit-2", "", "sess-1");
        assert_eq!(service.record_usage(rec2).unwrap_err(), UsageAuditError::EmptyIdentifier);
    }

    #[test]
    fn test_zero_tokens_fails_closed() {
        let service = UsageAccountingAuditService::new();
        let mut rec = create_test_record("audit-3", "tenant-alpha", "sess-1");
        rec.prompt_tokens = 0;
        rec.completion_tokens = 0;
        assert_eq!(
            service.record_usage(rec).unwrap_err(),
            UsageAuditError::InvalidTokenCount { prompt: 0, completion: 0 }
        );
    }

    #[test]
    fn test_negative_cost_fails_closed() {
        let service = UsageAccountingAuditService::new();
        let mut rec = create_test_record("audit-4", "tenant-alpha", "sess-1");
        rec.cost_usd = -0.5;
        assert_eq!(
            service.record_usage(rec).unwrap_err(),
            UsageAuditError::InvalidCost(-0.5)
        );
    }

    #[test]
    fn test_query_filtering_and_summarization() {
        let service = UsageAccountingAuditService::new();
        let mut rec1 = create_test_record("a1", "tenant-1", "sess-1");
        rec1.timestamp_ms = 1000;
        service.record_usage(rec1).unwrap();

        let mut rec2 = create_test_record("a2", "tenant-2", "sess-2");
        rec2.timestamp_ms = 2000;
        service.record_usage(rec2).unwrap();

        let query = UsageAuditQuery {
            tenant_id: Some("tenant-1".to_string()),
            user_id: None,
            session_id: None,
            from_timestamp_ms: None,
            to_timestamp_ms: None,
        };

        let records = service.query_records(&query);
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].tenant_id, "tenant-1");

        let summary = service.summarize_usage(&query);
        assert_eq!(summary.record_count, 1);
        assert_eq!(summary.total_tokens, 2000);
    }
}
