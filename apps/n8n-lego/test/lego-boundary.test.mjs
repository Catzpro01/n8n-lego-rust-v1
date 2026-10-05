/**
 * Boundary regression tests (P2.9).
 *
 * These exist to stop the specific failure mode that kills component
 * architectures: a boundary is breached, someone widens the allowlist, and the
 * gate goes green while the architecture gets worse. Every test here asserts an
 * UPPER BOUND — a surface that may shrink but never grow.
 */
import { strict as assert } from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { loadRegistry, getDomain, isDependencyAllowed } from '../src/lego/registry.mjs';
import { listExports } from '../../../tools/lego/architecture-gate.core.mjs';

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const registry = loadRegistry({ reload: true });
const lock = JSON.parse(readFileSync(join(APP_ROOT, 'src/lego/contracts/contract-lock.json'), 'utf8'));

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      sourceFiles(full, out);
    } else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

const ALL_SOURCES = sourceFiles(join(APP_ROOT, 'src'));

/* ------------------------------------------------- A1/A2: retired, stay retired */

test('the auth.identity contract exposes exactly two read-only functions', () => {
  const source = readFileSync(join(APP_ROOT, 'src/auth/contract/index.mjs'), 'utf8');
  assert.deepEqual(listExports(source).sort(), ['hasOwner', 'toPublicUser']);
});

test('the auth.identity contract holds no authority', () => {
  // The point of the narrow surface: a consumer can render a user, but cannot
  // become one. If any of these ever appear here, the contract has grown teeth.
  const exported = listExports(readFileSync(join(APP_ROOT, 'src/auth/contract/index.mjs'), 'utf8'));
  for (const forbidden of ['createSession', 'signToken', 'verifyToken', 'hashPassword', 'verifyPassword', 'authenticate', 'createOwner', 'SESSION_COOKIE']) {
    assert.ok(!exported.includes(forbidden), `auth.identity must not export '${forbidden}' — that is authority, not projection`);
  }
});

test('nothing outside src/auth/ imports src/auth.mjs internals', () => {
  // This is the assertion that keeps A1/A2 retired. Before P2.9 the
  // compatibility layer and settings reached straight into src/auth.mjs.
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const relative = file.slice(APP_ROOT.length + 1);
    if (relative === 'src/auth.mjs' || relative.startsWith('src/auth/')) continue;
    if (relative === 'src/server.mjs') continue; // composition root, allowed to wire internals
    const source = readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]*\/auth\.mjs['"]/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders, [], `these files bypass the auth.identity contract: ${offenders.join(', ')}`);
});

test('A1 and A2 are gone from the manifest, not merely marked resolved', () => {
  const ids = registry.allowances.map((allowance) => allowance.id);
  assert.ok(!ids.includes('A1'), 'A1 must be deleted');
  assert.ok(!ids.includes('A2'), 'A2 must be deleted');
});

test('auth.identity is a dependency-free leaf, which is what prevents a cycle', () => {
  const identity = getDomain('auth.identity', registry);
  assert.deepEqual(identity.dependsOn, [], 'auth.identity must depend on nothing');
  assert.equal(identity.parent, 'auth');
  // If it ever depends on compatibility, the compatibility -> auth.identity edge
  // becomes a cycle and the whole arrangement collapses.
  assert.ok(identity.mustNotDependOn.includes('compatibility'));
});

/* --------------------------------------------------------- A3: narrowed, bounded */

test('the allowance set is exactly A3 and A4, and nothing else', () => {
  // P2.6 shipped 3; P2.9 retired 2 (A1, A2). P5.4 added A4 — see the
  // high-water-mark test below for why this list changing is meant to be loud.
  assert.deepEqual(registry.allowances.map((allowance) => allowance.id), ['A3', 'A4']);
});

test('A3 is narrowed to exactly one symbol in exactly one file', () => {
  const a3 = registry.allowances.find((allowance) => allowance.id === 'A3');
  assert.deepEqual(a3.narrowedTo.symbols, ['newExecutionId']);
  assert.equal(a3.narrowedTo.file, 'src/engine.mjs');
  assert.equal(a3.narrowedTo.maxImporters, 1);
});

test('A3 has not grown: only src/engine.mjs imports src/store.mjs internals', () => {
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const relative = file.slice(APP_ROOT.length + 1);
    if (relative === 'src/store.mjs' || relative === 'src/server.mjs') continue;
    if (relative.startsWith('src/reference-lego/')) continue; // its own internal store
    const source = readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]*\/store\.mjs['"]/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(offenders, ['src/engine.mjs'], `A3 may not spread beyond src/engine.mjs — found: ${offenders.join(', ')}`);
});

test('A3 imports only newExecutionId, nothing more', () => {
  const source = readFileSync(join(APP_ROOT, 'src/engine.mjs'), 'utf8');
  const match = source.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/store\.mjs['"]/);
  assert.ok(match, 'expected a braced import of store.mjs in engine.mjs');
  const symbols = match[1].split(',').map((part) => part.trim()).filter(Boolean);
  assert.deepEqual(symbols, ['newExecutionId'], 'A3 is bounded to newExecutionId');
});

test('A3 records that it blocks a scale-out finding', () => {
  const a3 = registry.allowances.find((allowance) => allowance.id === 'A3');
  assert.ok(a3.blocks?.some((item) => /S2|execution-id/i.test(item)),
    'A3 must stay linked to the scale-out blocker it causes, so retiring it cannot be faked');
});

/* --------------------------------------------- allowances may shrink, never grow */

test('the allowance count never exceeds its recorded high-water mark', () => {
  // P2.6 shipped 3. P2.9 retired 2 (A1, A2). P5.4 added A4, moving 1 -> 2.
  //
  // Moving this number is the mechanism, not a workaround: the test exists so
  // that a new allowance cannot appear without someone editing this file and
  // justifying it in review. The direction of travel stays one-way — a THIRD
  // allowance still fails here until this line moves again.
  //
  // A4 is the P5.4 SecretBroker import: P2.27's broker is a locked published
  // contract (lego.plugin-runtime@0.10.0) that lego-foundation does not list in
  // its `public:` surface, and #217 forbids building a second broker. It is
  // pinned as tightly as A3 by the tests immediately below.
  assert.ok(registry.allowances.length <= 2, `allowances must not grow beyond 2; found ${registry.allowances.length}`);
});

test('A4 is narrowed to exactly two symbols in exactly one file', () => {
  const a4 = registry.allowances.find((allowance) => allowance.id === 'A4');
  assert.ok(a4, 'A4 must exist');
  assert.deepEqual(a4.narrowedTo.symbols, ['createSecretBroker', 'PLUGIN_SECRET_LIMITS']);
  assert.equal(a4.narrowedTo.file, 'src/auth/security/secret-ref.mjs');
  assert.equal(a4.narrowedTo.maxImporters, 1);
});

test('A4 has not spread: only secret-ref.mjs imports the broker internals', () => {
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const relative = file.slice(APP_ROOT.length + 1);
    const source = readFileSync(file, 'utf8');
    if (/from\s+['"][^'"]*\/plugin-secrets\.mjs['"]/.test(source)) offenders.push(relative);
  }
  assert.deepEqual(
    offenders,
    ['src/auth/security/secret-ref.mjs'],
    `A4 may not spread beyond secret-ref.mjs — found: ${offenders.join(', ')}`,
  );
});

test('A4 stays linked to a real owner, deadline and resolution', () => {
  const a4 = registry.allowances.find((allowance) => allowance.id === 'A4');
  assert.equal(a4.resolutionOwner, 'agent-1');
  assert.ok(a4.resolveBy, 'A4 needs a deadline phase');
  assert.ok(a4.resolution?.length > 20, 'A4 needs a concrete resolution, not a placeholder');
  assert.equal(a4.kind, 'internal-import');
});

test('every allowance names an owner, a deadline and a concrete resolution', () => {
  for (const allowance of registry.allowances) {
    assert.ok(allowance.resolutionOwner, `${allowance.id} needs an owner`);
    assert.ok(allowance.resolveBy, `${allowance.id} needs a deadline phase`);
    assert.ok(allowance.resolution?.length > 20, `${allowance.id} needs a concrete resolution, not a placeholder`);
  }
});

/* ------------------------------------------------------- public surface discipline */

test('no domain publishes executable implementation as a whole directory', () => {
  // A published directory is acceptable when it contains no executable
  // implementation to leak: a `contract/` facade, or a data directory such as
  // `src/lego/manifest` whose .json files ARE the architecture's source of
  // truth. What must never be published wholesale is a directory of .mjs
  // implementation, because then "public surface" means "everything".
  for (const domain of registry.domains) {
    for (const surface of domain.public ?? []) {
      if (surface.endsWith('.mjs')) continue;
      if (/\/contracts?(\/|$)/.test(surface)) continue;
      if (domain.id === 'compatibility') continue; // the compat boundary IS the contract

      const full = join(APP_ROOT, surface);
      const entries = readdirSync(full, { withFileTypes: true });
      const executable = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.mjs'));
      assert.deepEqual(
        executable.map((entry) => entry.name),
        [],
        `'${domain.id}' publishes directory '${surface}' containing executable modules — publish a contract facade or named files instead`,
      );
    }
  }
});

test('every locked contract points at a real file with matching exports', () => {
  for (const contract of lock.contracts) {
    for (const [file, expected] of Object.entries(contract.exports ?? {})) {
      const full = join(APP_ROOT, file);
      assert.ok(statSync(full).isFile(), `${contract.id} lists missing file ${file}`);
      const actual = listExports(readFileSync(full, 'utf8'));
      for (const name of expected) {
        assert.ok(actual.includes(name), `${contract.id} promises '${name}' from ${file}, which does not export it`);
      }
    }
  }
});

test('a consumer of a nested LEGO must declare it explicitly', () => {
  // Nesting grants nothing: compatibility reaching auth.identity is legal only
  // because it is declared, not because auth.identity sits under auth.
  const compatibility = getDomain('compatibility', registry);
  assert.ok(compatibility.dependsOn.includes('auth.identity'));
  assert.ok(!compatibility.dependsOn.includes('auth'), 'the declaration must name the leaf, not the parent');

  const verdict = isDependencyAllowed('compatibility', 'auth.identity', registry);
  assert.equal(verdict.allowed, true, verdict.reason);
});

test('an undeclared consumer still cannot reach the nested leaf', () => {
  const verdict = isDependencyAllowed('workflow', 'auth.identity', registry);
  assert.equal(verdict.allowed, false, 'workflow never declared auth.identity');
});

/* ------------------------------------------------------------ legacy zone bounds */

test('the legacy zone file list is frozen and did not grow', () => {
  assert.deepEqual(registry.legacy.files, ['src/rest/routes.mjs']);
  assert.equal(registry.legacy.frozen, true);
});

test('the legacy aggregate did not grow in line count', () => {
  // P2.7 recorded 845 lines (`wc -l`, i.e. newline count). The strangler rule is
  // that this only ever shrinks.
  const source = readFileSync(join(APP_ROOT, 'src/rest/routes.mjs'), 'utf8');
  const lines = source.split('\n').length - (source.endsWith('\n') ? 1 : 0);
  assert.ok(lines <= 845, `legacy aggregate grew to ${lines} lines (was 845) — carve-outs may leave, nothing may enter`);
});

test('nothing imports the legacy zone except the composition root', () => {
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const relative = file.slice(APP_ROOT.length + 1);
    if (relative.startsWith('src/rest/') || relative === 'src/server.mjs') continue;
    if (/from\s+['"][^'"]*rest\/routes\.mjs['"]/.test(readFileSync(file, 'utf8'))) offenders.push(relative);
  }
  assert.deepEqual(offenders, []);
});

/* -------------------------------------------------------------- kernel discipline */

test('the shared kernel stays small and generic', () => {
  const kernel = getDomain('platform-kernel', registry);
  assert.deepEqual(kernel.dependsOn, [], 'the kernel must depend on nothing');
  assert.ok(kernel.paths.length <= 3, `the kernel owns ${kernel.paths.length} files — it must not become a utility dump`);
});

test('the kernel contains no feature-domain LOGIC', () => {
  // A kernel that knows what a workflow *is* has stopped being a kernel.
  //
  // The line drawn here is logic, not vocabulary. `config.mjs` reads
  // `ENDPOINT_WEBHOOK` into a string — naming a configuration key is not the
  // same as understanding webhooks, and forcing every feature name out of the
  // config reader would just push the same strings somewhere worse. What is
  // forbidden is the kernel *doing* domain work: importing a domain, or
  // defining behaviour over domain objects.
  const forbidden = [
    /\bfunction\s+\w*(workflow|credential|execution|nodeType|webhook)\w*\s*\(/i,
    /\bclass\s+\w*(workflow|credential|execution|node|webhook)\w*/i,
    /from\s+['"][^'"]*(workflow|credential|engine|store|node-registry)[^'"]*['"]/i,
  ];
  for (const path of getDomain('platform-kernel', registry).paths) {
    const source = readFileSync(join(APP_ROOT, path), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const pattern of forbidden) {
      assert.ok(!pattern.test(code), `kernel file '${path}' contains feature-domain logic matching ${pattern}`);
    }
  }
});

test('the kernel exposes only generic primitives', () => {
  const kernel = getDomain('platform-kernel', registry);
  for (const capability of kernel.capabilities ?? []) {
    assert.ok(/^kernel\./.test(capability.id), `kernel capability '${capability.id}' must be namespaced kernel.*`);
  }
});
