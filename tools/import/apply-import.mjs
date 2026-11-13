// Applies a validated task package to a working copy and reports what changed.
// Usage:
//   node tools/import/apply-import.mjs --zip imports/taskA1.zip [--repo .] [--bootstrap]
//        [--validate-only] [--summary summary.md] [--github-output $GITHUB_OUTPUT]
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateArchive } from './validate-zip.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function lineBag(text) {
  const bag = new Map();
  for (const l of text.split('\n')) bag.set(l, (bag.get(l) ?? 0) + 1);
  return bag;
}

function lineDelta(oldText, newText) {
  const a = lineBag(oldText);
  const b = lineBag(newText);
  let added = 0;
  let removed = 0;
  for (const [l, n] of b) added += Math.max(0, n - (a.get(l) ?? 0));
  for (const [l, n] of a) removed += Math.max(0, n - (b.get(l) ?? 0));
  return { added, removed };
}

/** Resolves a repo-relative path and refuses anything that escapes the root or crosses a symlink. */
export function safeTarget(repoRoot, rel) {
  const root = path.resolve(repoRoot);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`path escapes the repository: ${rel}`);
  let cur = root;
  for (const seg of path.relative(root, target).split(path.sep)) {
    cur = path.join(cur, seg);
    let st = null;
    try { st = fs.lstatSync(cur); } catch { break; }
    if (st.isSymbolicLink()) throw new Error(`symbolic link in target path: ${rel}`);
  }
  return target;
}

export function formatSummary(result) {
  const lines = [];
  lines.push(`## Import ${result.manifest?.taskId ?? '?'}: ${result.manifest?.title ?? ''}`);
  lines.push('');
  if (!result.ok) {
    lines.push('**Rejected.** Nothing was changed.', '');
    for (const e of result.errors) lines.push(`- \`${e.code}\`${e.path ? ` (${e.path})` : ''}: ${e.message}`);
    return lines.join('\n') + '\n';
  }
  const c = result.changes ?? [];
  const count = (s) => c.filter((x) => x.status === s).length;
  lines.push(`Added ${count('added')}, modified ${count('modified')}, unchanged ${count('unchanged')}, deleted ${count('deleted')}.`);
  lines.push('Line counts are approximate; the pull request diff is exact.', '');
  lines.push('| Status | Path | Bytes | +lines | -lines |', '|---|---|---|---|---|');
  for (const x of c) lines.push(`| ${x.status} | ${x.path} | ${x.size ?? ''} | ${x.added ?? ''} | ${x.removed ?? ''} |`);
  if (result.warnings.length) {
    lines.push('', '### Review points');
    for (const w of result.warnings) lines.push(`- \`${w.code}\` (${w.path}): ${w.message}`);
  }
  return lines.join('\n') + '\n';
}

export function applyImport({ zipPath, repoRoot, bootstrap = false, validateOnly = false, config }) {
  const buf = fs.readFileSync(zipPath);
  const statePath = path.join(repoRoot, 'tasks', 'state.json');
  const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : null;
  const res = validateArchive(buf, { config, state, bootstrap });
  const result = { ok: res.ok, errors: res.errors, warnings: res.warnings, manifest: res.manifest, changes: [], applied: false };
  if (!res.ok) return result;

  // plan: resolve every target before writing anything
  const plan = [];
  try {
    for (const f of res.files) {
      const target = safeTarget(repoRoot, f.path);
      const exists = fs.existsSync(target);
      if (exists && fs.statSync(target).isDirectory()) throw new Error(`target is a directory: ${f.path}`);
      const old = exists ? fs.readFileSync(target) : null;
      const same = old !== null && old.equals(f.data);
      const delta = old === null ? { added: f.data.toString('utf8').split('\n').length, removed: 0 } : lineDelta(old.toString('utf8'), f.data.toString('utf8'));
      plan.push({ kind: 'write', path: f.path, target, data: f.data, status: old === null ? 'added' : same ? 'unchanged' : 'modified', size: f.data.length, ...delta });
    }
    for (const d of res.manifest.deletes ?? []) {
      const target = safeTarget(repoRoot, d);
      if (fs.existsSync(target)) plan.push({ kind: 'delete', path: d, target, status: 'deleted', size: fs.statSync(target).size, added: 0, removed: fs.readFileSync(target, 'utf8').split('\n').length });
    }
  } catch (e) {
    result.ok = false;
    result.errors.push({ code: 'unsafe-target', message: e.message });
    return result;
  }
  result.changes = plan.map(({ kind, target, data, ...rest }) => rest).sort((a, b) => a.path.localeCompare(b.path));
  if (validateOnly) return result;

  for (const step of plan) {
    if (step.kind === 'write') {
      if (step.status === 'unchanged') continue;
      fs.mkdirSync(path.dirname(step.target), { recursive: true });
      fs.writeFileSync(step.target, step.data, { mode: 0o644 });
    } else {
      fs.rmSync(step.target);
    }
  }
  const next = state ?? { schema: 1, completed: [], imports: [] };
  next.completed.push(res.manifest.taskId);
  next.imports.push({ taskId: res.manifest.taskId, title: res.manifest.title, zipSha256: crypto.createHash('sha256').update(buf).digest('hex') });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2) + '\n');
  result.applied = true;
  return result;
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const zipPath = arg(argv, '--zip');
  if (!zipPath) { console.error('usage: apply-import.mjs --zip <file> [--repo <dir>] [--bootstrap] [--validate-only] [--summary <file>] [--github-output <file>]'); process.exit(2); }
  const repoRoot = path.resolve(arg(argv, '--repo') ?? '.');
  const config = JSON.parse(fs.readFileSync(path.join(HERE, 'config.json'), 'utf8'));
  const result = applyImport({ zipPath, repoRoot, bootstrap: argv.includes('--bootstrap'), validateOnly: argv.includes('--validate-only'), config });
  const summary = formatSummary(result);
  console.log(summary);
  const summaryPath = arg(argv, '--summary');
  if (summaryPath) fs.writeFileSync(summaryPath, summary);
  const ghOut = arg(argv, '--github-output');
  if (ghOut && result.ok) fs.appendFileSync(ghOut, `task_id=${result.manifest.taskId}\ntitle=${result.manifest.title}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
