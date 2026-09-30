#!/usr/bin/env node
/**
 * Arena demand-based runner controller.
 *
 * Receives GitHub workflow_job webhook events and maintains desired runner
 * capacity. It deliberately does NOT modify Windows/Docker/WSL configuration.
 *
 * The actuator is optional: when RUNNER_ACTUATOR_URL is unset, the controller
 * remains in planning mode and only exposes desired state.
 */

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";

const PORT = Number(process.env.RUNNER_CONTROLLER_PORT || 7892);
const HOST = process.env.RUNNER_CONTROLLER_BIND || "127.0.0.1";
const SECRET_FILE = process.env.GITHUB_WEBHOOK_SECRET_FILE;
const SECRET = SECRET_FILE ? fs.readFileSync(SECRET_FILE, "utf8").trim() : "";
const ACTUATOR_URL = process.env.RUNNER_ACTUATOR_URL || "";
const MAX_ACTIVE = Math.max(1, Number(process.env.RUNNER_MAX_ACTIVE || 2));
const SCALE_DOWN_DELAY_MS = Math.max(0, Number(process.env.RUNNER_SCALE_DOWN_DELAY_MS || 30000));

const jobs = new Map();
let desired = 0;
let active = 0;
let scaleDownTimer = null;

function signatureValid(body, header) {
  if (!SECRET || typeof header !== "string" || !header.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", SECRET).update(body).digest("hex");
  const supplied = header.slice(7);
  return supplied.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
}

function calculateDesired() {
  const queued = [...jobs.values()].filter(j => j.status === "queued").length;
  const running = [...jobs.values()].filter(j => j.status === "in_progress").length;
  return Math.min(MAX_ACTIVE, Math.max(queued + running, running));
}

async function actuate(target) {
  if (!ACTUATOR_URL) return { mode: "planning", target };
  const response = await fetch(ACTUATOR_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ desiredActiveRunners: target, reason: "workflow_job" })
  });
  if (!response.ok) throw new Error(`actuator returned HTTP ${response.status}`);
  return { mode: "actuated", target };
}

async function reconcile() {
  const target = calculateDesired();
  if (target === desired) return;
  desired = target;

  if (target < active) {
    clearTimeout(scaleDownTimer);
    scaleDownTimer = setTimeout(() => {
      actuate(desired).then(() => { active = desired; }).catch(() => {});
    }, SCALE_DOWN_DELAY_MS);
    return;
  }

  clearTimeout(scaleDownTimer);
  try {
    await actuate(target);
    active = target;
  } catch {
    // Keep desired state visible; a later webhook/health cycle retries.
  }
}

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return json(res, 200, {
      status: "ok",
      mode: ACTUATOR_URL ? "actuated" : "planning",
      activeRunners: active,
      desiredActiveRunners: desired,
      trackedJobs: jobs.size,
      maxActive: MAX_ACTIVE
    });
  }

  if (req.method !== "POST" || req.url !== "/webhooks/github/workflow-job") {
    return json(res, 404, { error: "not_found" });
  }

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  if (!signatureValid(raw, req.headers["x-hub-signature-256"])) {
    return json(res, 401, { error: "invalid_signature" });
  }

  let event;
  try { event = JSON.parse(raw.toString("utf8")); }
  catch { return json(res, 400, { error: "invalid_json" }); }

  const action = event.action;
  const job = event.workflow_job;
  if (!job?.id || !["queued", "in_progress", "completed"].includes(action)) {
    return json(res, 202, { accepted: true, ignored: true });
  }

  if (action === "completed") jobs.delete(String(job.id));
  else jobs.set(String(job.id), { id: job.id, status: action });

  await reconcile();
  return json(res, 202, {
    accepted: true,
    action,
    desiredActiveRunners: desired,
    activeRunners: active
  });
});

server.listen(PORT, HOST, () => {
  console.log(`runner-demand-controller listening on http://${HOST}:${PORT}`);
});
