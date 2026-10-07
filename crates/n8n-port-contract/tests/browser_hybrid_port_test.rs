//! Port contract integration tests for L04.S07 Browser/scraper hybrid capability

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::Arc;

#[tokio::test]
async fn test_browser_render_and_hybrid_ports_roundtrip() {
    let adapter = InProcessAdapter::new();
    let render_port_id = PortId::new("port.node.browser.render.v1");
    let hybrid_port_id = PortId::new("port.node.browser.hybrid.v1");

    // 1. Register handler for render port
    let render_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let url = val.get("url").and_then(|v| v.as_str()).unwrap_or("");
                let session_id = val.get("session_id").and_then(|v| v.as_str()).unwrap_or("sess-1");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "session_id": session_id,
                        "url": url,
                        "status_code": 200,
                        "title": "Rendered Page",
                        "render_time_ms": 75
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    // 2. Register handler for hybrid scrape port
    let hybrid_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let url = val.get("url").and_then(|v| v.as_str()).unwrap_or("");
                PortResponse::success(
                    inv.invocation_id,
                    PortPayload::Json(json!({
                        "success": true,
                        "url": url,
                        "title": "Extracted News",
                        "extracted": {
                            "top_title": "Rust Async in Production"
                        },
                        "execution_time_ms": 90
                    })),
                    PortTelemetry::new(trace_id),
                )
            } else {
                PortResponse::error(
                    inv.invocation_id,
                    PortStatus::ClientError,
                    n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Invalid payload", false),
                    PortTelemetry::new(trace_id),
                )
            }
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(render_port_id.clone(), render_handler).await;
    adapter.register_handler(hybrid_port_id.clone(), hybrid_handler).await;

    let sec_ctx = SecurityContext::builder("worker-host", "tenant-hybrid-1")
        .authority_scope(vec![
            "port.node.browser.render.v1".to_string(),
            "port.node.browser.hybrid.v1".to_string(),
        ])
        .build();

    // Invocation 1: Render port
    let render_inv = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L04.S07"),
        render_port_id,
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "render",
            "session_id": "sess-live-1",
            "url": "https://docs.n8n.io"
        })),
    );

    let render_res = adapter.invoke(render_inv).await;
    assert_eq!(render_res.status, PortStatus::Success);
    if let PortPayload::Json(data) = render_res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["session_id"], "sess-live-1");
        assert_eq!(data["status_code"], 200);
    } else {
        panic!("Expected json payload for render response");
    }

    // Invocation 2: Hybrid port
    let hybrid_inv = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L04.S07"),
        hybrid_port_id,
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "scrape",
            "url": "https://news.ycombinator.com",
            "rules": [{ "name": "top_title", "selector": "h1" }]
        })),
    );

    let hybrid_res = adapter.invoke(hybrid_inv).await;
    assert_eq!(hybrid_res.status, PortStatus::Success);
    if let PortPayload::Json(data) = hybrid_res.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["extracted"]["top_title"], "Rust Async in Production");
    } else {
        panic!("Expected json payload for hybrid response");
    }
}

#[tokio::test]
async fn test_browser_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let port_id = PortId::new("port.node.browser.render.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(port_id.clone(), dummy_handler).await;

    let unauthorized_ctx = SecurityContext::builder("untrusted-caller", "tenant-unauth")
        .authority_scope(vec!["other.unrelated.port.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L04.S01"),
        SubLegoId::new("L04.S07"),
        port_id,
        ContractVersion::V1,
        RuntimeHostId::H04WorkerHost,
        unauthorized_ctx,
        PortPayload::Json(json!({
            "action": "render",
            "url": "https://secret.internal.net"
        })),
    );

    let res = adapter.invoke(inv).await;
    assert_eq!(res.status, PortStatus::SecurityDenied);
}
