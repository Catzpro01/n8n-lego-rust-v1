# Evidence: L04.S08 Dynamic Parameter/Schema Runtime

- **Sub-LEGO ID**: `L04.S08`
- **Name**: Dynamic parameter/schema runtime
- **Owning LEGO**: `L04-node-ecosystem`
- **Runtime Host**: `H04` (Worker Host)
- **Authoritative State Domain**: `dynamic-schema-cache`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L04-node-ecosystem/S08-dynamic-parameter-schema/`
- **Provided Ports**:
  - `port.node.schema.resolve_options.v1`
- **Required Ports**:
  - `port.node.registry.query.v1` (Provider: `L04.S01`)
- **Invariants Verified**:
  1. **Dynamic Schema & Options Resolution**: Evaluates runtime property choices (databases, tables, columns, timezones) with parameter contexts (`test_resolve_options_cache_miss_and_hit`, `test_resolve_tables_with_parameter_context`).
  2. **Authoritative State Domain Caching**: Stores resolved choices within `dynamic-schema-cache` with TTL evaluation and cache bypass capabilities (`test_resolve_options_cache_miss_and_hit`, `test_resolve_options_bypass_cache`).
  3. **Multi-Tenant Isolation**: Caches and scopes options strictly by tenant identifier (`test_invalid_request_validation`).
  4. **Fail-Closed Evaluation**: Unsupported resolution methods and malformed parameter payloads fail closed (`test_unsupported_method_fail_closed`, `test_invalid_request_validation`).
  5. **Transport-Neutral Port Contract**: In-process dispatcher executes `port.node.schema.resolve_options.v1` queries cleanly (`test_port_resolve_options_dispatcher`, `crates/n8n-port-contract/tests/dynamic_schema_port_test.rs`).
  6. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_resolve_options_cache_miss_and_hit`: PASSED
  - `test_resolve_options_bypass_cache`: PASSED
  - `test_resolve_tables_with_parameter_context`: PASSED
  - `test_unsupported_method_fail_closed`: PASSED
  - `test_invalid_request_validation`: PASSED
  - `test_port_resolve_options_dispatcher`: PASSED
  - `crates/n8n-port-contract/tests/dynamic_schema_port_test.rs`: PASSED (Roundtrip, Resolve Options, Security Context Scopes)
