use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use thiserror::Error;

use crate::types::{
    CompatibilityPolicy, ExecutionModel, PortId, SubLegoId,
};

#[derive(Debug, Error)]
pub enum RegistryValidationError {
    #[error("Missing Sub-LEGO definition: {0}")]
    MissingSubLego(String),
    #[error("Duplicate provided port: {port} claimed by both {first} and {second}")]
    DuplicateProvidedPort {
        port: String,
        first: String,
        second: String,
    },
    #[error("Orphan required port: {port} requested by {consumer} has no provider")]
    OrphanRequiredPort { port: String, consumer: String },
    #[error("Cyclic Sub-LEGO dependency detected in path: {0:?}")]
    CyclicDependency(Vec<String>),
    #[error("Invalid runtime host assignment: {0}")]
    InvalidRuntimeHost(String),
    #[error("Ambiguous or duplicate state ownership: state '{state}' claimed by {sub1} and {sub2}")]
    DuplicateStateOwner {
        state: String,
        sub1: String,
        sub2: String,
    },
    #[error("JSON deserialization error: {0}")]
    JsonError(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SubLegoMetadata {
    pub id: String,
    pub name: String,
    pub ownership: String,
    pub canonical_path: String,
    pub execution_model: ExecutionModel,
    pub runtime_host: String,
    pub state_ownership: String,
    pub contract_version: String,
    pub compatibility_policy: CompatibilityPolicy,
    pub status: String,
    pub contract_path: String,
    pub ports: PortDeclarations,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortDeclarations {
    pub provided: Vec<String>,
    pub required: Vec<String>,
    pub transport: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegoGroup {
    pub name: String,
    pub path: String,
    pub sublegos: HashMap<String, SubLegoMetadata>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostDefinition {
    pub name: String,
    pub responsibility: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegoRegistryDocument {
    pub version: u32,
    pub planning_model: String,
    pub total_sublegos: usize,
    pub runtime_hosts: HashMap<String, HostDefinition>,
    pub legos: HashMap<String, LegoGroup>,
}

/// In-memory validated Sub-LEGO and Port Registry
#[derive(Debug, Clone)]
pub struct LegoRegistry {
    pub sublegos: HashMap<SubLegoId, SubLegoMetadata>,
    pub port_to_provider: HashMap<PortId, SubLegoId>,
    pub state_to_owner: HashMap<String, SubLegoId>,
    pub dependency_graph: HashMap<SubLegoId, HashSet<SubLegoId>>,
}

impl LegoRegistry {
    /// Loads registry from JSON string and runs complete architecture validation suite
    pub fn from_json_str(json_str: &str) -> Result<Self, RegistryValidationError> {
        let doc: LegoRegistryDocument = serde_json::from_str(json_str)?;
        Self::from_doc(doc)
    }

    pub fn from_doc(doc: LegoRegistryDocument) -> Result<Self, RegistryValidationError> {
        let mut sublegos: HashMap<SubLegoId, SubLegoMetadata> = HashMap::new();
        let mut port_to_provider: HashMap<PortId, SubLegoId> = HashMap::new();
        let mut state_to_owner: HashMap<String, SubLegoId> = HashMap::new();

        // 1. Flatten all Sub-LEGOs
        for (_lego_id, lego_group) in doc.legos {
            for (_sub_key, meta) in lego_group.sublegos {
                let sub_id = SubLegoId::new(&meta.id);
                sublegos.insert(sub_id.clone(), meta);
            }
        }

        // 2. Validate Port uniqueness and State uniqueness
        for (sub_id, meta) in &sublegos {
            // Check state ownership (allow 'stateless' to be shared)
            if meta.state_ownership != "stateless" {
                if let Some(existing_owner) = state_to_owner.get(&meta.state_ownership) {
                    return Err(RegistryValidationError::DuplicateStateOwner {
                        state: meta.state_ownership.clone(),
                        sub1: existing_owner.as_str().to_string(),
                        sub2: sub_id.as_str().to_string(),
                    });
                }
                state_to_owner.insert(meta.state_ownership.clone(), sub_id.clone());
            }

            // Check provided ports uniqueness
            for prov in &meta.ports.provided {
                let pid = PortId::new(prov);
                if let Some(existing) = port_to_provider.get(&pid) {
                    return Err(RegistryValidationError::DuplicateProvidedPort {
                        port: prov.clone(),
                        first: existing.as_str().to_string(),
                        second: sub_id.as_str().to_string(),
                    });
                }
                port_to_provider.insert(pid, sub_id.clone());
            }
        }

        // 3. Build dependency graph and check orphan required ports
        let mut dependency_graph = HashMap::new();
        for (sub_id, meta) in &sublegos {
            let mut dep_set = HashSet::new();
            for req in &meta.ports.required {
                let req_pid = PortId::new(req);
                match port_to_provider.get(&req_pid) {
                    Some(provider_id) => {
                        if provider_id != sub_id {
                            dep_set.insert(provider_id.clone());
                        }
                    }
                    None => {
                        return Err(RegistryValidationError::OrphanRequiredPort {
                            port: req.clone(),
                            consumer: sub_id.as_str().to_string(),
                        });
                    }
                }
            }
            dependency_graph.insert(sub_id.clone(), dep_set);
        }

        // 4. Validate Acyclic Graph (Cycle Detection via DFS)
        let mut visited: HashMap<SubLegoId, u8> = HashMap::new(); // 0=unvisited, 1=visiting, 2=visited
        for sub_id in sublegos.keys() {
            if visited.get(sub_id).copied().unwrap_or(0) == 0 {
                let mut path = Vec::new();
                Self::dfs_check_cycle(sub_id, &dependency_graph, &mut visited, &mut path)?;
            }
        }

        Ok(Self {
            sublegos,
            port_to_provider,
            state_to_owner,
            dependency_graph,
        })
    }

    fn dfs_check_cycle(
        node: &SubLegoId,
        graph: &HashMap<SubLegoId, HashSet<SubLegoId>>,
        visited: &mut HashMap<SubLegoId, u8>,
        path: &mut Vec<String>,
    ) -> Result<(), RegistryValidationError> {
        visited.insert(node.clone(), 1);
        path.push(node.as_str().to_string());

        if let Some(neighbors) = graph.get(node) {
            for neighbor in neighbors {
                let state = visited.get(neighbor).copied().unwrap_or(0);
                if state == 1 {
                    let mut cycle_path = path.clone();
                    cycle_path.push(neighbor.as_str().to_string());
                    return Err(RegistryValidationError::CyclicDependency(cycle_path));
                } else if state == 0 {
                    Self::dfs_check_cycle(neighbor, graph, visited, path)?;
                }
            }
        }

        path.pop();
        visited.insert(node.clone(), 2);
        Ok(())
    }

    pub fn total_count(&self) -> usize {
        self.sublegos.len()
    }

    pub fn find_sublego(&self, id: &SubLegoId) -> Option<&SubLegoMetadata> {
        self.sublegos.get(id)
    }

    pub fn find_provider(&self, port: &PortId) -> Option<&SubLegoId> {
        self.port_to_provider.get(port)
    }
}
