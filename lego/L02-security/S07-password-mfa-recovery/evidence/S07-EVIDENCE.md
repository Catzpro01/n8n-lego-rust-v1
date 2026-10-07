# Evidence: L02.S07 Password/MFA Recovery

- **Sub-LEGO ID**: `L02.S07`
- **Name**: Password/MFA recovery
- **Owning LEGO**: `L02-security`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `credential-recovery-tokens`
- **Status Target**: `TESTED` (Promoted from `CONTRACTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L02-security/S07-password-mfa-recovery/`
- **Provided Ports**:
  - `port.security.recovery.initiate.v1`
  - `port.security.mfa.verify.v1`
- **Required Ports**:
  - `port.security.authz.authorize.v1` (Provider: `L02.S03`)
- **Invariants Verified**:
  1. **Fail-Closed Verification & Lockout**: Empty inputs, zero TTL, empty tenant, invalid challenge codes, expired tokens, or locked-out principals are immediately rejected (`test_recovery_fail_closed_empty_inputs`, `test_recovery_initiate_fail_closed_zero_ttl`, `test_recovery_verify_fail_closed_empty_tenant`, `test_recovery_verify_invalid_code`, `test_recovery_verify_expired_token`, `test_recovery_lockout_after_consecutive_failures`).
  2. **Multi-Tenant Token Boundary**: Verification strictly binds challenge tokens to the caller's tenant; cross-tenant attempts are denied (`test_recovery_verify_tenant_boundary_mismatch`).
  3. **Single-Use Anti-Replay Consumption**: Tokens are burned upon successful verification; replay attempts with the same token are rejected (`test_recovery_verify_success_and_single_use`).
  4. **Multi-Factor Channel Support**: Supports Email, SMS, MFA challenge, and Backup codes with secure cryptographic hashing in `credential-recovery-tokens` (`test_recovery_initiate_success`).
  5. **Brute-Force & Lockout Protection**: Consecutive failures automatically trigger principal lockout across initiation and verification, with support for administrative reset (`test_recovery_lockout_after_consecutive_failures`).
  6. **State Pruning & Garbage Collection**: Prunes expired and consumed tokens from `credential-recovery-tokens` (`test_recovery_cleanup_expired_tokens`).
  7. **Transport-Neutral Port Contract**: Port dispatchers for `port.security.recovery.initiate.v1` and `port.security.mfa.verify.v1` handle payload roundtrips cleanly (`test_recovery_ports_dispatchers`, `crates/n8n-port-contract/tests/password_mfa_recovery_port_test.rs`).
  8. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite Results**:
  - `test_recovery_initiate_success`: PASSED
  - `test_recovery_fail_closed_empty_inputs`: PASSED
  - `test_recovery_initiate_fail_closed_zero_ttl`: PASSED
  - `test_recovery_verify_success_and_single_use`: PASSED
  - `test_recovery_verify_invalid_code`: PASSED
  - `test_recovery_lockout_after_consecutive_failures`: PASSED
  - `test_recovery_verify_expired_token`: PASSED
  - `test_recovery_verify_tenant_boundary_mismatch`: PASSED
  - `test_recovery_verify_fail_closed_empty_tenant`: PASSED
  - `test_recovery_cleanup_expired_tokens`: PASSED
  - `test_recovery_ports_dispatchers`: PASSED
  - `crates/n8n-port-contract/tests/password_mfa_recovery_port_test.rs`: PASSED (Roundtrip, Verify, Denial)
