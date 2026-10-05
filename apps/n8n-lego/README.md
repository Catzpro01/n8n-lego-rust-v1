# n8n lego

Workflow automation you can install like n8n: the **real n8n editor UI**
(`n8n-editor-ui` 2.9.4) served by the **LEGO execution engine**.

```bash
npm install -g n8n-lego   # Node >= 22.18
n8n-lego start            # -> http://localhost:5678  (fetches the catalog on first boot)
n8n-lego doctor           # check node, UI bundle, catalog, icons, port
```

Docker and the VPS tarball do the same job:

```bash
docker run -d -p 5678:5678 -v n8n-lego-data:/home/node/.n8n-lego n8n-lego
# or, on a VPS:  tar -xzf n8n-lego-<version>.tar.gz && sudo bash install.sh --systemd
```

From a checkout:

```bash
npm run lego:install      # editor UI bundle + node catalog (483 node types)
npm run lego:start        # http://localhost:5678
npm run lego:doctor       # check node, UI bundle, catalog, port
npm run lego:test         # REST smoke suite (boots a real server)
```

Browser smoke test against a running instance (real n8n UI, Chromium via puppeteer):

```bash
npm --prefix tests/e2e install                       # once; downloads Chromium
npm run lego:smoke -- http://localhost:5678                  # create → add node → save → execute → inspect
npm run lego:smoke -- http://localhost:5678 --mode=verify    # restart the server first: the workflow must survive
```

All three channels, plus proxy/systemd notes: [`docs/n8n-lego/INSTALL.md`](../../docs/n8n-lego/INSTALL.md).
Build every artifact at once with `bash scripts/release.sh`.

First boot shows n8n's own **owner-setup screen** — create the account in the
browser, exactly like upstream n8n.

## What runs where

| Piece | Source | Why |
| :--- | :--- | :--- |
| Editor UI | `n8n-editor-ui@2.9.4` (npm, as-is) | the real canvas, NDV, credentials panel — not a re-implementation |
| Node metadata | `n8n-nodes-base@2.9.1` `dist/types/nodes.json` (7.5 MB, extracted) | palette + parameter panels stay faithful without the 70 MB node package |
| Roles & scopes | extracted from `reference/n8n/.../@n8n/permissions` | buttons/permissions match upstream (owner = 121 scopes) |
| Execution | `packages/reconstructed-engine` | LEGO engine — the piece being ported to Rust |
| Storage | JSON files in `N8N_LEGO_USER_FOLDER` | single-instance VPS; no database server required |
| Realtime | `/push` WebSocket (`src/push.mjs`, no deps) | canvas updates without polling |

The app never implements a DAG loop or node behaviour (single-engine rule,
`docs/lego-integration.md`); `src/engine.mjs` is the only module that calls the
engine and translates its output into n8n's `resultData.runData` shape.

## Configuration

`N8N_LEGO_*` wins over the n8n-compatible `N8N_*` name, so an existing n8n
`.env` mostly works as-is.

| Variable | Default | Notes |
| :--- | :--- | :--- |
| `N8N_LEGO_PORT` / `N8N_PORT` | `5678` | same default port as n8n |
| `N8N_LEGO_HOST` / `N8N_HOST` | `0.0.0.0` | |
| `N8N_LEGO_PATH` / `N8N_PATH` | `/` | serve under a sub-path |
| `N8N_LEGO_USER_FOLDER` / `N8N_USER_FOLDER` | `~/.n8n-lego` | workflows, executions, users, catalog, instance secret |
| `N8N_LEGO_OWNER_EMAIL` / `_PASSWORD` | *(unset)* | skip the setup screen and create the owner at boot |
| `N8N_LEGO_STORAGE` | `file` | `memory` for throwaway runs |
| `N8N_LEGO_EXECUTION_TIMEOUT` | `300000` | ms |
| `N8N_LEGO_LOG_LEVEL` | `info` | `debug` also logs every REST call |
| `N8N_LEGO_PROTOCOL` | `http` | `https` sets the `Secure` cookie flag |
| `N8N_LEGO_EDITOR_BASE_URL` | derived | public URL used for webhook/OAuth callbacks |

Invalid values abort the boot with exit code `78` rather than falling back
silently.

## API

`/rest/*` follows n8n 2.9.4 — same paths, same `{ data }` envelope, same error
shape. Implemented so far:

| Area | Endpoints |
| :--- | :--- |
| Boot | `GET /rest/settings`, `GET /rest/types/nodes.json`, `GET /rest/types/node-versions.json`, `GET /rest/types/credentials.json` |
| Auth | `GET/POST /rest/login`, `POST /rest/logout`, `POST /rest/owner/setup`, `GET/PATCH /rest/me`, `GET /rest/users` |
| Workflows | `GET/POST /rest/workflows`, `GET/PATCH/DELETE /rest/workflows/:id`, `POST /rest/workflows/:id/run`, `activate`, `deactivate`, `GET /rest/active-workflows` |
| Executions | `GET /rest/executions`, `GET /rest/executions/:id`, `DELETE`, `POST /rest/executions/:id/stop`, `POST /rest/executions/delete` |
| Permissions | `GET /rest/roles`, `GET /rest/roles/:slug` |
| Extras | `GET /rest/tags`, `POST /rest/tags`, `GET /rest/projects*`, `GET /rest/module-settings`, `GET /rest/community-node-types` |

An unimplemented call is **not** a silent 404: it is logged as
`[rest:todo] not implemented yet` with the method and path, and answered with an
empty envelope so the editor keeps rendering. Watch the log while clicking
through the UI — that list is the backlog.

## Layout

```
src/server.mjs     boot, base path, session gate, access log, /push upgrade
src/config.mjs     env parsing (fail fast, exit 78)
src/store.mjs      JSON collections (workflows, executions, users, tags) + ids
src/auth.mjs       scrypt passwords, HMAC session cookie, user shapes
src/catalog.mjs    node catalog loading + palette search
src/engine.mjs     the only engine bridge; engine output -> resultData.runData
src/ui.mjs         serves the templated editor bundle (BASE_PATH, CONFIG_TAGS)
src/push.mjs       dependency-free WebSocket for /push
src/rest/          router, settings object, route table
bin/n8n-lego.mjs   CLI: start | doctor | version | help
```

## Testing

```bash
npm run lego:doctor                 # environment checks
node apps/n8n-lego/test/*.test.mjs  # unit tests (node:test)
```
