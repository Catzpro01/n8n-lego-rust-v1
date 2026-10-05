/**
 * Reference sub-LEGO `reference.validation` — PRIVATE IMPLEMENTATION.
 *
 * INTERNAL: only `../contract/index.mjs` may import this. A sibling sub-LEGO
 * reaching in here (`A.sub -> B.sub internal`) is exactly the nested violation
 * the P2.7 gate fixtures plant and require to be caught.
 */

export function applyRules(value, { strict = false } = {}) {
  const issues = [];
  if (value && typeof value === 'object' && typeof value.name === 'string' && value.name.trim() === '') {
    issues.push({ path: 'name', reason: 'must not be blank' });
  }
  if (strict && value && typeof value === 'object' && value.description === undefined) {
    issues.push({ path: 'description', reason: 'required in strict mode' });
  }
  return issues;
}
