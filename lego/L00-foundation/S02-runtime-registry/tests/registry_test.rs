#[cfg(test)]
mod tests {
    use n8n_port_contract::{
        CompatibilityPolicy, ExecutionModel, PortDeclarations, SubLegoMetadata,
    };
    use std::collections::HashMap;

    // Helper construct
    fn sample_metadata(id: &str, provided_port: &str) -> SubLegoMetadata {
        SubLegoMetadata {
            id: id.to_string(),
            name: format!("Component {}", id),
            ownership: "runtime-core".to_string(),
            canonical_path: format!("lego/sample/{}", id),
            execution_model: ExecutionModel::InProcess,
            runtime_host: "H02".to_string(),
            state_ownership: "state".to_string(),
            contract_version: "1.0.0".to_string(),
            compatibility_policy: CompatibilityPolicy::SemverAdditive,
            status: "IMPLEMENTED".to_string(),
            contract_path: format!("lego/sample/{}/CONTRACT.md", id),
            ports: PortDeclarations {
                provided: vec![provided_port.to_string()],
                required: vec![],
                transport: "transport-neutral".to_string(),
            },
        }
    }

    #[test]
    fn test_runtime_registry_lifecycle_and_lookup() {
        let meta1 = sample_metadata("L00.S02", "port.runtime.registry.lookup.v1");
        assert_eq!(meta1.id, "L00.S02");
        assert_eq!(meta1.ports.provided[0], "port.runtime.registry.lookup.v1");
        assert_eq!(meta1.execution_model, ExecutionModel::InProcess);
    }
}
