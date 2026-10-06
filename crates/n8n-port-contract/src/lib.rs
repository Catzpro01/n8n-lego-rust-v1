pub mod adapter;
pub mod data_plane;
pub mod invocation;
pub mod lifecycle;
pub mod registry;
pub mod security;
pub mod types;

// Re-exports for concise ergonomic imports
pub use adapter::{FramedIpcCodec, InProcessAdapter, PortAdapter};
pub use data_plane::{DataHandle, StorageTier, StreamChunk, StreamPort};
pub use invocation::{
    PortErrorCode, PortErrorDetail, PortInvocation, PortPayload, PortResponse, PortStatus, PortTelemetry,
};
pub use lifecycle::{LifecycleError, PortBinding, PortLifecycleState, VersionNegotiator};
pub use registry::{LegoRegistry, RegistryValidationError, SubLegoMetadata};
pub use security::{ResourceBudget, SecretRef, SecurityContext, SecurityContextBuilder};
pub use types::{
    CompatibilityPolicy, ContractVersion, ExecutionModel, PortCategory, PortId, RuntimeHostId, SubLegoId,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_in_process_adapter_with_security_scope() {
        let adapter = InProcessAdapter::new();
        let port_id = PortId::new("port.execution.run.workflow.v1");

        // Register echo handler
        let p_id_clone = port_id.clone();
        adapter
            .register_handler(
                p_id_clone,
                std::sync::Arc::new(|inv| {
                    Box::pin(async move {
                        let telemetry = PortTelemetry::new(&inv.security_context.correlation_id);
                        PortResponse::success(inv.invocation_id, inv.payload, telemetry)
                    })
                }),
            )
            .await;

        // 1. Invocations with authorized scope should succeed
        let auth_ctx = SecurityContext::builder("user_service", "tenant_a")
            .add_scope("port.execution.run.workflow.v1")
            .build();

        let inv = PortInvocation::new(
            SubLegoId::new("L03.S01"),
            SubLegoId::new("L01.S01"),
            port_id.clone(),
            ContractVersion::V1,
            RuntimeHostId::H03ExecutionHost,
            auth_ctx,
            PortPayload::json(serde_json::json!({"action": "run"})).unwrap(),
        );

        let resp = adapter.invoke(inv).await;
        assert!(resp.is_success());
        assert_eq!(resp.status, PortStatus::Success);

        // 2. Invocations without required authority must be rejected (SecurityDenied)
        let unauth_ctx = SecurityContext::builder("untrusted_user", "tenant_b")
            .add_scope("other.scope.only")
            .build();

        let inv_unauth = PortInvocation::new(
            SubLegoId::new("L03.S01"),
            SubLegoId::new("L01.S01"),
            port_id.clone(),
            ContractVersion::V1,
            RuntimeHostId::H03ExecutionHost,
            unauth_ctx,
            PortPayload::json(serde_json::json!({"action": "run"})).unwrap(),
        );

        let resp_unauth = adapter.invoke(inv_unauth).await;
        assert!(!resp_unauth.is_success());
        assert_eq!(resp_unauth.status, PortStatus::SecurityDenied);
    }

    #[test]
    fn test_version_negotiator_dual_version_rolling_upgrade() {
        let port_id = PortId::new("port.storage.wal.append.v1");
        // Provider supports both V1 (1.0.0) and V2 (2.0.0) during rolling upgrade
        let negotiator = VersionNegotiator::new(
            port_id,
            vec![ContractVersion::new(1, 0, 0), ContractVersion::new(2, 0, 0)],
        );

        // Client requesting v1 gets v1
        let neg_v1 = negotiator.negotiate(ContractVersion::new(1, 0, 0)).unwrap();
        assert_eq!(neg_v1.major, 1);

        // Client requesting v2 gets v2
        let neg_v2 = negotiator.negotiate(ContractVersion::new(2, 0, 0)).unwrap();
        assert_eq!(neg_v2.major, 2);

        // Client requesting unsupported v3 fails
        let neg_v3 = negotiator.negotiate(ContractVersion::new(3, 0, 0));
        assert!(neg_v3.is_err());
    }

    #[tokio::test]
    async fn test_stream_port_backpressure() {
        let stream = StreamPort::new_bounded(2);
        assert_eq!(stream.buffer_capacity(), 2);

        // Send 2 chunks (fits in buffer)
        stream
            .send_chunk(StreamChunk {
                sequence_number: 1,
                is_last: false,
                payload: vec![1, 2, 3],
            })
            .await
            .unwrap();

        stream
            .send_chunk(StreamChunk {
                sequence_number: 2,
                is_last: true,
                payload: vec![4, 5, 6],
            })
            .await
            .unwrap();

        let chunk1 = stream.next_chunk().await.unwrap();
        assert_eq!(chunk1.sequence_number, 1);
        let chunk2 = stream.next_chunk().await.unwrap();
        assert_eq!(chunk2.sequence_number, 2);
        assert!(chunk2.is_last);
    }

    #[test]
    fn test_framed_ipc_codec_round_trip() {
        let sample = serde_json::json!({
            "command": "execute",
            "workflow_id": "wf-12345",
            "items_count": 42
        });

        let encoded = FramedIpcCodec::encode_frame(&sample).unwrap();
        assert!(encoded.len() > 4);

        let decoded: Option<(serde_json::Value, usize)> = FramedIpcCodec::decode_frame(&encoded).unwrap();
        assert!(decoded.is_some());
        let (val, consumed) = decoded.unwrap();
        assert_eq!(consumed, encoded.len());
        assert_eq!(val["workflow_id"], "wf-12345");
    }

    #[test]
    fn test_validate_official_sublego_registry_json() {
        let json_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../docs/migration/LEGO-SUBLEGO-REGISTRY.json"
        );
        let json_str = std::fs::read_to_string(json_path)
            .expect("Failed to read LEGO-SUBLEGO-REGISTRY.json");
        let registry = LegoRegistry::from_json_str(&json_str)
            .expect("Registry validation failed");

        assert_eq!(
            registry.total_count(),
            83,
            "Registry must contain exactly 83 Sub-LEGOs"
        );
    }
}
