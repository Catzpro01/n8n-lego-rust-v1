use n8n_port_contract::{
    ContractVersion, FramedIpcCodec, InProcessAdapter, PortAdapter, PortId,
    PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry, RuntimeHostId,
    SecurityContext, SubLegoId,
};
use std::sync::Arc;

/// Demonstrates that the exact same Sub-LEGO capability and contract can run across
/// multiple runtime modes (In-Process and Framed IPC) without altering the contract.
#[tokio::test]
async fn test_sublego_runs_in_multiple_runtime_modes() {
    let port_id = PortId::new("port.storage.wal.append.v1");
    let caller = SubLegoId::new("L01.S04");
    let provider = SubLegoId::new("L05.S02");

    let sec_ctx = SecurityContext::builder("execution_runner", "tenant_prod")
        .add_scope("port.storage.wal.append.v1")
        .build();

    let invocation = PortInvocation::new(
        caller,
        provider,
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx,
        PortPayload::json(serde_json::json!({
            "execution_id": "exec_abc_123",
            "lsn": 101,
            "record_type": "CHECKPOINT"
        }))
        .unwrap(),
    );

    // -------------------------------------------------------------
    // RUNTIME MODE 1: In-Process Direct Typed Call (Default intra-host)
    // -------------------------------------------------------------
    let in_process_adapter = InProcessAdapter::new();
    in_process_adapter
        .register_handler(
            port_id.clone(),
            Arc::new(|inv| {
                Box::pin(async move {
                    let mut telem = PortTelemetry::new(&inv.security_context.correlation_id);
                    telem.duration_ms = 1;
                    PortResponse::success(
                        inv.invocation_id,
                        PortPayload::json(serde_json::json!({
                            "appended_lsn": 101,
                            "bytes_written": 256,
                            "synced": true
                        }))
                        .unwrap(),
                        telem,
                    )
                })
            }),
        )
        .await;

    let in_proc_response = in_process_adapter.invoke(invocation.clone()).await;
    assert!(in_proc_response.is_success());
    let json_resp = in_proc_response.payload.as_json().unwrap();
    assert_eq!(json_resp["appended_lsn"], 101);
    assert_eq!(json_resp["synced"], true);

    // -------------------------------------------------------------
    // RUNTIME MODE 2: Framed Length-Prefixed IPC (Isolated boundary)
    // -------------------------------------------------------------
    // Encode the exact same invocation into a length-prefixed binary frame
    let frame_bytes = FramedIpcCodec::encode_frame(&invocation).expect("Encoding IPC frame must succeed");
    assert!(frame_bytes.len() > 4);

    // Decode frame on the receiver/worker end
    let (decoded_inv, consumed): (PortInvocation, usize) =
        FramedIpcCodec::decode_frame(&frame_bytes).unwrap().expect("Frame must decode");
    assert_eq!(consumed, frame_bytes.len());
    assert_eq!(decoded_inv.invocation_id, invocation.invocation_id);
    assert_eq!(decoded_inv.port_id, port_id);

    // Worker executes using the in-process handler
    let worker_resp = in_process_adapter.invoke(decoded_inv).await;
    assert!(worker_resp.is_success());

    // Encode response frame back to caller
    let resp_frame = FramedIpcCodec::encode_frame(&worker_resp).expect("Encoding response frame must succeed");
    let (decoded_resp, _): (PortResponse, usize) =
        FramedIpcCodec::decode_frame(&resp_frame).unwrap().expect("Response frame must decode");
    assert_eq!(decoded_resp.status, PortStatus::Success);
    assert_eq!(decoded_resp.payload.as_json().unwrap()["appended_lsn"], 101);
}
