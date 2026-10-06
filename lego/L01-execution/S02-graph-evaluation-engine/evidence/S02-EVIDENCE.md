# Evidence: L01.S02 Graph Evaluation Engine

- **Sub-LEGO ID**: `L01.S02`
- **Name**: Graph Evaluation Engine
- **Owning LEGO**: `L01-execution`
- **Runtime Host**: `H03` (Execution Host)
- **Authoritative State Domain**: `graph-evaluation-index`
- **Status Target**: `TESTED` (Promoted from `CONTRACTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L01-execution/S02-graph-evaluation-engine/`
- **Provided Ports**:
  - `port.execution.graph.evaluate.v1`
  - `port.execution.node.status.v1`
  - `port.execution.wait.suspend.v1`
  - `port.execution.wait.resume.v1`
- **Required Ports**:
  - `port.execution.run.workflow.v1` (Provider: `L01.S01`)
  - `port.storage.wal.append.v1` (Provider: `L05.S02`)
- **Invariants Verified**:
  1. **DAG Acyclicity & Cycle Detection**: Iterative DFS detects cycles and rejects cyclic workflow definitions with exact cycle path slicing (`test_cycle_detection`, `test_precise_cycle_slice_extraction`, `test_self_loop_cycle_detection`).
  2. **Stack Overflow Immunity on Deep Graphs**: Iterative heap-allocated stack traversal reliably evaluates graphs with >= 15,000 linear nodes without stack overflow (`test_deep_linear_recursion_iterative_dfs`).
  3. **Deterministic Topological Precedence**: Kahn's algorithm with sorted trigger seeding guarantees deterministic execution order across multiple evaluations (`test_deterministic_topological_sort_multi_roots`).
  4. **Multi-Parent Diamond Convergence**: Topological ordering guarantees all parent dependencies execute prior to convergent child nodes (`test_diamond_convergence_evaluation`).
  5. **Node Status FSM Immutability**: Enforces rigid M2 state machine transitions (`Pending` -> `Running`/`Skipped`/`Failed` -> `Succeeded`/`Failed`/`Waiting`) and strictly forbids modifying terminal states (`test_node_status_fsm_valid_and_invalid_transitions`).
  6. **Wait/Resume Lifecycle**: Suspends frames into Waiting state and resumes them to Running with active wait index tracking (`test_wait_and_resume_lifecycle`).
  7. **Transport-Neutral Port Contract**: Typed dispatchers process port invocations cleanly with security boundary verification (`test_port_contract_dispatchers`, `test_graph_evaluation_port_roundtrip_and_dag_topology`, `test_wait_and_resume_ports_roundtrip`).
  8. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_linear_dag_evaluation`: PASSED
  - `test_diamond_convergence_evaluation`: PASSED
  - `test_cycle_detection`: PASSED
  - `test_orphan_nodes_discovery`: PASSED
  - `test_node_status_fsm_valid_and_invalid_transitions`: PASSED
  - `test_wait_and_resume_lifecycle`: PASSED
  - `test_port_contract_dispatchers`: PASSED
  - `test_deep_linear_recursion_iterative_dfs`: PASSED (15,000 nodes)
  - `test_precise_cycle_slice_extraction`: PASSED
  - `test_self_loop_cycle_detection`: PASSED
  - `test_deterministic_topological_sort_multi_roots`: PASSED
  - `test_ghost_nodes_and_minimal_deserialization`: PASSED
  - `crates/n8n-port-contract/tests/graph_evaluation_port_test.rs`: 3/3 tests PASSED (Roundtrip, Security, Wait/Resume)
