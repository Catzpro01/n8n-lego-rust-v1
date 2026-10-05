use n8n_node_model::INode;
use n8n_validation::validate_node_uniqueness;
use std::fs;
use std::path::Path;

#[test]
fn test_fixture_empty_workflow() {
    let fixture_path = Path::new("../../tests/reference/01-empty-workflow/workflow.json");
    if !fixture_path.exists() {
        return;
    }
    let content = fs::read_to_string(fixture_path).expect("Failed to read fixture");
    let json: serde_json::Value = serde_json::from_str(&content).expect("Failed to parse JSON");

    let nodes: Vec<INode> = serde_json::from_value(json["nodes"].clone()).unwrap_or_default();
    let node_names: Vec<String> = nodes.iter().map(|n| n.name.clone()).collect();

    assert!(validate_node_uniqueness(&node_names).is_ok());
    assert_eq!(nodes.len(), 0);
}

#[test]
fn test_fixture_linear_workflow() {
    let fixture_path = Path::new("../../tests/reference/03-linear/workflow.json");
    if !fixture_path.exists() {
        return;
    }
    let content = fs::read_to_string(fixture_path).expect("Failed to read fixture");
    let json: serde_json::Value = serde_json::from_str(&content).expect("Failed to parse JSON");

    let nodes: Vec<INode> = serde_json::from_value(json["nodes"].clone()).unwrap_or_default();
    let node_names: Vec<String> = nodes.iter().map(|n| n.name.clone()).collect();

    assert!(validate_node_uniqueness(&node_names).is_ok());
    assert_eq!(nodes.len(), 2);
}
