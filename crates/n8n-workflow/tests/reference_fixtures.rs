//! Acceptance harness for the Rust Workflow port: runs `tests/reference/workflow-rust/fixtures.json`.
//!
//! The fixture file is derived from the pinned n8n runtime by
//! `tests/reference/workflow-rust/build-fixtures.mjs` (`--check` re-derives and fails on drift),
//! so a green run here means the port matches the reference behaviour, not that the test was
//! written to match the port. Case counts are asserted so a growing fixture file cannot be
//! silently skipped.

use n8n_workflow::{
    calculate_workflow_checksum, compare_connections, get_connected_nodes, ConnectionTypeFilter,
    Connections, INode, Workflow,
};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

const CHECKSUM_CASES: usize = 8;
const DIFF_CASES: usize = 6;
const SHAPE_CASES: usize = 6;
const RENAME_CASES: usize = 6;
const TRAVERSAL_CASES: usize = 9;

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
}

fn read_value(path: &PathBuf) -> Value {
    let text = fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

fn fixtures() -> Value {
    read_value(&repo_root().join("tests/reference/workflow-rust/fixtures.json"))
}

/// The reference fixture factory: `{id: `id-${name}`, name, type, typeVersion: 1, position, parameters}`.
fn node(name: &str) -> INode {
    node_with(name, json!({}))
}

fn node_with(name: &str, extra: Value) -> INode {
    let mut base = json!({
        "id": format!("id-{name}"),
        "name": name,
        "type": "n8n-nodes-base.noOp",
        "typeVersion": 1,
        "position": [0, 0],
        "parameters": {},
    });
    if let (Some(base_map), Some(extra_map)) = (base.as_object_mut(), extra.as_object()) {
        for (key, value) in extra_map {
            base_map.insert(key.clone(), value.clone());
        }
    }
    serde_json::from_value(base).expect("node fixture")
}

fn connections_from(value: &Value) -> Connections {
    serde_json::from_value(value.clone()).expect("connections fixture")
}

/// Deserialises connections from JSON *text*. Going through `serde_json::Value` first would sort
/// the keys (`Value::Object` is a `BTreeMap`), and connection-type order is observable — the
/// `all-types` fixture expects `['M','D','C','B']`, which only comes out of document order.
fn connections_from_text(text: &str) -> Connections {
    serde_json::from_str(text).expect("connections text fixture")
}

fn workflow_from_golden(fixture: &str) -> Workflow {
    let doc = read_value(
        &repo_root()
            .join("tests/reference")
            .join(fixture)
            .join("workflow.json"),
    );
    Workflow::new(
        doc.get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| Some("wf-shape".to_string())),
        doc.get("name").and_then(Value::as_str).map(str::to_string),
        serde_json::from_value(doc.get("nodes").cloned().unwrap_or_else(|| json!([])))
            .expect("golden nodes"),
        connections_from(doc.get("connections").unwrap_or(&json!({}))),
        false,
        doc.get("settings").cloned(),
        doc.get("staticData").cloned(),
        doc.get("pinData").cloned(),
    )
}

/// A → B → C chain plus an unrelated D (reference `chain()`).
fn chain() -> Workflow {
    Workflow::new(
        Some("wf-rename".into()),
        Some("Rename".into()),
        vec![node("A"), node("B"), node("C"), node("D")],
        connections_from(&json!({
            "A": {"main": [[{"node": "B", "type": "main", "index": 0}]]},
            "B": {"main": [[{"node": "C", "type": "main", "index": 0}]]}
        })),
        false,
        None,
        None,
        None,
    )
}

#[test]
fn checksum_matches_the_reference_runtime() {
    let fixtures = fixtures();
    let cases = fixtures["checksum"]["cases"].as_array().expect("cases");
    assert_eq!(cases.len(), CHECKSUM_CASES, "checksum case count");

    for case in cases {
        let id = case["id"].as_str().expect("id");
        let expected = case["sha256"].as_str().expect("sha256");
        let actual = calculate_workflow_checksum(&case["snapshot"]);
        assert_eq!(actual, expected, "checksum case `{id}`");
    }
}

#[test]
fn compare_connections_matches_the_reference() {
    let fixtures = fixtures();
    let cases = fixtures["compareConnections"].as_array().expect("cases");
    assert_eq!(cases.len(), DIFF_CASES, "diff case count");

    for case in cases {
        let id = case["id"].as_str().expect("id");
        let prev = connections_from(&case["prev"]);
        let next = connections_from(&case["next"]);
        let diff = compare_connections(&prev, &next);
        let actual = serde_json::to_value(&diff).expect("diff serialises");
        assert_eq!(actual, case["result"], "compareConnections case `{id}`");
    }
}

#[test]
fn aggregate_shape_matches_the_reference() {
    let fixtures = fixtures();
    let cases = fixtures["toJSON"].as_array().expect("cases");
    assert_eq!(cases.len(), SHAPE_CASES, "shape case count");

    for case in cases {
        let id = case["id"].as_str().expect("id");
        let workflow = match id {
            "wf-empty" => workflow_from_golden("01-empty-workflow"),
            "wf-one-node" => workflow_from_golden("02-one-node"),
            "wf-linear" => workflow_from_golden("03-linear"),
            "wf-all" => Workflow::new(
                Some("wf-all".into()),
                Some("Everything".into()),
                vec![node("A"), node_with("B", json!({"disabled": true}))],
                connections_from(
                    &json!({"A": {"main": [[{"node": "B", "type": "main", "index": 0}]]}}),
                ),
                false,
                Some(json!({
                    "timezone": "Asia/Jakarta",
                    "executionOrder": "v1",
                    "saveDataErrorExecution": "all"
                })),
                Some(json!({"lastId": 42})),
                Some(json!({"A": [{"json": {"pinned": true}}]})),
            ),
            "wf-dup" => Workflow::new(
                Some("wf-dup".into()),
                Some("Duplicate".into()),
                vec![
                    node("A"),
                    node_with("A", json!({"parameters": {"second": true}})),
                ],
                Connections::new(),
                false,
                None,
                None,
                None,
            ),
            "wf-proto" => Workflow::new(
                Some("wf-proto".into()),
                Some("Proto".into()),
                vec![node("A"), node("__proto__")],
                Connections::new(),
                false,
                None,
                None,
                None,
            ),
            other => panic!("unknown shape case `{other}`"),
        };

        let mut node_keys = workflow.node_keys();
        node_keys.sort();
        assert_eq!(json!(node_keys), case["nodeKeys"], "nodeKeys for `{id}`");
        assert_eq!(case["nodesAreKeyedByName"], json!(true), "`{id}`");
        assert_eq!(json!(workflow.node_count()), case["nodeCount"], "`{id}`");
        assert_eq!(
            serde_json::to_value(&workflow.connections_by_source_node).unwrap(),
            case["connectionsBySourceNode"],
            "connectionsBySourceNode for `{id}`"
        );
        assert_eq!(
            serde_json::to_value(&workflow.connections_by_destination_node).unwrap(),
            case["connectionsByDestinationNode"],
            "connectionsByDestinationNode for `{id}`"
        );
        assert_eq!(workflow.settings, case["settings"], "settings for `{id}`");
        assert_eq!(
            workflow.static_data, case["staticData"],
            "staticData for `{id}`"
        );
        assert_eq!(
            workflow.pin_data.clone().unwrap_or(Value::Null),
            case["pinData"],
            "pinData for `{id}`"
        );
        assert_eq!(
            json!(workflow.get_timezone()),
            case["timezone"],
            "timezone for `{id}`"
        );
        assert_eq!(json!(workflow.active), case["active"], "active for `{id}`");
        assert_eq!(
            workflow
                .id
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
            case["id"],
            "id for `{id}`"
        );
        assert_eq!(
            workflow
                .name
                .clone()
                .map(Value::String)
                .unwrap_or(Value::Null),
            case["name"],
            "name for `{id}`"
        );
    }
}

#[test]
fn rename_node_matches_the_reference_including_d08() {
    let fixtures = fixtures();
    let cases = fixtures["rename"].as_array().expect("cases");
    assert_eq!(cases.len(), RENAME_CASES, "rename case count");

    for case in cases {
        let id = case["id"].as_str().expect("id");
        let outcome = &case["outcome"];

        match id {
            "restricted-hasOwnProperty" | "restricted-constructor" | "restricted-__proto__" => {
                let restricted = id.strip_prefix("restricted-").expect("prefix");
                let mut workflow = chain();
                let error = workflow
                    .rename_node("D", restricted)
                    .expect_err("restricted name must be rejected");
                assert_eq!(outcome["threw"], json!(true), "`{id}` must throw");
                assert_eq!(
                    json!(error.error_name()),
                    outcome["errorName"],
                    "error name `{id}`"
                );
                assert_eq!(
                    json!(error.to_string()),
                    outcome["message"],
                    "message `{id}`"
                );
            }
            "collision-overwrites" => {
                let mut workflow = chain();
                workflow
                    .rename_node("D", "C")
                    .expect("collisions are not guarded");
                let mut node_names = workflow.node_keys();
                node_names.sort();
                assert_eq!(json!(node_names), outcome["nodeNames"], "nodeNames");
                assert_eq!(
                    json!(workflow.get_node("C").map(|node| node.id.clone())),
                    outcome["ownerOfC"],
                    "ownerOfC"
                );
                let mut source_keys = workflow.connections_by_source_node.key_names();
                source_keys.sort();
                assert_eq!(
                    json!(source_keys),
                    outcome["cStillHasItsEdges"],
                    "source keys"
                );
            }
            "d-08-stale-destination-index" => {
                let mut workflow = chain();
                workflow.rename_node("B", "Beta").expect("rename");

                let mut source_keys = workflow.connections_by_source_node.key_names();
                source_keys.sort();
                assert_eq!(json!(source_keys), outcome["sourceKeys"], "sourceKeys");

                let mut destination_keys = workflow.connections_by_destination_node.key_names();
                destination_keys.sort();
                assert_eq!(
                    json!(destination_keys),
                    outcome["destinationKeys"],
                    "destinationKeys"
                );

                assert_eq!(
                    json!(workflow.get_child_nodes("A", ConnectionTypeFilter::main(), -1)),
                    outcome["childNodesOfA"],
                    "childNodesOfA"
                );
                assert_eq!(
                    json!(workflow.get_parent_nodes("Beta", ConnectionTypeFilter::main(), -1)),
                    outcome["parentNodesOfBeta"],
                    "parentNodesOfBeta (stale index)"
                );
                assert_eq!(
                    json!(workflow.get_parent_nodes("B", ConnectionTypeFilter::main(), -1)),
                    outcome["parentNodesOfOldName"],
                    "parentNodesOfOldName"
                );
                assert_eq!(
                    serde_json::to_value(workflow.connections_by_source_node.get("Beta")).unwrap(),
                    outcome["sourceEdgeToBeta"],
                    "sourceEdgeToBeta"
                );

                workflow.set_connections(workflow.connections_by_source_node.clone());
                assert_eq!(
                    json!(workflow.get_parent_nodes("Beta", ConnectionTypeFilter::main(), -1)),
                    outcome["afterRederive"],
                    "afterRederive"
                );

                let mut node_names = workflow.node_keys();
                node_names.sort();
                assert_eq!(json!(node_names), outcome["nodeNames"], "nodeNames");
            }
            "parameter-references-rewritten" => {
                let mut workflow = Workflow::new(
                    Some("wf-rename-params".into()),
                    Some("Rename Params".into()),
                    vec![
                        node("A"),
                        node_with(
                            "B",
                            json!({
                                "type": "n8n-nodes-base.set",
                                "parameters": {"value": "={{ $('A').item.json.x }}", "plain": "A"}
                            }),
                        ),
                    ],
                    Connections::new(),
                    false,
                    None,
                    None,
                    None,
                );
                workflow.rename_node("A", "Alpha").expect("rename");
                let parameters = &workflow.get_node("B").expect("B").parameters.0;
                assert_eq!(
                    parameters["value"], outcome["value"],
                    "expression rewritten"
                );
                assert_eq!(
                    parameters["plain"], outcome["plain"],
                    "plain string untouched"
                );
            }
            other => panic!("unknown rename case `{other}`"),
        }
    }
}

#[test]
fn traversal_matches_the_reference_type_and_depth_rules() {
    let fixtures = fixtures();
    let cases = fixtures["traversal"].as_array().expect("cases");
    assert_eq!(cases.len(), TRAVERSAL_CASES, "traversal case count");

    let graph = connections_from_text(
        r#"{
            "A": {
                "main": [[{"node": "B", "type": "main", "index": 0}]],
                "ai_languageModel": [[{"node": "M", "type": "ai_languageModel", "index": 0}]]
            },
            "B": {"main": [[{"node": "C", "type": "main", "index": 0}]]},
            "C": {"main": [[{"node": "D", "type": "main", "index": 0}]]},
            "D": {},
            "M": {}
        }"#,
    );

    for case in cases {
        let id = case["id"].as_str().expect("id");
        let from = case["from"].as_str().expect("from");
        let filter = ConnectionTypeFilter::parse(case["type"].as_str().expect("type"));
        let depth = case["depth"].as_i64().expect("depth") as i32;

        let actual = get_connected_nodes(&graph, from, &filter, depth, None);
        assert_eq!(json!(actual), case["result"], "traversal case `{id}`");
    }
}
