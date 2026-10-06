use serde::{Deserialize, Serialize};
use thiserror::Error;

use crate::types::{ContractVersion, PortId, SubLegoId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PortLifecycleState {
    Discover,
    Negotiate,
    Bind,
    Ready,
    Invoke,
    Drain,
    Unbind,
}

#[derive(Debug, Error)]
pub enum LifecycleError {
    #[error("Invalid state transition from {from:?} to {to:?}")]
    InvalidTransition {
        from: PortLifecycleState,
        to: PortLifecycleState,
    },
    #[error("Version negotiation failed: client requested {client_version}, but provider supports {supported:?}")]
    VersionNegotiationFailed {
        client_version: ContractVersion,
        supported: Vec<ContractVersion>,
    },
    #[error("Port is draining, cannot accept new invocations")]
    Draining,
    #[error("Port is unbound")]
    Unbound,
}

/// Version Negotiator enabling rolling upgrades by supporting multi-version providers (v1 + v2)
#[derive(Debug, Clone)]
pub struct VersionNegotiator {
    port_id: PortId,
    supported_versions: Vec<ContractVersion>,
}

impl VersionNegotiator {
    pub fn new(port_id: PortId, supported_versions: Vec<ContractVersion>) -> Self {
        Self {
            port_id,
            supported_versions,
        }
    }

    pub fn port_id(&self) -> &PortId {
        &self.port_id
    }

    /// Negotiates best matching compatible contract version
    pub fn negotiate(&self, requested: ContractVersion) -> Result<ContractVersion, LifecycleError> {
        // Find highest version in supported that is compatible with requested
        let compatible = self
            .supported_versions
            .iter()
            .filter(|v| v.is_compatible_with(&requested) || (v.major == requested.major && v.minor == requested.minor))
            .max();

        match compatible {
            Some(v) => Ok(*v),
            None => Err(LifecycleError::VersionNegotiationFailed {
                client_version: requested,
                supported: self.supported_versions.clone(),
            }),
        }
    }

    pub fn supports(&self, version: &ContractVersion) -> bool {
        self.supported_versions.iter().any(|v| v.major == version.major)
    }
}

/// Port Binding instance tracking state machine
#[derive(Debug)]
pub struct PortBinding {
    pub port_id: PortId,
    pub provider_sublego: SubLegoId,
    pub active_version: ContractVersion,
    pub state: PortLifecycleState,
    in_flight_invocations: usize,
}

impl PortBinding {
    pub fn new(
        port_id: PortId,
        provider_sublego: SubLegoId,
        version: ContractVersion,
    ) -> Self {
        Self {
            port_id,
            provider_sublego,
            active_version: version,
            state: PortLifecycleState::Discover,
            in_flight_invocations: 0,
        }
    }

    /// Step DISCOVER -> NEGOTIATE
    pub fn negotiate(
        &mut self,
        negotiator: &VersionNegotiator,
        requested_version: ContractVersion,
    ) -> Result<ContractVersion, LifecycleError> {
        if self.state != PortLifecycleState::Discover && self.state != PortLifecycleState::Unbind {
            return Err(LifecycleError::InvalidTransition {
                from: self.state,
                to: PortLifecycleState::Negotiate,
            });
        }
        let selected = negotiator.negotiate(requested_version)?;
        self.active_version = selected;
        self.state = PortLifecycleState::Negotiate;
        Ok(selected)
    }

    /// Step NEGOTIATE -> BIND
    pub fn bind(&mut self) -> Result<(), LifecycleError> {
        if self.state != PortLifecycleState::Negotiate {
            return Err(LifecycleError::InvalidTransition {
                from: self.state,
                to: PortLifecycleState::Bind,
            });
        }
        self.state = PortLifecycleState::Bind;
        Ok(())
    }

    /// Step BIND -> READY
    pub fn mark_ready(&mut self) -> Result<(), LifecycleError> {
        if self.state != PortLifecycleState::Bind {
            return Err(LifecycleError::InvalidTransition {
                from: self.state,
                to: PortLifecycleState::Ready,
            });
        }
        self.state = PortLifecycleState::Ready;
        Ok(())
    }

    /// Prepares invocation: can be called when Ready or Invoke
    pub fn enter_invocation(&mut self) -> Result<(), LifecycleError> {
        match self.state {
            PortLifecycleState::Ready | PortLifecycleState::Invoke => {
                self.state = PortLifecycleState::Invoke;
                self.in_flight_invocations += 1;
                Ok(())
            }
            PortLifecycleState::Drain => Err(LifecycleError::Draining),
            _ => Err(LifecycleError::Unbound),
        }
    }

    /// Exits invocation
    pub fn exit_invocation(&mut self) {
        if self.in_flight_invocations > 0 {
            self.in_flight_invocations -= 1;
        }
        if self.in_flight_invocations == 0 && self.state == PortLifecycleState::Invoke {
            self.state = PortLifecycleState::Ready;
        }
    }

    /// Step READY/INVOKE -> DRAIN (prepare for graceful shutdown or rolling switch)
    pub fn start_drain(&mut self) -> Result<(), LifecycleError> {
        match self.state {
            PortLifecycleState::Ready | PortLifecycleState::Invoke => {
                self.state = PortLifecycleState::Drain;
                Ok(())
            }
            _ => Err(LifecycleError::InvalidTransition {
                from: self.state,
                to: PortLifecycleState::Drain,
            }),
        }
    }

    /// Checks if all in-flight calls are drained
    pub fn is_drained(&self) -> bool {
        self.state == PortLifecycleState::Drain && self.in_flight_invocations == 0
    }

    /// Step DRAIN -> UNBIND
    pub fn unbind(&mut self) -> Result<(), LifecycleError> {
        if self.state != PortLifecycleState::Drain || self.in_flight_invocations > 0 {
            return Err(LifecycleError::InvalidTransition {
                from: self.state,
                to: PortLifecycleState::Unbind,
            });
        }
        self.state = PortLifecycleState::Unbind;
        Ok(())
    }
}
