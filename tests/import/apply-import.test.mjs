import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyImport, formatSummary, safeTarget } from '../../tools/import/apply-import.mjs';
import { pkg, config, codes } from '../helpers/zips.mjs';

const tmp = (p = 'ia-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
const put = (buf) => { const f = path.join(tmp('ia-zip-'), 'p.zip'); fs.writeFileSync(f, buf); return f; };
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const A1 = { manifest: { taskId: 'A1', requires: null } };

function bootstrapRepo() {
  const root = tmp();
  const res = applyImport({ zipPath: put(pkg({ 'src/core/a.js': 'export const a = 1;\n', 'tools/import/x.mjs': 'export {};\n' }, A1)), repoRoot: root, bootstrap: true, config: config() });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  return root;
}

test('bootstrap import writes files and tasks/state.json', () => {
  const root = bootstrapRepo();
  assert.equal(read(root, 'src/core/a.js'), 'export const a = 1;\n');
  const state = JSON.parse(read(root, 'tasks/state.json'));
  assert.deepEqual(state.completed, ['A1']);
  assert.match(state.imports[0].zipSha256, /^[0-9a-f]{64}$/);
});

test('importing the same task twice is rejected and changes nothing', () => {
  const root = bootstrapRepo();
  const again = applyImport({ zipPath: put(pkg({ 'src/core/a.js': 'export const a = 2;\n' }, A1)), repoRoot: root, config: config() });
  assert.equal(again.ok, false);
  assert.ok(codes(again).includes('already-imported'));
  assert.equal(read(root, 'src/core/a.js'), 'export const a = 1;\n');
});

test('validate-only reports the plan without writing', () => {
  const root = bootstrapRepo();
  const res = applyImport({ zipPath: put(pkg({ 'src/core/a.js': 'export const a = 2;\n', 'src/core/b.js': 'export const b = 1;\n' })), repoRoot: root, validateOnly: true, config: config() });
  assert.equal(res.ok, true);
  assert.deepEqual(res.changes.map((c) => [c.path, c.status]), [['src/core/a.js', 'modified'], ['src/core/b.js', 'added']]);
  assert.equal(res.applied, false);
  assert.equal(read(root, 'src/core/a.js'), 'export const a = 1;\n');
  assert.equal(fs.existsSync(path.join(root, 'src/core/b.js')), false);
});

test('a later task modifies, adds, deletes and records itself', () => {
  const root = bootstrapRepo();
  fs.writeFileSync(path.join(root, 'src/core/old.js'), 'export const old = 1;\n');
  const res = applyImport({
    zipPath: put(pkg({ 'src/core/a.js': 'export const a = 2;\nexport const c = 3;\n', 'src/core/new.js': 'export const n = 1;\n' }, { manifest: { deletes: ['src/core/old.js'], allowedPrefixes: ['src/core/a.js', 'src/core/new.js', 'src/core/old.js'] } })),
    repoRoot: root, config: config(),
  });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.equal(read(root, 'src/core/a.js'), 'export const a = 2;\nexport const c = 3;\n');
  assert.equal(fs.existsSync(path.join(root, 'src/core/old.js')), false);
  assert.deepEqual(JSON.parse(read(root, 'tasks/state.json')).completed, ['A1', 'A2']);
  const modified = res.changes.find((c) => c.path === 'src/core/a.js');
  assert.equal(modified.status, 'modified');
  assert.ok(modified.added >= 1);
  assert.match(formatSummary(res), /Added 1, modified 1, unchanged 0, deleted 1/);
});

test('a symlinked directory in the working copy blocks the import before anything is written', () => {
  const root = bootstrapRepo();
  const outside = tmp('ia-outside-');
  fs.rmSync(path.join(root, 'docs'), { recursive: true, force: true });
  fs.symlinkSync(outside, path.join(root, 'docs'));
  const res = applyImport({ zipPath: put(pkg({ 'src/core/z.js': 'export const z = 1;\n', 'docs/x.md': '# x\n' })), repoRoot: root, config: config() });
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('unsafe-target'));
  assert.equal(fs.existsSync(path.join(root, 'src/core/z.js')), false);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.deepEqual(JSON.parse(read(root, 'tasks/state.json')).completed, ['A1']);
});

test('safeTarget refuses escapes and symlinks', () => {
  const root = tmp();
  assert.throws(() => safeTarget(root, '../x.js'), /escapes/);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'link'));
  assert.throws(() => safeTarget(root, 'link/x.js'), /symbolic link/);
  assert.equal(safeTarget(root, 'src/a.js'), path.join(root, 'src/a.js'));
});

test('rejected packages produce a clear summary and leave the repository untouched', () => {
  const root = bootstrapRepo();
  const res = applyImport({ zipPath: put(pkg({ 'secret/x.js': 'x\n' })), repoRoot: root, config: config() });
  assert.equal(res.ok, false);
  assert.match(formatSummary(res), /Rejected\.\*\* Nothing was changed\./);
  assert.equal(fs.existsSync(path.join(root, 'secret')), false);
});

test('the command line tool exits 0 for valid and 1 for invalid packages and writes outputs', () => {
  const root = bootstrapRepo();
  const out = path.join(tmp(), 'gh-output');
  const summary = path.join(tmp(), 'summary.md');
  const script = new URL('../../tools/import/apply-import.mjs', import.meta.url).pathname;
  const good = spawnSync('node', [script, '--zip', put(pkg({ 'src/core/b.js': 'export const b = 1;\n' })), '--repo', root, '--github-output', out, '--summary', summary], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.match(fs.readFileSync(out, 'utf8'), /task_id=A2\ntitle=Test task\n/);
  assert.match(fs.readFileSync(summary, 'utf8'), /Import A2/);
  const bad = spawnSync('node', [script, '--zip', put(pkg({ 'secret/x.js': 'x\n' }, { manifest: { taskId: 'A3', requires: 'A2' } })), '--repo', root], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  const usage = spawnSync('node', [script], { encoding: 'utf8' });
  assert.equal(usage.status, 2);
});
