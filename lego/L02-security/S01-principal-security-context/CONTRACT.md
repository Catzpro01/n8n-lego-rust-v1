# CONTRACT: L02.S01 — Principal and security context

## 1. Sub-LEGO Identity
- **ID**: `L02.S01`
- **Name**: Principal and security context
- **Owning LEGO**: `L02-security`
- **Ownership Team**: `security-kernel`
- **Execution Model**: `in-process`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `stateless`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.security.context.create.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active (Fail-closed; context issuance blocked without verified caller provenance)

### `port.security.context.validate.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active (Fail-closed; positive authorization blocked without verified trust anchor)

---

## 3. Required Ports
- `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras (0 private cross-sublego imports).
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`stateless`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
5. In-process typed invocation bukan bukti autentikasi caller. Klaim authority scope tidak boleh diperlakukan sebagai bukti identitas terverifikasi.
6. Tidak ada trust anchor yang terintegrasi untuk provenance security context (`BLK-L02-S01-TRUST-ANCHOR`). Create dan validate tidak menghasilkan security context tepercaya tanpa bukti provenance yang dapat diverifikasi.
7. Tidak ada physical H01↔H02 daemon transport yang sudah dibuktikan aktif (`BLK-L02-S01-PHYSICAL-TRANSPORT`).
8. Validasi fail-closed yang lulus di lingkungan lokal bukan sertifikasi produksi (`0 CERTIFIED` quality floor).

---

## 5. Active Blockers
- **`BLK-L02-S01-TRUST-ANCHOR`** (P0): Trust anchor provider (kriptografis/PKI/issuer provenance verification) belum terintegrasi di H02; penerbitan konteks tepercaya dan validasi positif diblokir fail-closed.
- **`BLK-L02-S01-PHYSICAL-TRANSPORT`** (P1): Daemon transport fisik H01↔H02 belum dibuktikan aktif di runtime.
