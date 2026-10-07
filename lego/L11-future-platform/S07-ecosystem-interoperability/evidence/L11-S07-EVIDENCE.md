# Architecture Evidence Ledger: L11.S07 Ecosystem interoperability

## 1. Sub-LEGO Identity
- **ID**: `L11.S07`
- **Name**: Ecosystem interoperability
- **Owning LEGO**: `L11-future-platform`
- **Runtime Host**: `H07` (Compatibility Host)
- **State Ownership**: `stateless`
- **Status Promoted To**: `TESTED`

## 2. Invariants & Proof of Conformance
1. **Stateless Ecosystem Interoperability Boundary**:
   - Manages state domain `stateless` executing protocol negotiation, schema translation, and error taxonomy conversions.
   - Enforces transport-neutrality at contract and adapter boundaries.
2. **Protocol Negotiation & Version Compatibility**:
   - Supports protocol version negotiation across `OpenApiV3`, `ZapierWebhookV2`, and `GenericRestV1`.
   - Rejects unsupported protocols or unregistered connector IDs fail-closed (`UnsupportedProtocol`).
3. **Schema Mapping & Error Taxonomy Translation**:
   - Transforms external incoming payloads (Zapier Webhooks, REST payloads) into standard n8n canonical structure (`[{ json: ..., pairedItem: ... }]`).
   - Normalizes external HTTP status codes to canonical taxonomy (`RateLimited`, `Unauthorized`, `BadRequest`, `Timeout`, `InternalError`).
4. **Transport-Neutral Port Contract**:
   - Implements provided port `port.future.ecosystem.convert.v1`.
   - Requires envelope contracts via `port.runtime.contract.envelope.v1`.
5. **Boundary Isolation**:
   - 0 private cross-Sub-LEGO imports. All communication strictly routed via public typed ports.

## 3. Verification Commands & Results
- Unit & protocol test verification:
  - Protocol negotiation success and rejection: PASS.
  - Schema conversion to canonical n8n format: PASS.
  - External error code mapping: PASS.
  - Port invocation convert and error mapping: PASS.
- Port contract integration tests:
  - Port lifecycle verified in `crates/n8n-port-contract`.
