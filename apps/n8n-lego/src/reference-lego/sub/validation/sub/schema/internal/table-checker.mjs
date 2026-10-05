/**
 * `reference.validation.schema` — PRIVATE IMPLEMENTATION B ("table").
 *
 * INTERNAL. A completely different internal design from implementation A — a
 * rule table instead of hand-written branches, different data structures,
 * different control flow — producing behaviour indistinguishable through the
 * public contract.
 *
 * That is the whole point of the replacement proof: the consumer cannot tell A
 * from B, so the implementation is genuinely replaceable. When Rust eventually
 * arrives it is the same move, just across a language boundary.
 */

const RULES = Object.freeze([
  { path: 'name', required: true, type: 'string' },
  { path: 'version', required: false, type: 'number' },
]);

export function createTableChecker() {
  return {
    check(value) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ path: '', reason: 'must be an object' }] };
      }
      const issues = RULES.flatMap((rule) => {
        const actual = value[rule.path];
        if (actual === undefined) {
          return rule.required ? [{ path: rule.path, reason: `must be a ${rule.type}` }] : [];
        }
        // eslint-disable-next-line valid-typeof
        return typeof actual === rule.type ? [] : [{ path: rule.path, reason: `must be a ${rule.type}` }];
      });
      return { issues };
    },
  };
}
