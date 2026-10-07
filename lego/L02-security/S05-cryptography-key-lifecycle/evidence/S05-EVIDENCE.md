# Evidence: L02.S05 Cryptography and Key Lifecycle

- **Sub-LEGO ID**: `L02.S05`
- **Name**: Cryptography and key lifecycle
- **Owning LEGO**: `L02-security`
- **Runtime Host**: `H02` (Control Host)
- **Authoritative State Domain**: `master-key-manifest`
- **Status Target**: `TESTED` (Promoted from `IMPLEMENTED`)
- **Certification Status**: `0 CERTIFIED` (Quality floor: zero self-awarded production certification)
- **Physical Root**: `lego/L02-security/S05-cryptography-key-lifecycle/`
- **Provided Ports**:
  - `port.security.crypto.encrypt.v1`
  - `port.security.crypto.decrypt.v1`
- **Required Ports**:
  - `port.runtime.contract.envelope.v1` (Provider: `L00.S01`)
- **Invariants Verified**:
  1. **Master Key Manifest Lifecycle**: Tracks active, deprecated, and revoked keys with versioning in `master-key-manifest` (`test_crypto_key_rotation_seamless_decrypt`, `test_crypto_revoked_key_rejection`).
  2. **Transparent Key Rotation**: Rotating keys seamlessly deprecates the active key while allowing previously encrypted payloads under deprecated keys to be decrypted without downtime (`test_crypto_key_rotation_seamless_decrypt`).
  3. **Revocation Enforcement**: Revoked keys reject both encryption and decryption immediately (`test_crypto_revoked_key_rejection`).
  4. **Tamper-Evident Integrity Verification**: Ciphertext modifications fail cryptographic HMAC integrity verification with fail-closed errors (`test_crypto_tampered_ciphertext_detection`).
  5. **Standardized Versioned Envelopes**: Outputs and parses envelopes adhering to `enc:v1:<key_id>:<iv>:<ciphertext>:<hmac>` (`test_crypto_envelope_format_parsing`).
  6. **Transport-Neutral Port Contract**: In-process dispatchers handle `port.security.crypto.encrypt.v1` and `port.security.crypto.decrypt.v1` cleanly with security boundary verification (`test_crypto_port_encrypt_and_decrypt_dispatchers`, `crates/n8n-port-contract/tests/cryptography_port_test.rs`).
  7. **Physical & Import Isolation**: 0 private cross-Sub-LEGO imports detected by CI architecture check.
- **Test Suite**:
  - `test_crypto_encrypt_decrypt_roundtrip`: PASSED
  - `test_crypto_key_rotation_seamless_decrypt`: PASSED
  - `test_crypto_revoked_key_rejection`: PASSED
  - `test_crypto_tampered_ciphertext_detection`: PASSED
  - `test_crypto_empty_plaintext_rejection`: PASSED
  - `test_crypto_envelope_format_parsing`: PASSED
  - `test_crypto_port_encrypt_and_decrypt_dispatchers`: PASSED
  - `test_crypto_rotate_fail_closed_empty_inputs`: PASSED
  - `test_crypto_active_key_revocation_fail_closed_encrypt`: PASSED
  - `test_crypto_decrypt_missing_key_rejection`: PASSED
  - `crates/n8n-port-contract/tests/cryptography_port_test.rs`: PASSED (Roundtrip, Key Rotation, Security Boundary)
