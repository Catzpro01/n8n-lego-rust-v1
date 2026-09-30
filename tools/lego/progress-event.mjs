#!/usr/bin/env node
/**
 * Live progress telemetry — DEC-0021 (LIVE-MILESTONE EXCEPTION).
 *
 *   node tools/lego/progress-event.mjs record --slice P5-M08 --checkpoint CP-03 \
 *          --status in-progress --evidence "<what proves it>" [--commit] [--push]
 *   node tools/lego/progress-event.mjs record --slice P5-M08 --init-file <checkpoints.json> [--commit] [--push]
 *   node tools/lego/progress-event.mjs resolve --slice P5-M08 --checkpoint CP-05 \
 *          --jobs jobs.json [--head <sha>] [--commit] [--push]
 *   node tools/lego/progress-event.mjs verify --slice P5-M08 --checkpoint CP-04 \
 *          --cmd "npm run lego:capabilities" [--on-fail blocked|keep] [--commit] [--push]
 *   node tools/lego/progress-event.mjs show [--slice P5-M08]
 *   node tools/lego/progress-event.mjs classify [-- <path> ...]
 *
 * ONE measurable event is ONE commit (DEC-0021 no-batching rule). The tool never
 * publishes a partial state: it validates first, writes the canonical register
 * `docs/n8n-lego/milestones.json`, regenerates `README.md` and `.ai`, runs the
 * freshness gate, and only then commits and pushes. Any failure restores the
 * register exactly as it was and exits non-zero.
 *
 * The exception is telemetry only. `classify` refuses a direct-main progress commit
 * that touches anything outside LIVE_PROGRESS_PATHS: source, tests, runtime, API,
 * frontend, backend, contracts, schemas, dependencies, Rust, CI workflows, security
 * policy, permissions, infrastructure, database schema or production configuration.
 *
 * Progress never bypasses a completion gate. A checkpoint can reach 100% realtime
 * while the slice still contributes 0% to Slice Completion, because only
 * `implemented` (DEC-0014 + DEC-0015) moves completion.
 *
 * Owner: manager. Pure Node, no dependencies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyChecks, OK } from '../workforce/src/checks.mjs';
import {
  normalizeEol, detectEol, applyEol,
  CHECKPOINT_STATUSES,
  LIVE_PROGRESS_MODEL,
  classifyProgressCommit,
  completionContribution,
  displayStatus,
  formatPercent,
  headlineMetrics,
  programTally,
  sliceDeliveryProgress,
  sliceRecords,
  validateGovernanceRegister,
  validateSliceCheckpoints,
  verifyingIndex,
} from './governance-register.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REGISTER_PATH = join(REPO_ROOT, LIVE_PROGRESS_MODEL.register);
const AI_PACK = join(REPO_ROOT, 'tools/lego/ai-pack.mjs');

const SLICE_INDENT = ' '.repeat(10);
const SLICE_END = /^ {8}\},?$/;
const CHECKPOINT_ID = /^CP-\d{2,}$/;

const nowIso = () => `${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}`;

/* ------------------------------------------------------------------ pure model */

/** Every slice of programs + future programs, with its parent, by id. */
export function findSlice(register, sliceId) {
  for (const record of sliceRecords(register)) {
    if (record.slice.id === sliceId) return record;
  }
  return null;
}

const nonEmpty = (value) => String(value ?? '').trim();

/**
 * Apply one progress event to a *clone* of the register. Throws on any rule
 * violation, so the caller never writes an invalid register.
 */
export function applyProgressEvent(register, event = {}) {
  const sliceId = nonEmpty(event.slice);
  if (!sliceId) throw new Error('record: --slice is required');
  const found = findSlice(register, sliceId);
  if (!found) throw new Error(`record: slice ${sliceId} is not in the register`);

  const next = structuredClone(register);
  const target = findSlice(next, sliceId).slice;
  const at = nonEmpty(event.at) || nowIso();

  if (event.initFile) {
    const declared = JSON.parse(readFileSync(resolve(REPO_ROOT, event.initFile), 'utf8'));
    if (!Array.isArray(declared) || declared.length === 0) throw new Error('record: --init-file must hold a non-empty checkpoint array');
    target.checkpoints = declared.map((checkpoint) => normalizeCheckpoint(checkpoint, sliceId));
  } else {
    const checkpointId = nonEmpty(event.checkpoint);
    if (!CHECKPOINT_ID.test(checkpointId)) throw new Error(`record: --checkpoint must look like CP-01 (got "${checkpointId}")`);
    const checkpoints = Array.isArray(target.checkpoints) ? target.checkpoints : null;
    if (!checkpoints) {
      throw new Error(`record: ${sliceId} declares no checkpoint model. Install one first with --init-file (weights must sum to 100).`);
    }
    const checkpoint = checkpoints.find((item) => item.id === checkpointId);
    if (!checkpoint) throw new Error(`record: ${sliceId} has no checkpoint ${checkpointId} (declared: ${checkpoints.map((item) => item.id).join(', ')})`);
    if (nonEmpty(event.title)) checkpoint.title = nonEmpty(event.title);
    if (nonEmpty(event.purpose)) checkpoint.purpose = nonEmpty(event.purpose);
    if (event.weight !== undefined) {
      if (!Number.isInteger(event.weight) || event.weight <= 0) throw new Error(`record: --weight must be a positive integer (got ${event.weight})`);
      checkpoint.weight = event.weight;
    }
    if (nonEmpty(event.status)) {
      if (!CHECKPOINT_STATUSES.includes(event.status)) {
        throw new Error(`record: --status must be one of ${CHECKPOINT_STATUSES.join(', ')} (got ${event.status})`);
      }
      checkpoint.status = event.status;
    }
    if (nonEmpty(event.evidence)) checkpoint.evidence = nonEmpty(event.evidence);
    if (nonEmpty(event.reference)) checkpoint.reference = nonEmpty(event.reference);
    if (nonEmpty(event.blockedBy)) checkpoint.blockedBy = nonEmpty(event.blockedBy);
    if (nonEmpty(event.reason)) checkpoint.reason = nonEmpty(event.reason);
    if (nonEmpty(event.completedAt)) checkpoint.completedAt = nonEmpty(event.completedAt);
    // A transition into a state must carry that state's own proof for THIS event:
    // an old evidence string is not evidence that the work happened now.
    if (checkpoint.status === 'completed') {
      if (!nonEmpty(event.evidence)) {
        throw new Error(`record: ${sliceId} ${checkpointId} cannot be completed without --evidence for this event`);
      }
      if (!nonEmpty(checkpoint.completedAt)) checkpoint.completedAt = at;
    } else {
      delete checkpoint.completedAt;
    }
    if (checkpoint.status === 'blocked') {
      if (!nonEmpty(event.blockedBy ?? checkpoint.blockedBy ?? target.blockedBy)) {
        throw new Error(`record: ${sliceId} ${checkpointId} cannot be blocked without --blocked-by`);
      }
    } else {
      delete checkpoint.blockedBy;
    }
    if (checkpoint.status === 'skipped') {
      if (!nonEmpty(event.reason ?? checkpoint.reason)) {
        throw new Error(`record: ${sliceId} ${checkpointId} cannot be skipped without --reason`);
      }
    } else {
      delete checkpoint.reason;
    }
  }

  // `updatedAt` is stamped BEFORE validation: the register rule "a slice with
  // checkpoints must record updatedAt" is satisfied by this very event, so
  // validating first would reject the first checkpoint a slice ever records.
  target.updatedAt = at;
  if (nonEmpty(event.latestUpdate)) target.latestUpdate = nonEmpty(event.latestUpdate);

  const problems = [...validateSliceCheckpoints(target), ...validateGovernanceRegister(next)];
  if (problems.length) throw new Error(`record: the register would be invalid:\n- ${problems.join('\n- ')}`);

  return { register: next, slice: target, at };
}

function normalizeCheckpoint(checkpoint, sliceId) {
  const normalized = {};
  for (const key of ['id', 'title', 'purpose', 'weight', 'status', 'evidence', 'reference', 'completedAt', 'blockedBy', 'reason']) {
    if (checkpoint[key] !== undefined && checkpoint[key] !== null) normalized[key] = checkpoint[key];
  }
  if (!CHECKPOINT_ID.test(nonEmpty(normalized.id))) throw new Error(`record: ${sliceId} checkpoint id "${normalized.id}" must look like CP-01`);
  return normalized;
}

/* ----------------------------------- DEC-0015 evidence from the GitHub API */

const API = 'https://api.github.com';

/**
 * Pull the jobs of every workflow run on a head SHA, straight from the GitHub
 * Actions jobs API. The Manager never exports anything by hand: `resolve --fetch`
 * asks for the evidence and classifies it. Returns job objects in the shape
 * `classifyChecks` expects ({ name, status, conclusion, labels, runner_name, run_id }).
 */
export async function fetchJobs({ repo, head, token, fetchImpl = globalThis.fetch } = {}) {
  if (!repo || !head) throw new Error('fetchJobs needs a repo and a head SHA');
  const auth = token ? { Authorization: `token ${token}` } : {};
  const runs = await get(`${API}/repos/${repo}/actions/runs?head_sha=${head}&per_page=100`, fetchImpl, auth);
  const jobs = [];
  for (const run of runs.workflow_runs ?? []) {
    const page = await get(`${API}/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`, fetchImpl, auth);
    for (const job of page.jobs ?? []) {
      jobs.push({
        name: job.name, status: job.status, conclusion: job.conclusion,
        labels: job.labels ?? [], runner_name: job.runner_name ?? null, run_id: run.id,
      });
    }
  }
  return jobs;
}

/** Self-hosted runner availability, for the DEC-0015 WAITING_RUNNER test. */
export async function fetchOnlineRunners({ repo, token, fetchImpl = globalThis.fetch } = {}) {
  if (!repo) throw new Error('fetchOnlineRunners needs a repo');
  const auth = token ? { Authorization: `token ${token}` } : {};
  const page = await get(`${API}/repos/${repo}/actions/runners?per_page=100`, fetchImpl, auth);
  return (page.runners ?? []).map((r) => ({ name: r.name, busy: r.busy, labels: r.labels ?? [] }));
}

async function get(url, fetchImpl, headers) {
  const response = await fetchImpl(url, { headers: { Accept: 'application/vnd.github+json', ...headers } });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
}

/* --------------------------------------------- evidence -> checkpoint state */

/**
 * DEC-0021 §5/§6: the Manager submits evidence identity, never a percentage.
 * `deriveCheckpointState` turns operational evidence into a checkpoint state:
 *
 *   - every required self-hosted check green        -> completed
 *   - a self-hosted check failed                    -> blocked (with the failure)
 *   - anything still queued / running / waiting     -> in-progress (not earned)
 *
 * The classification itself is DEC-0015's (`tools/workforce/src/checks.mjs`), so
 * WAITING_RUNNER is never PASS and an absent self-hosted check is never success.
 * PURE: jobs come from the GitHub Actions jobs API ({ name, status, conclusion,
 * labels, runner_name, run_id }).
 */
export function deriveCheckpointState(jobs = [], { onlineRunners, head, required = [] } = {}) {
  const verdict = classifyChecks(jobs, { onlineRunners });
  const where = head ? ` on ${head}` : '';
  const selfHosted = verdict.selfHosted;
  // DEC-0015 needs named checks, not "everything that ran is green": a head that
  // never ran the Level 0/1/2 suite is ALL_GREEN and still unverified. When the
  // checkpoint declares the checks it requires, only those can earn it.
  const wanted = [...new Set(required)].filter(Boolean);
  if (wanted.length) {
    const missing = wanted.filter((name) => !jobs.some((job) => job.name === name));
    const unfinished = wanted.filter((name) => jobs.some((job) => job.name === name && job.status !== 'completed'));
    const failed = wanted.filter((name) => jobs.some((job) => job.name === name && job.status === 'completed' && !OK.has(job.conclusion)));
    if (missing.length) {
      return {
        status: 'in-progress',
        evidence: `DEC-0015 verification is incomplete${where}: required check(s) have not run: ${missing.join(', ')}. An absent self-hosted check is never success.`,
        verdict, required: wanted,
      };
    }
    if (failed.length) {
      return {
        status: 'blocked',
        evidence: `DEC-0015 self-hosted verification FAILED${where}: ${failed.join(', ')} completed without success (${verdict.reasons.join('; ')}).`,
        blockedBy: `self-hosted verification failed${where}: ${failed.join(', ')} — classify the failure before recording it as environmental or an implementation regression`,
        verdict, required: wanted,
      };
    }
    if (unfinished.length) {
      return {
        status: 'in-progress',
        evidence: `DEC-0015 verification not finished${where}: ${unfinished.join(', ')} still running. WAITING_RUNNER is never PASS, so the checkpoint is not earned.`,
        verdict, required: wanted,
      };
    }
    return {
      status: 'completed',
      evidence: `DEC-0015 verification PASS${where}: ${wanted.map((name) => jobLabel(jobs, name)).filter(Boolean).join('; ')}. Verdict ${verdict.verdict} (${formatChecksSummary(verdict)}).`,
      verdict, required: wanted,
    };
  }
  const passed = selfHosted.pass.map((name) => jobLabel(jobs, name)).filter(Boolean);
  if (verdict.verdict === 'BLOCKED' && selfHosted.fail.length) {
    return {
      status: 'blocked',
      evidence: `DEC-0015 self-hosted verification FAILED${where}: ${selfHosted.fail.join(', ')} (${verdict.reasons.join('; ')})`,
      blockedBy: `self-hosted verification failed${where}: ${selfHosted.fail.join(', ')} — classify the failure before recording it as environmental or an implementation regression`,
      verdict,
    };
  }
  if (verdict.verdict === 'PENDING' || verdict.verdict === 'ALLOWED_BY_DEC-0015' || !selfHosted.pass.length) {
    const waiting = [...selfHosted.running, ...selfHosted.waitingRunner, ...verdict.hosted.pending];
    return {
      status: 'in-progress',
      evidence: `DEC-0015 verification not finished${where}: ${waiting.length ? waiting.join(', ') : verdict.reasons.join('; ')}. WAITING_RUNNER is never PASS, so the checkpoint is not earned.`,
      verdict,
    };
  }
  return {
    status: 'completed',
    evidence: `DEC-0015 self-hosted verification PASS${where}: ${passed.join('; ')}. Verdict ${verdict.verdict} (${formatChecksSummary(verdict)}).`,
    verdict,
  };
}

/** The DEC-0015 checks a checkpoint declares it needs (register `checkpoints[].requires`). */
export function checkpointRequires(register, sliceId, checkpointId) {
  const checkpoint = findSlice(register, sliceId)?.slice.checkpoints?.find((item) => item.id === checkpointId);
  return [...(checkpoint?.requires ?? [])];
}

function jobLabel(jobs, name) {
  const job = jobs.find((item) => item.name === name);
  if (!job) return name;
  const runner = job.runner_name ? ` on ${job.runner_name}` : '';
  const run = job.run_id ? ` (run ${job.run_id})` : '';
  return `${name}${runner}${run}`;
}

function formatChecksSummary(verdict) {
  const sh = verdict.selfHosted;
  return `GitHub-hosted ${verdict.hosted.pass.length} pass, self-hosted ${sh.pass.length} pass / ${sh.fail.length} fail / ${sh.waitingRunner.length} waiting`;
}

/**
 * Run a verification command and derive the checkpoint state from its exit code.
 * Returns the state without writing anything; the caller decides.
 */
export function deriveCommandState(command, { output = '', code = 0 } = {}) {
  if (code === 0) {
    return { status: 'completed', evidence: `\`${command}\` exited 0 (local verification at ${nowIso()})`, blockedBy: undefined };
  }
  const tail = String(output).trim().split('\n').slice(-6).join(' ').slice(0, 600);
  return {
    status: 'blocked',
    evidence: `\`${command}\` exited ${code} (local verification at ${nowIso()}): ${tail}`,
    blockedBy: `verification command failed: \`${command}\` exited ${code}: ${tail}`,
  };
}

/* ------------------------------------------------- register text (surgical) */

/**
 * Rewrite the managed keys (`status`, `checkpoints`, `updatedAt`, `latestUpdate`)
 * of one slice inside the raw register text, leaving every other byte of the file
 * untouched. The register is hand-formatted; re-serialising it would rewrite
 * thousands of unrelated lines in a progress commit.
 */
export function syncSliceText(raw, sliceId, slice) {
  // EOL-PRESERVING, and the only place the register's line endings are handled.
  //
  // Every match below is exact: a line must equal `"id": "P3-M01",` and a status
  // line must match /^ {10}"status": ".+",?$/. On a CRLF working tree every line
  // carries a trailing CR, so none of them match, the slice is reported as "not
  // found", and the writer refuses to run. That is what made the round-trip
  // assertion fail on the self-hosted test job on 2026-09-30.
  //
  // The input is matched canonically and the output is re-terminated with
  // whatever the input used, so a rewrite is still byte-identical when the state
  // has not changed -- the property the round-trip assertion actually checks.
  const eol = detectEol(raw);
  const lines = normalizeEol(raw).split('\n');
  const start = lines.findIndex((line, index) => line === `${SLICE_INDENT}"id": "${sliceId}",`
    && (lines[index + 1] ?? '').startsWith(`${SLICE_INDENT}"title":`));
  if (start === -1) return { ok: false, reason: `slice ${sliceId} was not found in ${LIVE_PROGRESS_MODEL.register}` };
  let end = start + 1;
  while (end < lines.length && !SLICE_END.test(lines[end])) end += 1;
  if (end >= lines.length) return { ok: false, reason: `slice ${sliceId} block is not terminated` };
  if (!lines.slice(start, end).some((line) => /^ {10}"status": ".+",?$/.test(line))) {
    return { ok: false, reason: `slice ${sliceId} has no status line` };
  }

  const out = lines.slice(0, start + 1);
  const rest = lines.slice(start + 1, end);
  let inserted = false;
  const insertManaged = () => {
    if (inserted) return;
    out.push(...renderCheckpointBlock(slice), ...renderKeyLines(slice, ['updatedAt', 'latestUpdate']));
    inserted = true;
  };

  for (let index = 0; index < rest.length;) {
    const line = rest[index];
    const match = line.match(/^ {10}"([a-zA-Z]+)":/);
    const key = match ? match[1] : null;
    if (key === 'status') {
      out.push(`${SLICE_INDENT}${jsonString('status')}: ${jsonString(slice.status)},`);
      insertManaged();
      index += 1;
    } else if (key === 'checkpoints') {
      index += 1;
      if (!/^ {10}"checkpoints": \[\],?$/.test(line)) {
        while (index < rest.length && !/^ {10}\],?$/.test(rest[index])) index += 1;
        index += 1; // the closing bracket of the old block
      }
    } else if (key === 'updatedAt' || key === 'latestUpdate') {
      index += 1;
    } else {
      out.push(line);
      index += 1;
    }
  }
  if (!inserted) {
    const statusAt = out.findIndex((line, index) => index > start && /^ {10}"status": ".+",?$/.test(line));
    out.splice(statusAt + 1, 0, ...renderCheckpointBlock(slice), ...renderKeyLines(slice, ['updatedAt', 'latestUpdate']));
    inserted = true;
  }
  // The slice's last key must not carry a trailing comma: an inserted key may now be last.
  for (let index = out.length - 1; index > start; index -= 1) {
    if (!out[index].trim()) continue;
    if (out[index].endsWith(',')) out[index] = out[index].slice(0, -1);
    break;
  }
  out.push(...lines.slice(end));
  return { ok: true, text: applyEol(out.join('\n'), eol) };
}

function renderKeyLines(slice, keys) {
  const lines = [];
  for (const key of keys) {
    // A key the slice does not carry stays absent: writing `"latestUpdate": null` would add a
    // line the canonical register does not have, for no reason at all.
    if (slice[key] === undefined || slice[key] === null) continue;
    lines.push(`${SLICE_INDENT}${jsonString(key)}: ${jsonString(slice[key])},`);
  }
  return lines;
}

function renderCheckpointBlock(slice) {
  if (slice.checkpoints === undefined) return [];
  if (slice.checkpoints.length === 0) return [`${SLICE_INDENT}${jsonString('checkpoints')}: [],`];
  const lines = [`${SLICE_INDENT}${jsonString('checkpoints')}: [`];
  slice.checkpoints.forEach((checkpoint, index) => {
    lines.push(' '.repeat(12) + '{');
    const entries = Object.entries(checkpoint);
    entries.forEach(([key, value], position) => {
      const comma = position === entries.length - 1 ? '' : ',';
      lines.push(`${' '.repeat(14)}${jsonString(key)}: ${jsonString(value)}${comma}`);
    });
    lines.push(' '.repeat(12) + `}${index === slice.checkpoints.length - 1 ? '' : ','}`);
  });
  lines.push(`${SLICE_INDENT}],`);
  return lines;
}

/**
 * The register escapes non-ASCII (`\u00a7` for §), so a re-rendered line must
 * too — otherwise rewriting one checkpoint would rewrite every accented character
 * in the slice and a progress commit would carry a thousand unrelated diff lines.
 */
function jsonString(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/* ------------------------------------------------------------------- commands */

function readRegister() {
  // The bytes exactly as committed. syncSliceText matches canonically and hands
  // the terminator back, so `sync.text === before.raw` remains a meaningful
  // no-change test and the rollback writes back precisely what was there.
  const raw = readFileSync(REGISTER_PATH, 'utf8');
  return { raw, register: JSON.parse(raw) };
}

/**
 * A key-order-insensitive canonical form. The surgical writer emits the managed
 * keys (`checkpoints`, `updatedAt`, `latestUpdate`) immediately after `status`,
 * while the in-memory clone carries them wherever they were appended, so a plain
 * `JSON.stringify` comparison rejects a register whose content is identical.
 * Array order still matters (slices, checkpoints); object key order does not.
 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function liveState(register, sliceId) {
  const found = findSlice(register, sliceId);
  if (!found) return null;
  const verifying = verifyingIndex(register);
  return {
    id: sliceId,
    program: found.parentId,
    status: displayStatus(found.slice, verifying),
    realtime: sliceDeliveryProgress(found.slice),
    completion: completionContribution(found.slice),
  };
}

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
}

export function changedPaths(cwd = REPO_ROOT) {
  const out = execFileSync('git', ['status', '--porcelain=v1'], { cwd, encoding: 'utf8' });
  const paths = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const body = line.slice(3);
    const renamed = body.split(' -> ');
    paths.push((renamed.length > 1 ? renamed[renamed.length - 1] : body).trim());
  }
  return paths;
}

function record(argv) {
  const flags = parseFlags(argv);
  const event = {
    slice: flags.slice,
    checkpoint: flags.checkpoint,
    status: flags.status,
    title: flags.title,
    purpose: flags.purpose,
    weight: flags.weight === undefined ? undefined : Number(flags.weight),
    evidence: flags.evidence,
    reference: flags.reference,
    blockedBy: flags.blockedBy,
    reason: flags.reason,
    completedAt: flags.completedAt,
    latestUpdate: flags.latestUpdate,
    initFile: flags.initFile,
    at: flags.at,
  };

  const before = readRegister();
  const beforeState = liveState(before.register, event.slice);
  const beforeMetrics = headlineMetrics(before.register);

  let applied;
  try {
    applied = applyProgressEvent(before.register, event);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    return 1;
  }

  // DEC-0021: telemetry never carries delivery state. A slice status transition
  // (in particular to `implemented`) is reconciled by one governance PR.
  const statusBefore = findSlice(before.register, event.slice)?.slice.status;
  const statusAfter = findSlice(applied.register, event.slice)?.slice.status;
  if (statusBefore !== statusAfter) {
    process.stderr.write(`record: refusing to move ${event.slice} from ${statusBefore} to ${statusAfter} in a telemetry commit — delivery state is reconciled by a governance PR (DEC-0020 + DEC-0021)\n`);
    return 1;
  }

  const sync = syncSliceText(before.raw, event.slice, applied.slice);
  if (!sync.ok) {
    process.stderr.write(`${sync.reason}\n`);
    return 1;
  }
  if (canonical(JSON.parse(sync.text)) !== canonical(applied.register)) {
    process.stderr.write('record: the surgical register edit did not round-trip; nothing was written\n');
    return 1;
  }

  if (flags.dryRun) {
    process.stdout.write(`dry run: ${event.slice} would move to ${formatPercent(applied.slice ? sliceDeliveryProgress(applied.slice).percent : 0)} realtime\n`);
    process.stdout.write(sync.text === before.raw ? 'register text: unchanged\n' : 'register text: would change\n');
    return 0;
  }

  // Atomicity: write the register, regenerate every projection, then prove freshness.
  writeFileSync(REGISTER_PATH, sync.text);
  try {
    execFileSync('node', [AI_PACK], { cwd: REPO_ROOT, stdio: 'inherit' });
    execFileSync('node', [AI_PACK, '--check'], { cwd: REPO_ROOT, stdio: 'inherit' });
  } catch {
    writeFileSync(REGISTER_PATH, before.raw); // never publish a partial state
    process.stderr.write('record: projection regeneration or freshness failed; the register was restored\n');
    return 1;
  }

  const paths = changedPaths();
  const classified = classifyProgressCommit(paths);
  if (!classified.ok) {
    // Never publish a partial state: put the register and every projection back.
    writeFileSync(REGISTER_PATH, before.raw);
    execFileSync('node', [AI_PACK], { cwd: REPO_ROOT, stdio: 'inherit' });
    execFileSync('node', [AI_PACK, '--check'], { cwd: REPO_ROOT, stdio: 'inherit' });
    process.stderr.write(`record: refusing to commit non-telemetry paths (DEC-0021); the register and projections were restored:\n- ${classified.violations.join('\n- ')}\n`);
    return 1;
  }

  const afterState = liveState(applied.register, event.slice);
  const afterMetrics = headlineMetrics(applied.register);
  const programOf = (register) => [...(register.programs ?? []), ...(register.futurePrograms ?? [])]
    .find((entity) => (entity.slices ?? []).some((slice) => slice.id === event.slice));
  const programBefore = programTally(programOf(before.register), verifyingIndex(before.register));
  const programAfter = programTally(programOf(applied.register), verifyingIndex(applied.register));
  process.stdout.write([
    `${event.slice}: ${beforeState.status} → ${afterState.status}`,
    `  realtime ${formatPercent(beforeState.realtime.percent)} → ${formatPercent(afterState.realtime.percent)} (current checkpoint: ${afterState.realtime.current ? `${afterState.realtime.current.id} ${afterState.realtime.current.status}` : 'none'})`,
    `  completion contribution ${formatPercent(beforeState.completion)} → ${formatPercent(afterState.completion)}`,
    `  program ${afterState.program} realtime ${formatPercent(programBefore.realtime)} → ${formatPercent(programAfter.realtime)}; slice completion ${formatPercent(programBefore.percent)} → ${formatPercent(programAfter.percent)}`,
    `  delivery realtime ${formatPercent(beforeMetrics.current.realtime)} → ${formatPercent(afterMetrics.current.realtime)}; slice completion ${formatPercent(beforeMetrics.current.sliceCompletion)} → ${formatPercent(afterMetrics.current.sliceCompletion)}`,
    `  register + README + .ai regenerated; npm run lego:ai:check passed`,
  ].join('\n'));

  if (!flags.commit && !flags.push) {
    process.stdout.write('\nno --commit given: the working tree holds the update. Re-run with --commit (and --push) to publish it.\n');
    return 0;
  }

  const message = nonEmpty(flags.message) || `${LIVE_PROGRESS_MODEL.commitPrefix} ${defaultMessage(event)}`;
  try {
    git('add', '--', ...classified.allowed.filter((path) => paths.includes(path)));
    git('commit', '-m', message);
    const sha = git('rev-parse', 'HEAD').trim();
    process.stdout.write(`committed ${sha.slice(0, 8)} on ${git('rev-parse', '--abbrev-ref', 'HEAD').trim()}\n`);
    if (flags.push) {
      git('push', 'origin', 'HEAD:main');
      git('fetch', 'origin', 'main');
      const remote = git('rev-parse', 'origin/main').trim();
      if (remote !== sha) {
        process.stderr.write(`record: origin/main is ${remote.slice(0, 8)}, expected ${sha.slice(0, 8)}\n`);
        return 1;
      }
      process.stdout.write(`pushed and verified: main is ${sha.slice(0, 8)}\n`);
    }
  } catch (error) {
    process.stderr.write(`record: git failed: ${error.message}\n`);
    return 1;
  }
  return 0;
}

function defaultMessage(event) {
  if (event.initFile) return `install ${event.slice} checkpoint model`;
  return `update ${event.slice} ${event.checkpoint} → ${event.status}`;
}

/**
 * Evidence identity in, checkpoint state out. The Manager supplies a jobs export
 * (the GitHub Actions jobs API for the runs that matter) and, optionally, the
 * head SHA they ran on; the DEC-0015 classifier decides the state.
 */
async function resolveCommand(argv, { fetchImpl = globalThis.fetch } = {}) {
  const flags = parseFlags(argv);
  const sliceId = nonEmpty(flags.slice);
  const checkpointId = nonEmpty(flags.checkpoint);
  if (!sliceId || !checkpointId) {
    process.stderr.write('resolve: --slice and --checkpoint are required\n');
    return 2;
  }
  let onlineRunners;
  let jobs = [];
  if (!flags.fetch) {
    if (!nonEmpty(flags.jobs)) {
      process.stderr.write('resolve: --jobs <file.json> or --fetch --head <sha> is required\n');
      return 2;
    }
    try {
      const raw = readFileSync(resolve(REPO_ROOT, flags.jobs), 'utf8');
      const parsed = JSON.parse(raw);
      jobs = Array.isArray(parsed) ? parsed : parsed.jobs ?? [];
    } catch (error) {
      process.stderr.write(`resolve: cannot read --jobs: ${error.message}\n`);
      return 2;
    }
  }
  if (flags.fetch) {
    const repo = nonEmpty(flags.repo) || 'Catzpro01/n8n-rust-v.4';
    const head = nonEmpty(flags.head);
    if (!head) {
      process.stderr.write('resolve: --fetch needs --head <sha>\n');
      return 2;
    }
    const token = process.env[nonEmpty(flags.tokenEnv) || 'GITHUB_TOKEN'] || process.env.GH_TOKEN || '';
    try {
      jobs = await fetchJobs({ repo, head, token, fetchImpl });
      onlineRunners = await fetchOnlineRunners({ repo, token, fetchImpl });
      process.stdout.write(`fetched ${jobs.length} job(s) on ${head} from ${repo}; ${onlineRunners.length} runner(s) reported\n`);
    } catch (error) {
      process.stderr.write(`resolve: --fetch failed: ${error.message}\n`);
      return 2;
    }
  } else if (flags.runners) {
    try {
      const parsed = JSON.parse(readFileSync(resolve(REPO_ROOT, flags.runners), 'utf8'));
      onlineRunners = parsed.runners ?? parsed;
    } catch (error) {
      process.stderr.write(`resolve: cannot read --runners: ${error.message}\n`);
      return 2;
    }
  }
  const required = nonEmpty(flags.require)
    ? nonEmpty(flags.require).split(',').map((name) => name.trim()).filter(Boolean)
    : checkpointRequires(readRegister().register, sliceId, checkpointId);
  const derived = deriveCheckpointState(jobs, { onlineRunners, head: flags.head, required });
  if (flags.fetch) {
    const sh = derived.verdict.selfHosted;
    const idle = (onlineRunners ?? []).filter((r) => !r.busy).length;
    process.stdout.write(`runners: ${idle}/${(onlineRunners ?? []).length} online and idle\n`);
    process.stdout.write(`DEC-0015: hosted ${derived.verdict.hosted.pass.length} pass | self-hosted ${sh.pass.length} pass, ${sh.fail.length} fail, ${sh.running.length} running, ${sh.waitingRunner.length} waiting\n`);
  }
  process.stdout.write([
    `required checks: ${required.length ? required.join(', ') : '(none declared)'}`,
    `DEC-0015 verdict: ${derived.verdict.verdict} — ${formatChecksSummary(derived.verdict)}`,
    `derived state for ${sliceId} ${checkpointId}: ${derived.status}`,
    `  evidence: ${derived.evidence}`,
    derived.blockedBy ? `  blocker: ${derived.blockedBy}` : '',
    derived.verdict.selfHosted.waitingRunner.length ? 'WAITING_RUNNER is never PASS: the checkpoint stays unearned.' : '',
  ].filter(Boolean).join('\n'));

  return record([...argv.filter((token) => !token.startsWith('--jobs') && !token.startsWith('--head') && !token.startsWith('--runners')),
    '--status', derived.status,
    '--evidence', derived.evidence,
    ...(derived.blockedBy ? ['--blocked-by', derived.blockedBy] : []),
    ...(flags.dryRun ? ['--dry-run'] : []),
    ...(flags.commit ? ['--commit'] : []),
    ...(flags.push ? ['--push'] : []),
    ...(flags.message ? ['--message', flags.message] : []),
  ]);
}

/** Run a verification command and record the state its exit code implies. */
function verify(argv) {
  const flags = parseFlags(argv);
  const command = nonEmpty(flags.cmd);
  if (!command) {
    process.stderr.write('verify: --cmd is required\n');
    return 2;
  }
  const onFail = nonEmpty(flags.onFail) || 'blocked';
  if (!['blocked', 'keep'].includes(onFail)) {
    process.stderr.write('verify: --on-fail must be blocked or keep\n');
    return 2;
  }
  process.stdout.write(`running: ${command}\n`);
  let code = 0;
  let output = '';
  try {
    output = execFileSync('sh', ['-c', command], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    code = typeof error.status === 'number' ? error.status : 1;
    output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
  }
  const derived = deriveCommandState(command, { output, code });
  process.stdout.write(`exit ${code} -> ${derived.status}\n  evidence: ${derived.evidence}\n`);
  if (derived.status === 'blocked' && onFail === 'keep') {
    process.stdout.write('--on-fail keep: nothing was recorded. Fix the failure or record the blocker explicitly.\n');
    return 1;
  }
  return record([
    '--slice', flags.slice, '--checkpoint', flags.checkpoint,
    '--status', derived.status,
    '--evidence', derived.evidence,
    ...(derived.blockedBy ? ['--blocked-by', derived.blockedBy] : []),
    ...(flags.commit ? ['--commit'] : []),
    ...(flags.push ? ['--push'] : []),
    ...(flags.dryRun ? ['--dry-run'] : []),
    ...(flags.message ? ['--message', flags.message] : []),
  ]);
}

function show(argv) {
  const flags = parseFlags(argv);
  const { register } = readRegister();
  const verifying = verifyingIndex(register);
  const metrics = headlineMetrics(register);
  const wanted = flags.slice ? [flags.slice] : sliceRecords(register).filter((item) => item.slice.checkpoints).map((item) => item.slice.id);
  if (!wanted.length) {
    process.stdout.write(`no slice declares a checkpoint model. Realtime ${formatPercent(metrics.current.realtime)}, slice completion ${formatPercent(metrics.current.sliceCompletion)}.\n`);
    return 0;
  }
  const lines = [`Realtime Delivery Progress ${formatPercent(metrics.current.realtime)} · Slice Completion ${formatPercent(metrics.current.sliceCompletion)} (${metrics.current.implemented}/${metrics.current.total})`, ''];
  for (const id of wanted) {
    const found = findSlice(register, id);
    if (!found) {
      process.stderr.write(`show: slice ${id} is not in the register\n`);
      return 1;
    }
    const slice = found.slice;
    const progress = sliceDeliveryProgress(slice);
    lines.push(`${id} (${found.parentId}) — ${displayStatus(slice, verifying)} · realtime ${formatPercent(progress.percent)} · completion contribution ${formatPercent(completionContribution(slice))}`);
    lines.push(`  last update: ${slice.updatedAt ?? '—'}${slice.latestUpdate ? ` — ${slice.latestUpdate}` : ''}`);
    for (const checkpoint of slice.checkpoints ?? []) {
      lines.push(`  ${checkpoint.id} ${checkpoint.status} weight ${checkpoint.weight} — ${checkpoint.title}${checkpoint.evidence ? ` · evidence ${checkpoint.evidence}` : ''}${checkpoint.blockedBy ? ` · blocker ${checkpoint.blockedBy}` : ''}${checkpoint.reason ? ` · reason ${checkpoint.reason}` : ''}`);
    }
    lines.push('');
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function classify(argv) {
  const flags = parseFlags(argv);
  const paths = flags._.length ? flags._ : changedPaths();
  const result = classifyProgressCommit(paths);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) {
    process.stderr.write(`DEC-0021: these paths are implementation, not progress telemetry, and need a delivery PR:\n- ${result.violations.join('\n- ')}\n`);
    return 1;
  }
  return 0;
}

function parseFlags(argv) {
  const flags = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--') {
      flags._.push(...argv.slice(index + 1));
      break;
    }
    if (!token.startsWith('--')) {
      flags._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split('=');
    const name = key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (inline !== undefined) flags[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[name] = argv[++index];
    else flags[name] = true;
  }
  return flags;
}

const USAGE = `usage: progress-event.mjs <command>

  record --slice <id> --checkpoint <CP-nn> [--status <status>] [--evidence <ref>]
         [--reference <ref>] [--blocked-by <text>] [--reason <text>] [--weight <int>]
         [--title <text>] [--purpose <text>] [--completed-at <iso>] [--latest-update <text>]
         [--message <text>] [--commit] [--push] [--dry-run]
         (--init-file <checkpoints.json> installs a whole checkpoint model)
  resolve --slice <id> --checkpoint <CP-nn> [--jobs <file.json>] [--head <sha>]
         [--runners <file.json> | --fetch] [--repo <owner/name>] [--token-env <VAR>]
         [--commit] [--push] [--dry-run]
         [--require "Check A,Check B"]   default: the checkpoint's own DEC-0015 requires
         derives the checkpoint state from DEC-0015 check results; no percentage is typed.
         --fetch reads the jobs and the runners from the GitHub API itself
  verify --slice <id> --checkpoint <CP-nn> --cmd "<command>" [--on-fail blocked|keep]
         [--commit] [--push] [--dry-run]
         runs the command and derives completed / blocked from its exit code
  show [--slice <id>]
  classify [-- <path> ...]        exit 1 when a path is not pure progress telemetry
`;

async function main(argv = process.argv.slice(2), { fetchImpl = globalThis.fetch } = {}) {
  const [command, ...rest] = argv;
  if (command === 'record') return record(rest);
  if (command === 'resolve') return resolveCommand(rest, { fetchImpl });
  if (command === 'verify') return verify(rest);
  if (command === 'show') return show(rest);
  if (command === 'classify') return classify(rest);
  process.stderr.write(USAGE);
  return 2;
}

if (import.meta.url === `file://${process.argv[1]}`) main().then((code) => { process.exitCode = code; });

export { main };
