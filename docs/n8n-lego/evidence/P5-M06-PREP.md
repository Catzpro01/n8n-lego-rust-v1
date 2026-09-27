# P5-M06 Preparation - Mail Transport Options Outlines (REQ-0003 section 9)

**Status:** DEC-0028 is now **ACTIVE** (rev 2, decidedBy OWNER, selectedOption A-injected-transport).
This preparation is the implementation basis for P5-M06 delivery (provider-neutral injected mail
transport). (Historical note: at preparation time DEC-0028 was still PROPOSED. No architecture
is committed; no transport is implemented. These outlines exist so the owner can
decide on concrete trade-offs and so an authorized implementation can start without
re-doing discovery.

## Reset-token primitive (verified, main e7a72b4f)

The P5-M03 reset-token plumbing already exists in `apps/n8n-lego/src/auth/account-routes.mjs`,
`routes.mjs` and `security/step-up.mjs`. Any mail transport delivers the token this
primitive issues; the transport must not mint its own tokens.

## Per-option implementation outlines

**Option A - injected transport (Manager recommendation, DEC-0028 selectedOption).**
Abstract MailTransport interface in the app layer; a dev/console transport ships by
default; a production transport is injected at composition root. Test plan: unit
(interface contract, failure injection: timeout, refused, partial send), integration
(reset mail with console transport asserting token content reaches the message),
regression (auth suites unchanged). Rollback: remove the injection binding; default
console transport remains valid behavior. Scaffolding is reversible (interface +
default impl can be deleted without data migration).

**Option B - external SMTP provider client.**
Provider client behind the same interface (A must exist first), configuration via
environment/config table (additive), no provider-specific fields in the contract.
Test plan: contract tests against the interface with a fake SMTP endpoint; provider
failure matrix (DNS, auth, relay refusal); no live network in CI. Rollback: unbind
provider, fall back to console transport. Note: external provider = trust boundary,
owner-visible; credentials for SMTP must go through P2.27, never plain config.

**Option C - platform-provided mail service.**
Bind the transport to an existing platform mail capability if the deployment
environment provides one (capability discovery first). Same interface as A; test and
rollback plans identical; discovery outcome is itself an acceptance artifact.

## Test plan (common)

Unit: transport contract, error mapping to explicit failures (never silent drop),
token never logged. Integration: full reset-request -> reset-mail -> reset-complete
path with the injected transport. Regression: P5-M03 auth suites, account routes
suites. Zero silent failure: every send outcome is an explicit result.

## What this document is NOT

At preparation time this was not a decision. DEC-0028 has since become ACTIVE (rev 2,
decidedBy OWNER, selectedOption A-injected-transport); only the
owner selects an option (or directs the Manager in chat to record that choice). Any
implementation before ACTIVE state is an invalid-authority error.
