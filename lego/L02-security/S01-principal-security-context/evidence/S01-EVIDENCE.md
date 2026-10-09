# Evidence: L02.S01 Principal and Security Context

- **Sub-LEGO ID**: `L02.S01`
- **Name**: Principal and security context
- **Owning LEGO**: `L02-security`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `stateless`
- **Status Target**: `TESTED`
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L02-security/S01-principal-security-context/`
- **Provided Ports**:
  - `port.security.context.create.v1`
  - `port.security.context.validate.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## Active Blockers
- **`BLK-L02-S01-TRUST-ANCHOR`** (P0): Trust anchor provider (kriptografis/PKI/issuer provenance verification) belum terintegrasi di H02; penerbitan konteks tepercaya dan validasi positif diblokir fail-closed.
- **`BLK-L02-S01-PHYSICAL-TRANSPORT`** (P1): Daemon transport fisik H01↔H02 belum dibuktikan aktif di runtime.

---

## Architectural & Governance Invariants
1. **In-Process Invocation Is Not Caller Provenance**: Struct invocation berorientasi memory (`PortInvocation.security_context`) bukan bukti autentikasi identitas caller. Field deklaratif tidak diperlakukan sebagai identitas terverifikasi.
2. **Fail-Closed Missing Trust Anchor**: Ketiadaan trust anchor provider terintegrasi (`BLK-L02-S01-TRUST-ANCHOR`) memaksa seluruh operasi penerbitan konteks (`port.security.context.create.v1`) dan validasi positif (`port.security.context.validate.v1`) berakhir fail-closed dengan diagnostik eksplisit.
3. **No Synthetic / Ephemeral Trust**: Dilarang membuat fake signer, hard-coded key, ephemeral trust anchor, synthetic system caller, boolean `trusted` buatan, atau bukti identitas dari string principal/tenant semata.
4. **Scope vs Provenance Separation**: Pemeriksaan authority scope dipisahkan secara deterministik dari verifikasi provenance. Caller yang tidak memiliki scope ditolak dengan `InsufficientAuthority`, sedangkan caller yang memiliki scope deklaratif namun tanpa pembuktian provenance ditolak dengan `BLK-L02-S01-TRUST-ANCHOR`.
5. **Multi-Tenant Boundary Isolation**: Pemeriksaan tenant dievaluasi fail-closed; mismatch tenant mengembalikan `TenantMismatch`.
6. **Deterministic Deadline Expiration**: Invocations melewati deadline ditolak fail-closed dengan `ContextExpired` (`expired: true`).
7. **Audience Boundary Enforcement**: Target service audience divalidasi fail-closed; mismatch mengembalikan `InvalidAudience`.
8. **Synthetic Context Rejection**: JSON context buatan yang diinjeksi tanpa provenance terverifikasi ditolak pada jalur konsumsi berikutnya.
9. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports terdeteksi pada pemindaian pohon `lego/`.
10. **Local Fail-Closed vs Production Certification**: Keberhasilan tes fail-closed di lokal membuktikan ketahanan boundary, namun bukan merupakan sertifikasi produksi (`0 CERTIFIED`). Produksi tetap `BLOCKED` hingga trust anchor terintegrasi.

---

## Verified Test Matrix (23/23 PASSED)
- `test_security_context_create_unverified_caller_denied`: PASSED (Menolak penerbitan konteks bagi caller tanpa provenance yang mengklaim scope create; mengembalikan `BLK-L02-S01-TRUST-ANCHOR`)
- `test_security_context_validate_unverified_caller_denied`: PASSED (Menolak validasi positif bagi caller tanpa provenance yang mengklaim scope validate; `valid: false, authorized: false`)
- `test_security_context_system_and_kernel_principals_unverified_denied`: PASSED (Principal `system`, `control-kernel`, `root`, `kernel-supervisor` tetap tidak dipercaya tanpa provenance)
- `test_security_context_wildcard_scope_unverified_denied`: PASSED (Caller dengan authority scope `*` tetap ditolak tanpa provenance)
- `test_security_context_subject_json_never_positive_without_provenance`: PASSED (Subject JSON dengan scope biasa maupun wildcard tidak memperoleh `valid: true` atau `authorized: true`)
- `test_security_context_synthetic_created_json_rejected_on_validate`: PASSED (JSON context hasil injeksi/sintetik ditolak pada jalur validasi lanjutan)
- `test_security_context_fail_closed_tenant_mismatch`: PASSED (Mismatch tenant menghasilkan `TenantMismatch`)
- `test_security_context_fail_closed_audience_mismatch`: PASSED (Mismatch audience menghasilkan `InvalidAudience`)
- `test_security_context_fail_closed_expired_deadline`: PASSED (Deadline kadaluarsa menghasilkan `ContextExpired` & `expired: true`)
- `test_security_context_fail_closed_empty_principal`: PASSED (Principal kosong/whitespace ditolak `MissingPrincipal`)
- `test_security_context_fail_closed_empty_tenant`: PASSED (Tenant kosong/whitespace ditolak `MissingTenant`)
- `test_security_context_missing_scope_distinguished_from_unverified_provenance`: PASSED (Membedakan kegagalan `InsufficientAuthority` dari kegagalan unverified provenance `BLK-L02-S01-TRUST-ANCHOR`)
- `test_security_context_empty_required_scope_denied`: PASSED (Scope yang kosong/whitespace deterministik menghasilkan false)
- `test_security_context_prefix_wildcard_scope_matching`: PASSED (Evaluasi prefix wildcard matching `port.execution.*`)
- `test_security_context_port_create_dispatcher_fail_closed`: PASSED (Dispatcher create port fail-closed dengan error `BLK-L02-S01-TRUST-ANCHOR`)
- `test_security_context_port_validate_dispatcher_fail_closed`: PASSED (Dispatcher validate port fail-closed dengan error `BLK-L02-S01-TRUST-ANCHOR`)
- `test_security_context_port_validate_tenant_mismatch`: PASSED (Dispatcher validate port menolak tenant mismatch)
- `test_security_context_port_contract_shape_compatibility`: PASSED (Bentuk payload port-contract tanpa `principal_kind` dapat dide-serialize dan fail-closed dengan `BLK-L02-S01-TRUST-ANCHOR`)
- `test_security_context_validate_missing_principal_key_in_json`: PASSED (Ketiadaan field principal pada JSON validasi menghasilkan `MissingPrincipal`)
- `test_security_context_validate_missing_tenant_key_in_json`: PASSED (Ketiadaan field tenant pada JSON validasi menghasilkan `MissingTenant`)
- `test_security_context_validate_null_and_non_object_payload_fail_closed`: PASSED (Payload null atau non-object pada dispatcher validate ditangani fail-closed)
- `test_security_context_create_non_object_payload_fail_closed`: PASSED (Payload non-object pada dispatcher create ditangani fail-closed)
- `test_security_context_principal_struct_and_blocker_constants`: PASSED (Konstruksi struct Principal dan verifikasi konstanta blocker runtime)
