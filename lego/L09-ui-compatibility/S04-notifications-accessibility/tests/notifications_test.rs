//! Unit tests for L09.S04 Notifications/accessibility parity

#[cfg(test)]
mod tests {
    use crate::*;

    #[test]
    fn test_publish_notification_accessibility_mapping() {
        let service = UiNotificationService::new(10);
        let n_err = service
            .publish_notification(
                "notif-1",
                "Execution Failed",
                "Workflow run timed out",
                NotificationLevel::Error,
                true,
                None,
                1000,
            )
            .unwrap();

        assert_eq!(n_err.aria_live, AriaLiveSetting::Assertive);
        assert_eq!(n_err.aria_role, "alert");
        assert!(n_err.is_banner);

        let n_info = service
            .publish_notification(
                "notif-2",
                "Saved",
                "Workflow version saved successfully",
                NotificationLevel::Success,
                false,
                Some(3000),
                2000,
            )
            .unwrap();

        assert_eq!(n_info.aria_live, AriaLiveSetting::Polite);
        assert_eq!(n_info.aria_role, "status");
        assert!(!n_info.is_banner);
    }

    #[test]
    fn test_empty_content_fails_closed() {
        let service = UiNotificationService::new(10);
        let err = service.publish_notification(
            "notif-empty",
            "",
            "Valid message",
            NotificationLevel::Info,
            false,
            None,
            1000,
        );
        assert_eq!(err.unwrap_err(), NotificationError::EmptyContent);

        let err2 = service.publish_notification(
            "notif-empty2",
            "Valid title",
            "   ",
            NotificationLevel::Info,
            false,
            None,
            1000,
        );
        assert_eq!(err2.unwrap_err(), NotificationError::EmptyContent);
    }

    #[test]
    fn test_query_filtering_and_limit() {
        let service = UiNotificationService::new(10);
        service
            .publish_notification("n1", "T1", "M1", NotificationLevel::Warning, false, None, 100)
            .unwrap();
        service
            .publish_notification("n2", "T2", "M2", NotificationLevel::Warning, true, None, 200)
            .unwrap();
        service
            .publish_notification("n3", "T3", "M3", NotificationLevel::Info, false, None, 300)
            .unwrap();

        let query_warn = NotificationQuery {
            level: Some(NotificationLevel::Warning),
            is_banner: None,
            limit: None,
        };
        let res = service.query_notifications(&query_warn);
        assert_eq!(res.len(), 2);

        let query_banner = NotificationQuery {
            level: None,
            is_banner: Some(true),
            limit: None,
        };
        let res_banner = service.query_notifications(&query_banner);
        assert_eq!(res_banner.len(), 1);
        assert_eq!(res_banner[0].notification_id, "n2");
    }

    #[test]
    fn test_dismiss_lifecycle() {
        let service = UiNotificationService::new(10);
        service
            .publish_notification("n-dismiss", "T", "M", NotificationLevel::Info, false, None, 100)
            .unwrap();

        service.dismiss("n-dismiss").unwrap();

        let not_found = service.dismiss("n-dismiss");
        assert_eq!(not_found.unwrap_err(), NotificationError::NotFound("n-dismiss".to_string()));
    }

    #[test]
    fn test_capacity_overflow_fails_closed() {
        let service = UiNotificationService::new(2);
        service
            .publish_notification("n1", "T1", "M1", NotificationLevel::Info, false, None, 100)
            .unwrap();
        service
            .publish_notification("n2", "T2", "M2", NotificationLevel::Info, false, None, 200)
            .unwrap();

        let err = service.publish_notification("n3", "T3", "M3", NotificationLevel::Info, false, None, 300);
        assert_eq!(err.unwrap_err(), NotificationError::QueueFull(2));
    }
}
