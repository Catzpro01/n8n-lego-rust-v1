/**
 * Validation LEGO — rule enforcement (NEW CAPABILITY per ISSUE-003 Option A).
 *
 * Standalone, pure TypeScript implementation of contracts/validation.contract.md §4.4 / §10:
 *   validateWorkflow(workflow, { allowCycles }) → { valid, errors[] }
 * with composable parts checkNodeUniqueness / checkDanglingConnections / detectCycles.
 *
 * Not wired into any reference path (the n8n 2.9.4 reference never calls this) — additive and
 * opt-in, so the regression gate is unaffected. No imports from reference/ or packages/core.
 */

export type ValidationErrorCode =
	| 'INVALID_INPUT'
	| 'DUPLICATE_NODE_NAME'
	| 'DANGLING_CONNECTION'
	| 'INVALID_CONNECTION_TYPE'
	| 'CYCLE_DETECTED';

export interface ValidationError {
	code: ValidationErrorCode;
	message: string;
	node?: string;
	path?: string[];
}

export interface ValidationReport {
	valid: boolean;
	errors: ValidationError[];
}

export interface ValidateWorkflowOptions {
	/** Reference parity: n8n allows runtime loops (Loop Over Items). Default true. */
	allowCycles?: boolean;
}

/** Mirrors `nodeConnectionTypes` in n8n 2.9.4 packages/workflow/src/interfaces.ts (NodeConnectionTypes). */
export const NODE_CONNECTION_TYPES = [
	'ai_agent',
	'ai_chain',
	'ai_document',
	'ai_embedding',
	'ai_languageModel',
	'ai_memory',
	'ai_outputParser',
	'ai_retriever',
	'ai_reranker',
	'ai_textSplitter',
	'ai_tool',
	'ai_vectorStore',
	'main',
] as const;
const CONNECTION_TYPE_SET: ReadonlySet<string> = new Set(NODE_CONNECTION_TYPES);

interface ConnectionTarget {
	node: string;
	type: string;
	index: number;
}
type Connections = Record<string, Record<string, Array<Array<ConnectionTarget> | null>>>;
interface WorkflowLike {
	nodes: Array<{ name: string; disabled?: boolean }>;
	connections?: Connections;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function checkNodeUniqueness(workflow: WorkflowLike): ValidationError[] {
	const seen = new Set<string>();
	const errors: ValidationError[] = [];
	workflow.nodes.forEach((node, i) => {
		if (seen.has(node.name)) {
			errors.push({ code: 'DUPLICATE_NODE_NAME', node: node.name, path: ['nodes', String(i), 'name'], message: `Duplicate node name "${node.name}"` });
		}
		seen.add(node.name);
	});
	return errors;
}

export function checkDanglingConnections(workflow: WorkflowLike): ValidationError[] {
	const names = new Set(workflow.nodes.map((n) => n.name));
	const errors: ValidationError[] = [];
	for (const [source, byType] of Object.entries(workflow.connections ?? {})) {
		if (!names.has(source)) {
			errors.push({ code: 'DANGLING_CONNECTION', node: source, path: ['connections', source], message: `Connection from unknown node "${source}"` });
		}
		if (!isObject(byType)) continue;
		for (const [type, outputs] of Object.entries(byType)) {
			if (!CONNECTION_TYPE_SET.has(type)) {
				errors.push({ code: 'INVALID_CONNECTION_TYPE', node: source, path: ['connections', source, type], message: `Unknown connection type "${type}" on node "${source}"` });
			}
			if (!Array.isArray(outputs)) continue;
			outputs.forEach((output, oi) => {
				(output ?? []).forEach((target, ti) => {
					const path = ['connections', source, type, String(oi), String(ti)];
					if (!target || typeof target.node !== 'string') {
						errors.push({ code: 'DANGLING_CONNECTION', node: source, path, message: `Malformed connection target from "${source}"` });
						return;
					}
					if (!names.has(target.node)) {
						errors.push({ code: 'DANGLING_CONNECTION', node: source, path, message: `Connection from "${source}" to unknown node "${target.node}"` });
					}
					if (typeof target.type === 'string' && !CONNECTION_TYPE_SET.has(target.type)) {
						errors.push({ code: 'INVALID_CONNECTION_TYPE', node: source, path: [...path, 'type'], message: `Unknown connection type "${target.type}" on node "${source}"` });
					}
				});
			});
		}
	}
	return errors;
}

/**
 * Iterative DFS with visiting/visited sets over `main` edges only (contract §11.8).
 * Deterministic: nodes are visited in `workflow.nodes` order, edges in output/index order.
 * Reports the first back-edge as a path `A → B → A`.
 */
export function detectCycles(workflow: WorkflowLike): ValidationError[] {
	const adj = new Map<string, string[]>();
	for (const n of workflow.nodes) adj.set(n.name, []);
	for (const [source, byType] of Object.entries(workflow.connections ?? {})) {
		const outputs = isObject(byType) ? byType.main : undefined;
		if (!Array.isArray(outputs) || !adj.has(source)) continue;
		for (const output of outputs) for (const t of output ?? []) if (t && adj.has(t.node)) adj.get(source)!.push(t.node);
	}

	const WHITE = 0, GREY = 1, BLACK = 2;
	const color = new Map<string, number>();
	for (const name of adj.keys()) color.set(name, WHITE);

	for (const root of adj.keys()) {
		if (color.get(root) !== WHITE) continue;
		const stack: Array<{ node: string; next: number }> = [{ node: root, next: 0 }];
		const pathStack: string[] = [root];
		color.set(root, GREY);
		while (stack.length) {
			const frame = stack[stack.length - 1];
			const edges = adj.get(frame.node)!;
			if (frame.next < edges.length) {
				const to = edges[frame.next++];
				const c = color.get(to);
				if (c === GREY) {
					const cycle = [...pathStack.slice(pathStack.indexOf(to)), to];
					return [{ code: 'CYCLE_DETECTED', node: to, path: ['connections', frame.node, 'main'], message: `Cycle detected: ${cycle.join(' → ')}` }];
				}
				if (c === WHITE) {
					color.set(to, GREY);
					stack.push({ node: to, next: 0 });
					pathStack.push(to);
				}
			} else {
				color.set(frame.node, BLACK);
				stack.pop();
				pathStack.pop();
			}
		}
	}
	return [];
}

export function validateWorkflow(workflow: unknown, options: ValidateWorkflowOptions = {}): ValidationReport {
	if (!isObject(workflow) || !Array.isArray(workflow.nodes) || !workflow.nodes.every((n) => isObject(n) && typeof n.name === 'string')) {
		return { valid: false, errors: [{ code: 'INVALID_INPUT', message: 'Workflow must be an object with a `nodes` array of named nodes' }] };
	}
	if (workflow.connections !== undefined && !isObject(workflow.connections)) {
		return { valid: false, errors: [{ code: 'INVALID_INPUT', message: '`connections` must be an object', path: ['connections'] }] };
	}
	const wf = workflow as unknown as WorkflowLike;
	const errors = [...checkNodeUniqueness(wf), ...checkDanglingConnections(wf)];
	if (options.allowCycles === false) errors.push(...detectCycles(wf));
	return { valid: errors.length === 0, errors };
}
