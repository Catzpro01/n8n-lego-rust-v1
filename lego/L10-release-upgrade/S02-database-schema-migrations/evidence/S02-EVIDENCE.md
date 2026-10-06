# Architecture Evidence Ledger: L10.S02 Database/schema migrations

## 1. Sub-LEGO Identity
- **ID**: `L10.S02`
- **Name**: Database/schema migrations
- **Owning LEGO**: `L10-release-upgrade`
- **Runtime Host**: `H05` (Data Host)
- **State Ownership**: `migration-version-ledger`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Ordered Migration Version Ledger**:
   - Manages state domain `migration-version-ledger` recording sequential versions, names, checksum hashes, and execution timestamps.
   - Enforces sequential ordering: out-of-order version jumps are rejected fail-closed.
2. **Deterministic Idempotency & Rollback**:
   - Applying migrations when already up to date is idempotent (0 pending).
   - Rollback decrements current version cleanly and marks prior migration as pending.
3. **Transport-Neutral Port Contract**:
   - Implements provided port `port.release.migration.apply.v1`.
   - Requires storage persistence via `port.storage.persistence.save.v1`.
   - Rejects unauthorized invocations via security context scope validation.
4. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication via typed public ports and `n8n-port-contract`.

## 3. Verification Commands & Results
- Unit test compilation & execution:
  `rustc --test --edition=2021 lego/L10-release-upgrade/S02-database-schema-migrations/implementation/mod.rs -L target/debug/deps --extern serde=... --extern serde_json=... -o target/debug/test_l10_s02.exe`
  - Result: 6/6 tests PASS (Exit code 0).
- Port contract integration tests:
  `cargo test -p n8n-port-contract --test schema_migration_port_test`
  - Result: 2/2 tests PASS (Exit code 0).
- Full workspace tests:
  `cargo test -p n8n-port-contract`
  - Result: All tests PASS (Exit code 0).
- Architecture CI Enforcement:
  `python scripts/ci_architecture_check.py`
  - Result: 11/11 checks PASS (Exit code 0).
