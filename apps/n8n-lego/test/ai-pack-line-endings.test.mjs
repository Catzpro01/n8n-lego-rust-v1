/**
 * The generated pack must be identical on every runner — DEC-0020, portability axis.
 *
 * WHAT THIS PROTECTS
 * ------------------
 * `.ai/` and the README governance block are GENERATED projections of the canonical
 * register, and `ai-pack --check` is what proves they are current. That proof was
 * only ever true on a machine whose working tree happened to be LF. It is not a
 * property of the projection; it was a property of the runner.
 *
 * THE FAILURE THESE TESTS TARGET
 * ------------------------------
 * On 2026-09-30 the self-hosted architecture job reported all 101 generated files
 * and the README block as stale in a single step. The cause was a checkout round
 * trip, and it had two halves — fixing only one of them still fails:
 *
 *   1. `actions/checkout` is invoked with `clean: true`. Its cleaning step runs
 *      `git clean -ffdx` + `git reset --hard HEAD` BEFORE the fetch and the
 *      checkout, which deletes the working tree — including the very
 *      `.gitattributes` that pins `eol=lf`. Git therefore resolves attributes
 *      against an index that predates the file, falls back to
 *      `core.autocrlf=true` on a Windows runner, and materialises the tree CRLF.
 *   2. Builders copy text out of the working tree. `adrIndex()` reads an ADR
 *      heading and splices it into a table row, so on a CRLF tree the trailing
 *      CR survives `split('\n')` and lands in the MIDDLE of a generated line.
 *      Normalising only the file on disk does not help: here the GENERATED side
 *      is the dirty one.
 *
 * The first half is fixed at the checkout in the workflow; these tests pin the
 * second half in the generator, so the pack is CR-free by construction no matter
 * which builder is involved or which platform runs it.
 *
 * WHAT IS DELIBERATELY NOT RELAXED
 * --------------------------------
 * Only the terminators are normalised. A difference of any other kind still
 * compares unequal, and a test below proves it: staleness detection must remain
 * exactly as strict as it was, or this file would be a gate downgrade wearing a
 * portability fix.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generate, check, normalizeEol, detectEol, applyEol } from '../../../tools/lego/ai-pack.mjs';
import { syncSliceText } from '../../../tools/lego/progress-event.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (relative) => readFileSync(join(REPO_ROOT, relative), 'utf8');

const canonical = normalizeEol;

/** The first slice the register declares, used to exercise the surgical writer. */
const firstSlice = (registerText) => JSON.parse(registerText).programs[0].slices[0];
const firstSliceId = (registerText) => firstSlice(registerText).id;

test('normalizeEol treats CRLF and a bare CR as one line break', () => {
  assert.equal(normalizeEol('a\r\nb\r\n'), 'a\nb\n');
  // The single most important case: a CR that survived split('\n') and is now
  // stranded mid-line, which is what adrIndex() produced on a Windows checkout.
  assert.equal(normalizeEol('| ADR-0002 |\r |'), '| ADR-0002 |\n |');
  assert.equal(normalizeEol('already\nlf\n'), 'already\nlf\n');
  assert.equal(normalizeEol(''), '');
});

test('detectEol and applyEol round-trip, so rewriting a file is diff-neutral', () => {
  const lf = 'one\ntwo\n';
  const crlf = 'one\r\ntwo\r\n';
  assert.equal(detectEol(crlf), '\r\n');
  assert.equal(detectEol(lf), '\n');
  assert.equal(applyEol(normalizeEol(crlf), detectEol(crlf)), crlf);
  assert.equal(applyEol(normalizeEol(lf), detectEol(lf)), lf);
  // A LF file must never be handed a CRLF terminator by accident.
  assert.equal(applyEol(lf, '\n'), lf);
});

test('the generated pack is CR-free whatever the working tree looks like', () => {
  const files = generate();
  const dirty = [...files.entries()]
    .filter(([, content]) => content.includes('\r'))
    .map(([path]) => path);
  assert.deepEqual(
    dirty,
    [],
    `generate() emitted a carriage return into ${dirty.length} file(s): ${dirty.slice(0, 5).join(', ')}`,
  );
});

test('a CRLF working tree is not reported as stale — the exact CI failure', () => {
  const files = generate();
  const expected = files.get('master/MILESTONE_REGISTER.md');
  assert.ok(expected, 'the master milestone register must be generated');

  // Reproduce the runner: the same content, materialised with CRLF, compared by
  // the same predicate `check()` uses. Before the fix this compared unequal and
  // the architecture job failed on all 101 files.
  const crlfWorkingTree = expected.replace(/\n/g, '\r\n');
  assert.notEqual(crlfWorkingTree, expected, 'the fixture must actually be CRLF');
  assert.equal(
    normalizeEol(crlfWorkingTree),
    expected,
    'a CRLF working tree must still compare equal to the generated pack',
  );
});

test('staleness detection is NOT weakened: a real content change is still caught', () => {
  const files = generate();
  const expected = files.get('master/MILESTONE_REGISTER.md');
  const oneCharacter = expected.replace(/P3-M01/, 'P3-M0X');
  assert.notEqual(oneCharacter, expected, 'the mutation must actually change the content');
  assert.notEqual(normalizeEol(oneCharacter), expected);
  // …and a terminator-only change is the ONLY thing normalisation forgives.
  assert.equal(normalizeEol(expected.replace(/\n/g, '\r\n')), expected);
});

test('check() names the line and both sides, so a stale file is actionable', () => {
  const files = generate();

  // A mutation to one file must be reported with enough detail to act on. The
  // pre-fix message was the single word "(out of date)", which is why a 101-file
  // failure stayed unattributable until the content was dumped by hand.
  //
  // `(missing)` is excluded from the baseline: a sparse checkout legitimately
  // does not materialise every curated document, and that is an artefact of the
  // working tree, never of the projection. It is asserted separately below.
  const present = (entry) => existsSync(join(REPO_ROOT, '.ai', entry.slice(0, entry.indexOf(' '))));
  assert.deepEqual(
    check(files).filter((entry) => !entry.endsWith('(missing)') || present(entry)),
    [],
    'every generated file that exists on disk must be current',
  );

  const target = 'master/MILESTONE_REGISTER.md';
  const mutated = new Map(files);
  mutated.set(target, files.get(target).replace(/P3-M01/, 'P3-M0X'));
  const reported = check(mutated).filter((entry) => entry.startsWith(target));
  assert.equal(reported.length, 1, `expected exactly one report for ${target}, got ${reported.length}`);
  assert.match(reported[0], /out of date at line \d+/);

  // Both sides are quoted starting at the first differing character, which is
  // the whole point: the reader is shown the exact divergence, not a ream of
  // near-identical text.
  const sides = reported[0].match(/on disk (".*?") \/ generated (".*?")\)$/);
  assert.ok(sides, `the report must quote both sides, got: ${reported[0]}`);
  assert.equal(sides[1][1], '1', 'the on-disk side must start at the differing character');
  assert.equal(sides[2][1], 'X', 'the generated side must show what was expected instead');
});

test('the repository pins eol=lf, and no CI step depends on the checkout style', () => {
  // `.gitattributes` is hygiene, not the fix: it makes ordinary checkouts and
  // diffs sane on Windows. It cannot be the fix, because `actions/checkout` runs
  // with `clean: true` and its cleaning step deletes the working tree -- this
  // file included -- before the checkout that would have honoured it.
  const attributes = join(REPO_ROOT, '.gitattributes');
  assert.ok(existsSync(attributes), '.gitattributes must exist');
  assert.match(read('.gitattributes'), /^\*\s+text=auto\s+eol=lf$/m);

  // A re-materialisation step was tried and removed, and the reason it could go
  // is the whole point of this file: the comparison code is now canonical, so no
  // job may reintroduce a dependency on how the runner materialised the tree.
  // The `reset --hard` version rewrote all 16732 tracked files -- 15050 of them
  // the vendored reference/ tree, which `.gitattributes` marks `-text` and which
  // was never affected -- and pushed the architecture job past its 15-minute
  // timeout. Pinned here so it is not quietly added back as a "safety net".
  //
  // The pin looks at COMMANDS, not at the text: the workflow explains the CRLF
  // cause in a comment and names `core.autocrlf` and `reset --hard` while doing
  // so, and a substring match over the whole file would fail on the explanation
  // of the thing it is meant to forbid. Only non-comment lines are considered.
  const workflow = read('.github/workflows/n8n-lego.yml');
  const commands = workflow
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  assert.doesNotMatch(commands.join('\n'), /checkout-index -a -f/);
  assert.doesNotMatch(commands.join('\n'), /core\.autocrlf/);
  assert.doesNotMatch(commands.join('\n'), /reset --hard/);
});

test('the governance comparisons are canonical too, not just the generator', () => {
  // The generator was only half the fix. These three functions read the working
  // tree and compare it against rendered text, and every match in them is exact
  // -- a README marker, a 10-space `"status":` key, a slice `"id":` line. On a
  // CRLF tree each of those carries a trailing CR, so all of them miss, which is
  // what made the architecture job report 101 stale files and the test job fail 7
  // governance assertions on 2026-09-30.
  const source = [
    read('tools/lego/governance-register.mjs'),
    read('tools/lego/progress-event.mjs'),
  ].join('\n');
  // Slice each function out of the source rather than pattern-matching across a
  // character window: a long explanatory comment between the signature and the
  // first statement is exactly the kind of edit a brittle regex rejects.
  const bodyOf = (name) => {
    const at = source.indexOf(`function ${name}(`);
    assert.notEqual(at, -1, `${name} must still exist`);
    const next = source.indexOf('\nexport function ', at + 1);
    return source.slice(at, next === -1 ? undefined : next);
  };
  for (const fn of ['validateMilestoneProjections', 'syncReadmeMilestoneSection', 'syncSliceText']) {
    assert.match(bodyOf(fn), /normalizeEol\(/, `${fn} must canonicalise its input before comparing`);
  }
  // And the writer hands the terminator back, so a no-op rewrite stays byte-identical.
  assert.match(bodyOf('syncSliceText'), /applyEol\(out\.join\('\\n'\), eol\)/);

  // Behaviour, not just source shape: a CRLF register round-trips unchanged.
  // Built with applyEol rather than `replace(/\n/g, '\r\n')` so the test is valid
  // on BOTH tree styles — on an already-CRLF checkout the naive replace turns
  // every `\r\n` into `\r\r\n` and the test fails for its own construction.
  const register = read('docs/n8n-lego/milestones.json');
  const crlf = applyEol(canonical(register), '\r\n');
  assert.equal(canonical(crlf), canonical(register));
  assert.equal(syncSliceText(crlf, firstSliceId(register), firstSlice(register)).text, crlf);
});
