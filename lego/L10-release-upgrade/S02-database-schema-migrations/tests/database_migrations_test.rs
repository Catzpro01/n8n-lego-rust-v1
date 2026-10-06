//! Unit tests for L10.S02 Database/schema migrations

#[cfg(test)]
mod tests {
    use crate::*;
    use serde_json::json;

    #[test]
    fn test_initial_status_shows_pending_migrations() {
        let service = DatabaseMigrationService::new();
        let st = service.status();

        assert_eq!(st.current_version, 0);
        assert_eq!(st.total_migrations, 3);
        assert_eq!(st.applied_migrations, 0);
        assert_eq!(st.pending_migrations, 3);
        assert!(!st.is_synchronized);
    }

    #[test]
    fn test_apply_all_migrations_success() {
        let service = DatabaseMigrationService::new();
        let count = service.apply_all(1000).unwrap();
        assert_eq!(count, 3);

        let st = service.status();
        assert_eq!(st.current_version, 3);
        assert_eq!(st.applied_migrations, 3);
        assert_eq!(st.pending_migrations, 0);
        assert!(st.is_synchronized);
    }

    #[test]
    fn test_apply_idempotency_when_already_applied() {
        let service = DatabaseMigrationService::new();
        service.apply_all(1000).unwrap();

        // Second apply does nothing
        let second = service.apply_all(2000).unwrap();
        assert_eq!(second, 0);
        assert_eq!(service.status().current_version, 3);
    }

    #[test]
    fn test_rollback_decrements_version() {
        let service = DatabaseMigrationService::new();
        service.apply_all(1000).unwrap();

        let rolled = service.rollback_last().unwrap();
        assert_eq!(rolled, Some(3));
        assert_eq!(service.status().current_version, 2);
        assert_eq!(service.status().pending_migrations, 1);
    }

    #[test]
    fn test_out_of_order_migration_rejected() {
        let service = DatabaseMigrationService::new();
        // Register version 5 skipping 4
        service.register_migration(
            5,
            "0005_skipped",
            "CREATE TABLE skipped (id TEXT);",
            "DROP TABLE skipped;",
            "chk_0005",
        );

        let err = service.apply_all(1000);
        assert!(matches!(err, Err(MigrationError::OutOfOrderVersion { current: 3, attempted: 5 })));
    }

    #[test]
    fn test_port_handler_apply_and_status_flow() {
        let service = DatabaseMigrationService::new();

        // 1. Port Status initially
        let s_init = service.handle_port_migration(&json!({"action": "status"})).unwrap();
        assert_eq!(s_init["success"], true);
        assert_eq!(s_init["status"]["current_version"], 0);

        // 2. Port Apply
        let s_apply = service
            .handle_port_migration(&json!({
                "action": "apply",
                "now_ms": 1000
            }))
            .unwrap();
        assert_eq!(s_apply["success"], true);
        assert_eq!(s_apply["applied_count"], 3);
        assert_eq!(s_apply["current_version"], 3);
        assert_eq!(s_apply["is_synchronized"], true);

        // 3. Port Rollback
        let s_rb = service.handle_port_migration(&json!({"action": "rollback"})).unwrap();
        assert_eq!(s_rb["success"], true);
        assert_eq!(s_rb["rolled_back_version"], 3);
        assert_eq!(s_rb["current_version"], 2);
    }

    #[test]
    fn test_checksum_mismatch_detected_on_tampered_migration() {
        let service = DatabaseMigrationService::new();
        // 1. Initial apply succeeds
        service.apply_all(1000).unwrap();

        // 2. Tamper migration catalog: overwrite version 2 with a modified checksum
        {
            let mut cat = service.catalog.write().unwrap();
            for m in cat.iter_mut() {
                if m.version == 2 {
                    m.checksum = "chk_0002_TAMPERED".to_string();
                }
            }
        }

        // 3. Subsequent apply_all must detect the checksum mismatch fail-closed
        let err = service.apply_all(2000);
        match err {
            Err(MigrationError::ChecksumMismatch { version, expected, found }) => {
                assert_eq!(version, 2);
                assert_eq!(expected, "chk_0002_v1");
                assert_eq!(found, "chk_0002_TAMPERED");
            }
            other => panic!("Expected ChecksumMismatch, got {:?}", other),
        }
    }
}
