# CONTRACT: L02.S07 — Password/MFA recovery

## 1. Sub-LEGO Identity
- **ID**: `L02.S07`
- **Name**: Password/MFA recovery
- **Owning LEGO**: `L02-security`
- **Ownership Team**: `security-kernel`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `credential-recovery-tokens`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `semver-additive`
- **Status**: `TESTED`

---

## 2. Provided Ports
### `port.security.recovery.initiate.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

### `port.security.mfa.verify.v1`
- **Category**: Public Contract
- **Transport**: contract-defined
- **Status**: Active

---

## 3. Required Ports
- `port.security.authz.authorize.v1` (Provider: `L02.S03`)

---

## 4. Invariants & Rules
1. Komunikasi antar Sub-LEGO hanya diizinkan melalui public contract / ports (`port.*`).
2. Private cross-Sub-LEGO import di dalam folder `lego/` dilarang keras.
3. State ownership eksklusif berada di bawah kendali Sub-LEGO ini (`credential-recovery-tokens`).
4. Model eksekusi mematuhi batasan runtime host `H02` (Control Host).
5. Fail-closed: ketiadaan token, token invalid/hangus/kedaluwarsa, atau percobaan melebihi ambang batas lockout secara deterministik ditolak.
6. Isolasi multi-tenant: inisiasi dan verifikasi recovery terikat pada tenant eksplisit.
7. Single-use token: token recovery hangus seketika setelah verifikasi berhasil (anti-replay).
8. Proteksi lockout: kegagalan verifikasi berulang (default 5 kali) mengunci principal selama durasi cooldown.
