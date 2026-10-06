use n8n_port_contract::{
    ContractVersion, InProcessAdapter, LifecycleError, PortAdapter, PortBinding, PortErrorCode,
    PortErrorDetail, PortId, PortInvocation, PortLifecycleState, PortPayload, PortResponse,
    PortStatus, PortTelemetry, RuntimeHostId, SecurityContext, SubLegoId, VersionNegotiator,
};
use std::sync::Arc;

#[test]
fn test_rolling_upgrade_version_negotiator() {
    let port_id = PortId::new("port.workflow.execution.v1");
    // During rolling upgrade, provider node simultaneously supports V1 (1.0.0, 1.2.0) and V2 (2.0.0)
    let supported = vec![
        ContractVersion::new(1, 0, 0),
        ContractVersion::new(1, 2, 0),
        ContractVersion::new(2, 0, 0),
    ];
    let negotiator = VersionNegotiator::new(port_id.clone(), supported);

    assert_eq!(negotiator.port_id(), &port_id);
    assert!(negotiator.supports(&ContractVersion::new(1, 0, 0)));
    assert!(negotiator.supports(&ContractVersion::new(2, 0, 0)));
    assert!(!negotiator.supports(&ContractVersion::new(3, 0, 0)));

    // 1. Consumer v1 (1.0.0) is served with compatible v1 (1.2.0 or 1.0.0)
    let negotiated_v1 = negotiator
        .negotiate(ContractVersion::new(1, 0, 0))
        .expect("Consumer v1 negotiation must succeed");
    assert_eq!(negotiated_v1.major, 1);

    // Consumer v1 (1.2.0 exact)
    let negotiated_v1_2 = negotiator
        .negotiate(ContractVersion::new(1, 2, 0))
        .expect("Consumer v1.2 negotiation must succeed");
    assert_eq!(negotiated_v1_2, ContractVersion::new(1, 2, 0));

    // 2. Consumer v2 is served with v2
    let negotiated_v2 = negotiator
        .negotiate(ContractVersion::new(2, 0, 0))
        .expect("Consumer v2 negotiation must succeed");
    assert_eq!(negotiated_v2.major, 2);
    assert_eq!(negotiated_v2, ContractVersion::new(2, 0, 0));

    // 3. Unsupported consumer v3 is rejected
    let result_v3 = negotiator.negotiate(ContractVersion::new(3, 0, 0));
    assert!(result_v3.is_err());
    match result_v3.err().unwrap() {
        LifecycleError::VersionNegotiationFailed { client_version, supported } => {
            assert_eq!(client_version, ContractVersion::new(3, 0, 0));
            assert_eq!(supported.len(), 3);
        }
        other => panic!("Unexpected error: {:?}", other),
    }
}

#[tokio::test]
async fn test_rolling_upgrade_dual_version_provider_serving() {
    let port_id = PortId::new("port.data.entity.store.v1");
    let adapter = InProcessAdapter::new();

    // Provider registers multi-version capable handler
    let p_clone = port_id.clone();
    let supported_versions = vec![ContractVersion::V1, ContractVersion::V2];
    let negotiator = VersionNegotiator::new(port_id.clone(), supported_versions);

    adapter
        .register_handler(
            p_clone,
            Arc::new(move |inv| {
                let negotiator = negotiator.clone();
                Box::pin(async move {
                    let telem = PortTelemetry::new(&inv.security_context.correlation_id);

                    // Check version compatibility via negotiator
                    let active_ver = match negotiator.negotiate(inv.version) {
                        Ok(v) => v,
                        Err(e) => {
                            return PortResponse::error(
                                inv.invocation_id,
                                PortStatus::ClientError,
                                PortErrorDetail::new(
                                    PortErrorCode::VersionMismatch,
                                    format!("{}", e),
                                    false,
                                ),
                                telem,
                            );
                        }
                    };

                    let req_body = inv.payload.as_json().unwrap();
                    let resp_body = if active_ver.major == 1 {
                        // V1 legacy contract response
                        serde_json::json!({
                            "version_served": 1,
                            "id": req_body["id"],
                            "status": "stored_v1"
                        })
                    } else if active_ver.major == 2 {
                        // V2 enhanced contract response with enriched fields
                        serde_json::json!({
                            "version_served": 2,
                            "id": req_body["id"],
                            "status": "stored_v2",
                            "checksum": "sha256_placeholder",
                            "replication_factor": 3
                        })
                    } else {
                        unreachable!()
                    };

                    PortResponse::success(inv.invocation_id, PortPayload::json(resp_body).unwrap(), telem)
                })
            }),
        )
        .await;

    let sec_ctx = SecurityContext::builder("storage_client", "tenant_prod")
        .add_scope("port.data.entity.store.v1")
        .build();

    // Case 1: Consumer requesting V1
    let inv_v1 = PortInvocation::new(
        SubLegoId::new("L02.S01"),
        SubLegoId::new("L05.S01"),
        port_id.clone(),
        ContractVersion::V1,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::json(serde_json::json!({"id": "item-101"})).unwrap(),
    );

    let resp_v1 = adapter.invoke(inv_v1).await;
    assert!(resp_v1.is_success());
    let v1_json = resp_v1.payload.as_json().unwrap();
    assert_eq!(v1_json["version_served"], 1);
    assert_eq!(v1_json["status"], "stored_v1");

    // Case 2: Consumer requesting V2
    let inv_v2 = PortInvocation::new(
        SubLegoId::new("L02.S01"),
        SubLegoId::new("L05.S01"),
        port_id.clone(),
        ContractVersion::V2,
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::json(serde_json::json!({"id": "item-102"})).unwrap(),
    );

    let resp_v2 = adapter.invoke(inv_v2).await;
    assert!(resp_v2.is_success());
    let v2_json = resp_v2.payload.as_json().unwrap();
    assert_eq!(v2_json["version_served"], 2);
    assert_eq!(v2_json["status"], "stored_v2");
    assert_eq!(v2_json["replication_factor"], 3);

    // Case 3: Consumer requesting unsupported V3 is rejected
    let inv_v3 = PortInvocation::new(
        SubLegoId::new("L02.S01"),
        SubLegoId::new("L05.S01"),
        port_id.clone(),
        ContractVersion::new(3, 0, 0),
        RuntimeHostId::H05DataHost,
        sec_ctx.clone(),
        PortPayload::json(serde_json::json!({"id": "item-103"})).unwrap(),
    );

    let resp_v3 = adapter.invoke(inv_v3).await;
    assert!(!resp_v3.is_success());
    assert_eq!(resp_v3.status, PortStatus::ClientError);
    let err = resp_v3.error.unwrap();
    assert_eq!(err.code, PortErrorCode::VersionMismatch);
    assert!(err.message.contains("Version negotiation failed"));
}

#[test]
fn test_port_binding_lifecycle_state_machine_and_drain() {
    let port_id = PortId::new("port.storage.blob.write.v1");
    let provider_sublego = SubLegoId::new("L05.S03");
    let mut binding = PortBinding::new(port_id.clone(), provider_sublego, ContractVersion::V1);

    assert_eq!(binding.state, PortLifecycleState::Discover);

    let negotiator = VersionNegotiator::new(
        port_id.clone(),
        vec![ContractVersion::V1, ContractVersion::V2],
    );

    // 1. Invalid transition directly to Bind from Discover must fail
    assert!(binding.bind().is_err());

    // 2. Negotiate v1
    let selected_ver = binding
        .negotiate(&negotiator, ContractVersion::V1)
        .expect("Negotiation must succeed");
    assert_eq!(selected_ver, ContractVersion::V1);
    assert_eq!(binding.state, PortLifecycleState::Negotiate);

    // 3. Bind
    binding.bind().expect("Bind must succeed");
    assert_eq!(binding.state, PortLifecycleState::Bind);

    // 4. Mark Ready
    binding.mark_ready().expect("Mark ready must succeed");
    assert_eq!(binding.state, PortLifecycleState::Ready);

    // 5. Invocations while Ready
    binding.enter_invocation().expect("Invocation 1 must enter");
    assert_eq!(binding.state, PortLifecycleState::Invoke);

    binding.enter_invocation().expect("Invocation 2 must enter concurrently");
    assert_eq!(binding.state, PortLifecycleState::Invoke);

    // Complete invocation 1
    binding.exit_invocation();
    // Still in Invoke because invocation 2 is active
    assert_eq!(binding.state, PortLifecycleState::Invoke);

    // Complete invocation 2 -> returns to Ready
    binding.exit_invocation();
    assert_eq!(binding.state, PortLifecycleState::Ready);

    // 6. Start Rolling Upgrade Drain
    binding.start_drain().expect("Drain must start");
    assert_eq!(binding.state, PortLifecycleState::Drain);

    // New invocations during drain must be rejected with LifecycleError::Draining
    let drain_inv_err = binding.enter_invocation().expect_err("Must reject calls while draining");
    match drain_inv_err {
        LifecycleError::Draining => {}
        other => panic!("Expected LifecycleError::Draining, got {:?}", other),
    }

    // 7. Verify is_drained
    assert!(binding.is_drained());

    // 8. Unbind
    binding.unbind().expect("Unbind must succeed");
    assert_eq!(binding.state, PortLifecycleState::Unbind);

    // Invocations after unbind must fail with LifecycleError::Unbound
    let unbound_err = binding.enter_invocation().expect_err("Must reject calls when unbound");
    match unbound_err {
        LifecycleError::Unbound => {}
        other => panic!("Expected LifecycleError::Unbound, got {:?}", other),
    }

    // 9. Re-negotiate after Unbind (e.g. for V2 upgrade)
    let re_negotiated = binding
        .negotiate(&negotiator, ContractVersion::V2)
        .expect("Re-negotiation for V2 upgrade must succeed");
    assert_eq!(re_negotiated, ContractVersion::V2);
    assert_eq!(binding.active_version, ContractVersion::V2);
    assert_eq!(binding.state, PortLifecycleState::Negotiate);
}
