/**
 * Workflow checksum — same contract as `n8n-workflow`'s
 * `packages/workflow/src/workflow-checksum.ts`.
 *
 * The editor refuses to consider a save successful unless the response carries a
 * `checksum` (`if (!updatedWorkflow.checksum) throw new Error('Failed to update
 * workflow')`), and it sends the value back as `expectedChecksum` on the next
 * save so the server can detect a stale write. We therefore reproduce the exact
 * hash: SHA-256 over a key-sorted JSON encoding of the content fields only —
 * `id`, `versionId`, timestamps and `staticData` are deliberately excluded.
 */
import { createHash } from 'node:crypto';

const CHECKSUM_FIELDS = [
  'name',
  'description',
  'nodes',
  'connections',
  'settings',
  'meta',
  'pinData',
  'isArchived',
  'activeVersionId',
];

/** Recursively sorts object keys; arrays keep their order but are normalized too. */
function sortObjectKeys(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  const sorted = {};
  for (const key of Object.keys(value).sort()) sorted[key] = sortObjectKeys(value[key]);
  return sorted;
}

export function calculateWorkflowChecksum(workflow) {
  const payload = {};
  for (const field of CHECKSUM_FIELDS) {
    const value = workflow[field];
    if (value !== undefined) payload[field] = value;
  }
  const serialized = JSON.stringify(sortObjectKeys(payload));
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
