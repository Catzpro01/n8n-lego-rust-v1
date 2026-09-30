// Repository-level invariants for the governance records (DEC-0002, DEC-0004, DEC-0019).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../src/schema.mjs';
import { checkDecisionRecords, main } from '../src/cli.mjs';

const git = (...args) => { try { return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };

test('DEC-0004: gateway token files are never tracked', (t) => {
  const tracked = git('ls-files', '--', '.arena/gateway_tokens.json', '.arena/workforce-state');
  if (tracked === null) { t.skip('not a git checkout'); return; }
  assert.equal(tracked.trim(), '');
  const ignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
  assert.match(ignore, /^\.arena\/gateway_tokens\.json$/m);
  assert.match(ignore, /^\.arena\/workforce-state\/$/m);
});

test('workforce control plane stays out of the product manifests and product code', () => {
  for (const f of ['apps/n8n-lego/data/domains.json', 'apps/n8n-lego/data/ai-lego-set.json', 'docs/n8n-lego/ai-lego-set.json']) {
    const p = join(REPO_ROOT, f);
    if (existsSync(p)) assert.doesNotMatch(readFileSync(p, 'utf8'), /tools\/workforce|engineering-operations\/workforce/, f);
  }
  const src = join(REPO_ROOT, 'tools', 'workforce', 'src');
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(join(src, f), 'utf8'), /from ['"][./]*\/?apps\/|n8n-lego\/src/, `${f} must not import product code`);
});

test('no secret-like material in governance sources or decisions', () => {
  const roots = [join(REPO_ROOT, 'tools', 'workforce'), join(REPO_ROOT, 'docs', 'engineering-operations', 'workforce')];
  const pat = /(ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else assert.doesNotMatch(readFileSync(p, 'utf8'), pat, p); } };
  for (const r of roots) walk(r);
});

test('canonical decision records are schema-valid and consistent', () => {
  const r = checkDecisionRecords();
  assert.deepEqual(r.problems, []);
  const ids = r.records.map((d) => d.objectId);
  for (const id of ['DEC-0001', 'DEC-0002', 'DEC-0003', 'DEC-0004', 'DEC-0005', 'DEC-0006', 'DEC-0007', 'DEC-0008']) assert.ok(ids.includes(id), id);
  const d5 = r.records.find((d) => d.objectId === 'DEC-0005');
  assert.match(JSON.stringify(d5), /AVAILABLE/, 'DEC-0005 records the AgentState release-edge amendment');
  assert.ok(ids.includes('DEC-0009'), 'DEC-0009 records the Manager credential mechanism');
  for (const d of r.records.filter((x) => x.promotion.canonical)) {
    assert.match(d.promotion.mainCommitSha, /^[0-9a-f]{40}$/, `${d.objectId}: canonical needs the main commit SHA`);
    assert.equal(d.promotion.mainPath, `docs/engineering-operations/workforce/decisions/${d.objectId}.json`, `${d.objectId}: mainPath`);
    assert.ok(d.sources.issues.length || d.sources.prs.length, `${d.objectId}: canonical needs provenance`);
  }
  assert.ok(ids.includes('DEC-0011'), 'DEC-0011 records the Manager-executed completion path');
  const d14 = r.records.find((d) => d.objectId === 'DEC-0014');
  assert.ok(d14 && d14.state === 'ACTIVE' && d14.authority.decidedBy === 'OWNER' && d14.sources.issues.includes(282), 'DEC-0014 records the owner Slice delivery rule (#282)');
  const d15 = r.records.find((d) => d.objectId === 'DEC-0015');
  assert.ok(d15 && d15.state === 'ACTIVE' && d15.authority.decidedBy === 'OWNER' && d15.sources.issues.includes(285) && d15.selectedOption.startsWith('B-'), 'DEC-0015 records the owner two-phase rule, model B (#285)');
  const d16 = r.records.find((d) => d.objectId === 'DEC-0016');
  assert.ok(d16 && d16.state === 'ACTIVE' && d16.selectedOption === 'A-manager-executes-slice-tasks', 'DEC-0016 records the Manager-executed Slice task path');
  const d17 = r.records.find((d) => d.objectId === 'DEC-0017');
  assert.ok(d17 && d17.state === 'SUPERSEDED' && d17.supersededBy === 'DEC-0019' && d17.authority.decidedBy === 'OWNER' && d17.selectedOption === 'A-git-native' && d17.supersedes === 'DEC-0010', 'DEC-0017 is superseded by DEC-0019, its record otherwise kept');
  const d19 = r.records.find((d) => d.objectId === 'DEC-0019');
  assert.ok(d19 && d19.state === 'ACTIVE' && d19.authority.decidedBy === 'OWNER' && d19.selectedOption === 'A-manager-executes' && d19.supersedes === 'DEC-0017', 'DEC-0019 records the owner rule: the Manager executes every task, only main and arena-manager persist');
  const d10 = r.records.find((d) => d.objectId === 'DEC-0010');
  assert.ok(d10.state === 'SUPERSEDED' && d10.supersededBy === 'DEC-0017' && d10.selectedOption === 'open-shared', 'DEC-0010 is superseded, its record otherwise kept');
  for (const d of r.records) assert.ok(Date.parse(d.createdAt) <= Date.parse(d.updatedAt), `${d.objectId}: createdAt <= updatedAt`);
  for (const d of r.records.filter((x) => x.promotion.canonical)) assert.ok(Date.parse(d.createdAt) <= Date.parse(d.promotion.promotedAt), `${d.objectId}: created before promotion`);
  for (const id of ['DEC-0001', 'DEC-0002', 'DEC-0003', 'DEC-0004', 'DEC-0005', 'DEC-0006', 'DEC-0007', 'DEC-0008', 'DEC-0009', 'DEC-0010', 'DEC-0011', 'DEC-0012', 'DEC-0013', 'DEC-0014', 'DEC-0015', 'DEC-0016', 'DEC-0017', 'DEC-0019']) {
    assert.equal(r.records.find((d) => d.objectId === id).promotion.canonical, true, `${id} promoted canonical`);
  }
});

test('cli: decisions-check succeeds; unknown command is a usage error', () => {
  const out = [];
  const io = { out: (s) => out.push(s), err: () => {} };
  assert.equal(main(['decisions-check'], io), 0);
  assert.equal(main(['frobnicate'], io), 2);
});

/**
 * Storage regression guard (2026-09-29).
 *
 * The account is a personal Free plan: 0.50 GB of Actions/Packages storage. On
 * 2026-09-29 the repository alone held 5.94 GB of artifacts - 97% of it one artifact
 * class, `n8n-lego-release`, at ~17 MB per run - which put the account 12x over its
 * allowance and stopped GitHub-hosted jobs from starting at all.
 *
 * The rule this encodes is about PURPOSE, not size: Actions artifact storage is CI
 * scratch space for small, purposeful evidence. A build payload - a distributable
 * tarball, an archive of dist/ or target/, an installed node_modules - is reproducible
 * from the commit and belongs in a release store, never in a CI artifact. Evidence
 * (JSON reports, logs, screenshots, checksums, manifests) is exactly what artifacts are
 * for and is deliberately NOT restricted here.
 */
test('no workflow uploads a build payload as a CI artifact', () => {
  const dir = join(REPO_ROOT, '.github', 'workflows');
  // A path is a payload if it names a distributable archive or a build/dependency tree.
  const PAYLOAD = [
    /\.tgz\s*$/,
    /\.tar\.gz\s*$/,
    /\.tar\.(xz|bz2|zst)\s*$/,
    /\.(zip|whl|jar|deb|rpm|dmg|exe|msi|apk|AppImage)\s*$/,
    /^\s*(dist|build|out|target|node_modules|vendor|\.next|coverage)\/?\s*$/,
  ];
  // ...unless it is the checksum or manifest that describes one, which is the point.
  const EVIDENCE = [/\.sha256\s*$/, /manifest/i, /checksum/i];

  const offenders = [];
  let uploads = 0;
  for (const entry of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const lines = readFileSync(join(dir, entry), 'utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (!/uses:\s*actions\/upload-artifact/.test(lines[i])) continue;
      uploads += 1;
      // walk the `with:` block of this step and collect its path entries
      for (let j = i + 1; j < Math.min(lines.length, i + 40); j += 1) {
        const line = lines[j];
        if (/^\s*-\s*name:/.test(line) || /^\s{0,4}\w[\w-]*:\s*$/.test(line)) break;
        const m = line.match(/^\s*(?:path:\s*)?[|>]?\s*(\S.*)$/);
        if (!m) continue;
        const value = m[1].trim();
        if (!value || value.startsWith('#') || /^(name|if|retention-days|if-no-files-found|overwrite|compression-level):/.test(value)) continue;
        if (EVIDENCE.some((re) => re.test(value))) continue;
        if (PAYLOAD.some((re) => re.test(value))) {
          offenders.push(`${entry}:${j + 1}: ${value}`);
        }
      }
    }
  }
  assert.ok(uploads > 0, 'the scan found upload-artifact steps to check (guard is not vacuous)');
  assert.deepEqual(
    offenders,
    [],
    'A build payload must not be uploaded as a CI artifact: it is reproducible from the\n'
      + 'commit, nothing downloads it, and it exhausts the Actions storage allowance.\n'
      + 'Upload a checksum or manifest instead, and publish real releases to a release store.\n'
      + offenders.join('\n'),
  );
});

/** The guard above must be able to see a violation, or it proves nothing. */
test('the build-payload guard rejects a reintroduced payload upload', () => {
  const sample = [
    '      - name: Upload release artifacts',
    '        uses: actions/upload-artifact@v4',
    '        with:',
    '          name: n8n-lego-release',
    '          path: |',
    '            dist/n8n-lego-0.1.0.tgz',
    '            dist/n8n-lego-0.1.0.tar.gz.sha256',
  ];
  const PAYLOAD = [/\.tgz\s*$/, /\.tar\.gz\s*$/];
  const EVIDENCE = [/\.sha256\s*$/];
  const hits = sample
    .map((l) => l.trim())
    .filter((v) => {
      if (EVIDENCE.some((re) => re.test(v))) return false;
      return PAYLOAD.some((re) => re.test(v));
    });
  assert.deepEqual(hits, ['dist/n8n-lego-0.1.0.tgz'], 'the payload is caught and the checksum is not');
});

test('DEC-0019: the task-distribution engine and legacy agent runtime stay removed', () => {
  const gone = ['tools/workforce/src/engine.mjs', 'tools/workforce/src/scheduler.mjs', 'docs/engineering-operations/workforce/policy.json',
    'tools/arena-bridge', 'tools/arena-executor', 'tools/gateway', 'tools/orchestration/control_plane.py', 'tools/orchestration/task_manager.py', 'tools/orchestration/audit_runner.py',
    '.arena/AGENT_RULES.md', '.arena/templates'];
  for (const p of gone) assert.ok(!existsSync(join(REPO_ROOT, p)), `${p} must not come back without a new owner decision`);
});
