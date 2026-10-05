/**
 * Node Creator & Translation Foundation — P2.23.
 *
 * PUBLIC CONTRACT (`node.creator`, v1.0.0, owner: manager, domain `node-registry`).
 *
 * A bounded definition producer, not an authority:
 *
 *   CREATE / INPUT → NORMALIZE → TRANSLATE → VALIDATE → PORTABILITY CHECK
 *                 → APPROVAL GATE (policy-explicit) → REFERENCE / ARTIFACT RESULT
 *
 * Creator output is a CANDIDATE / REFERENCE — never a publish, an execution, a
 * capability grant, a permission grant, a credential, or an approval. Declaration
 * ≠ authorization at every layer. The portability verdict has exactly one
 * source of truth: `node.portability@1.0.0#canPort` — this module never
 * re-implements the verdict; a parallel checker has no place in the design.
 *
 * Translation is a deterministic, bounded, side-effect-free, offline transform
 * from a source representation to the canonical candidate shape. Identical
 * input ⇒ identical output and identical refusals. Lossy or unknown source
 * semantics are REJECTED with canonical reasons — never best-effort, never
 * silently dropped (a source field that cannot survive translation —
 * credentials, tokens — refuses the whole translation).
 *
 * Approval uses the P2.19 approval foundation (explicit, bounded, auditable,
 * fail-closed) and only when policy says so: creationMode NODE, or an
 * authority-bearing portability class. Artifact results use the P2.19 artifact
 * registry: reference + checksum + provenance, content never dereferenced.
 *
 * Identity: one creator kind, five explicit facets (sourceKind, creatorKind,
 * creatorId, creationMode, sourceReference). human-created and node-created
 * candidates share ONE validation pipeline — origin is provenance, never a
 * security bypass.
 */
import { CLASS_DECLARATION_RULES, PORTABILITY_CLASSES, PORTABILITY_TARGETS,
  canPort, describePortability, schemaPortability } from './node-portability.mjs';
import { createApprovalFoundation } from './approval.mjs';
import { artifactContentDigest, createArtifactRegistry } from './artifact.mjs';
import { RISK_LEVELS } from './ai-foundation.mjs';
import { loadRegistry } from './registry.mjs';

/* ------------------------------------------------------------------ *
 * Contract identity & surfaces
 * ------------------------------------------------------------------ */

export const NODE_CREATOR_CONTRACT = 'node.creator@1.0.0';
export const NODE_CREATOR_CONTRACT_VERSION = '1.0.0';

/** Top-level fields of a candidate this contract validates. */
export const NODE_CREATOR_FIELDS = Object.freeze([
  'nodeId', 'contract', 'name', 'version', 'description',
  'portability', 'requiredCapabilities', 'requiredPermissions', 'schemas',
  'artifactRequirements', 'securityProfile', 'translationProvenance', 'creator',
]);

/** Caller operations — creator / translation / validation, separated by semantics. */
export const NODE_CREATOR_OPERATIONS = Object.freeze([
  'create', 'translate', 'validate', 'preview', 'approvalStatus',
]);

/** Permission words this foundation publishes (node:read reused for read paths). */
export const NODE_CREATOR_PERMISSIONS = Object.freeze([
  'node:creator:create', 'node:creator:translate', 'node:creator:validate', 'node:read',
]);

/* ------------------------------------------------------------------ *
 * §7 Creator identity — one primitive, five facets, no second model
 * ------------------------------------------------------------------ */

export const CREATOR_KIND = 'node-creator';
export const CREATION_MODES = Object.freeze(['HUMAN', 'NODE']);
export const SOURCE_KINDS = Object.freeze(['manual', 'imported', 'translated']);

/* ------------------------------------------------------------------ *
 * §9 Creator lifecycle — bounded candidate states (own object, not a
 * second capability/artifact/approval vocabulary: those describe THEIR
 * records; these describe a candidate flow record)
 * ------------------------------------------------------------------ */

export const CREATOR_STATES = Object.freeze([
  'INPUT', 'CANDIDATE', 'VALIDATING', 'VALID', 'REJECTED',
  'APPROVAL_REQUIRED', 'APPROVED', 'PUBLISHED_REFERENCE',
]);

export const CREATOR_STATE_TRANSITIONS = Object.freeze({
  INPUT: Object.freeze(['CANDIDATE']),
  CANDIDATE: Object.freeze(['VALIDATING']),
  VALIDATING: Object.freeze(['VALID', 'REJECTED', 'APPROVAL_REQUIRED', 'APPROVED']),
  VALID: Object.freeze(['VALIDATING']),
  REJECTED: Object.freeze([]),
  APPROVAL_REQUIRED: Object.freeze(['APPROVED', 'REJECTED', 'VALIDATING']),
  APPROVED: Object.freeze(['PUBLISHED_REFERENCE']),
  PUBLISHED_REFERENCE: Object.freeze([]),
});

/* ------------------------------------------------------------------ *
 * §17 Approval policy — explicit, never implicit for everything
 * ------------------------------------------------------------------ */

/** Classes whose declarations carry authority → an approval gate is required. */
export const APPROVAL_REQUIRED_CLASSES = Object.freeze(
  PORTABILITY_CLASSES.filter((cls) => CLASS_DECLARATION_RULES[cls].requirePermissionCategory !== null),
);
/** Machine-authored candidates always pass the gate (stricter, never laxer). */
export const APPROVAL_REQUIRED_CREATION_MODES = Object.freeze(['NODE']);

export const APPROVAL_POLICY = Object.freeze({
  requiredClasses: APPROVAL_REQUIRED_CLASSES,
  requiredCreationModes: APPROVAL_REQUIRED_CREATION_MODES,
  note: 'approval is policy-explicit: authority-bearing class OR node-created origin; HUMAN+PURE/API never waits, and NO origin ever bypasses validation',
  riskFor: Object.freeze({
    low: Object.freeze(['PURE', 'API']),
    medium: Object.freeze(['FILESYSTEM', 'ENVIRONMENT_SPECIFIC']),
    high: Object.freeze(['NETWORK', 'NATIVE_PROCESS', 'REMOTE_BRIDGE']),
  }),
});

/**
 * Closed creator-level refusal reasons. Schema reasons reuse the P2.22 family
 * (`schema-unsupported`, `schema-lossy`) and portability answers carry the
 * P2.22 closed set verbatim — this list only adds the flow words the P2.22
 * set does not own. No second error family.
 */
export const CREATOR_REFUSAL_REASONS = Object.freeze([
  'contract-incompatible', 'approval-not-granted', 'schema-unsupported', 'schema-lossy',
]);

/** Deterministic risk word for an approval request (canonical RISK_LEVELS subset). */
export function approvalRiskFor(className) {
  for (const risk of ['low', 'medium', 'high']) {
    if (APPROVAL_POLICY.riskFor[risk].includes(className)) {
      if (!RISK_LEVELS.includes(risk)) {
        fail(`policy risk '${risk}' is not in the canonical RISK_LEVELS vocabulary`, { risk });
      }
      return risk;
    }
  }
  if (!RISK_LEVELS.includes('high')) fail('canonical RISK_LEVELS no longer carries high', {});
  return 'high';
}

/** Does THIS candidate require the approval gate? Pure function of declaration + origin. */
export function requiresApproval(candidate) {
  if (APPROVAL_POLICY.requiredCreationModes.includes(candidate.creator.creationMode)) return true;
  return APPROVAL_POLICY.requiredClasses.includes(candidate.portability.class);
}

/* ------------------------------------------------------------------ *
 * §10–§13 Translation semantics — deterministic, fail-closed
 * ------------------------------------------------------------------ */

export const TRANSLATION_CONTRACT_VERSION = '1.0.0';

/**
 * Closed refusal reasons for SOURCE-level translation failures. Schema-level
 * failures reuse the P2.22 family verbatim (`schema-unsupported`,
 * `schema-lossy`) — there is no second error vocabulary.
 */
export const TRANSLATION_REFUSAL_REASONS = Object.freeze([
  'unknown-source-construct', 'lossy-source-field', 'unknown-language-marker',
  'unknown-creation-mode', 'unknown-source-kind', 'missing-source-schema',
]);

/** Source fields whose semantics cannot survive translation — carrying them
 * would require credentials/authority, so the WHOLE translation is refused. */
export const TRANSLATION_FORBIDDEN_FIELDS = Object.freeze([
  'credential', 'credentials', 'token', 'secret', 'apiKey', 'api-key',
  'authentication', 'oauth', 'privateKey', 'webhookSecret',
]);

/** Source constructs (top-level keys of the source document) that are accepted. */
export const TRANSLATION_SOURCE_FIELDS = Object.freeze([
  'nodeId', 'name', 'version', 'description', 'schemas',
  'requiredCapabilities', 'requiredPermissions', 'portability',
  'artifactRequirements', 'securityProfile',
]);

export const TRANSLATION_MARKER_RE = /^[a-z][a-z0-9-]*(?:@[A-Za-z0-9._-]+)?$/;

/* ------------------------------------------------------------------ *
 * §34 Bounds — deterministic refusal, never an unbounded walk
 * ------------------------------------------------------------------ */

export const CREATOR_LIMITS = Object.freeze({
  maxDepth: 16,
  maxSchemaNodes: 256,
  maxCandidateKeys: 64,
  maxArtifactRequirements: 8,
  maxNameLength: 128,
  maxDescriptionLength: 512,
  maxSourceBytes: 64 * 1024,
  maxReasonLength: 256,
});

/* ------------------------------------------------------------------ *
 * Errors — the published code only (no second error family)
 * ------------------------------------------------------------------ */

export class NodeCreatorError extends Error {
  constructor(message, meta = {}) {
    super(message);
    this.name = 'NodeCreatorError';
    this.code = 'lego.contract_violation';
    this.meta = Object.freeze({ ...meta });
  }
}

const fail = (message, meta) => { throw new NodeCreatorError(message, meta); };

const isPlainObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const NODE_ID_RE = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
const OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
const SENSITIVE_TEXT = /(?:BEGIN\s+(?:RSA|OPENSSH|PRIVATE)\s+KEY|(?:^|\W)sk-[a-z0-9]{8,}|(?:^|\W)ghp_[a-z0-9]{8,}|(?:^|\W)github_pat_[a-z0-9_]{8,}|Bearer\s+[a-z0-9._-]+)/i;

function stableJson(value) {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortDeep(value[key]);
    return out;
  }
  return value;
}

function assertOpaque(value, field, { nullable = true } = {}) {
  if (value === null || value === undefined) {
    if (nullable) return null;
    fail(`${field} is required`, { field });
  }
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || !OPAQUE_RE.test(value)) {
    fail(`${field} must be an opaque reference of 1..128 characters`, { field });
  }
  if (SENSITIVE_TEXT.test(value)) fail(`${field} carries secret-shaped material`, { field });
  return value;
}

function walkBound(value, state, path = 'candidate') {
  state.nodes += 1;
  if (state.nodes > CREATOR_LIMITS.maxSchemaNodes) {
    fail(`input exceeds ${CREATOR_LIMITS.maxSchemaNodes} schema nodes — bounded deterministic refusal`, {
      limit: 'maxSchemaNodes',
    });
  }
  if (state.depth > CREATOR_LIMITS.maxDepth) {
    fail(`input exceeds depth ${CREATOR_LIMITS.maxDepth} — bounded deterministic refusal`, {
      limit: 'maxDepth',
    });
  }
  if (Array.isArray(value)) {
    state.depth += 1;
    for (const item of value) walkBound(item, state, path);
    state.depth -= 1;
    return;
  }
  if (isPlainObject(value)) {
    state.depth += 1;
    for (const [key, item] of Object.entries(value)) walkBound(item, state, `${path}.${key}`);
    state.depth -= 1;
  }
}

/* ------------------------------------------------------------------ *
 * Vocabulary — memoized once from the domain registry (O(1) after load)
 * ------------------------------------------------------------------ */

function buildVocabulary() {
  const registry = loadRegistry();
  const capabilities = new Set();
  const permissions = new Set();
  for (const domain of registry.domains) {
    for (const capability of domain.capabilities ?? []) {
      capabilities.add(capability.id);
      for (const permission of capability.permissions ?? []) permissions.add(permission);
      for (const operation of capability.operations ?? []) {
        if (operation.permission) permissions.add(operation.permission);
      }
    }
  }
  for (const permission of NODE_CREATOR_PERMISSIONS) permissions.add(permission);
  return Object.freeze({ capabilities, permissions });
}

/** Immutable memoization of the static manifest vocabulary (registry.mjs construct). */
const KNOWN_VOCABULARY = buildVocabulary();

/* ------------------------------------------------------------------ *
 * Candidate construction (shared by create() and translate())
 * ------------------------------------------------------------------ */

function assertCandidateShape(candidate) {
  if (!isPlainObject(candidate)) fail('candidate must be a plain object', { field: 'candidate' });
  const keys = Object.keys(candidate);
  if (keys.length > CREATOR_LIMITS.maxCandidateKeys) {
    fail(`candidate carries more than ${CREATOR_LIMITS.maxCandidateKeys} keys`, { limit: 'maxCandidateKeys' });
  }
  if (typeof candidate.nodeId !== 'string' || !NODE_ID_RE.test(candidate.nodeId)) {
    fail('nodeId must be a namespaced canonical id (lowercase segments joined by a dot)', { field: 'nodeId' });
  }
  if (typeof candidate.version !== 'string' || !VERSION_RE.test(candidate.version)) {
    fail('version must be semver (major.minor.patch)', { field: 'version' });
  }
  if (typeof candidate.name !== 'string' || candidate.name.length === 0 || candidate.name.length > CREATOR_LIMITS.maxNameLength) {
    fail(`name must be 1..${CREATOR_LIMITS.maxNameLength} characters`, { field: 'name' });
  }
  if ('description' in candidate && candidate.description !== null
    && (typeof candidate.description !== 'string' || candidate.description.length > CREATOR_LIMITS.maxDescriptionLength)) {
    fail(`description must be at most ${CREATOR_LIMITS.maxDescriptionLength} characters`, { field: 'description' });
  }
  // canPort compatibility: the candidate IS a node.portability declaration plus extras
  if (!isPlainObject(candidate.portability) || typeof candidate.portability.class !== 'string') {
    fail('portability.class must be a string', { field: 'portability' });
  }
  if (!PORTABILITY_CLASSES.includes(candidate.portability.class)) {
    fail(`portability.class '${candidate.portability.class}' is not a canonical class`, {
      field: 'portability.class', class: candidate.portability.class,
    });
  }
  for (const field of ['requiredCapabilities', 'requiredPermissions']) {
    if (!Array.isArray(candidate[field]) || candidate[field].some((item) => typeof item !== 'string')) {
      fail(`${field} must be an array of strings`, { field });
    }
  }
  if (!isPlainObject(candidate.schemas) || !isPlainObject(candidate.schemas.input) || !isPlainObject(candidate.schemas.output)) {
    fail('schemas must carry plain-object input and output', { field: 'schemas' });
  }
  if (!('contract' in candidate) || typeof candidate.contract !== 'string') {
    fail('contract is derived as nodeId@version and must be present', { field: 'contract' });
  }
  if ('securityProfile' in candidate
    && (typeof candidate.securityProfile !== 'string' || candidate.securityProfile.length === 0)) {
    fail('securityProfile must be a canonical id when present', { field: 'securityProfile' });
  }
  if (!('creator' in candidate) || !isPlainObject(candidate.creator)) {
    fail('creator identity must be present', { field: 'creator' });
  }
  for (const reference of candidate.artifactRequirements ?? []) {
    assertOpaque(reference, 'artifactRequirements', { nullable: false });
  }
  walkBound(candidate, { nodes: 0, depth: 0 });
  return candidate;
}

function freezeCandidate(candidate) {
  // Copy-then-freeze (never mutate in place: nested identity objects may
  // already be frozen by their creator).
  const freezeDeep = (value) => {
    if (Array.isArray(value)) return Object.freeze(value.map(freezeDeep));
    if (isPlainObject(value)) {
      const out = {};
      for (const [key, item] of Object.entries(value)) out[key] = freezeDeep(item);
      return Object.freeze(out);
    }
    return value;
  };
  return freezeDeep(candidate);
}

function buildCandidate(definition, identity, translationProvenance = null) {
  const candidate = {
    nodeId: definition.nodeId,
    contract: `${definition.nodeId}@${definition.version}`,
    name: definition.name,
    version: definition.version,
    description: definition.description ?? null,
    portability: sortDeep(definition.portability),
    requiredCapabilities: [...definition.requiredCapabilities],
    requiredPermissions: [...definition.requiredPermissions],
    schemas: sortDeep(definition.schemas),
    artifactRequirements: [...(definition.artifactRequirements ?? [])],
    // Omit the key entirely when unset: node.portability@1.0.0 requires a
    // canonical id whenever securityProfile is PRESENT — absent is the honest
    // way to say "no profile", and null would be a presence claim.
    ...(definition.securityProfile != null ? { securityProfile: definition.securityProfile } : {}),
    creator: Object.freeze({ ...identity }),
    translationProvenance,
  };
  assertCandidateShape(candidate);
  if (candidate.artifactRequirements.length > CREATOR_LIMITS.maxArtifactRequirements) {
    fail(`at most ${CREATOR_LIMITS.maxArtifactRequirements} artifact requirements`, { limit: 'maxArtifactRequirements' });
  }
  return freezeCandidate(candidate);
}

function assertIdentity(context) {
  if (!isPlainObject(context)) fail('creator context must be a plain object', { field: 'context' });
  const { sourceKind, creatorKind, creatorId, creationMode, sourceReference = null } = context;
  if (!SOURCE_KINDS.includes(sourceKind)) {
    fail(`sourceKind must be one of ${SOURCE_KINDS.join(', ')}`, { field: 'sourceKind', sourceKind });
  }
  if (creatorKind !== CREATOR_KIND) {
    fail(`creatorKind must be '${CREATOR_KIND}' — P2.23 defines exactly one creator kind`, { field: 'creatorKind' });
  }
  assertOpaque(creatorId, 'creatorId', { nullable: false });
  if (!CREATION_MODES.includes(creationMode)) {
    fail(`creationMode must be one of ${CREATION_MODES.join(', ')}`, { field: 'creationMode', creationMode });
  }
  assertOpaque(sourceReference, 'sourceReference');
  return Object.freeze({ sourceKind, creatorKind, creatorId, creationMode, sourceReference });
}

/** Content-addressed record identity: identical candidate ⇒ identical record id. */
function contentRecordId(candidate) {
  return `cnd-${artifactContentDigest(stableJson(candidate)).slice(7, 22)}`;
}

/* ------------------------------------------------------------------ *
 * Factory
 * ------------------------------------------------------------------ */

export function createNodeCreator(options = {}) {
  // time and identity are injected (P2.19 discipline) — the module never reads
  // the wall clock or ambient randomness itself.
  if (typeof options.now !== 'function' || typeof options.newId !== 'function') {
    throw new NodeCreatorError('now and newId must be injected (no ambient clock, no ambient id)');
  }
  const { now, newId } = options;

  const approvals = options.approvals ?? createApprovalFoundation({ now, newId });
  const artifacts = options.artifacts ?? createArtifactRegistry({ now });

  const store = new Map();

  function load(recordId, operation) {
    const record = store.get(recordId);
    if (!record) fail(`unknown creator record '${recordId}' (${operation})`, { recordId, operation });
    return record;
  }

  /** A record handed in must BE one of ours (provenance), but its fields —
   * including the approval reference — are what the caller presents. */
  function accept(record, operation) {
    if (!isPlainObject(record) || typeof record.recordId !== 'string' || !store.has(record.recordId)) {
      fail(`${operation} requires a creator record from this creator`, { field: 'record' });
    }
    return record;
  }

  function transition(record, next) {
    const allowed = CREATOR_STATE_TRANSITIONS[record.state];
    if (!allowed || !allowed.includes(next)) {
      fail(`creator lifecycle refuses the edge '${record.state}' -> '${next}'`, {
        from: record.state, to: next,
      });
    }
    return Object.freeze({ ...record, state: next });
  }

  function put(record) {
    store.set(record.recordId, record);
    return record;
  }

  function runPortability(candidate, opts) {
    const target = opts.target
      ?? candidate.portability.runtimeRequirements?.[0]
      ?? PORTABILITY_TARGETS[0];
    return canPort(candidate, target, opts.context ?? {});
  }

  function openApproval(record, answer) {
    const approvalId = `apr-${String(newId()).slice(0, 40)}`;
    approvals.request({
      approvalId,
      action: `node.create:${record.candidate.nodeId}@${record.candidate.version}`,
      actor: record.candidate.creator.creatorId,
      risk: approvalRiskFor(record.candidate.portability.class),
      scope: `node-registry:${record.candidate.nodeId}`,
      contextReference: record.candidate.creator.sourceReference,
    });
    const next = transition(record, 'APPROVAL_REQUIRED');
    const settled = Object.freeze({ ...next, approval: Object.freeze({ approvalId }) });
    return put(settled);
  }

  function seal(record) {
    const candidate = record.candidate;
    const checksum = artifactContentDigest(stableJson({
      nodeId: candidate.nodeId,
      version: candidate.version,
      schemas: candidate.schemas,
      portability: candidate.portability,
      requiredCapabilities: candidate.requiredCapabilities,
      requiredPermissions: candidate.requiredPermissions,
    }));
    const artifactId = `ndef-${String(newId()).slice(0, 48)}`;
    artifacts.create({
      artifactId,
      kind: 'file',
      storageRef: `node.definition/${candidate.nodeId}@${candidate.version}`,
      checksum,
      owner: candidate.creator.creatorId,
      metadata: {
        nodeId: candidate.nodeId,
        version: candidate.version,
        mode: candidate.creator.creationMode,
        lifecycle: 'publishable-reference',
      },
    });
    const reference = Object.freeze({
      artifactId,
      checksum,
      storageRef: `node.definition/${candidate.nodeId}@${candidate.version}`,
      meaning: 'publishable-reference — a system with publishing authority may consume it; this creator holds no such authority',
    });
    const approved = transition(record, 'APPROVED');
    const sealed = Object.freeze({ ...approved, reference });
    return put(transition(sealed, 'PUBLISHED_REFERENCE'));
  }

  const creator = {
    /**
     * §6 — bounded definition producer. Produces a CANDIDATE record and
     * nothing else: no grant, no publish, no approval, no execution.
     */
    create(definition, context) {
      if (!isPlainObject(definition)) fail('definition must be a plain object', { field: 'definition' });
      const identity = assertIdentity(context);
      const bytes = Buffer.byteLength(stableJson(definition), 'utf8');
      if (bytes > CREATOR_LIMITS.maxSourceBytes) {
        fail(`definition exceeds ${CREATOR_LIMITS.maxSourceBytes} bytes — bounded deterministic refusal`, {
          limit: 'maxSourceBytes',
        });
      }
      for (const forbidden of TRANSLATION_FORBIDDEN_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(definition, forbidden)) {
          fail(`definition may not carry '${forbidden}' — creators never handle credentials or standing authority`, {
            field: forbidden,
          });
        }
      }
      const candidate = buildCandidate(definition, identity, null);
      const record = Object.freeze({
        recordId: contentRecordId(candidate),
        state: 'CANDIDATE',
        candidate,
        validation: null,
        approval: null,
        reference: null,
        reasons: Object.freeze([]),
      });
      put(record);
      return record;
    },

    /**
     * §10–§13 — deterministic translation: source → canonical candidate.
     * Success returns a CANDIDATE record (still unvalidated). Semantic
     * refusals return state REJECTED with canonical reasons — the source is
     * never partially consumed. Identical input ⇒ identical output.
     */
    translate(source, context) {
      if (!isPlainObject(source)) fail('source must be a plain object', { field: 'source' });
      const identity = assertIdentity(context);
      const {
        sourceRuntime, sourceReference = null, source: sourceDoc,
      } = source;
      if (typeof sourceRuntime !== 'string' || !TRANSLATION_MARKER_RE.test(sourceRuntime)) {
        fail(`sourceRuntime must be a canonical language/runtime marker (e.g. n8n-nodes-base@2.9.1)`, {
          field: 'sourceRuntime',
        });
      }
      assertOpaque(sourceReference, 'sourceReference');
      if (!isPlainObject(sourceDoc)) fail('source.source must be the node document', { field: 'source.source' });

      const bytes = Buffer.byteLength(stableJson(source), 'utf8');
      if (bytes > CREATOR_LIMITS.maxSourceBytes) {
        fail(`source exceeds ${CREATOR_LIMITS.maxSourceBytes} bytes — bounded deterministic refusal`, {
          limit: 'maxSourceBytes',
        });
      }

      const envelopeDigest = artifactContentDigest(stableJson({ sourceRuntime, sourceReference: sourceReference ?? null, source: sourceDoc }));
      const refuse = (reason, detail) => {
        const rejected = Object.freeze({
          recordId: `cnd-r${envelopeDigest.slice(7, 22)}`,
          state: 'REJECTED',
          candidate: null,
          validation: null,
          approval: null,
          reference: null,
          reasons: Object.freeze([Object.freeze({ reason, detail: detail ?? null })]),
        });
        store.set(rejected.recordId, rejected); // persisted: terminal, inspectable, identical input ⇒ identical id
        return rejected;
      };

      // Unknown or forbidden constructs refuse the WHOLE translation.
      for (const key of Object.keys(sourceDoc)) {
        if (TRANSLATION_FORBIDDEN_FIELDS.includes(key)) {
          return refuse('lossy-source-field', key);
        }
        if (!TRANSLATION_SOURCE_FIELDS.includes(key)) {
          return refuse('unknown-source-construct', key);
        }
      }
      if (!isPlainObject(sourceDoc.schemas)) return refuse('missing-source-schema', 'schemas');

      // Origin: creationMode comes from the identity context only — a transported
      // document cannot claim its own origin; translate always marks the
      // candidate as translated-source provenance.
      const effectiveIdentity = Object.freeze({
        ...identity, sourceKind: 'translated',
      });

      // Schema subset: P2.22 refusal family, verbatim.
      for (const side of ['input', 'output']) {
        const report = schemaPortability(sourceDoc.schemas[side]);
        if (report.unsupported.length > 0) {
          return refuse('schema-unsupported', `${side}:${report.unsupported[0].detail}`);
        }
        if (report.lossy.length > 0) {
          return refuse('schema-lossy', `${side}:${report.lossy[0].detail}`);
        }
      }

      if (typeof sourceDoc.nodeId !== 'string' || !NODE_ID_RE.test(sourceDoc.nodeId)) {
        return refuse('unknown-source-construct', 'nodeId');
      }
      if (typeof sourceDoc.version !== 'string' || !VERSION_RE.test(sourceDoc.version)) {
        return refuse('unknown-source-construct', 'version');
      }
      const definition = {
        nodeId: sourceDoc.nodeId,
        version: sourceDoc.version,
        name: sourceDoc.name ?? sourceDoc.nodeId,
        description: sourceDoc.description ?? null,
        portability: sourceDoc.portability,
        requiredCapabilities: sourceDoc.requiredCapabilities ?? [],
        requiredPermissions: sourceDoc.requiredPermissions ?? [],
        schemas: sourceDoc.schemas,
        artifactRequirements: sourceDoc.artifactRequirements ?? [],
        securityProfile: sourceDoc.securityProfile ?? null,
      };

      const translationProvenance = Object.freeze({
        translator: NODE_CREATOR_CONTRACT,
        sourceKind: 'translated',
        sourceRuntime,
        sourceReference: sourceReference ?? null,
        sourceDigest: artifactContentDigest(stableJson({ sourceRuntime, sourceReference: sourceReference ?? null, source: sourceDoc })),
      });

      let candidate;
      try {
        candidate = buildCandidate(definition, effectiveIdentity, translationProvenance);
      } catch (error) {
        if (error instanceof NodeCreatorError) {
          return Object.freeze({
            ...refuse('unknown-source-construct', String(error.meta?.field ?? 'definition')),
            reasons: Object.freeze([Object.freeze({
              reason: 'unknown-source-construct',
              detail: String(error.meta?.field ?? error.message).slice(0, CREATOR_LIMITS.maxReasonLength),
            })]),
          });
        }
        throw error;
      }
      const record = Object.freeze({
        recordId: contentRecordId(candidate),
        state: 'CANDIDATE',
        candidate,
        validation: null,
        approval: null,
        reference: null,
        reasons: Object.freeze([]),
      });
      put(record);
      return record;
    },

    /**
     * §15/§16 — the ONE validation sequence: contract → schema → runtime →
     * portability → environment, where the last four axes come from
     * `node.portability@1.0.0#canPort` itself. Drives the approval policy and
     * seals an approved candidate into a publishable reference.
     */
    validate(recordOrId, opts = {}) {
      const record = typeof recordOrId === 'string' ? load(recordOrId, 'validate') : accept(recordOrId, 'validate');
      if (record.state === 'PUBLISHED_REFERENCE' || record.state === 'REJECTED') {
        return record; // terminal states are stable — re-validation changes nothing
      }
      let current = record;
      if (current.state === 'VALID' || current.state === 'APPROVED' || current.state === 'APPROVAL_REQUIRED' || current.state === 'CANDIDATE') {
        current = transition(current, 'VALIDATING');
      }
      put(current);

      // creator-level contract checks (candidate shape) — throws ⇒ REJECTED record
      let candidate;
      try {
        candidate = assertCandidateShape(current.candidate);
      } catch (error) {
        const settled = put(transition(current, 'REJECTED'));
        return put(Object.freeze({
          ...settled,
          reasons: Object.freeze([Object.freeze({
            reason: 'contract-incompatible',
            detail: String(error.message).slice(0, CREATOR_LIMITS.maxReasonLength),
          })]),
        }));
      }

      // schema axis pre-check uses the P2.22 subset directly for creator-visible reasons
      for (const side of ['input', 'output']) {
        const report = schemaPortability(candidate.schemas[side]);
        if (!report.portable) {
          const first = report.unsupported[0] ?? report.lossy[0];
          const reason = report.unsupported.length > 0 ? 'schema-unsupported' : 'schema-lossy';
          const settled = put(transition(current, 'REJECTED'));
          return put(Object.freeze({
            ...settled,
            validation: null,
            reasons: Object.freeze([Object.freeze({ reason, detail: `${side}:${first.detail}` })]),
          }));
        }
      }

      // SINGLE portability authority: P2.22 canPort, verbatim
      let answer;
      try {
        answer = runPortability(candidate, opts);
      } catch (error) {
        const settled = put(transition(current, 'REJECTED'));
        return put(Object.freeze({
          ...settled,
          validation: null,
          reasons: Object.freeze([Object.freeze({
            reason: 'contract-incompatible',
            detail: String(error.message).slice(0, CREATOR_LIMITS.maxReasonLength),
          })]),
        }));
      }

      if (!answer.portable) {
        const settled = put(transition(current, 'REJECTED'));
        return put(Object.freeze({
          ...settled,
          validation: answer,
          reasons: answer.reasons,
        }));
      }

      // approval policy — explicit, never implicit-for-all
      const needsApproval = requiresApproval(current.candidate);
      if (!needsApproval) {
        const valid = put(Object.freeze({
          ...transition(current, 'VALID'),
          validation: answer,
          reasons: Object.freeze([]),
        }));
        return valid;
      }

      if (!current.approval) {
        const pending = openApproval(current, answer);
        return put(Object.freeze({ ...pending, validation: answer }));
      }

      // approval exists — consult the P2.19 decision boundary (evaluate is the
      // fail-closed ALLOW path: explicit granted + unexpired + scope/identity
      // matched; everything else — unknown, denied, expired — is DENY).
      const decision = approvals.evaluate(current.approval.approvalId, {
        identity: current.candidate.creator.creatorId,
        scope: `node-registry:${current.candidate.nodeId}`,
      });
      if (decision.decision === 'granted') {
        const withValidation = Object.freeze({ ...current, validation: answer });
        return seal(withValidation);
      }
      const structuralDeny = ['unknown-approval', 'scope-mismatch', 'identity-mismatch', 'not-granted'];
      const terminalDeny = decision.state === 'denied' || decision.state === 'expired';
      const unknownRef = structuralDeny.includes(String(decision.reason ?? ''));
      if (decision.decision === 'denied' && !unknownRef && !terminalDeny && decision.state === 'requested') {
        // still waiting — settle back to APPROVAL_REQUIRED, never dangle in VALIDATING
        return put(Object.freeze({
          ...transition(current, 'APPROVAL_REQUIRED'),
          validation: answer,
        }));
      }
      if (decision.decision === 'denied') {
        const settled = put(transition(current, 'REJECTED'));
        return put(Object.freeze({
          ...settled,
          validation: answer,
          reasons: Object.freeze([Object.freeze({
            reason: 'approval-not-granted',
            detail: decision.reason ?? decision.state ?? 'denied',
          })]),
        }));
      }
      return put(Object.freeze({
        ...transition(current, 'APPROVAL_REQUIRED'),
        validation: answer,
      }));
    },

    /** §7/§9 read path — structure only, no decision of its own. */
    preview(recordOrId) {
      const record = typeof recordOrId === 'string' ? load(recordOrId, 'preview') : accept(recordOrId, 'preview');
      if (!record.candidate) {
        return Object.freeze({
          recordId: record.recordId, state: record.state, candidate: null,
          requiresApproval: null, portability: null, approval: record.approval, reference: record.reference,
          reasons: record.reasons,
        });
      }
      return Object.freeze({
        recordId: record.recordId,
        state: record.state,
        candidate: Object.freeze({
          nodeId: record.candidate.nodeId,
          contract: record.candidate.contract,
          version: record.candidate.version,
          name: record.candidate.name,
          creator: record.candidate.creator,
          translationProvenance: record.candidate.translationProvenance,
        }),
        requiresApproval: requiresApproval(record.candidate),
        portability: describePortability(record.candidate),
        validation: record.validation,
        approval: record.approval,
        reference: record.reference,
        reasons: record.reasons,
      });
    },

    /** §17 approval touchpoint read — delegates to the P2.19 foundation. */
    approvalStatus(recordOrId) {
      const record = typeof recordOrId === 'string' ? load(recordOrId, 'approvalStatus') : accept(recordOrId, 'approvalStatus');
      if (!record.approval) {
        return Object.freeze({
          approvalId: null,
          required: record.candidate ? requiresApproval(record.candidate) : null,
          state: null,
          decision: null,
          reason: 'no approval requested for this record',
        });
      }
      const approvalRecord = approvals.inspect(record.approval.approvalId);
      if (!approvalRecord) {
        // fail-closed: an unknown approval reports absence, never a grant
        return Object.freeze({
          approvalId: record.approval.approvalId,
          required: true,
          state: null,
          decision: 'denied',
          reason: 'unknown approval — fail-closed',
          scope: null,
          risk: null,
          requestedAt: null,
          resolvedAt: null,
        });
      }
      return Object.freeze({
        approvalId: approvalRecord.approvalId,
        required: true,
        state: approvalRecord.state,
        decision: approvalRecord.decision,
        reason: approvalRecord.reason ?? null,
        scope: approvalRecord.scope ?? null,
        risk: approvalRecord.risk ?? null,
        requestedAt: approvalRecord.requestedAt ?? null,
        resolvedAt: approvalRecord.resolvedAt ?? null,
      });
    },

    /** The record store (frozen view) — deterministic inspection for tests/evidence. */
    inspect(recordOrId) {
      return typeof recordOrId === 'string' ? load(recordOrId, 'inspect') : accept(recordOrId, 'inspect');
    },
  };

  return Object.freeze(creator);
}
