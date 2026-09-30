# Arena CI Deployment Specification & Security Contract

Repository: `Catzpro01/n8n-rust-v.4`

---

## 1. Arsitektur Target & Network Boundary

```text
GitHub
   │
   │ HTTPS Webhook (X-Hub-Signature-256)
   ▼
Cloudflare Tunnel
   │
   │ Private Docker network (arena_internal bridge)
   ▼
arena-gateway
   │
   ├── webhook ingress :7890 (publicly accessible strictly via Tunnel)
   │     - POST only
   │     - HMAC SHA-256 validation
   │     - Exact 40-char hex commit SHA validation
   │     - X-GitHub-Delivery idempotency / deduplication
   │
   ├── control API :7891 (STRICTLY PRIVATE / LOCALHOST)
   │     - Bound to 127.0.0.1
   │     - Published to localhost only
   │     - Never exposed to LAN/public interfaces or the Tunnel
   │
   └── runner orchestration boundary
         - 10 Windows self-hosted runners are the target fleet
         - Linux workloads execute through explicit Docker images on Windows runners
         - Legacy WSL runners are not part of the target adaptive-control topology
```

This deployment contract does not enable adaptive runner scaling by itself; that controller is a separate slice.

---

## 2. Container Filesystem & Security Boundaries

For `arena-gateway`:
- **Least Privilege**: non-root execution as the `node` user.
- **Read-Only App**: `/app` is mounted read-only.
- **Minimal Writable State**: `/var/lib/arena-ci` stores persistent state; `arena_node_modules` is the only writable application dependency volume.
- **Absolute Host Isolation**:
  - Do not mount `C:\`, `C:\Users\`, `C:\Windows\`, `C:\Program Files\`, Desktop, Documents, browser profiles, SSH profiles, or arbitrary drives.
  - Do not mount the Docker socket (`/var/run/docker.sock`).
  - Do not use `privileged: true`.
  - Do not use `network_mode: host`.

---

## 3. Secret Management Contract

- **Zero Secret in Repo**: GitHub authentication and webhook secrets never enter git history.
- **No Git Remote URL Parsing**: the gateway must not extract credentials from the git remote.
- **Local Secret Storage**:
  - `deploy/arena-ci/secrets/github_webhook_secret.txt`
  - `deploy/arena-ci/secrets/github_pat.txt`
- Secret files are mounted as Docker secrets:
  - `/run/secrets/github_webhook_secret`
  - `/run/secrets/github_pat`
- The gateway reads them through the `*_FILE` variables, not token-valued environment variables.
- Secret values must not appear in logs, argv, health responses, compose output, or evidence.
- Prefer a GitHub App installation token over a long-lived PAT when the gateway implementation supports it.

---

## 4. Container Deployment Manifest

Canonical example: `deploy/arena-ci/docker-compose.yml`.

Required properties:
- `arena-gateway` exposes only the private control API to localhost.
- Port `7890` is reachable from `cloudflared` over the internal Docker network and is not published to the host.
- Port `7891` is published only as `127.0.0.1:7891:7891`.
- `cloudflared` mounts its configuration and credential directory read-only.
- The gateway runs health checks before the tunnel is allowed to depend on it.
- Container restart must preserve only the intended data volume.

---

## 5. Granular Health Monitoring

Gateway `/health` should report at least:
1. `gatewayProcess`: `HEALTHY`
2. `runnerSubsystem`: current runner health
3. `githubConnectivity`: current GitHub connectivity/configuration health
4. `tunnel`: current tunnel connectivity health

A deployment is not considered ready from configuration alone; the runtime health response and a real webhook E2E are required evidence.

---

## 6. Acceptance

The deployment is not ready until all of these are proven:

1. Docker containers restart without manual intervention.
2. Cloudflare Tunnel connects to `arena-gateway:7890`.
3. GitHub webhook signature verification passes.
4. Duplicate GitHub deliveries are deduplicated.
5. Exact commit SHA is validated before a job is enqueued.
6. GitHub status reporting works without exposing credentials.
7. `7891` is unreachable from the LAN/public tunnel.
8. The container cannot read arbitrary host paths.
9. Restart preserves only the intended `C:\arena-ci\data` state.
10. Gateway health and a real webhook E2E are evidenced.
