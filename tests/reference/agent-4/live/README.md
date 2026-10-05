# Live verification harness (Agent 4)

`smoke.mjs` replays the 11-step baseline (`tests/reference/baseline/SMOKE_TEST_RESULTS.md`)
against any running n8n 2.9.4 and exits 0 **only** on 11/11.

| # | Step | Evidence checked |
|---|---|---|
| 1 | n8n starts | `GET /healthz` 200 `{"status":"ok"}`, `/healthz/readiness` 200 |
| 2 | editor opens | `GET /` 200 html; `GET /rest/settings` unauthenticated = public mode |
| 3 | login/owner works | owner setup (or 400 `Instance owner already setup`) → login → `GET /rest/login` role `global:owner` |
| 4 | workflow create | `POST /rest/workflows` (client id kept; duplicate id → 400) |
| 5 | workflow save | settings-only PATCH keeps `versionId`; node-change PATCH bumps it + `workflow_history` row |
| 6 | workflow load | `GET /rest/workflows/:id` 200; unknown → 404 |
| 7 | manual execution | `POST /rest/workflows/:id/run` → `{data:{executionId}}` → status `success`, mode `manual` |
| 8 | one-node execution | Manual Trigger output `[{"json":{},"pairedItem":{"item":0}}]`; `data` is a flatted string |
| 9 | linear execution | Code output `{"status":"ok","count":42}`, source = Manual Trigger |
| 10 | webhook execution | `POST /webhook/smoke-test` 200 `smoke_test:PASS`, `executionMode:production`; GET → 404; unknown → 404; PROPFIND → 500 code 0 |
| 11 | execution recorded | `GET /rest/executions/:id` status `success` mode `webhook`; optional SQLite row check |

```bash
N8N_URL=http://127.0.0.1:5678 N8N_OWNER_EMAIL=… N8N_OWNER_PASS=… \
N8N_SQLITE_PATH=/path/.n8n/database.sqlite \
node tests/reference/agent-4/live/smoke.mjs --record out.json
```

Files:
- `workflows/02-one-node.json`, `03-linear.json` — copies of `tests/reference/02-one-node`, `03-linear`.
- `workflows/04-webhook.json` — reconstruction of the baseline `SMOKETEST001TEST` workflow (Webhook v2.1 POST `smoke-test`, responseMode `lastNode` → Code).
- `baseline-before.json` — recorded **before** Agent 4 isolation work: 11/11.
- `baseline-after.json` — recorded **after** all Agent 4 deliverables: 11/11.
- `record-golden.mjs` — records `../golden/*.golden.json` from a live instance.

Reference instance used in this session: n8n 2.9.4 installed via npm in `/home/user/n8n-runtime`
(SQLite, `N8N_ENCRYPTION_KEY` throw-away, diagnostics off), started with
`node node_modules/n8n/bin/n8n start`. The original VPS (157.10.160.95) was unreachable from the sandbox.
