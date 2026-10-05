#!/usr/bin/env node
/**
 * Workflow LEGO — Rust port conformance fixtures.
 *
 * The Phase-3 Rust crate (`crates/n8n-workflow`) must reproduce the reference
 * Workflow Model. This script derives the *expected* values from the pinned
 * reference runtime (n8n-workflow 2.9.1 = the 2.9.4 dependency set) and writes
 * them as golden JSON, so a Rust test can assert against the same numbers
 * without a Node host in the loop.
 *
 * It covers the parts of the frozen 15-symbol surface that the Phase-3 crate
 * currently does NOT implement at all, plus the behaviours that a naive
 * re-implementation silently "fixes":
 *
 *   1. `calculateWorkflowChecksum`  — surface symbol #14 (9 whitelisted fields,
 *      recursively sorted keys, SHA-256 hex; id/active/staticData excluded)
 *   2. `compareConnections`         — surface symbol #15 (`{ added, removed }`)
 *   3. the aggregate's in-memory shape — the reference `Workflow` has NO
 *      `toJSON()`; `nodes` is keyed by name internally, while the persisted /
 *      API shape (and the `WorkflowSnapshot` the checksum consumes) carries
 *      `nodes` as an ARRAY. Captured: duplicate-name overwrite, defaults.
 *   4. `renameNode` semantics       — restricted names throw, collision
 *      overwrites, and D-08: the destination index is NOT rebuilt
 *   5. `getConnectedNodes`          — connection-type filter + depth
 *
 * Usage:
 *   node tests/reference/workflow-rust/build-fixtures.mjs           # derive + write
 *   node tests/reference/workflow-rust/build-fixtures.mjs --check   # re-derive + compare (exit 1 on drift)
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const OUT = join(HERE, 'fixtures.json');

/** Resolve the pinned reference runtime the same way the isolation gate does. */
const runtimeDir =
	process.env.LEGO_LIVE_RUNTIME ??
	[join(REPO, '.runtime', 'node_modules'), '/home/user/.n8n-live/node_modules'].find((p) =>
		existsSync(join(p, 'n8n-workflow', 'package.json')),
	);
if (!runtimeDir) {
	console.error('reference runtime not found — run scripts/setup-reference-runtime.sh (or set LEGO_LIVE_RUNTIME)');
	process.exit(2);
}

const req = createRequire(join(runtimeDir, 'n8n-workflow', 'package.json'));
const { Workflow, calculateWorkflowChecksum, getConnectedNodes } = req('n8n-workflow');
const { compareConnections } = req(join(runtimeDir, 'n8n-workflow', 'dist/cjs/connections-diff.js'));

/* ------------------------------------------------------------------ */
/* inputs                                                             */
/* ------------------------------------------------------------------ */
const golden = (name) => JSON.parse(readFileSync(join(REPO, 'tests', 'reference', name, 'workflow.json'), 'utf8'));

/** Node factory: the reference re-keys nodes by name, so ids may be synthetic. */
const node = (name, type = 'n8n-nodes-base.noOp', extra = {}) => ({
	id: `id-${name}`,
	name,
	type,
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
	...extra,
});

const linear = golden('03-linear');
const oneNode = golden('02-one-node');
const empty = golden('01-empty-workflow');

/* ------------------------------------------------------------------ */
/* 1. checksum                                                        */
/* ------------------------------------------------------------------ */
const checksumCases = [];
const push = (id, snapshot, note) => checksumCases.push({ id, note, snapshot });

const base = {
	name: 'Checksum Base',
	nodes: [
		node('A', 'n8n-nodes-base.manualTrigger', { parameters: { note: 'x' } }),
		node('B', undefined, { parameters: { value: 1, nested: { z: 1, a: 2 } } }),
	],
	connections: { A: { main: [[{ node: 'B', type: 'main', index: 0 }]] } },
};
push('base', base, 'name + nodes + connections');
push(
	'key-order-invariance',
	{ connections: base.connections, nodes: base.nodes, name: base.name },
	'top-level key order differs — must hash identically (sortObjectKeys)',
);
push(
	'nested-key-order-invariance',
	{
		...base,
		settings: { executionOrder: 'v1', timezone: 'Asia/Jakarta' },
		nodes: [
			node('A', 'n8n-nodes-base.manualTrigger', { parameters: { note: 'x' } }),
			node('B', undefined, { parameters: { nested: { a: 2, z: 1 }, value: 1 } }),
		],
	},
	'nested object key order differs — must hash identically',
);
push(
	'excluded-fields-ignored',
	{ ...base, id: 'wf-123', active: true, versionId: 'v9', createdAt: '2026-01-01T00:00:00.000Z', staticData: { lastId: 7 } },
	'id/active/versionId/timestamps/staticData are NOT in the 9 whitelisted fields — must hash like `base`',
);
push(
	'node-order-matters',
	{ ...base, nodes: [base.nodes[1], base.nodes[0]] },
	'`nodes` is an ARRAY in the snapshot — element order is part of the payload',
);
push(
	'pin-data-included',
	{ ...base, pinData: { B: [{ json: { value: 1 } }] } },
	'pinData IS whitelisted — adding it must change the digest',
);
push('empty-workflow', { nodes: [], connections: {} }, 'empty structures still hash');
push('golden-03-linear', { name: linear.name, nodes: linear.nodes, connections: linear.connections }, 'golden fixture 03');

for (const c of checksumCases) c.sha256 = await calculateWorkflowChecksum(c.snapshot);

/* ------------------------------------------------------------------ */
/* 2. compareConnections                                              */
/* ------------------------------------------------------------------ */
const c = (n, t = 'main', i = 0) => ({ node: n, type: t, index: i });
const diffCases = [
	{
		id: 'identical',
		prev: { A: { main: [[c('B')]] } },
		next: { A: { main: [[c('B')]] } },
	},
	{
		id: 'destination-changed',
		prev: { A: { main: [[c('B')]] } },
		next: { A: { main: [[c('C')]] } },
	},
	{
		id: 'second-output-added',
		prev: { A: { main: [[c('B')], [c('C')]] } },
		next: { A: { main: [[c('B')]] } },
	},
	{
		id: 'empty-to-one',
		prev: {},
		next: { A: { main: [[c('B', 'main', 1)]] } },
	},
	{
		id: 'connection-type-changed',
		prev: { A: { main: [[c('B')]] } },
		next: { A: { ai_tool: [[c('B')]] } },
	},
	{
		id: 'slot-shifted',
		prev: { A: { main: [[c('B'), c('C')]] } },
		next: { A: { main: [[c('C'), c('B')]] } },
	},
];
for (const d of diffCases) d.result = compareConnections(d.prev, d.next);

/* ------------------------------------------------------------------ */
/* 3. aggregate shape (the reference has NO toJSON)                    */
/* ------------------------------------------------------------------ */
/**
 * Measured: `Workflow` exposes `nodes` as a name-keyed map, both connection
 * maps, `settings` (default `{}`), `staticData` (default `{}`, observable),
 * `pinData` (undefined unless given) and a readonly `timezone` resolved from
 * `settings.timezone ?? getGlobalState().defaultTimezone`. Serde must model
 * exactly this, NOT a `nodes` map on the wire (the API/entity layer stores
 * `nodes` as an array — see checksum cases, whose snapshots use arrays).
 */
const shapeCases = [];
const shape = (id, workflowJson, note, extraNodes = []) => {
	const wf = new Workflow({
		id: workflowJson.id ?? 'wf-shape',
		name: workflowJson.name,
		nodes: [...workflowJson.nodes, ...extraNodes],
		connections: workflowJson.connections,
		active: false,
		nodeTypes: { getByNameAndVersion: () => undefined },
		settings: workflowJson.settings,
		staticData: workflowJson.staticData,
		pinData: workflowJson.pinData,
	});
	shapeCases.push({
		id,
		note,
		// in-memory shape of the aggregate
		nodeKeys: Object.keys(wf.nodes).sort(),
		nodesAreKeyedByName: !Array.isArray(wf.nodes) && typeof wf.nodes === 'object',
		nodeCount: Object.keys(wf.nodes).length,
		connectionsBySourceNode: wf.connectionsBySourceNode,
		connectionsByDestinationNode: wf.connectionsByDestinationNode,
		settings: wf.settings,
		staticData: wf.staticData,
		pinData: wf.pinData ?? null,
		timezone: wf.timezone,
		active: wf.active,
		id: wf.id,
		name: wf.name ?? null,
	});
};
shape('golden-01-empty', empty, 'empty workflow — settings/staticData default to {}, pinData stays undefined');
shape('golden-02-one-node', oneNode, 'single node');
shape('golden-03-linear', linear, 'two nodes, one edge — destination index is derived at construction');
shape('settings-and-static-data', {
	id: 'wf-all',
	name: 'Everything',
	nodes: [node('A'), node('B', undefined, { disabled: true })],
	connections: { A: { main: [[c('B')]] } },
	settings: { timezone: 'Asia/Jakarta', executionOrder: 'v1', saveDataErrorExecution: 'all' },
	staticData: { lastId: 42 },
	pinData: { A: [{ json: { pinned: true } }] },
}, 'settings pass through unchanged (unknown keys preserved); timezone comes from settings');
shape('duplicate-node-name', {
	id: 'wf-dup',
	name: 'Duplicate',
	nodes: [node('A'), node('A', undefined, { parameters: { second: true } })],
	connections: {},
}, 'documented invariant gap: setNodes() silently overwrites — last node wins');
shape('restricted-name-overwrite', {
	id: 'wf-proto',
	name: 'Proto',
	nodes: [node('A')],
	connections: {},
}, 'a node literally named `__proto__` must not corrupt the map', [node('__proto__')]);

/* ------------------------------------------------------------------ */
/* 4. renameNode semantics (incl. D-08)                               */
/* ------------------------------------------------------------------ */
const renameCases = [];

/** Build a 3-node chain A → B → C plus an unrelated D. */
const chain = () =>
	new Workflow({
		id: 'wf-rename',
		name: 'Rename',
		nodes: [node('A'), node('B'), node('C'), node('D')],
		connections: { A: { main: [[c('B')]] }, B: { main: [[c('C')]] } },
		active: false,
		nodeTypes: { getByNameAndVersion: () => undefined },
	});

// 4a. restricted names must throw
for (const restricted of ['hasOwnProperty', 'constructor', '__proto__']) {
	const wf = chain();
	let outcome;
	try {
		wf.renameNode('D', restricted);
		outcome = { threw: false };
	} catch (error) {
		outcome = { threw: true, errorName: error.constructor?.name ?? null, message: error.message };
	}
	renameCases.push({ id: `restricted-${restricted}`, note: 'restricted JS-prototype name', outcome });
}

// 4b. collision: no check in the reference — the existing node object is replaced
{
	const wf = chain();
	let outcome;
	try {
		wf.renameNode('D', 'C');
		outcome = {
			threw: false,
			nodeNames: Object.keys(wf.nodes).sort(),
			// which node survived under the name 'C'? (last write wins)
			ownerOfC: wf.nodes.C?.id,
			cStillHasItsEdges: Object.keys(wf.connectionsBySourceNode).sort(),
		};
	} catch (error) {
		outcome = { threw: true, message: error.message };
	}
	renameCases.push({ id: 'collision-overwrites', note: 'rename D → C when C exists', outcome });
}

// 4c. D-08: destination index is NOT rebuilt by renameNode
{
	const wf = chain();
	wf.renameNode('B', 'Beta');
	renameCases.push({
		id: 'd-08-stale-destination-index',
		note: 'after renaming B → Beta: source map is re-keyed and rewritten, destination index keeps the OLD key',
		outcome: {
			sourceKeys: Object.keys(wf.connectionsBySourceNode).sort(),
			destinationKeys: Object.keys(wf.connectionsByDestinationNode).sort(),
			childNodesOfA: wf.getChildNodes('A'),
			// expected per D-08: [] — the stale destination index has no 'Beta' key
			parentNodesOfBeta: wf.getParentNodes('Beta'),
			// expected per D-08: ['A'] — the stale destination index still has 'B'
			parentNodesOfOldName: wf.getParentNodes('B'),
			// the *rewritten* source data does point to Beta
			sourceEdgeToBeta: wf.connectionsBySourceNode.Beta,
			// re-deriving the destination index makes the rename visible to parent queries
			afterRederive: (() => {
				wf.setConnections(wf.connectionsBySourceNode);
				return wf.getParentNodes('Beta');
			})(),
			nodeNames: Object.keys(wf.nodes).sort(),
		},
	});
}

// 4d. rename rewrites parameter references through the ports (expression + form fields)
{
	const wf = new Workflow({
		id: 'wf-rename-params',
		name: 'Rename Params',
		nodes: [
			node('A'),
			node('B', 'n8n-nodes-base.set', { parameters: { value: "={{ $('A').item.json.x }}", plain: 'A' } }),
		],
		connections: {},
		active: false,
		nodeTypes: { getByNameAndVersion: () => undefined },
	});
	wf.renameNode('A', 'Alpha');
	renameCases.push({
		id: 'parameter-references-rewritten',
		note: 'P-NODE-REFERENCE rewrites expression strings; a plain (non-expression) string is left alone',
		outcome: {
			value: wf.nodes.B.parameters.value,
			plain: wf.nodes.B.parameters.plain,
		},
	});
}

/* ------------------------------------------------------------------ */
/* 5. getConnectedNodes — type filter + depth                          */
/* ------------------------------------------------------------------ */
const graph = {
	A: {
		main: [[c('B')]],
		ai_languageModel: [[c('M')]],
	},
	B: { main: [[c('C')]] },
	C: { main: [[c('D')]] },
	D: {},
	M: {},
};
const traversalCases = [
	['default-main-depth-unlimited', 'A', undefined, undefined],
	['main-depth-0', 'A', 'main', 0],
	['main-depth-1', 'A', 'main', 1],
	['main-depth-2', 'A', 'main', 2],
	['all-types', 'A', 'ALL', -1],
	['all-non-main', 'A', 'ALL_NON_MAIN', -1],
	['ai-language-model', 'A', 'ai_languageModel', -1],
	['leaf-node', 'D', 'main', -1],
	['unknown-node', 'ZZZ', 'main', -1],
].map(([id, from, type, depth]) => ({
	id,
	from,
	type: type ?? 'main',
	depth: depth ?? -1,
	result: getConnectedNodes(graph, from, type ?? 'main', depth ?? -1),
}));

/* ------------------------------------------------------------------ */
/* output                                                             */
/* ------------------------------------------------------------------ */
const payload = {
	generatedAt: new Date().toISOString(),
	source: 'reference runtime (n8n-workflow 2.9.1 — the 2.9.4 dependency set)',
	runtimeDir,
	provenance: {
		package: 'n8n-workflow',
		version: req(join(runtimeDir, 'n8n-workflow', 'package.json')).version,
		referenceSource: 'reference/n8n/packages/workflow/src @ b6dc2787c45677a29a9612cd27eb911302961a83',
	},
	checksum: {
		algorithm: 'SHA-256 (hex, lowercase) over JSON.stringify(sortObjectKeys(whitelist(snapshot)))',
		whitelist: ['name', 'description', 'nodes', 'connections', 'settings', 'meta', 'pinData', 'isArchived', 'activeVersionId'],
		cases: checksumCases,
	},
	compareConnections: diffCases,
	toJSON: shapeCases,
	rename: renameCases,
	traversal: traversalCases,
};

const json = JSON.stringify(payload, null, 2) + '\n';

if (process.argv.includes('--check')) {
	if (!existsSync(OUT)) {
		console.error(`${OUT} missing — run without --check first`);
		process.exit(2);
	}
	const committed = JSON.parse(readFileSync(OUT, 'utf8'));
	const same = JSON.stringify({ ...committed, generatedAt: null }) === JSON.stringify({ ...payload, generatedAt: null });
	if (!same) {
		const a = JSON.stringify({ ...committed, generatedAt: null }, null, 1).split('\n');
		const b = JSON.stringify({ ...payload, generatedAt: null }, null, 1).split('\n');
		const at = a.findIndex((line, i) => line !== b[i]);
		console.error(`DRIFT: fixtures differ from the pinned reference (first difference at line ${at + 1})`);
		console.error(`  committed: ${a[at]}`);
		console.error(`  recomputed: ${b[at]}`);
		process.exit(1);
	}
	console.log(`fixtures match the pinned reference: ${payload.checksum.cases.length} checksum, ${payload.compareConnections.length} diff, ${payload.toJSON.length} shape, ${payload.rename.length} rename, ${payload.traversal.length} traversal cases`);
	process.exit(0);
}

mkdirSync(HERE, { recursive: true });
writeFileSync(OUT, json);
console.log(`wrote ${OUT}`);
console.log(`  checksum ${payload.checksum.cases.length} · diff ${payload.compareConnections.length} · shape ${payload.toJSON.length} · rename ${payload.rename.length} · traversal ${payload.traversal.length}`);
