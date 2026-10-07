# Evidence: L02.S01 Principal and Security Context

- **Sub-LEGO ID**: `L02.S01`
- **Name**: Principal and security context
- **Owning LEGO**: `L02-security`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `stateless`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L02-security/S01-principal-security-context/`
- **Provided Ports**:
  - `port.security.context.create.v1`
  - `port.security.context.validate.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
- **Invariants Verified**:
  1. **Fail-Closed Missing Principal/Tenant**: Rejects context creation or validation immediately if principal or tenant is empty or whitespace (`test_security_context_fail_closed_empty_principal`, `test_security_context_fail_closed_empty_tenant`).
  2. **Multi-Tenant Boundary Isolation**: Validates context against expected tenant; mismatches fail closed with `TenantMismatch` (`test_security_context_tenant_mismatch_denied`, `test_security_context_port_validate_tenant_mismatch`).
  3. **Exact & Wildcard Authority Scope Evaluation**: Evaluates scope checks against exact scope names, prefix wildcards (`port.execution.*`), and universal wildcards (`*`) (`test_security_context_exact_scope_authorization`, `test_security_context_wildcard_scope_authorization`).
  4. **Strict Scope Sanitization**: Authority scopes are trimmed and empty/whitespace scopes are stripped during creation (`test_security_context_scope_sanitization`, `test_security_context_empty_required_scope_denied`).
  5. **Strict Expiration Enforcement**: Deadlines specified via `deadline_epoch_ms` are enforced deterministically; past-deadline invocations fail with `ContextExpired` (`test_security_context_expiration_enforcement`).
  6. **Audience Boundary Enforcement**: Validates that the intended service audience matches or fails closed (`test_security_context_audience_validation`).
  7. **Correlation Continuity**: Preserves or automatically generates trace correlation IDs across port boundaries (`test_security_context_port_create_dispatcher`).
  8. **Transport-Neutral Port Dispatchers**: Both `port.security.context.create.v1` and `port.security.context.validate.v1` dispatchers process structured JSON payloads cleanly with full error reporting (`test_security_context_port_create_dispatcher`, `test_security_context_port_validate_dispatcher`, `crates/n8n-port-contract/tests/security_context_port_test.rs`).
  9. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_security_context_creation_success`: PASSED
  - `test_security_context_fail_closed_empty_principal`: PASSED
  - `test_security_context_fail_closed_empty_tenant`: PASSED
  - `test_security_context_exact_scope_authorization`: PASSED
  - `test_security_context_wildcard_scope_authorization`: PASSED
  - `test_security_context_expiration_enforcement`: PASSED
  - `test_security_context_audience_validation`: PASSED
  - `test_security_context_port_create_dispatcher`: PASSED
  - `test_security_context_port_validate_dispatcher`: PASSED
  - `test_security_context_tenant_mismatch_denied`: PASSED
  - `test_security_context_empty_required_scope_denied`: PASSED
  - `test_security_context_scope_sanitization`: PASSED
  - `test_security_context_port_validate_tenant_mismatch`: PASSED
  - `crates/n8n-port-contract/tests/security_context_port_test.rs`: PASSED (Roundtrip, Scope Checking, Fail-Closed Boundaries)
