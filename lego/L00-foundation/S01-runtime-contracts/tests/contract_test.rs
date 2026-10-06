#[cfg(test)]
mod tests {
    use n8n_port_contract::{
        ContractVersion, PortId, PortInvocation, PortPayload, RuntimeHostId, SecurityContext,
        SubLegoId,
    };

    #[test]
    fn test_l00_s01_envelope_verification() {
        let ctx = SecurityContext::builder("admin", "tenant-1").build();
        let inv = PortInvocation::new(
            SubLegoId::new("L00.S02"),
            SubLegoId::new("L00.S01"),
            PortId::new("port.runtime.contract.envelope.v1"),
            ContractVersion::V1,
            RuntimeHostId::H02ControlHost,
            ctx,
            PortPayload::Empty,
        );

        assert!(!inv.invocation_id.is_empty());
        assert_eq!(inv.caller_sublego.as_str(), "L00.S02");
        assert_eq!(inv.provider_sublego.as_str(), "L00.S01");
    }
}
