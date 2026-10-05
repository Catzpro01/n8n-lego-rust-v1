/**
 * Storage for n8n lego.
 *
 * Two backends behind one interface: `file` (default, atomic JSON writes in the
 * data directory — survives restarts, good enough for a single instance on a
 * small VPS) and `memory` (throwaway runs and tests).
 *
 * Collections are deliberately generic: workflows, executions, users, tags and
 * variables all use the same `Collection` so nothing here knows about n8n
 * semantics.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** 16-char id, same shape as n8n workflow / execution ids. */
export function newId(length = 16) {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

export function newExecutionId() {
  return String(nextExecutionCounter());
}

let executionCounter = 0;
function nextExecutionCounter() {
  executionCounter += 1;
  return executionCounter;
}

/** Keeps generated execution ids unique even after a restart. */
export function seedExecutionCounter(value) {
  if (Number.isInteger(value) && value > executionCounter) executionCounter = value;
}

export class Collection {
  /**
   * @param {string} file absolute path (or `:memory:` for the memory backend)
   * @param {{ idKey?: string, readOnly?: boolean }} [options]
   */
  constructor(file, options = {}) {
    this.file = file;
    this.idKey = options.idKey ?? 'id';
    this.readOnly = options.readOnly ?? false;
    this.docs = [];
    this.load();
  }

  load() {
    if (this.file === ':memory:' || !existsSync(this.file)) {
      this.docs = [];
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'));
      this.docs = Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      throw new Error(`cannot read ${this.file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  persist() {
    if (this.readOnly || this.file === ':memory:') return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.docs, null, 2)}\n`);
    renameSync(tmp, this.file);
  }

  all() {
    return this.docs;
  }

  count() {
    return this.docs.length;
  }

  find(predicate) {
    return this.docs.find(predicate) ?? null;
  }

  filter(predicate) {
    return this.docs.filter(predicate);
  }

  get(id) {
    return this.find((doc) => doc[this.idKey] === id);
  }

  insert(doc) {
    const id = doc[this.idKey] ?? newId();
    const stored = { ...doc, [this.idKey]: id };
    this.docs.push(stored);
    this.persist();
    return stored;
  }

  update(id, patch) {
    const index = this.docs.findIndex((doc) => doc[this.idKey] === id);
    if (index === -1) return null;
    const next = typeof patch === 'function' ? patch(this.docs[index]) : { ...this.docs[index], ...patch };
    if (next === null) return null;
    this.docs[index] = next;
    this.persist();
    return next;
  }

  remove(id) {
    const index = this.docs.findIndex((doc) => doc[this.idKey] === id);
    if (index === -1) return false;
    this.docs.splice(index, 1);
    this.persist();
    return true;
  }

  replaceAll(docs) {
    this.docs = docs;
    this.persist();
  }
}

export function createStore(config) {
  const memory = config.storage === 'memory';
  const path = (name) => (memory ? ':memory:' : join(config.dataDir, `${name}.json`));
  return {
    kind: memory ? 'memory' : 'file',
    workflows: new Collection(path('workflows')),
    executions: new Collection(path('executions')),
    users: new Collection(path('users')),
    tags: new Collection(path('tags')),
    variables: new Collection(path('variables')),
    credentials: new Collection(path('credentials')),
  };
}
