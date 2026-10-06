//! Port contract integration tests for L09.S01 Official Vue surface compatibility

use n8n_port_contract::{
    ContractVersion, InProcessAdapter, PortAdapter, PortErrorCode, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId,
};
use serde_json::json;
use std::sync::{Arc, Mutex};

struct TestStaticServer {
    files: std::collections::HashMap<String, String>,
}

#[tokio::test]
async fn test_vue_surface_static_serve_port_roundtrip() {
    let adapter = InProcessAdapter::new();
    let serve_port = PortId::new("port.ui.static.serve.v1");

    let server_state = Arc::new(Mutex::new(TestStaticServer {
        files: {
            let mut m = std::collections::HashMap::new();
            m.insert("/index.html".to_string(), "<html>n8n Vue App</html>".to_string());
            m.insert("/assets/app.js".to_string(), "console.log('n8n');".to_string());
            m
        },
    }));

    let server_clone = server_state.clone();
    let serve_handler = Arc::new(move |inv: PortInvocation| {
        let server = server_clone.clone();
        Box::pin(async move {
            let trace_id = inv.security_context.correlation_id.clone();
            if let PortPayload::Json(val) = inv.payload {
                let action = val.get("action").and_then(|v| v.as_str()).unwrap_or("serve");
                let path = val.get("path").and_then(|v| v.as_str()).unwrap_or("/");

                match action {
                    "serve" => {
                        let lock = server.lock().unwrap();
                        let target = if path == "/" || !path.contains('.') {
                            "/index.html"
                        } else {
                            path
                        };

                        if let Some(content) = lock.files.get(target) {
                            PortResponse::success(
                                inv.invocation_id,
                                PortPayload::Json(json!({
                                    "success": true,
                                    "path": target,
                                    "content_type": if target.ends_with(".html") { "text/html" } else { "application/javascript" },
                                    "body": content
                                })),
                                PortTelemetry::new(trace_id),
                            )
                        } else {
                            PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                n8n_port_contract::PortErrorDetail::new(PortErrorCode::NotFound, "Asset not found", false),
                                PortTelemetry::new(trace_id),
                            )
                        }
                    }
                    _ => PortResponse::error(
                        inv.invocation_id,
                        PortStatus::ClientError,
                        n8n_port_contract::PortErrorDetail::new(PortErrorCode::BadRequest, "Unknown action", false),
                        PortTelemetry::new(trace_id),
                    ),
                }
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

    adapter.register_handler(serve_port.clone(), serve_handler).await;

    let sec_ctx = SecurityContext::builder("gateway", "tenant-global")
        .authority_scope(vec!["port.ui.static.serve.v1".to_string()])
        .build();

    // 1. Root index.html request
    let inv_root = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L09.S01"),
        serve_port.clone(),
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx.clone(),
        PortPayload::Json(json!({
            "action": "serve",
            "path": "/"
        })),
    );

    let res_root = adapter.invoke(inv_root).await;
    assert_eq!(res_root.status, PortStatus::Success);
    if let PortPayload::Json(data) = res_root.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["path"], "/index.html");
        assert_eq!(data["content_type"], "text/html");
    } else {
        panic!("Expected json payload");
    }

    // 2. Asset request
    let inv_asset = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L09.S01"),
        serve_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        sec_ctx,
        PortPayload::Json(json!({
            "action": "serve",
            "path": "/assets/app.js"
        })),
    );

    let res_asset = adapter.invoke(inv_asset).await;
    assert_eq!(res_asset.status, PortStatus::Success);
    if let PortPayload::Json(data) = res_asset.payload {
        assert_eq!(data["success"], true);
        assert_eq!(data["path"], "/assets/app.js");
        assert_eq!(data["body"], "console.log('n8n');");
    } else {
        panic!("Expected json payload");
    }
}

#[tokio::test]
async fn test_vue_surface_port_security_denied_for_unauthorized_invoker() {
    let adapter = InProcessAdapter::new();
    let serve_port = PortId::new("port.ui.static.serve.v1");

    let dummy_handler = Arc::new(|inv: PortInvocation| {
        Box::pin(async move {
            PortResponse::success(
                inv.invocation_id,
                PortPayload::Json(json!({"success": true})),
                PortTelemetry::new(inv.security_context.correlation_id),
            )
        }) as std::pin::Pin<Box<dyn std::future::Future<Output = PortResponse> + Send>>
    });

    adapter.register_handler(serve_port.clone(), dummy_handler).await;

    let bad_sec_ctx = SecurityContext::builder("untrusted-caller", "tenant-x")
        .authority_scope(vec!["other.scope.v1".to_string()])
        .build();

    let inv = PortInvocation::new(
        SubLegoId::new("L00.S01"),
        SubLegoId::new("L09.S01"),
        serve_port,
        ContractVersion::V1,
        RuntimeHostId::H01GatewayHost,
        bad_sec_ctx,
        PortPayload::Json(json!({"path": "/"})),
    );

    let resp = adapter.invoke(inv).await;
    assert_eq!(resp.status, PortStatus::SecurityDenied);
}
