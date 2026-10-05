'use strict';
/**
 * Reference case runner.
 *
 *   node run.js                 -> run all cases
 *   node run.js execution-data  -> only tests/reference/execution-data/*
 *   node run.js expression      -> only tests/reference/expression/*
 *   node run.js connection      -> only tests/reference/connection/*
 *   UPDATE=1 node run.js        -> (re)write expected.json from the real runtime
 *
 * Every case dir contains:
 *   case.json      the input (workflow + data + probes)
 *   expected.json  the OBSERVED n8n 2.9.4 behaviour (never hand-written)
 */
const fs = require('fs');
const path = require('path');
const { createRunExecutionData } = require('n8n-workflow');
const { runWorkflow, buildWorkflow, evaluate, errorToJson } = require('./harness');
const { runConnectionCase } = require('./connection');

const ROOT = path.resolve(__dirname, '..');
const UPDATE = process.env.UPDATE === '1';

/** Strip volatile fields so snapshots are deterministic. */
function snapshotRun(result) {
	const rd = result.data.resultData;
	const nodes = {};
	for (const [name, runs] of Object.entries(rd.runData)) {
		nodes[name] = runs.map((t) => ({
			executionStatus: t.executionStatus,
			source: t.source,
			main: t.data?.main?.map((branch) => branch?.map(stripItem) ?? null),
			error: t.error ? errorToJson(t.error) : undefined,
		}));
	}
	return {
		status: result.status,
		finished: result.finished ?? false,
		lastNodeExecuted: rd.lastNodeExecuted,
		error: rd.error ? errorToJson(rd.error) : undefined,
		runData: nodes,
	};
}
function stripItem(item) {
	const out = { ...item };
	if (out.binary) {
		out.binary = Object.fromEntries(Object.entries(out.binary).map(([k, v]) => {
			const b = { ...v };
			if (b.id) b.id = '<binary-id>'; // storage ids are random
			return [k, b];
		}));
	}
	return JSON.parse(JSON.stringify(out)); // drop undefined
}

async function runExecutionDataCase(c) {
	const result = await runWorkflow(c.workflow, { startItems: c.startItems, mode: c.mode, executionId: c.executionId });
	return snapshotRun(result);
}

function runExpressionCase(c) {
	const workflow = buildWorkflow(c.workflow);
	const runExecutionData = c.runData === null ? null : createRunExecutionData({ resultData: { runData: c.runData ?? {} } });
	const out = {};
	for (const probe of c.probes) {
		const ctx = {
			runExecutionData: probe._runDataNull ? null : runExecutionData,
			runIndex: probe.runIndex ?? c.runIndex ?? 0,
			itemIndex: probe.itemIndex ?? 0,
			activeNodeName: probe.activeNodeName ?? c.activeNodeName,
			connectionInputData: probe.connectionInputData ?? c.connectionInputData ?? [],
			mode: probe.mode ?? c.mode ?? 'manual',
			additionalKeys: c.additionalKeys ?? {},
			executeData: probe.executeData === null ? undefined : (probe.executeData ?? c.executeData),
		};
		if (ctx.executeData && !ctx.executeData.node) ctx.executeData = { ...ctx.executeData, node: workflow.getNode(ctx.activeNodeName) };
		let value;
		try {
			const v = evaluate(workflow, ctx, probe.value);
			value = v === undefined ? { undefined: true } : JSON.parse(JSON.stringify(v));
		} catch (e) {
			value = errorToJson(e);
		}
		out[probe.name] = value;
	}
	return out;
}

function diff(a, b, p = '') {
	const out = [];
	if (JSON.stringify(a) === JSON.stringify(b)) return out;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) {
		out.push(`${p || '<root>'}: expected ${JSON.stringify(a)} got ${JSON.stringify(b)}`); return out;
	}
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diff(a[k], b[k], p ? `${p}.${k}` : k));
	return out;
}

async function main() {
	const filter = process.argv[2];
	const suites = ['execution-data', 'expression', 'connection'].filter((s) => !filter || s === filter);
	let pass = 0, fail = 0, unknown = 0; const failures = [];
	for (const suite of suites) {
		const dir = path.join(ROOT, suite);
		if (!fs.existsSync(dir)) continue;
		for (const name of fs.readdirSync(dir).sort()) {
			const caseFile = path.join(dir, name, 'case.json');
			if (!fs.existsSync(caseFile)) continue;
			const c = JSON.parse(fs.readFileSync(caseFile, 'utf8'));
			const expectedFile = path.join(dir, name, 'expected.json');
			let observed;
			try {
				observed = suite === 'execution-data' ? await runExecutionDataCase(c) : suite === 'connection' ? runConnectionCase(c) : runExpressionCase(c);
			} catch (e) {
				observed = { harnessError: errorToJson(e) };
			}
			if (UPDATE || !fs.existsSync(expectedFile)) {
				fs.writeFileSync(expectedFile, JSON.stringify(observed, null, 2) + '\n');
				console.log(`[WRITE] ${suite}/${name}`); continue;
			}
			const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
			if (expected.UNKNOWN) { unknown++; console.log(`[UNKNOWN] ${suite}/${name}: ${expected.UNKNOWN}`); continue; }
			const d = diff(expected, observed);
			if (d.length === 0) { pass++; console.log(`[PASS] ${suite}/${name}`); }
			else { fail++; failures.push([`${suite}/${name}`, d]); console.log(`[FAIL] ${suite}/${name}`); }
		}
	}
	for (const [n, d] of failures) { console.log(`\n--- ${n}`); d.slice(0, 20).forEach((l) => console.log('  ' + l)); }
	console.log(`\nREFERENCE TESTS: ${pass} PASS / ${fail} FAIL / ${unknown} UNKNOWN`);
	process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(2); });
