// Validates a task package (ZIP) before anything touches the repository.
// Design document section 5.13 and the approved review decision 5.
import crypto from 'node:crypto';
import { readZip, extractEntry, findOverlaps } from './zip-reader.mjs';
import { scanForSecrets } from './secret-scan.mjs';

const TASK_ID = /^[A-Z][0-9]{1,2}(?:\.[0-9]{1,2})?$/;
const TITLE = /^[A-Za-z0-9 .,:()_\-]{1,100}$/;
const SAFE_NAME = /^[A-Za-z0-9._\-/]+$/;
const MANIFEST_KEYS = new Set(['schema', 'taskId', 'title', 'requires', 'allowedPrefixes', 'files', 'deletes']);

export function checkEntryName(name) {
  if (name.length === 0) return 'empty path';
  if (name.length > 200) return 'path is longer than 200 characters';
  if (name.includes('\0')) return 'path contains a NUL byte';
  if (name.includes('\\')) return 'path contains a backslash';
  if (name.startsWith('/')) return 'absolute path';
  if (!SAFE_NAME.test(name)) return 'path contains characters outside A-Z a-z 0-9 . _ - /';
  const bare = name.endsWith('/') ? name.slice(0, -1) : name;
  for (const seg of bare.split('/')) {
    if (seg === '') return 'path contains an empty segment';
    if (seg === '.' || seg === '..') return `path contains a '${seg}' segment`;
  }
  return null;
}

const covered = (prefixes, p) => prefixes.some((x) => (x.endsWith('/') ? p.startsWith(x) : p === x));
const globallyAllowed = (config, p) => config.globalAllowedFiles.includes(p) || config.globalAllowedPrefixes.some((x) => p.startsWith(x));
const isProtected = (config, p) => config.protectedFiles.includes(p) || config.protectedPrefixes.some((x) => p.startsWith(x));

/**
 * @param {Buffer} buf archive bytes
 * @param {{config:object, state?:{completed:string[]}|null, bootstrap?:boolean}} opts
 */
export function validateArchive(buf, { config, state = null, bootstrap = false }) {
  const errors = [];
  const warnings = [];
  const files = [];
  let manifest = null;
  const err = (code, message, path) => errors.push(path ? { code, message, path } : { code, message });
  const done = () => ({ ok: errors.length === 0, errors, warnings, manifest, files });

  if (buf.length > config.maxArchiveBytes) { err('archive-too-large', `archive is ${buf.length} bytes (limit ${config.maxArchiveBytes})`); return done(); }

  let zip;
  try { zip = readZip(buf); } catch (e) { err(e.code ?? 'zip-structure', e.message); return done(); }
  if (zip.entries.length > config.maxFiles) { err('too-many-files', `archive has ${zip.entries.length} entries (limit ${config.maxFiles})`); return done(); }
  try {
    for (const name of findOverlaps(buf, zip.entries)) err('overlapping-entries', 'entry data overlaps another entry', name);
  } catch (e) { err(e.code ?? 'zip-structure', e.message); return done(); }

  // ---- entry-level checks
  const seen = new Set();
  const lowerSeen = new Map();
  const fileEntries = [];
  let expanded = 0;
  for (const e of zip.entries) {
    const problem = checkEntryName(e.name);
    if (problem) { err('bad-path', problem, e.name); continue; }
    const bare = e.isDirectory ? e.name.slice(0, -1) : e.name;
    if (seen.has(e.name)) err('duplicate-path', 'duplicate entry', e.name);
    seen.add(e.name);
    const lower = bare.toLowerCase();
    if (lowerSeen.has(lower) && lowerSeen.get(lower) !== bare) err('case-collision', `collides with '${lowerSeen.get(lower)}' on case-insensitive file systems`, e.name);
    lowerSeen.set(lower, bare);
    if (e.encrypted) err('encrypted', 'encrypted entries are not allowed', e.name);
    if (e.method !== 0 && e.method !== 8) err('compression-method', `unsupported compression method ${e.method}`, e.name);
    if (e.hostOS === 3 && e.unixMode) {
      const type = e.unixMode & 0o170000;
      if (type === 0o120000) err('symlink', 'symbolic links are not allowed', e.name);
      else if (type !== 0o100000 && type !== 0o040000) err('special-file', 'device, socket and FIFO entries are not allowed', e.name);
    }
    if (e.isDirectory) {
      if (e.uncompressedSize !== 0) err('dir-with-data', 'directory entry carries data', e.name);
      continue;
    }
    if (e.uncompressedSize > config.maxFileBytes) err('file-too-large', `${e.uncompressedSize} bytes (limit ${config.maxFileBytes})`, e.name);
    expanded += e.uncompressedSize;
    if (e.compressedSize === 0 ? e.uncompressedSize > 0 : e.uncompressedSize / e.compressedSize > config.maxCompressionRatio) {
      err('compression-ratio', `compression ratio exceeds ${config.maxCompressionRatio}:1`, e.name);
    }
    fileEntries.push(e);
  }
  if (expanded > config.maxExpandedBytes) err('expanded-too-large', `expanded size ${expanded} bytes (limit ${config.maxExpandedBytes})`);

  // ---- manifest
  const manifestEntries = fileEntries.filter((e) => e.name === 'TASK.json');
  if (manifestEntries.length !== 1) { err('manifest-missing', 'the archive must contain exactly one TASK.json at its root'); return done(); }
  try {
    manifest = JSON.parse(extractEntry(buf, manifestEntries[0], config.maxFileBytes).toString('utf8'));
  } catch (e) { err('manifest-invalid', `TASK.json cannot be read: ${e.message}`); return done(); }

  const bad = (m) => err('manifest-invalid', m);
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) { bad('TASK.json must be an object'); return done(); }
  for (const k of Object.keys(manifest)) if (!MANIFEST_KEYS.has(k)) bad(`unknown key '${k}'`);
  if (manifest.schema !== 1) bad('schema must be 1');
  if (typeof manifest.taskId !== 'string' || !TASK_ID.test(manifest.taskId)) bad('taskId is missing or malformed');
  if (typeof manifest.title !== 'string' || !TITLE.test(manifest.title)) bad('title is missing or contains characters outside A-Z a-z 0-9 . , : ( ) _ - and space');
  if (manifest.requires !== null && !(typeof manifest.requires === 'string' && TASK_ID.test(manifest.requires))) bad('requires must be null or a task id');
  if (!Array.isArray(manifest.allowedPrefixes) || manifest.allowedPrefixes.length === 0 || !manifest.allowedPrefixes.every((x) => typeof x === 'string' && x.length > 0)) bad('allowedPrefixes must be a non-empty array of strings');
  if (!Array.isArray(manifest.files) || !manifest.files.every((f) => f && typeof f.path === 'string' && Number.isInteger(f.size) && f.size >= 0 && typeof f.sha256 === 'string' && /^[0-9a-f]{64}$/.test(f.sha256))) bad('files must be an array of {path, size, sha256}');
  if (manifest.deletes !== undefined && !(Array.isArray(manifest.deletes) && manifest.deletes.every((x) => typeof x === 'string'))) bad('deletes must be an array of strings');
  if (errors.some((x) => x.code === 'manifest-invalid')) return done();

  for (const pre of manifest.allowedPrefixes) {
    const ok = pre.endsWith('/') ? config.globalAllowedPrefixes.some((g) => pre.startsWith(g)) : globallyAllowed(config, pre);
    if (!ok) err('manifest-widens-allowlist', `allowedPrefixes entry '${pre}' is outside the global allowlist`);
    if (checkEntryName(pre)) err('manifest-invalid', `allowedPrefixes entry '${pre}' is not a safe path`);
  }

  // ---- state and ordering
  const completed = state?.completed ?? [];
  if (bootstrap) {
    if (state !== null) err('bootstrap-not-allowed', 'bootstrap import is allowed only when tasks/state.json does not exist');
    if (manifest.taskId !== 'A1' || manifest.requires !== null) err('bootstrap-not-allowed', 'bootstrap import is only for task A1');
  }
  if (manifest.requires !== null && !completed.includes(manifest.requires)) err('requires-not-completed', `task ${manifest.taskId} requires ${manifest.requires}, which has not been imported`);
  if (completed.includes(manifest.taskId)) err('already-imported', `task ${manifest.taskId} has already been imported`);

  const pathProblem = (p) => {
    if (checkEntryName(p)) return checkEntryName(p);
    if (!globallyAllowed(config, p)) return 'outside the global allowlist';
    if (isProtected(config, p) && !(bootstrap && p !== 'tasks/state.json')) return 'protected path (cannot be changed by an import)';
    if (!covered(manifest.allowedPrefixes, p)) return 'outside the prefixes declared by this task';
    return null;
  };

  // ---- file-level checks
  const listed = new Map();
  for (const f of manifest.files) {
    if (listed.has(f.path)) err('manifest-invalid', 'path listed twice in TASK.json', f.path);
    listed.set(f.path, f);
  }
  const present = new Set(fileEntries.map((e) => e.name));
  for (const p of listed.keys()) if (!present.has(p)) err('manifest-file-missing', 'listed in TASK.json but absent from the archive', p);

  for (const e of fileEntries) {
    if (e.name === 'TASK.json') continue;
    const p = e.name;
    if (!config.globalAllowedFiles.includes(p)) {
      const dot = p.lastIndexOf('.');
      const ext = dot > p.lastIndexOf('/') ? p.slice(dot).toLowerCase() : '';
      if (!config.allowedExtensions.includes(ext)) err('extension-not-allowed', `extension '${ext}' is not allowed`, p);
    }
    const problem = pathProblem(p);
    if (problem) err(problem.startsWith('protected') ? 'protected-path' : problem.startsWith('outside the global') ? 'outside-allowlist' : problem.startsWith('outside the prefixes') ? 'outside-task-scope' : 'bad-path', problem, p);
    const entry = listed.get(p);
    if (!entry) { err('not-in-manifest', 'present in the archive but not listed in TASK.json', p); continue; }
    let data;
    try { data = extractEntry(buf, e, config.maxFileBytes); } catch (x) { err(x.code ?? 'extract', x.message, p); continue; }
    if (data.length !== entry.size) err('size-mismatch', `manifest says ${entry.size} bytes, archive has ${data.length}`, p);
    if (crypto.createHash('sha256').update(data).digest('hex') !== entry.sha256) err('hash-mismatch', 'SHA-256 does not match TASK.json', p);
    const text = data.toString('utf8');
    for (const s of scanForSecrets(p, text)) err('secret-detected', `possible secret (${s.rule}${s.line ? ` at line ${s.line}` : ''})`, p);
    if (p === 'package.json') {
      try {
        const pkg = JSON.parse(text);
        for (const k of Object.keys(pkg.scripts ?? {})) if (config.forbiddenLifecycleScripts.includes(k)) err('lifecycle-script', `package.json script '${k}' runs automatically on install and is not allowed`, p);
        if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) warnings.push({ code: 'runtime-dependency', message: 'package.json declares runtime dependencies (the design requires zero); review carefully', path: p });
        if (pkg.devDependencies) warnings.push({ code: 'dev-dependencies', message: `package.json declares devDependencies: ${Object.keys(pkg.devDependencies).join(', ')}`, path: p });
      } catch { err('manifest-invalid', 'package.json is not valid JSON', p); }
    }
    if (p === '.github/workflows/ci.yml') warnings.push({ code: 'workflow-change', message: 'CI workflow is changed by this package; review the diff', path: p });
    files.push({ path: p, data });
  }

  for (const d of manifest.deletes ?? []) {
    const problem = pathProblem(d);
    if (problem) err('bad-delete', `delete target rejected: ${problem}`, d);
  }

  return done();
}
