// Builds a task package (ZIP + TASK.json) from files in this repository and validates it with the import validator.
// Usage: node tools/package-task.mjs --task A1 --title "Scaffold" [--requires A0] --out imports/taskA1.zip <path> [<path> ...]
// Paths may be files or directories (relative to the repository root).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeZip } from './import/zip-writer.mjs';
import { validateArchive } from './import/validate-zip.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP = new Set(['node_modules', 'dist', '.git', 'imports']);

function collect(rel, out) {
  const full = path.join(ROOT, rel);
  const st = fs.lstatSync(full);
  if (st.isSymbolicLink()) throw new Error(`refusing to package a symbolic link: ${rel}`);
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(full).sort()) {
      if (SKIP.has(name)) continue;
      collect(path.posix.join(rel.replace(/\/$/, ''), name), out);
    }
  } else out.push(rel);
}

export function buildPackage({ taskId, title, requires = null, paths, bootstrap = false, root = ROOT }) {
  const rels = [];
  for (const p of paths) collect(p.replace(/\\/g, '/'), rels);
  rels.sort();
  const entries = [];
  const files = [];
  for (const rel of rels) {
    const data = fs.readFileSync(path.join(root, rel));
    files.push({ path: rel, size: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') });
    entries.push({ name: rel, data, mode: 0o100644 });
  }
  const manifest = { schema: 1, taskId, title, requires, allowedPrefixes: rels, files };
  entries.unshift({ name: 'TASK.json', data: JSON.stringify(manifest, null, 2) + '\n', mode: 0o100644 });
  const zip = writeZip(entries);
  const config = JSON.parse(fs.readFileSync(path.join(root, 'tools/import/config.json'), 'utf8'));
  const check = validateArchive(zip, { config, state: bootstrap ? null : { completed: requires ? [requires] : [] }, bootstrap });
  return { zip, manifest, check };
}

function arg(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

function main(argv) {
  const taskId = arg(argv, '--task');
  const title = arg(argv, '--title');
  const requires = arg(argv, '--requires') ?? null;
  const out = arg(argv, '--out');
  const flagged = new Set(['--task', '--title', '--requires', '--out']);
  const paths = [];
  for (let i = 0; i < argv.length; i++) {
    if (flagged.has(argv[i])) { i++; continue; }
    if (argv[i] === '--bootstrap') continue;
    paths.push(argv[i]);
  }
  if (!taskId || !title || !out || paths.length === 0) { console.error('usage: package-task.mjs --task A1 --title "..." [--requires A0] [--bootstrap] --out imports/taskA1.zip <path>...'); process.exit(2); }
  const { zip, manifest, check } = buildPackage({ taskId, title, requires, paths, bootstrap: argv.includes('--bootstrap') });
  if (!check.ok) {
    for (const e of check.errors) console.error(`${e.code}${e.path ? ` (${e.path})` : ''}: ${e.message}`);
    console.error('package is invalid; nothing written');
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(ROOT, out)), { recursive: true });
  fs.writeFileSync(path.resolve(ROOT, out), zip);
  console.log(`wrote ${out}: ${manifest.files.length} file(s), ${zip.length} bytes, sha256 ${crypto.createHash('sha256').update(zip).digest('hex')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
