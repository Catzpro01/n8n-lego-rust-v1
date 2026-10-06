use serde::{Deserialize, Serialize};
use std::fmt;

/// Strong identifier for Sub-LEGO (e.g. L00.S01 ... L11.S08)
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct SubLegoId(pub String);

impl SubLegoId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub fn lego_prefix(&self) -> &str {
        if self.0.len() >= 3 {
            &self.0[..3]
        } else {
            &self.0
        }
    }
}

impl fmt::Display for SubLegoId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Global unique Port Identifier (e.g. port.execution.run.workflow.v1)
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct PortId(pub String);

impl PortId {
    pub fn new(id: impl Into<String>) -> Self {
        Self(id.into())
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for PortId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.0)
    }
}

/// Deployment unit identifier: H01 to H07
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum RuntimeHostId {
    #[serde(rename = "H01")]
    H01GatewayHost,
    #[serde(rename = "H02")]
    H02ControlHost,
    #[serde(rename = "H03")]
    H03ExecutionHost,
    #[serde(rename = "H04")]
    H04WorkerHost,
    #[serde(rename = "H05")]
    H05DataHost,
    #[serde(rename = "H06")]
    H06AgentHost,
    #[serde(rename = "H07")]
    H07CompatibilityHost,
}

impl RuntimeHostId {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::H01GatewayHost => "H01",
            Self::H02ControlHost => "H02",
            Self::H03ExecutionHost => "H03",
            Self::H04WorkerHost => "H04",
            Self::H05DataHost => "H05",
            Self::H06AgentHost => "H06",
            Self::H07CompatibilityHost => "H07",
        }
    }

    pub fn description(&self) -> &'static str {
        match self {
            Self::H01GatewayHost => "Gateway Host (HTTP/UI/Realtime ingress)",
            Self::H02ControlHost => "Control Host (Identity, policy, lifecycle, cluster HA)",
            Self::H03ExecutionHost => "Execution Host (Workflow execution and state machine)",
            Self::H04WorkerHost => "Worker Host (Isolated node execution and sandboxing)",
            Self::H05DataHost => "Data Host (Durable persistence, WAL, object storage)",
            Self::H06AgentHost => "Agent Host (Agent, tool, and MCP execution)",
            Self::H07CompatibilityHost => "Compatibility Host (Official n8n & Node.js adapters)",
        }
    }
}

impl fmt::Display for RuntimeHostId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

impl std::str::FromStr for RuntimeHostId {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        match s {
            "H01" => Ok(Self::H01GatewayHost),
            "H02" => Ok(Self::H02ControlHost),
            "H03" => Ok(Self::H03ExecutionHost),
            "H04" => Ok(Self::H04WorkerHost),
            "H05" => Ok(Self::H05DataHost),
            "H06" => Ok(Self::H06AgentHost),
            "H07" => Ok(Self::H07CompatibilityHost),
            _ => Err(format!("Unknown RuntimeHostId: {}", s)),
        }
    }
}

/// Semantic Contract Versioning
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
pub struct ContractVersion {
    pub major: u32,
    pub minor: u32,
    pub patch: u32,
}

impl ContractVersion {
    pub const fn new(major: u32, minor: u32, patch: u32) -> Self {
        Self { major, minor, patch }
    }

    pub const V1: Self = Self::new(1, 0, 0);
    pub const V2: Self = Self::new(2, 0, 0);

    pub fn is_compatible_with(&self, other: &Self) -> bool {
        // Semantic compatibility: same major, and self has required minor/patch
        self.major == other.major && self.minor >= other.minor
    }
}

impl fmt::Display for ContractVersion {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}.{}.{}", self.major, self.minor, self.patch)
    }
}

/// Category of Port Capability
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PortCategory {
    Command,
    Query,
    Event,
    Stream,
    Lifecycle,
    Data,
}

/// Explicit Execution Model for Sub-LEGO
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExecutionModel {
    ContractOnly,
    #[serde(rename = "library/pure")]
    Pure,
    InProcess,
    StatefulComponent,
    ControlComponent,
    WorkerCapability,
    RemoteAdapter,
    Tooling,
}

/// Compatibility Policy across versions
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CompatibilityPolicy {
    SemverAdditive,
    RollingDualVersion,
    StrictLockstep,
}
