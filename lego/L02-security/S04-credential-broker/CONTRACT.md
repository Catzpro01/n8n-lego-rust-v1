# CONTRACT: L02.S04 — Credential Broker

## 1. Sub-LEGO Identity
- **ID**: `L02.S04`
- **Name**: Credential broker
- **Owning LEGO**: `L02-security`
- **Ownership Team**: `security-kernel`
- **Execution Model**: `stateful-component`
- **Runtime Host**: `H02` (Control Host)
- **State Ownership**: `vault-secret-references`
- **Contract Version**: `1.0.0`
- **Compatibility Policy**: `rolling-dual-version`

---

## 2. Provided Ports

### `port.security.credential.release.v1`
- **Category**: Command / Security
- **Purpose**: Merilis plaintext credential secara terkontrol dan berbatas waktu (single-use / scoped) kepada node yang terotorisasi menggunakan `SecretRef`.
- **Request Shape**: `{ "secret_ref": SecretRef, "audience": string, "node_type": string }`
- **Response Shape**: `{ "decrypted_data": Value, "expires_at_ms": u64 }`
- **Error Taxonomy**: `PortErrorCode::Unauthorized`, `PortErrorCode::Forbidden`, `PortErrorCode::NotFound`

### `port.security.credential.store.v1`
- **Category**: Command / Security
- **Purpose**: Menyimpan credential terenkripsi dan menerbitkan `SecretRef`.
- **Request Shape**: `{ "credential_type": string, "data": Value, "tenant_id": string }`
- **Response Shape**: `{ "secret_ref": SecretRef }`

---

## 3. Required Ports
- `port.security.authz.authorize.v1` (Provider: `L02.S03`)
- `port.security.crypto.encrypt.v1` (Provider: `L02.S05`)

---

## 4. Invariants & Security Boundaries
1. Plaintext credentials dilarang keras beredar di control-plane port generic atau execution state JSON.
2. Setiap pelepasan credential wajib diaudit dan diverifikasi terhadap tenant & audience scope.
