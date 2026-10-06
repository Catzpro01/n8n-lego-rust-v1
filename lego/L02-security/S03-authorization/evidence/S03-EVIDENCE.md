# Evidence: L02.S03 Authorization

- **Sub-LEGO ID**: `L02.S03`
- **Name**: Authorization
- **Owning LEGO**: `L02-security`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `authz-policy-cache`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L02-security/S03-authorization/`
- **Provided Ports**:
  - `port.security.authz.authorize.v1`
- **Required Ports**:
  - `port.security.context.validate.v1` (Provider: `L02.S01`)
- **Invariants Verified**:
  1. **Fail-Closed Default Deny**: Unregistered roles, unspecified actions, or non-matching rules are denied by default (`test_authorization_fail_closed_default_deny`).
  2. **Multi-Tenant Isolation**: Enforces tenant boundaries strictly; cross-tenant resource access is rejected unless the principal possesses superuser roles (`test_authorization_multi_tenant_boundary`).
  3. **Role & Action Hierarchies**: Supports standard roles (`global:owner`, `global:admin`, `global:member`) and wildcard action matching (`workflow:*`, `*`) (`test_authorization_owner_full_access`, `test_authorization_admin_allowed_actions`, `test_authorization_member_permissions_and_denials`).
  4. **Policy Cache Hit & Invalidation**: High-throughput in-memory caching of authorization decisions (`authz-policy-cache`) with deterministic invalidation upon policy updates (`test_authorization_cache_hit_and_invalidation`).
  5. **Dynamic Tenant Policy Registration**: Supports runtime registration of custom tenant-specific policies (`test_authorization_tenant_custom_policy_registration`).
  6. **Transport-Neutral Port Contract**: Port dispatcher handles `port.security.authz.authorize.v1` requests cleanly with structured decision output (`test_authorization_port_dispatcher_allow`, `test_authorization_port_dispatcher_deny`, `crates/n8n-port-contract/tests/authorization_port_test.rs`).
  7. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_authorization_owner_full_access`: PASSED
  - `test_authorization_admin_allowed_actions`: PASSED
  - `test_authorization_member_permissions_and_denials`: PASSED
  - `test_authorization_fail_closed_default_deny`: PASSED
  - `test_authorization_multi_tenant_boundary`: PASSED
  - `test_authorization_tenant_custom_policy_registration`: PASSED
  - `test_authorization_cache_hit_and_invalidation`: PASSED
  - `test_authorization_port_dispatcher_allow`: PASSED
  - `test_authorization_port_dispatcher_deny`: PASSED
  - `crates/n8n-port-contract/tests/authorization_port_test.rs`: PASSED (Roundtrip, Policy Evaluation, Security Boundaries)
