# P5-M06 DELIVERY — Email-based password recovery (DEC-0028 rev 2, option A)

**Slice:** P5-M06 (#85) — "Email-based password recovery: mail transport decision + upstream
`/rest/forgot-password` delivery over the P5 reset-token primitive (split out of P5-M03)"
**Governance:** DEC-0028 rev 2 **ACTIVE**, `decidedBy: OWNER`, `selectedOption: A-injected-transport`
**Delivery:** provider-neutral injected `MailTransport` + deterministic recovery-mail delivery
wired through the composition root. No SMTP client and no provider SDK is bundled.

## CP-01 — Injected mail transport contract

`apps/n8n-lego/src/auth/security/mail-transport.mjs` (new).

- **Contract:** `send(message) -> Promise<SendOutcome>`; *pure values in, frozen values out; the
  host does the IO* (the repo's standard split). Messages are validated and frozen by
  `freezeMailMessage` — only the provider-neutral keys `to`/`subject`/`text`/`html?` survive, so a
  provider-specific field cannot enter the contract. Outcomes are frozen
  `{ messageId, accepted }`; a partially accepted send is a **REFUSED failure** carrying
  `details.rejected`, never a quiet success.
- **Closed error model:** `MailTransportError` refuses any code outside `MAIL_TRANSPORT_REASON`
  (the P5.1 SecurityError trick). Every reason maps onto an **already-published** error code
  (`INVALID_MESSAGE→lego.contract_violation`, `UNAVAILABLE→lego.unavailable`,
  `TIMEOUT→lego.deadline_exceeded`, `REFUSED→lego.access_denied`) — a mapping, not a new
  namespace, so `contracts/errors.contract.json` (and `contract-lock.json`) do not change.
  `assertMailTransportReason` pins the mapping against the published vocabulary.
- **Adapters shipped (no IO in either):** `createConsoleMailTransport({ logger })` — dev default,
  logs a **redacted** view only — and `createRecordingMailTransport()` — the recording fake
  DEC-0028 prescribes for tests, with single-use typed failure injection (`failNext`).
- **Secret hygiene:** the reset URL *is* the credential. `redactMailSecrets` masks `token=`
  query parameters; every log path runs bodies through it (test asserts the raw token never
  reaches a log line).

## CP-02 — Password recovery surface over the P5 reset-token primitive

The surface (`POST /rest/forgot-password`, `GET /rest/resolve-password-token`,
`POST /rest/change-password`) is the P5-M03 work in `account-routes.mjs`, kept as-is: the
transport must not mint its own tokens (P5-M06-PREP). P5-M06 delivers the mail half and proves
the closed loop end to end (test "forgot-password delivers through the transport; token
completes the reset; replay refused"):

- pinned upstream answer: identical empty `200 {}` for existing and unknown accounts
  (enumeration resistance), delivery never awaited;
- the composed message carries the issued token URL; `resolve-password-token` -> 200,
  `change-password` -> 200 and single-use replay -> 404 (same answer as every other miss);
- login works with the new password afterwards;
- the token appears in **no log line** (route logs + delivery logs + transport logs).

## CP-03 — Delivery wiring through the injected transport

`apps/n8n-lego/src/auth/password-reset-delivery.mjs` (new) + `server.mjs` composition root.

- `composePasswordResetMail` is deterministic (byte-stable template, no timestamps/ids), the
  subject is pinned to upstream's (`"n8n password reset"`, `user-management-mailer.ts`), and the
  input shape is upstream's `PasswordResetData` (`{ email, firstName, passwordResetUrl }`).
- `createPasswordResetDelivery({ transport, logger })` is the `delivery` port
  `accountRoutes` consumes. It sends **only** through the injected transport (injection-swap
  test: with a recording fake injected, the console path runs zero times). Transport failures
  propagate with their closed code; a foreign throw is wrapped into `UNAVAILABLE` without copying
  foreign internals; the success log carries `messageId` only — never the body/URL.
- Composition root (`startServer`): `mailTransport` option. Default `null` binds the console
  transport (dev-safe). A deployment injects its SMTP/provider adapter here (outside the product
  bundle). `mailTransport: false` unplants delivery entirely. Handle exposed on the return value
  (`mailTransport`) like `backing` for test seeding.

## CP-04 — Tests + rollback

`apps/n8n-lego/test/lego-mail-transport.test.mjs` — **18 focused tests, all green**:

1. contract: closed reasons ↔ published codes; `MailTransportError` freezes and refuses
   out-of-set codes (incl. published-but-not-a-reason, e.g. `lego.cancelled`);
2. `freezeMailMessage` validation + provider-field stripping; `redactMailSecrets` masks tokens;
3. composition determinism + pinned subject + greeting fallback;
4. adapters: recording fake (record/failNext), console redaction (raw token never logged),
   injection swap with no hidden provider, typed failure propagation, foreign-throw wrapping,
   INVALID input never reaches the transport;
5. E2E over the reset-token primitive (see CP-02) + explicit `auth.password-reset-delivery-failed`
   warn on transport failure with the HTTP answer unchanged;
6. rollback: `delivery = null` restores the pinned upstream 500 ("Email sending must be set up
   in order to request a password reset email") identical for every address; the outstanding
   token from the wired phase still resolves (reset-token history untouched); composition-root
   test proves both `mailTransport: recording` injection and `mailTransport: false`.

**Rollback contract:** unplug the binding (`delivery = null` / `mailTransport: false`) — the
upstream no-SMTP answer returns and reset-token history is untouched. Scaffolding is reversible
(interface + adapters delete without data migration).

**Regression:** `lego-account-security.test.mjs` 70/70 (its "no delivery port => upstream 500"
fixtures pass unchanged — the harness injects `delivery` explicitly).

## CP-05 — Evidence + delivery notes committed; battery green

| Suite | Result |
|---|---|
| `lego:test` (incl. 18 new) | **3071/3071** |
| `workflow-lego:test` (engine isolation) | 19/19 |
| `runtime:test` | 79/79 |
| `frontend-lego:test` | 672 pass / 0 fail (1 pre-existing skip) |
| gates: arch, arch:selftest, foundation, foundation:selftest, capabilities, scaleout, ai:check | **7/7 PASS** |
| `ai-pack --check` | in sync |
| `governance-register --validate` | clean |

Environment note: the runner workspace was wiped before this delivery (7th time); the reference
runtime (`scripts/setup-reference-runtime.sh`), `packages/workflow-lego` deps + build and the
node catalog were restored before the battery ran.

**Zero silent failure:** every send outcome is either a frozen typed success or a thrown
`MailTransportError`; route-level delivery failures are explicit warnings; no test asserts a
swallowed promise.

**Not in scope (unchanged):** SMTP/provider clients (options B/C remain operator-side adapters
behind the same contract), account enumeration semantics (P5-M03), reset-token semantics
(P5.6 primitive).
