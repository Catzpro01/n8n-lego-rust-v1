/**
 * node.io@0.1.0 — the node I/O compiler.
 *
 * P6 milestone 21 of 31 (Issue #100). A node declaration says what it reads and what it
 * writes. That is the part of the contract a workflow is actually wired to, and the part
 * that breaks quietly when a version moves or when a node is moved to another runtime.
 *
 * This contract compiles a declaration's ports into an ENFORCEABLE WIRE CONTRACT and
 * answers three questions that are asked in practice:
 *
 *  1. IS THIS DECLARATION COHERENT? Ports are named once per direction, connection types
 *     come from the vocabulary n8n publishes, item fields have types, and a node that
 *     neither reads nor writes is not a node.
 *  2. DID A VERSION MOVE BREAK SOMETHING? `compareNodeIo` answers `identical`, `additive`
 *     or `breaking`, and names why: a removed port, a changed connection type, a narrowed
 *     arity, a field that disappeared, a field added to a CLOSED shape. "It still works on
 *     my workflow" is not a compatibility statement.
 *  3. WHAT CROSSES A RUNTIME BOUNDARY? A node may run in the JS host (`js-compat`), in WASM,
 *     as native code (`rust-native`) or on a REMOTE worker. `planHandoff` decides, per field, whether the value travels inline,
 *     travels as a REFERENCE (a handle into the artifact store), or is REFUSED — because a
 *     value the compiler does not understand cannot be promised to arrive intact, and a
 *     payload is not something to push into a sandbox.
 *
 * Scope walls (enforced by tests): no workflow graph or connections (P3/P4), no routing or
 * scheduling (P4), no artifact store implementation (P6.7), no capability or trust verdict
 * (P6.12), no admission decision (P6.17). No filesystem, network, clock, randomness or
 * shared-state mutation — the only `node:` import is the hash.
 *
 * Authority: this contract says what a node's edges look like and what may cross them. It
 * never decides that a node may run, and it never inspects data: it compiles declarations.
 */
import { createHash } from 'node:crypto';
import { NODE_RUNTIME_LOCALITIES } from './node-registry.mjs';

export const IO_CONTRACT = 'node.io@0.1.0';
export const IO_CONTRACT_VERSION = '0.1.0';
export const IO_SCHEMA_VERSION = 1;

export const IO_OPERATIONS = Object.freeze(['compile', 'compare', 'handoff', 'describe']);
export const IO_PERMISSIONS = Object.freeze(['node:read']);

/**
 * The connection types n8n publishes. Quoted, not invented: a node wired with a type the
 * runtime does not know is a node nothing can connect to.
 */
export const NODE_CONNECTION_TYPES = Object.freeze([
  'main',
  'ai_agent', 'ai_chain', 'ai_document', 'ai_embedding', 'ai_languageModel', 'ai_memory',
  'ai_outputParser', 'ai_retriever', 'ai_reranker', 'ai_textSplitter', 'ai_tool', 'ai_vectorStore',
]);

/**
 * n8n's documentation also spells the vector store connection `ai_vectorRetriever`. Rather
 * than guess which spelling a real workflow uses, the alias is accepted and compiled to the
 * canonical type, and the port records that it arrived under an alias.
 */
export const CONNECTION_TYPE_ALIASES = Object.freeze({ ai_vectorRetriever: 'ai_vectorStore' });

/** How many connections a port accepts. Narrowing either of these breaks an existing graph. */
export const PORT_ARITIES = Object.freeze(['single', 'many']);

/** Item field types. `binary` and `date` exist because n8n items really carry them. */
export const ITEM_FIELD_TYPES = Object.freeze(['string', 'number', 'boolean', 'date', 'object', 'array', 'binary', 'null']);

/** What comparing two compilations can say. There is no "probably fine". */
export const IO_VERDICTS = Object.freeze(['identical', 'additive', 'breaking']);

/** How a field crosses a runtime boundary. */
export const TRANSPORT_KINDS = Object.freeze(['inline', 'reference', 'refused']);

export const IO_REASONS = Object.freeze([
  'io.input', 'io.port', 'io.type', 'io.shape', 'io.compare', 'io.handoff',
]);

export const IO_RULES = Object.freeze({
  quotes: 'connection types are the ones n8n publishes; a type nobody knows is a port nothing can connect to',
  shape: 'an item field has a type, and a shape is a promise: open means more may arrive, closed means this is all',
  compare: 'a version movement is identical, additive or breaking, and the answer names why',
  closed: 'a field added to a shape that is now CLOSED is breaking: every producer of that item has to supply it',
  boundary: 'a value crosses a runtime boundary inline, as a handle, or not at all',
  payload: 'a payload is not pushed into a sandbox: binary data crosses as a reference into the artifact store',
  unknown: 'a value the compiler does not understand is not promised to arrive intact; it is refused',
  authority: 'this contract compiles ports; it never decides that a node may run',
});

export class IoError extends Error {
  constructor(message, { code = 'io.input', meta = {} } = {}) {
    super(message);
    this.name = 'IoError';
    this.code = 'lego.contract_violation';
    this.meta = { code, ...meta };
  }
}

const fail = (message, detail = {}) => { throw new IoError(message, detail); };

const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;
const isIdentity = (value) => isNonEmptyString(value) && value.includes('@') && value.split('@').every((part) => part.length > 0);

/** Canonical JSON: key order must not change a digest. */
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** A digest over a set of fields, so a shape is comparable by content. */
export function ioDigest(fields) {
  return sha256(stableJson(fields ?? {}));
}

/** The types a field may declare, and the transport each one gets when it has to travel. */
const FIELD_TRANSPORT = Object.freeze({
  string: 'inline',
  number: 'inline',
  boolean: 'inline',
  null: 'inline',
  object: 'inline',
  array: 'inline',
  date: 'refused',
  binary: 'reference',
});

/**
 * Compiling a declaration's ports is where a loose description becomes something a caller
 * can be held to: named ports, quoted connection types, typed fields, and a digest per port
 * so a change in shape is visible without reading the shape.
 */
export function compileNodeIo({ identity, trigger = false, inputs = [], outputs = [], additionalProperties = true } = {}) {
  if (!isIdentity(identity)) {
    fail("a node I/O contract belongs to an identity 'type@typeVersion': ports without a node are a diagram", { code: 'io.input', field: 'identity' });
  }
  if (typeof trigger !== 'boolean') fail('trigger is a boolean: a node either starts a workflow or it does not', { code: 'io.input', field: 'trigger' });
  if (typeof additionalProperties !== 'boolean') fail('additionalProperties is a boolean: a shape is open or closed, not probably', { code: 'io.input', field: 'additionalProperties' });
  if (!Array.isArray(inputs) || !Array.isArray(outputs)) fail('inputs and outputs are lists of ports', { code: 'io.input', field: 'ports' });
  if (inputs.length === 0 && outputs.length === 0) {
    fail('a node that neither reads nor writes is not a node', { code: 'io.port', field: 'ports' });
  }
  if (inputs.length === 0 && !trigger) {
    fail('a node with no input must be a trigger: otherwise nothing can ever reach it', { code: 'io.port', field: 'inputs' });
  }
  const compiledInputs = compilePorts(inputs, 'input', additionalProperties);
  const compiledOutputs = compilePorts(outputs, 'output', additionalProperties);
  const body = {
    contract: IO_CONTRACT,
    schemaVersion: IO_SCHEMA_VERSION,
    identity,
    trigger,
    additionalProperties,
    inputs: compiledInputs,
    outputs: compiledOutputs,
  };
  return Object.freeze({ ...body, ioDigest: ioDigest(body) });
}

function compilePorts(ports, direction, additionalProperties) {
  const seen = new Set();
  return Object.freeze(ports.map((port, index) => {
    const name = port?.name;
    if (!isNonEmptyString(name)) {
      fail(`${direction} port ${index} has no name: an unnamed port is a wire nobody can point at`, { code: 'io.port', field: `${direction}s[${index}].name` });
    }
    if (seen.has(name)) {
      fail(`${direction} port '${name}' is declared twice: two ports of one name are one port with two meanings`, { code: 'io.port', field: `${direction}s[${index}].name` });
    }
    seen.add(name);
    const declaredType = port?.connectionType;
    const canonicalType = CONNECTION_TYPE_ALIASES[declaredType] ?? declaredType;
    if (!NODE_CONNECTION_TYPES.includes(canonicalType)) {
      fail(`connection type '${String(declaredType)}' is not one n8n publishes: a node wired with a type the runtime does not know is a node nothing can connect to`, { code: 'io.type', field: `${direction}s[${index}].connectionType` });
    }
    const arity = port?.arity ?? 'many';
    if (!PORT_ARITIES.includes(arity)) {
      fail(`arity '${String(arity)}' is not ${PORT_ARITIES.join(' or ')}`, { code: 'io.port', field: `${direction}s[${index}].arity` });
    }
    const fields = normalizeFields(port?.fields, `${direction}s[${index}].fields`);
    const shape = { fields, additionalProperties };
    return Object.freeze({
      name,
      direction,
      connectionType: canonicalType,
      aliasedFrom: canonicalType === declaredType ? null : declaredType,
      arity,
      fields,
      fieldNames: Object.freeze(Object.keys(fields).sort()),
      shapeDigest: ioDigest(shape),
      note: isNonEmptyString(port?.note) ? port.note : null,
    });
  }));
}

function normalizeFields(fields, path) {
  if (fields === undefined || fields === null) return Object.freeze({});
  if (typeof fields !== 'object' || Array.isArray(fields)) {
    fail(`${path} is a map of field name to type`, { code: 'io.shape', field: path });
  }
  const normalized = {};
  for (const [name, type] of Object.entries(fields)) {
    if (!isNonEmptyString(name)) fail(`${path} has an empty field name`, { code: 'io.shape', field: path });
    if (!ITEM_FIELD_TYPES.includes(type)) {
      fail(`field '${name}' declares type '${String(type)}': item fields are one of ${ITEM_FIELD_TYPES.join(', ')}`, { code: 'io.shape', field: `${path}.${name}` });
    }
    normalized[name] = type;
  }
  return Object.freeze(normalized);
}

export function isNodeIo(value) {
  return Boolean(value) && typeof value === 'object'
    && value.contract === IO_CONTRACT
    && isIdentity(value.identity)
    && Array.isArray(value.inputs)
    && isNonEmptyString(value.ioDigest);
}

const portKey = (port) => `${port.direction}:${port.name}`;

/**
 * Comparing two compilations of one node is how a version movement is described before it
 * happens. The answer names the changes, and a change is breaking when an existing caller
 * could notice it.
 */
export function compareNodeIo(before, after) {
  if (!isNodeIo(before) || !isNodeIo(after)) fail('compareNodeIo reads two compiled node I/O contracts', { code: 'io.input', field: 'contracts' });
  if (before.identity !== after.identity) {
    fail(`comparing '${before.identity}' with '${after.identity}' is comparing two nodes, not two versions of one`, { code: 'io.compare', field: 'identity' });
  }
  if (before.ioDigest === after.ioDigest) {
    return Object.freeze({ ok: true, verdict: 'identical', identity: before.identity, changes: Object.freeze([]), message: 'the wire contract is unchanged' });
  }
  const changes = [];
  const beforePorts = new Map([...before.inputs, ...before.outputs].map((port) => [portKey(port), port]));
  const afterPorts = new Map([...after.inputs, ...after.outputs].map((port) => [portKey(port), port]));

  for (const [key, port] of beforePorts) {
    if (!afterPorts.has(key)) {
      changes.push({ kind: 'port-removed', port: key, impact: 'breaking', detail: `the ${port.connectionType} ${port.direction} port '${port.name}' is gone: every wire into it dangles` });
    }
  }
  for (const [key, port] of afterPorts) {
    const previous = beforePorts.get(key);
    if (!previous) {
      changes.push({ kind: 'port-added', port: key, impact: 'additive', detail: `a ${port.connectionType} ${port.direction} port '${port.name}' is new` });
      continue;
    }
    if (previous.connectionType !== port.connectionType) {
      changes.push({ kind: 'connection-type-changed', port: key, impact: 'breaking', detail: `'${port.name}' was ${previous.connectionType} and is now ${port.connectionType}: existing wires are of the wrong kind` });
    }
    if (previous.arity !== port.arity) {
      const narrowed = previous.arity === 'many' && port.arity === 'single';
      changes.push({
        kind: narrowed ? 'arity-narrowed' : 'arity-widened',
        port: key,
        impact: narrowed ? 'breaking' : 'additive',
        detail: narrowed
          ? `'${port.name}' accepted many connections and now accepts one: a graph that used the second connection breaks`
          : `'${port.name}' now accepts more connections than before`,
      });
    }
    changes.push(...compareFields(previous, port, key, before.additionalProperties, after.additionalProperties));
  }
  if (before.trigger !== after.trigger) {
    changes.push({
      kind: 'trigger-changed',
      port: null,
      impact: 'breaking',
      detail: before.trigger ? 'this node no longer starts a workflow' : 'this node now claims to start a workflow',
    });
  }
  if (before.additionalProperties !== after.additionalProperties) {
    const closed = before.additionalProperties && !after.additionalProperties;
    changes.push({
      kind: 'shape-closed',
      port: null,
      impact: closed ? 'breaking' : 'additive',
      detail: closed
        ? 'item fields are now closed: anything a producer sent beyond the declared fields is no longer promised'
        : 'item fields are now open: more fields may arrive than were declared',
    });
  }
  const breaking = changes.filter((change) => change.impact === 'breaking');
  return Object.freeze({
    ok: true,
    verdict: breaking.length > 0 ? 'breaking' : (changes.length > 0 ? 'additive' : 'identical'),
    identity: before.identity,
    changes: Object.freeze(changes.map((change) => Object.freeze(change))),
    message: breaking.length > 0
      ? `${breaking.length} breaking change(s): ${breaking.map((change) => change.kind).join(', ')}`
      : `${changes.length} additive change(s)`,
  });
}

function compareFields(previous, port, key, beforeOpen, afterOpen) {
  const changes = [];
  for (const [name, type] of Object.entries(previous.fields)) {
    const now = port.fields[name];
    if (now === undefined) {
      changes.push({ kind: 'field-removed', port: key, field: name, impact: 'breaking', detail: `consumers read '${name}' from '${port.name}' and it is gone` });
    } else if (now !== type) {
      changes.push({ kind: 'field-type-changed', port: key, field: name, impact: 'breaking', detail: `'${name}' was ${type} and is now ${now}` });
    }
  }
  for (const [name, type] of Object.entries(port.fields)) {
    if (previous.fields[name] !== undefined) continue;
    // What matters is the shape the item must satisfy NOW: if it is closed, every producer
    // has to supply the new field; if it is open, a producer may simply not send it yet.
    const closed = !afterOpen;
    changes.push({
      kind: 'field-added',
      port: key,
      field: name,
      impact: closed ? 'breaking' : 'additive',
      detail: closed
        ? `'${name}' (${type}) was added to a CLOSED shape: every producer of this item now has to supply it`
        : `'${name}' (${type}) was added to an open shape`,
    });
  }
  return changes;
}

export function isIoDiff(value) {
  return Boolean(value) && typeof value === 'object' && IO_VERDICTS.includes(value.verdict) && Array.isArray(value.changes);
}

/** One readable line per change, because a compatibility report nobody reads is not a report. */
export function explainIoDiff(diff) {
  if (!isIoDiff(diff)) fail('explainIoDiff reads a diff made by compareNodeIo', { code: 'io.compare', field: 'diff' });
  if (diff.changes.length === 0) return `${diff.identity}: ${diff.message}`;
  return `${diff.identity}: ${diff.verdict.toUpperCase()} — ${diff.changes.map((change) => `${change.kind}${change.port ? ` ${change.port}` : ''}${change.field ? `.${change.field}` : ''}`).join(', ')}`;
}

/**
 * Moving a node between runtimes is not a deployment detail: it is a question about every
 * field on every port, answered per field. A payload stays out of a sandbox; it crosses as a
 * handle into the artifact store.
 */
export function planHandoff(io, { from, to } = {}) {
  if (!isNodeIo(io)) fail('planHandoff reads a compiled node I/O contract', { code: 'io.input', field: 'io' });
  for (const [field, locality] of [['from', from], ['to', to]]) {
    if (!NODE_RUNTIME_LOCALITIES.includes(locality)) {
      fail(`'${String(locality)}' is not a runtime locality the foundation publishes (${NODE_RUNTIME_LOCALITIES.join(', ')})`, { code: 'io.handoff', field });
    }
  }
  if (from === to) {
    return Object.freeze({ ok: true, same: true, from, to, transports: Object.freeze([]), refused: Object.freeze([]), message: `nothing crosses: both sides are '${from}'` });
  }
  const transports = [];
  const refused = [];
  for (const port of [...io.inputs, ...io.outputs]) {
    for (const [name, type] of Object.entries(port.fields)) {
      const base = FIELD_TRANSPORT[type] ?? 'refused';
      let kind = base;
      let note;
      if (type === 'binary') {
        // Never inline across a boundary: a payload is not pushed into another runtime. The
        // host resolves the handle on the far side, which is why the field survives where the
        // bytes would not. (One address space means no boundary to cross, and that case
        // returns above.)
        kind = 'reference';
        note = 'the payload does not cross: the field travels as a handle into the artifact store, and the host resolves it on the other side';
      } else if (type === 'date') {
        note = 'a date is an object, not a value: declared as a date it cannot be promised to arrive intact across a boundary';
      } else if (kind === 'refused') {
        note = `the compiler does not understand '${type}' and will not promise it arrives intact`;
      } else {
        note = 'travels inline: a JSON value is the same value on the other side';
      }
      const entry = Object.freeze({
        port: `${port.direction}:${port.name}`,
        connectionType: port.connectionType,
        field: name,
        type,
        kind,
        note,
      });
      transports.push(entry);
      if (kind === 'refused') refused.push(entry);
    }
  }
  if (refused.length > 0) {
    return Object.freeze({
      ok: false,
      reason: 'io.handoff',
      from,
      to,
      transports: Object.freeze(transports),
      refused: Object.freeze(refused),
      message: `${refused.length} field(s) cannot cross from '${from}' to '${to}': a value the compiler does not understand cannot be promised to arrive intact`,
    });
  }
  return Object.freeze({
    ok: true,
    same: false,
    from,
    to,
    transports: Object.freeze(transports),
    refused: Object.freeze([]),
    message: `${transports.length} field(s) cross from '${from}' to '${to}'`,
  });
}

/** The counts a review opens with: how many ports, of which kinds, and what a shape promises. */
export function describeNodeIo(io) {
  if (!isNodeIo(io)) fail('describeNodeIo reads a compiled node I/O contract', { code: 'io.input', field: 'io' });
  const all = [...io.inputs, ...io.outputs];
  const byType = {};
  for (const port of all) byType[port.connectionType] = (byType[port.connectionType] ?? 0) + 1;
  return Object.freeze({
    contract: IO_CONTRACT,
    identity: io.identity,
    trigger: io.trigger,
    ports: all.length,
    inputs: Object.freeze(io.inputs.map((port) => `${port.name} (${port.connectionType}${port.aliasedFrom ? `, aliased from ${port.aliasedFrom}` : ''})`)),
    outputs: Object.freeze(io.outputs.map((port) => `${port.name} (${port.connectionType}${port.aliasedFrom ? `, aliased from ${port.aliasedFrom}` : ''})`)),
    connectionTypes: Object.freeze(Object.keys(byType).sort()),
    fields: all.reduce((total, port) => total + Object.keys(port.fields).length, 0),
    binaryFields: all.flatMap((port) => Object.entries(port.fields).filter(([, type]) => type === 'binary').map(([name]) => `${port.direction}:${port.name}.${name}`)),
    shape: io.additionalProperties ? 'open' : 'closed',
    ioDigest: io.ioDigest,
  });
}

export function explainNodeIo(io) {
  const described = describeNodeIo(io);
  const kind = described.trigger ? 'trigger' : 'node';
  return `${described.identity}: ${kind} with ${described.ports} port(s) — ${described.inputs.length} in, ${described.outputs.length} out; ${described.fields} declared item field(s), shape ${described.shape}`;
}
