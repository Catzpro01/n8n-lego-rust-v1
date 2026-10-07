//! Unit tests for L04.S07 Browser/scraper hybrid capability

use super::*;
use serde_json::json;

#[test]
fn test_acquire_and_reuse_session() {
    let pool = BrowserSessionPoolService::new(5, 60_000);
    let s1 = pool.acquire_session("sess-1", Some("CustomUA/1.0"), Some(1000)).unwrap();
    assert_eq!(s1.session_id, "sess-1");
    assert_eq!(s1.status, SessionStatus::Leased);
    assert_eq!(s1.user_agent, "CustomUA/1.0");

    // Release session back to Idle
    pool.release_session("sess-1", Some(1500)).unwrap();

    // Re-acquire same session
    let s1_reacquired = pool.acquire_session("sess-1", None, Some(2000)).unwrap();
    assert_eq!(s1_reacquired.status, SessionStatus::Leased);
    assert_eq!(s1_reacquired.last_used_at_ms, 2000);
}

#[test]
fn test_pool_capacity_limit_enforced() {
    let pool = BrowserSessionPoolService::new(2, 60_000);
    pool.acquire_session("s1", None, None).unwrap();
    pool.acquire_session("s2", None, None).unwrap();

    let err = pool.acquire_session("s3", None, None);
    assert!(err.is_err());
    match err.unwrap_err() {
        BrowserError::PoolCapacityExceeded { max_capacity } => assert_eq!(max_capacity, 2),
        other => panic!("Unexpected error: {:?}", other),
    }
}

#[test]
fn test_session_termination_and_pruning() {
    let pool = BrowserSessionPoolService::new(5, 10_000);
    pool.acquire_session("s1", None, Some(1000)).unwrap();
    pool.acquire_session("s2", None, Some(1000)).unwrap();

    pool.terminate_session("s1").unwrap();

    // Reusing terminated session should fail
    let reuse_err = pool.acquire_session("s1", None, Some(2000));
    assert!(reuse_err.is_err());

    // Prune stale sessions with simulated future clock
    let pruned = pool.prune_stale_sessions(Some(15_000));
    assert_eq!(pruned, 2); // s1 (terminated) and s2 (expired > 10s ttl)
}

#[test]
fn test_render_page_success() {
    let pool = BrowserSessionPoolService::new(5, 60_000);
    pool.acquire_session("render-sess", None, None).unwrap();

    let opts = RenderOptions {
        wait_for_selector: Some("#main".to_string()),
        timeout_ms: 5000,
        capture_screenshot: true,
        extract_html: true,
    };

    let res = pool.render_page("render-sess", "https://example.com/data", &opts, None).unwrap();
    assert_eq!(res.status_code, 200);
    assert!(res.html.unwrap().contains("Rendered from https://example.com/data"));
    assert!(res.screenshot_base64.is_some());
}

#[test]
fn test_render_invalid_url_fails() {
    let pool = BrowserSessionPoolService::new(5, 60_000);
    pool.acquire_session("sess-bad", None, None).unwrap();

    let opts = RenderOptions::default();
    assert!(pool.render_page("sess-bad", "ftp://invalid-proto", &opts, None).is_err());
    assert!(pool.render_page("sess-bad", "", &opts, None).is_err());
}

#[test]
fn test_scrape_hybrid_execution() {
    let pool = BrowserSessionPoolService::new(5, 60_000);
    pool.acquire_session("scrape-sess", None, None).unwrap();

    let rules = vec![
        ExtractRule {
            name: "headline".to_string(),
            selector: "h1".to_string(),
            attribute: None,
        },
        ExtractRule {
            name: "price".to_string(),
            selector: ".price".to_string(),
            attribute: None,
        },
    ];

    let scrape = pool.scrape_hybrid("scrape-sess", "https://shop.example.com", &rules, None).unwrap();
    assert_eq!(scrape.extracted_fields.len(), 2);
    assert!(scrape.extracted_fields.contains_key("headline"));
    assert!(scrape.extracted_fields.contains_key("price"));
}

#[test]
fn test_port_render_handler() {
    let pool = BrowserSessionPoolService::new(5, 60_000);
    let payload = json!({
        "action": "render",
        "session_id": "port-sess-1",
        "url": "https://service.local/dashboard",
        "screenshot": true
    });

    let resp = pool.handle_port_browser_render(&payload).unwrap();
    assert_eq!(resp["success"], true);
    assert_eq!(resp["session_id"], "port-sess-1");
    assert_eq!(resp["status_code"], 200);

    let release_payload = json!({
        "action": "release",
        "session_id": "port-sess-1"
    });
    let release_resp = pool.handle_port_browser_render(&release_payload).unwrap();
    assert_eq!(release_resp["success"], true);
}

#[test]
fn test_port_hybrid_handler() {
    let pool = BrowserSessionPoolService::new(5, 60_000);
    let payload = json!({
        "action": "scrape",
        "session_id": "port-sess-2",
        "url": "https://news.ycombinator.com",
        "rules": [
            { "name": "top_story", "selector": ".titleline > a" }
        ]
    });

    let resp = pool.handle_port_browser_hybrid(&payload).unwrap();
    assert_eq!(resp["success"], true);
    assert!(resp["extracted"]["top_story"].is_string());
}
