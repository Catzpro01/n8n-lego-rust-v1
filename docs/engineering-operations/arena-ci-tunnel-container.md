# Arena CI — Tunnel + Container Boundary

This deployment contract isolates the laptop-local Arena CI gateway behind two containers:

```text
GitHub
  │ HTTPS webhook
  ▼
Cloudflare Tunnel
  │ private Docker network
  ▼
arena-gateway:7890
  │
  ├── local control API: 127.0.0.1:7891 (published to localhost only)
  └── persistent state: /var/lib/arena-ci
```

## Security boundary

Only these host paths may be mounted:

- `C:\arena-ci\gateway` → read-only application source
- `C:\arena-ci\data` → persistent gateway state
- `C:\arena-ci\cloudflared` → tunnel configuration/credentials, read-only

Do **not** mount:

- `C:\`
- `C:\Users`
- Desktop/Documents/Downloads
- the whole Git checkout
- arbitrary host drives
- Docker socket

Port `7890` is **not published to the Windows host**. Cloudflare Tunnel reaches it over the Docker network.

Port `7891` **is published to localhost only** (`127.0.0.1:7891:7891`). It is not published to LAN/public interfaces and is not routed through the tunnel.

## Secrets

Webhook secret and GitHub authentication are supplied as Docker secrets from files outside Git:

`secrets/github_webhook_secret.txt`
`secrets/github_pat.txt`

The gateway must read these via the *_FILE variables. Secrets must never appear in compose, logs, Git, command arguments, or the tunnel configuration.

Prefer a GitHub App installation token over a long-lived PAT when the gateway supports it.

## Tunnel

The tunnel configuration in `cloudflared/config.yml` intentionally contains no secret. Replace:

- `REPLACE_WITH_TUNNEL_ID`
- the credential JSON filename
- `ci.example.com`

with values provisioned on the deployment host.

The public endpoint should expose **only the GitHub webhook path handled by port 7890**. The operator/control API must remain private.

## Gateway Host Verification

The gateway source is expected under `C:\arena-ci\gateway` and the compose file mounts that exact directory read-only.

Required runtime contracts:
- **Entrypoint**: `server.js` starts ingress (:7890) and control API (:7891).
- **Dependency lockfile**: `package-lock.json` is compatible with `npm ci --omit=dev`.
- **Health endpoint**: `GET /health` on port 7890 returns HTTP 200.
- **Docker secrets**: `GITHUB_WEBHOOK_SECRET_FILE` and `GITHUB_PAT_FILE` are supported.
- **Non-root user**: container runs as `node` with `no-new-privileges:true`.
- **Operator access**: port `127.0.0.1:7891:7891` remains localhost-only.

## Acceptance

The deployment is not ready until all of these are proven:

1. Docker containers restart without manual intervention.
2. Cloudflare Tunnel connects to `arena-gateway:7890`.
3. GitHub webhook signature verification passes.
4. Duplicate GitHub deliveries are deduplicated.
5. Exact commit SHA is validated before a job is enqueued.
6. GitHub status reporting works without exposing credentials.
7. `7891` is unreachable from the LAN/public tunnel.
8. Container cannot read arbitrary host paths.
9. Restart preserves only the intended `C:\arena-ci\data` state.
10. Gateway health and a real webhook E2E are evidenced.
