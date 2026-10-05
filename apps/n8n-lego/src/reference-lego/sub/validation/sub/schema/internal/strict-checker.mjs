/**
 * `reference.validation.schema` — PRIVATE IMPLEMENTATION A ("strict").
 *
 * INTERNAL. Hand-written checks. Interchangeable with implementation B
 * (`table-checker.mjs`): both are reachable only through the public contract,
 * so neither can be named by a consumer.
 */

export function createStrictChecker() {
  return {
    check(value) {
      const issues = [];
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ path: '', reason: 'must be an object' }] };
      }
      if (typeof value.name !== 'string') issues.push({ path: 'name', reason: 'must be a string' });
      if (value.version !== undefined && typeof value.version !== 'number') {
        issues.push({ path: 'version', reason: 'must be a number' });
      }
      return { issues };
    },
  };
}
