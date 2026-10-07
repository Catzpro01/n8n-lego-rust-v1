# Evidence: L02.S02 Session Lifecycle

- **Sub-LEGO ID**: `L02.S02`
- **Name**: Session lifecycle
- **Owning LEGO**: `L02-security`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `session-state-cache`
- **Status Target**: `TESTED` (Promoted from `CONTRACTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L02-security/S02-session-lifecycle/`
- **Provided Ports**:
  - `port.security.session.create.v1`
  - `port.security.session.validate.v1`
  - `port.security.session.revoke.v1`
- **Required Ports**:
  - `port.security.context.validate.v1` (Provider: `L02.S01`)
- **Invariants Verified**:
  1. **Fail-Closed Principle**: Empty principal, empty tenant, zero custom TTL, missing session token, revoked token, or expired TTL are rejected immediately (`test_session_create_fail_closed_empty_principal`, `test_session_create_fail_closed_empty_tenant`, `test_session_create_fail_closed_zero_ttl`, `test_session_validate_fail_closed_empty_tenant`, `test_session_validate_expired`, `test_session_revoke_lifecycle`).
  2. **Multi-Tenant Boundary Isolation**: Tenant context is strictly checked upon session validation; cross-tenant session reuse and cross-tenant session revocation are strictly rejected (`test_session_validate_tenant_mismatch`, `test_session_scoped_revoke_tenant_mismatch_denied`, `test_session_port_revoke_with_tenant`).
  3. **Fixation & Replay Protection**: Session rotation creates a new token and revokes the predecessor token cleanly within tenant boundary (`test_session_rotation_fixation_protection`).
  4. **Security Epoch / Version Invalidation**: Bumping user security epoch invalidates all existing active sessions issued under older security epochs, with tenant-scoped isolation (`test_session_security_epoch_invalidation`, `test_session_scoped_security_version_bump`).
  5. **State Pruning & Garbage Collection**: Prunes expired and revoked sessions deterministically (`test_session_cleanup_expired_sessions`).
  6. **Transport-Neutral Port Contract**: Port dispatchers for `port.security.session.create.v1`, `port.security.session.validate.v1`, and `port.security.session.revoke.v1` handle payload roundtrips (`test_session_ports_dispatchers`, `crates/n8n-port-contract/tests/session_lifecycle_port_test.rs`).
  7. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite Results**:
  - `test_session_create_success`: PASSED
  - `test_session_create_fail_closed_empty_principal`: PASSED
  - `test_session_create_fail_closed_empty_tenant`: PASSED
  - `test_session_create_fail_closed_zero_ttl`: PASSED
  - `test_session_validate_success`: PASSED
  - `test_session_validate_fail_closed_empty_tenant`: PASSED
  - `test_session_validate_expired`: PASSED
  - `test_session_validate_tenant_mismatch`: PASSED
  - `test_session_revoke_lifecycle`: PASSED
  - `test_session_rotation_fixation_protection`: PASSED
  - `test_session_security_epoch_invalidation`: PASSED
  - `test_session_cleanup_expired_sessions`: PASSED
  - `test_session_ports_dispatchers`: PASSED
  - `test_session_scoped_revoke_tenant_mismatch_denied`: PASSED
  - `test_session_scoped_security_version_bump`: PASSED
  - `test_session_port_revoke_with_tenant`: PASSED
  - `crates/n8n-port-contract/tests/session_lifecycle_port_test.rs`: PASSED (Roundtrip, Lifecycle, Security Boundary)
