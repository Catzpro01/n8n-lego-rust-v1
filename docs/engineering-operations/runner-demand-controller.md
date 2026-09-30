# Demand-Based Self-Hosted Runner Controller

## Purpose

Keep the Windows laptop from running the full target runner fleet continuously.

The controller consumes GitHub's `workflow_job` webhook and computes desired
runner capacity:

- 0 jobs -> 0 active runners
- 1 job -> 1 active runner
- 2+ jobs -> up to `RUNNER_MAX_ACTIVE` (default 2)
- excess work remains queued in GitHub

The default cap of 2 is intentionally conservative for a laptop. It can be
changed at deployment time without changing the laptop's operating-system
configuration.

## Endpoint

`POST /webhooks/github/workflow-job`

Required header:

`X-Hub-Signature-256: sha256=<HMAC-SHA256>`

The controller rejects unsigned or incorrectly signed requests.

`GET /health` reports the desired and currently actuated capacity.

## Lifecycle

1. GitHub emits `workflow_job: queued`.
2. Controller calculates demand.
3. If an actuator is configured, it receives the desired active-runner count.
4. When jobs complete, capacity is reduced after a short drain delay.
5. GitHub queues jobs when no matching runner is online.

## Important boundary

This repository change does **not** alter Windows services, runner
registration, Docker Desktop, WSL, Defender, power settings, or other laptop
configuration.

The optional `RUNNER_ACTUATOR_URL` is an integration boundary. It must point
to an already-authorized runner lifecycle service. Leaving it unset is safe
planning mode: GitHub webhooks are processed and desired capacity is reported,
but no machine is started or stopped.

## Deployment requirements

Run the controller on an always-on control-plane host (for example the existing
Arena gateway/VPS), not on the runner it is supposed to wake.

Configure:

- `GITHUB_WEBHOOK_SECRET_FILE`
- `RUNNER_MAX_ACTIVE` (default `2`)
- `RUNNER_SCALE_DOWN_DELAY_MS` (default `30000`)
- optionally `RUNNER_ACTUATOR_URL`

Configure a GitHub repository webhook for the `Workflow jobs` event and route
it through the existing Arena gateway boundary.

Do not put GitHub credentials or webhook secrets in git.

## Safety properties

- HMAC verification is mandatory.
- No shell commands are executed from webhook data.
- No credentials are logged.
- No privileged Docker socket is required.
- Runner capacity is capped.
- Scale-down is delayed so a short job burst does not repeatedly flap capacity.
- A failed actuator does not erase the desired state.

## Acceptance

Before enabling actuation:

1. Send signed `queued`, `in_progress`, and `completed` events.
2. Verify `/health` transitions to 1, then back to 0.
3. Verify concurrent jobs cap at 2.
4. Verify malformed signatures return HTTP 401.
5. Verify no laptop configuration changes occur.

Only after those checks should an existing runner lifecycle actuator be wired.
