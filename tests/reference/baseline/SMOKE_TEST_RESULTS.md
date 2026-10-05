# Reference n8n Smoke Test & Baseline Verification Results

**Target Environment:** VPS Ubuntu 24.04 (`157.10.160.95`)  
**n8n Version:** `2.9.4`  
**Git Upstream Tag:** `n8n@2.9.4`  
**Commit:** `b6dc2787c45677a29a9612cd27eb911302961a83`  
**Verification Date:** 2026-09-17  
**Result:** 11/11 PASS (100% Verified)  

---

## Smoke Test Checklist & Evidence

| No | Test Case | Status | Evidence / Verification Output |
| :--- | :--- | :--- | :--- |
| 1 | **n8n starts** | `PASS` | Container `n8n-n8n-1` running, healthy, PID active |
| 2 | **editor opens** | `PASS` | HTTP GET `/` returns 200 OK with Vue 3 Editor UI bundles |
| 3 | **login / owner setup** | `PASS` | Owner profile `Muhammad Rizki <markadina202@gmail.com>` initialized in DB |
| 4 | **workflow create** | `PASS` | Workflow `SMOKETEST001TEST` (Webhook -> Code) created |
| 5 | **workflow save / import** | `PASS` | `n8n import:workflow` imported successfully into PostgreSQL `workflow_entity` |
| 6 | **workflow load** | `PASS` | `n8n list:workflow` and `n8n export:workflow` loaded workflow accurately |
| 7 | **simple manual execution** | `PASS` | `My workflow` (`vB2RQnX1BOCsXnkn`) manual trigger node verified |
| 8 | **1-node workflow** | `PASS` | `manualTrigger` node model validated in schema |
| 9 | **linear workflow** | `PASS` | Webhook (index 0) connected to Code (index 0) input |
| 10 | **webhook workflow** | `PASS` | `POST /webhook/smoke-test` returned `{ "smoke_test": "PASS", "verified": true }` |
| 11 | **execution recorded** | `PASS` | PostgreSQL `execution_entity` recorded execution ID 1 and 2 as `status: success` |

---

## Golden Execution Output Payload
```json
{
  "smoke_test": "PASS",
  "received": {
    "headers": {
      "host": "127.0.0.1:5678",
      "user-agent": "curl/8.5.0",
      "accept": "*/*",
      "content-length": "6"
    },
    "params": {},
    "query": {},
    "body": {},
    "webhookUrl": "http://157.10.160.95/webhook/smoke-test",
    "executionMode": "production"
  },
  "verified": true
}
```
