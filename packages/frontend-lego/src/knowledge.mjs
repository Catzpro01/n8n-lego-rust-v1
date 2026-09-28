/**
 * The `.ai/` knowledge pack, as data.
 *
 * The pack itself is a set of small files; this module is the index that says
 * which of them belong to which level, so a task can load *only* what it needs.
 * It reads nothing from disk and runs nothing at boot: retrieving context is a
 * tooling concern, and the browser never pays for it.
 *
 * Framework-neutral and browser-safe: no framework import, no `node:*` import.
 */

/** Where the pack lives, relative to the repository root. */
export const PACK_ROOT = '.ai';

/** The five context levels. Load L0 always; add levels as the task requires. */
export const CONTEXT_LEVELS = Object.freeze([
  Object.freeze({
    id: 'L0',
    title: 'Constitution',
    files: Object.freeze(['.ai/constitution.md']),
    answers: 'What is forbidden, who owns what, which boundaries are hard.',
    maxBytes: 6144,
  }),
  Object.freeze({
    id: 'L1',
    title: 'Frontend domain card',
    files: Object.freeze(['.ai/frontend/card.md']),
    answers: 'How the frontend LEGO is built, where things live, how boot works.',
    maxBytes: 8704,
  }),
  Object.freeze({
    id: 'L2',
    title: 'Contract card',
    files: Object.freeze(['.ai/index/contracts.json']),
    answers: 'What a contract promises, who consumes it, what it may not encode.',
    maxBytes: 8192,
  }),
  Object.freeze({
    id: 'L3',
    title: 'Task recipe',
    files: Object.freeze(['.ai/cards/recipes.md']),
    answers: 'The exact steps and commands for a known task shape.',
    maxBytes: 8192,
  }),
  Object.freeze({
    id: 'L4',
    title: 'Source',
    files: Object.freeze([]),
    answers: 'Implementation detail the pack deliberately does not restate.',
    maxBytes: null,
  }),
]);

/** Reference material that is useful but not part of the level ladder. */
export const REFERENCE_FILES = Object.freeze({
  card: '.ai/frontend/card.md',
  glossary: '.ai/frontend/glossary.md',
  decisions: '.ai/cards/decisions.md',
  dependencies: '.ai/maps/dependencies.md',
  units: '.ai/index/units.json',
  capabilities: '.ai/index/capabilities.json',
  contracts: '.ai/index/contracts.json',
  readme: '.ai/README.md',
});

/**
 * The master project specification — the durable memory of this repository.
 *
 * This is **not retrieval context**. The pack above is what an agent loads to *work* in this
 * repository, and it is budget-enforced so it never becomes a document you read in full. The
 * master set is what an agent (or a person) reads to *understand the project*: what n8n LEGO
 * is, which domains exist, how AI is supposed to work, what is published, what is blocked,
 * what comes next.
 *
 * It is deliberately excluded from `packFiles()`: a task that needs the specification loads
 * `productContextFor()` on purpose, so no ordinary task pays for it in bytes or in attention.
 * Its own budget is separate and enforced by `test/30-master-plan.test.mjs`.
 *
 * Ownership rule: documents that describe backend declarations are *consumption views*; the
 * declarations themselves live in the agent-2 owned registry and lock, and this tree never
 * restates a generated fact as if it were the source.
 */
export const MASTER_PLAN_BUDGET = 256 * 1024;

/** No single master document may exceed this — a specification nobody can read is not one. */
export const MASTER_PLAN_MAX_FILE = 32 * 1024;

/**
 * The master documents this package reads.
 *
 * Ten of these resolve to `.ai/master/frontend/` rather than `.ai/master/` directly. Those ten
 * subjects have a *generated* canonical document at `.ai/master/<NAME>.md`, derived from the
 * backend manifests by `tools/lego/ai-pack.mjs`; the copy under `frontend/` is the hand-written
 * frontend consumption view of the same subject, kept because it carries design reasoning the
 * generator does not produce. Each view opens by naming its canonical sibling, and the rule is
 * recorded there: where the two disagree on a number, the generated document wins. The frontend
 * reads the view; the manifest tests (`apps/n8n-lego/test/lego-ai-set.test.mjs`) guard the
 * canonical document. The remaining eighteen subjects have no generated counterpart and are
 * read straight from `.ai/master/`.
 */
export const MASTER_PLAN_FILES = Object.freeze({
  project: '.ai/master/frontend/PROJECT_MASTER_PLAN.md',
  coreLego: '.ai/master/frontend/CORE_LEGO_ARCHITECTURE.md',
  status: '.ai/master/frontend/CURRENT_STATUS.md',
  blockers: '.ai/master/frontend/KNOWN_BLOCKERS.md',
  decisions: '.ai/master/frontend/PROJECT_DECISIONS.md',
  workforce: '.ai/master/frontend/PROJECT_WORKFORCE_ORCHESTRATION.md',
  deployment: '.ai/master/PLATFORM_AND_DEPLOYMENT_STRATEGY.md',
  aiLego: '.ai/master/frontend/AI_AGENT_LEGO_MASTER_PLAN.md',
  aiRuntime: '.ai/master/frontend/AI_RUNTIME_AND_PROVIDER_PLAN.md',
  providers: '.ai/master/PROVIDER_TAXONOMY.md',
  context: '.ai/master/CONTEXT_SESSION_MEMORY_PLAN.md',
  tokens: '.ai/master/TOKEN_USAGE_AND_RESOURCE_PLAN.md',
  memoryGraph: '.ai/master/MEMORY_GRAPH_OBSIDIAN_PLAN.md',
  skills: '.ai/master/SKILL_AND_CAPABILITY_PLAN.md',
  agents: '.ai/master/AGENT_MACHINE_PLAN.md',
  workspace: '.ai/master/WORKSPACE_AND_EXTERNAL_ACTION_PLAN.md',
  mcp: '.ai/master/MCP_AND_RUNTIME_ADAPTER_PLAN.md',
  nodeCreator: '.ai/master/NODE_CREATOR_PLAN.md',
  translation: '.ai/master/TRANSLATION_PLAN.md',
  security: '.ai/master/SECURITY_AND_APPROVAL_MODEL.md',
  scenarios: '.ai/master/frontend/REFERENCE_AGENT_SCENARIOS.md',
  phases: '.ai/master/frontend/IMPLEMENTATION_PHASES.md',
  experience: '.ai/master/AI_UI_EXPERIENCE_MASTER_PLAN.md',
  matrix: '.ai/master/AI_FRONTEND_CONTRACT_MATRIX.md',
  disclosure: '.ai/master/AI_UX_PROGRESSIVE_DISCLOSURE.md',
  states: '.ai/master/AI_UI_STATES_AND_FLOWS.md',
  accessibility: '.ai/master/AI_ACCESSIBILITY_AND_LOCALIZATION.md',
  uiPhases: '.ai/master/AI_UI_IMPLEMENTATION_PHASES.md',
});

/** The master documents, sorted, for the budget check and for docs. */
export function masterPlanFiles() {
  return Object.freeze(Object.values(MASTER_PLAN_FILES).sort());
}

/**
 * Product tasks → the master document to read. Separate from `TASK_INDEX` on purpose: a
 * task that changes a contract reads the pack, a task that designs a surface reads the
 * specification, and neither should silently pull the other in.
 */
export const PRODUCT_TASK_INDEX = Object.freeze({
  project: Object.freeze({ document: 'project', alsoRead: Object.freeze(['coreLego', 'status']), question: 'What is this project, who owns what, and which domains exist?' }),
  'core-lego': Object.freeze({ document: 'coreLego', alsoRead: Object.freeze(['project']), question: 'What does a core LEGO domain promise, and what may the frontend consume from it?' }),
  status: Object.freeze({ document: 'status', alsoRead: Object.freeze(['blockers']), question: 'What is the state of the branches, the gates and the readiness?' }),
  blockers: Object.freeze({ document: 'blockers', alsoRead: Object.freeze(['status']), question: 'What is blocked, what is the evidence, and who owns each blocker?' }),
  decisions: Object.freeze({ document: 'decisions', alsoRead: Object.freeze(['status']), question: 'What has been decided, by whom, and what may not be reopened silently?' }),
  workforce: Object.freeze({ document: 'workforce', alsoRead: Object.freeze(['project']), question: 'How is the development workforce organised, and what does a worker own?' }),
  deployment: Object.freeze({ document: 'deployment', alsoRead: Object.freeze(['aiRuntime']), question: 'How does the product run on a small device, on a phone, offline or in the cloud — and when may Rust be used?' }),
  'ai-lego': Object.freeze({ document: 'aiLego', alsoRead: Object.freeze(['aiRuntime']), question: 'Which AI/Agent LEGO exist, which are published, and which are pending?' }),
  runtimes: Object.freeze({ document: 'aiRuntime', alsoRead: Object.freeze(['providers']), question: 'How is a runtime or a provider declared, reached and replaced?' }),
  providers: Object.freeze({ document: 'providers', alsoRead: Object.freeze(['aiRuntime']), question: 'Which provider kind is this, and what may a vendor name never be used for?' }),
  context: Object.freeze({ document: 'context', alsoRead: Object.freeze(['tokens']), question: 'How do conversation, session, context window, memory and execution differ?' }),
  tokens: Object.freeze({ document: 'tokens', alsoRead: Object.freeze(['context']), question: 'Which count is which, and where must a number be reported rather than estimated?' }),
  memory: Object.freeze({ document: 'memoryGraph', alsoRead: Object.freeze(['context']), question: 'How does the memory graph relate to Obsidian, retrieval and context?' }),
  skills: Object.freeze({ document: 'skills', alsoRead: Object.freeze(['aiLego']), question: 'How do skills and capabilities differ, and where does authority live?' }),
  agents: Object.freeze({ document: 'agents', alsoRead: Object.freeze(['security']), question: 'What is the Agent Machine, and what is published versus still a target?' }),
  workspace: Object.freeze({ document: 'workspace', alsoRead: Object.freeze(['security']), question: 'What may an external action touch, and what is its scope?' }),
  mcp: Object.freeze({ document: 'mcp', alsoRead: Object.freeze(['providers']), question: 'How does MCP fit without becoming internal architecture or a tool dump?' }),
  'node-creator': Object.freeze({ document: 'nodeCreator', alsoRead: Object.freeze(['workspace']), question: 'How is a node created, validated and installed, and what is gated?' }),
  translation: Object.freeze({ document: 'translation', alsoRead: Object.freeze(['accessibility']), question: 'What is the status of translation, and which locales and rules apply?' }),
  security: Object.freeze({ document: 'security', alsoRead: Object.freeze(['agents']), question: 'Which security invariants and approval rules hold everywhere?' }),
  scenarios: Object.freeze({ document: 'scenarios', alsoRead: Object.freeze(['agents']), question: 'What does an end-to-end agent run look like, contract-compatibly?' }),
  phases: Object.freeze({ document: 'phases', alsoRead: Object.freeze(['project']), question: 'Which phase is this work in, and what is the order?' }),
  'ai-surface': Object.freeze({ document: 'experience', alsoRead: Object.freeze(['matrix']), question: 'What is this surface, where does it live, what does it show first?' }),
  'ai-contract': Object.freeze({ document: 'matrix', alsoRead: Object.freeze(['experience']), question: 'Which canonical contract and vocabulary does this surface consume?' }),
  'ai-disclosure': Object.freeze({ document: 'disclosure', alsoRead: Object.freeze(['states']), question: 'What is visible at each level, and what must never be rendered?' }),
  'ai-state': Object.freeze({ document: 'states', alsoRead: Object.freeze(['disclosure']), question: 'Which states must this surface render, and what does it do when it cannot answer?' }),
  'ai-accessibility': Object.freeze({ document: 'accessibility', alsoRead: Object.freeze(['states']), question: 'How does this behave in Arabic, by keyboard, and without colour?' }),
  'ai-phase': Object.freeze({ document: 'uiPhases', alsoRead: Object.freeze(['experience', 'matrix']), question: 'When is this built, what does it depend on, and what proves it?' }),
});

/**
 * Resolve a product task to the master document(s) it needs, cheapest first.
 *
 * @param {{ kind?: string }} task
 */
export function productContextFor(task = {}) {
  const kind = typeof task.kind === 'string' ? task.kind : 'project';
  const entry = PRODUCT_TASK_INDEX[kind] ?? PRODUCT_TASK_INDEX.project;
  const files = [MASTER_PLAN_FILES[entry.document], ...entry.alsoRead.map((key) => MASTER_PLAN_FILES[key])];
  return Object.freeze({
    kind: PRODUCT_TASK_INDEX[kind] ? kind : 'project',
    question: entry.question,
    files: Object.freeze([...new Set(files)]),
    budget: MASTER_PLAN_BUDGET,
  });
}

/**
 * Task shapes → the files to load, in order. `unknown` is the honest default: when
 * a task does not match a known shape, load the constitution and the domain card and
 * stop, rather than guessing at more.
 */
export const TASK_INDEX = Object.freeze({
  'add-unit': Object.freeze({ level: 'L3', recipe: 'R1 — Add a sub-LEGO unit', files: Object.freeze(['.ai/cards/recipes.md', '.ai/index/units.json', '.ai/maps/dependencies.md']) }),
  'change-hook': Object.freeze({ level: 'L3', recipe: 'R2 — Change or add an extension hook', files: Object.freeze(['.ai/cards/recipes.md', '.ai/index/contracts.json']) }),
  'change-contract': Object.freeze({ level: 'L3', recipe: 'R3 — Change a frontend contract', files: Object.freeze(['.ai/cards/recipes.md', '.ai/index/contracts.json', '.ai/maps/dependencies.md']) }),
  'upgrade-unit': Object.freeze({ level: 'L3', recipe: 'R4 — Upgrade a unit version', files: Object.freeze(['.ai/cards/recipes.md', '.ai/index/units.json']) }),
  'run-tests': Object.freeze({ level: 'L3', recipe: 'R5 — Run the selective test set', files: Object.freeze(['.ai/cards/recipes.md', '.ai/maps/dependencies.md']) }),
  'hand-off': Object.freeze({ level: 'L3', recipe: 'R6 — Hand work to another agent or the Manager', files: Object.freeze(['.ai/cards/recipes.md', '.ai/index/contracts.json']) }),
  'add-capability': Object.freeze({ level: 'L2', files: Object.freeze(['.ai/index/capabilities.json', '.ai/index/contracts.json']) }),
  'translation-readiness': Object.freeze({ level: 'L2', files: Object.freeze(['.ai/index/capabilities.json', '.ai/frontend/glossary.md', '.ai/index/contracts.json']) }),
  unknown: Object.freeze({ level: 'L1', files: Object.freeze(['.ai/frontend/card.md']) }),
});

/** Every file the pack declares, deduplicated and sorted. */
export function packFiles() {
  const files = new Set([
    REFERENCE_FILES.readme,
    ...CONTEXT_LEVELS.flatMap((level) => level.files),
    ...Object.values(TASK_INDEX).flatMap((task) => task.files),
    ...Object.values(REFERENCE_FILES),
  ]);
  return Object.freeze([...files].sort());
}

/**
 * The context to load for a task, cheapest useful set first.
 *
 * @param {{ kind?: string, unit?: string|null, contract?: string|null }} task
 */
export function contextFor(task = {}) {
  const kind = typeof task.kind === 'string' ? task.kind : 'unknown';
  const matched = TASK_INDEX[kind] ?? TASK_INDEX.unknown;
  const known = kind in TASK_INDEX;
  const files = [...new Set([...CONTEXT_LEVELS[0].files, ...matched.files])];
  if (task.contract) files.push(task.contract);
  return Object.freeze({
    kind,
    known,
    level: matched.level,
    ...(matched.recipe ? { recipe: matched.recipe } : {}),
    files: Object.freeze(files),
    /** Never load the pack wholesale — the level ladder exists to prevent it. */
    advice: known
      ? `Start at L0 (${CONTEXT_LEVELS[0].files[0]}), then the files listed here. Open source only for implementation detail.`
      : 'No recipe matches this task shape: load L0 and L1, then ask which unit and contract it belongs to.',
  });
}

/** The pack as data, for docs, tests and tooling. */
export function describePack() {
  return Object.freeze({
    root: PACK_ROOT,
    levels: CONTEXT_LEVELS,
    reference: REFERENCE_FILES,
    tasks: Object.keys(TASK_INDEX),
  });
}
