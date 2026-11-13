import crypto from 'node:crypto';
import fs from 'node:fs';
import { writeZip } from '../../tools/import/zip-writer.mjs';

export const sha = (d) => crypto.createHash('sha256').update(d).digest('hex');
export const config = (over = {}) => ({
  ...JSON.parse(fs.readFileSync(new URL('../../tools/import/config.json', import.meta.url), 'utf8')),
  ...over,
});
export const codes = (res) => res.errors.map((e) => e.code);

/**
 * Builds a task package. files: { path: content }.
 * opts.manifest: field overrides (undefined removes a field); opts.entry: per-path zip entry overrides;
 * opts.extra: extra zip entries that are not in the manifest; opts.noManifest: omit TASK.json.
 */
export function pkg(files, opts = {}) {
  const paths = Object.keys(files);
  const manifest = {
    schema: 1, taskId: 'A2', title: 'Test task', requires: 'A1', allowedPrefixes: paths,
    files: paths.map((p) => ({ path: p, size: Buffer.byteLength(files[p]), sha256: sha(Buffer.from(files[p])) })),
    ...(opts.manifest ?? {}),
  };
  for (const k of Object.keys(manifest)) if (manifest[k] === undefined) delete manifest[k];
  const entries = paths.map((p) => ({ name: p, data: files[p], ...(opts.entry?.[p] ?? {}) }));
  if (!opts.noManifest) entries.unshift({ name: 'TASK.json', data: JSON.stringify(manifest) });
  entries.push(...(opts.extra ?? []));
  return writeZip(entries);
}

export const STATE = { completed: ['A1'] };
