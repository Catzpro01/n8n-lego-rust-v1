//! Implementation of L00.S01 Runtime Contracts
//! Exposes contract verification and envelope construction logic.

pub use n8n_port_contract::{
    ContractVersion, ExecutionModel, PortCategory, PortId, PortInvocation, PortPayload,
    PortResponse, PortStatus, PortTelemetry, ResourceBudget, RuntimeHostId, SecurityContext,
    SubLegoId, VersionNegotiator,
};

/// Verifies whether an incoming invocation complies with the L00.S01 envelope standard
pub fn verify_envelope(inv: &PortInvocation) -> Result<(), &'static str> {
    if inv.invocation_id.is_empty() {
        return Err("invocation_id cannot be empty");
    }
    if inv.caller_sublego.as_str().is_empty() {
        return Err("caller_sublego cannot be empty");
    }
    if inv.provider_sublego.as_str().is_empty() {
        return Err("provider_sublego cannot be empty");
    }
    if inv.security_context.principal.is_empty() {
        return Err("security_context.principal cannot be empty");
    }
    if inv.security_context.tenant.is_empty() {
        return Err("security_context.tenant cannot be empty");
    }
    Ok(())
}
