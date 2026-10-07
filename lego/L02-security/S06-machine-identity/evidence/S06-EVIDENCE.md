# Evidence: L02.S06 Machine Identity

- **Sub-LEGO ID**: `L02.S06`
- **Name**: Machine identity
- **Owning LEGO**: `L02-security`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `machine-identity-keystore`
- **Status Target**: `TESTED` (Promoted from `CONTRACTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L02-security/S06-machine-identity/`
- **Provided Ports**:
  - `port.security.machine.token.v1`
  - `port.security.machine.authenticate.v1`
- **Required Ports**:
  - `port.security.context.create.v1` (Provider: `L02.S01`)
- **Invariants Verified**:
  1. **Fail-Closed Secret & Token Verification**: Unregistered machine IDs, empty credentials, zero TTL, invalid secrets, corrupted hashes, revoked tokens, or expired timestamps are immediately rejected (`test_machine_issue_token_fail_closed_wrong_secret`, `test_machine_issue_token_fail_closed_zero_ttl`, `test_machine_authenticate_token_fail_closed_empty_tenant`, `test_machine_authenticate_api_key_fail_closed_empty`, `test_machine_authenticate_token_expired`).
  2. **Multi-Tenant Keystore Boundary**: Machine records and tokens are strictly partitioned by tenant ID; cross-tenant authentication fails (`test_machine_authenticate_token_tenant_mismatch`).
  3. **Zero Plaintext Secret Storage**: Raw secrets are transformed into deterministic 64-bit cryptographic hashes before persistence in `machine-identity-keystore` (`test_machine_register_and_issue_token`).
  4. **Granular Machine Kinds**: Supports Worker, ServiceAccount, ApiKey, Agent, and Mcp machine identities with attached scopes (`test_machine_register_and_issue_token`, `test_machine_authenticate_token_success`).
  5. **Instant Invalidation & Deactivation**: Individual tokens can be revoked by ID or by raw bearer token, and parent machines deactivated to revoke all token usages (`test_machine_revoke_token`, `test_machine_revoke_token_by_raw`, `test_machine_deactivate_disables_tokens`).
  6. **State Pruning & Garbage Collection**: Prunes expired and revoked tokens from `machine-identity-keystore` (`test_machine_cleanup_expired_tokens`).
  7. **Transport-Neutral Port Dispatchers**: Both `port.security.machine.token.v1` and `port.security.machine.authenticate.v1` handle port roundtrips cleanly (`test_machine_ports_dispatchers`, `crates/n8n-port-contract/tests/machine_identity_port_test.rs`).
  8. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite Results**:
  - `test_machine_register_and_issue_token`: PASSED
  - `test_machine_issue_token_fail_closed_wrong_secret`: PASSED
  - `test_machine_issue_token_fail_closed_zero_ttl`: PASSED
  - `test_machine_authenticate_token_success`: PASSED
  - `test_machine_authenticate_token_expired`: PASSED
  - `test_machine_authenticate_token_tenant_mismatch`: PASSED
  - `test_machine_authenticate_token_fail_closed_empty_tenant`: PASSED
  - `test_machine_revoke_token`: PASSED
  - `test_machine_revoke_token_by_raw`: PASSED
  - `test_machine_deactivate_disables_tokens`: PASSED
  - `test_machine_authenticate_api_key_direct`: PASSED
  - `test_machine_authenticate_api_key_fail_closed_empty`: PASSED
  - `test_machine_cleanup_expired_tokens`: PASSED
  - `test_machine_ports_dispatchers`: PASSED
  - `crates/n8n-port-contract/tests/machine_identity_port_test.rs`: PASSED (Roundtrip, Auth, Denial)
