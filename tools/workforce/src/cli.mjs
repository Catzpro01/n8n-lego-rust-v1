#!/usr/bin/env node
// Matrix trigger: DEC-0027 requires the full DEC-0015 matrix on the exact head being merged, so this governance PR carries a no-op code touch (docs-only diffs are paths-ignored by Level 0/1/2) to run every required check here. No behavior.
// Matrix trigger (see DEC-0027): docs-only governance diffs are paths-ignored by Level 0/1/2, so this no-op comment forces the full required matrix on the exact head being merged. No behavior.
// Governance CLI (DEC-0019: the Manager executes every task; there is no task-distribution engine).
//
//   node tools/workforce/src/cli.mjs <command>
//
//   decisions-check               validate the decision records under docs/engineering-operations/workforce/decisions
//   checks <jobs.json|->          DEC-0015 merge verdict for exact-head jobs ({ jobs, onlineRunners? })
//
// Exit codes: 0 ok, 1 findings / merge not allowed, 2 usage error.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { classifyChecks, formatChecks } from './checks.mjs';
import { validate, WORKFORCE_DOCS } from './schema.mjs';

export function checkDecisionRecords(dir = join(WORKFORCE_DOCS, 'decisions')) {
  const problems = [];
  const records = [];
  let files = [];
  try { files = readdirSync(dir).filter((f) => /^DEC-\d{4,}\.json$/.test(f)).sort(); } catch { return { records, problems: [`missing ${dir}`] }; }
  for (const f of files) {
    let d;
    try { d = JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch (e) { problems.push(`${f}: ${e.message}`); continue; }
    const errs = validate('Decision', d);
    if (errs.length) problems.push(...errs.map((e) => `${f}: ${e}`));
    if (`${d.objectId}.json` !== f) problems.push(`${f}: objectId ${d.objectId} does not match the file name`);
    records.push(d);
  }
  const ids = new Set(records.map((d) => d.objectId));
  for (const d of records) {
    if (d.supersedes && !ids.has(d.supersedes)) problems.push(`${d.objectId}: supersedes unknown ${d.supersedes}`);
    if (d.supersededBy && !ids.has(d.supersededBy)) problems.push(`${d.objectId}: supersededBy unknown ${d.supersededBy}`);
    if (d.state === 'ACTIVE' && d.supersededBy) problems.push(`${d.objectId}: ACTIVE but superseded`);
  }
  return { records, problems };
}

export function main(argv = process.argv.slice(2), io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  const [cmd, arg] = argv;
  const json = (v) => io.out(`${JSON.stringify(v, null, 2)}\n`);
  switch (cmd) {
    case 'decisions-check': {
      const r = checkDecisionRecords();
      json({ ok: r.problems.length === 0, decisions: r.records.map((d) => `${d.objectId}:${d.state}`), problems: r.problems });
      return r.problems.length ? 1 : 0;
    }
    case 'checks': {
      if (!arg) { io.err('usage: checks <jobs.json|->\n'); return 2; }
      const input = JSON.parse(readFileSync(arg === '-' ? 0 : arg, 'utf8'));
      const r = classifyChecks(input.jobs ?? [], { onlineRunners: input.onlineRunners });
      json({ ...r, summary: formatChecks(r) });
      return r.mergeAllowed ? 0 : 1;
    }
    default:
      io.err('usage: cli.mjs decisions-check | checks <jobs.json|->\n');
      return 2;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
