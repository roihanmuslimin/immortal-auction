import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { validateArchive } from '../../tools/import/validate-zip.mjs';
import { writeZip } from '../../tools/import/zip-writer.mjs';
import { config, sha, STATE } from '../helpers/zips.mjs';

const have = (cmd) => spawnSync(cmd, ['-h'], { encoding: 'utf8' }).error === undefined;

test('a ZIP created by the system zip tool is read and validated', { skip: !have('zip') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-interop-'));
  const files = { 'src/core/a.js': 'export const a = 1;\n', 'docs/readme.md': '# hi\n'.repeat(50) };
  for (const [p, c] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), c); }
  const manifest = { schema: 1, taskId: 'A2', title: 'Interop', requires: 'A1', allowedPrefixes: Object.keys(files), files: Object.entries(files).map(([p, c]) => ({ path: p, size: Buffer.byteLength(c), sha256: sha(Buffer.from(c)) })) };
  fs.writeFileSync(path.join(dir, 'TASK.json'), JSON.stringify(manifest));
  const out = path.join(dir, 'out.zip');
  const r = spawnSync('zip', ['-X', '-q', '-r', out, 'TASK.json', 'src', 'docs'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const res = validateArchive(fs.readFileSync(out), { config: config(), state: STATE });
  assert.deepEqual(res.errors, []);
  assert.equal(res.files.length, 2);
});

test('a ZIP written by our writer passes the system unzip integrity test', { skip: !have('unzip') }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-interop-'));
  const out = path.join(dir, 'w.zip');
  fs.writeFileSync(out, writeZip([{ name: 'a/b.txt', data: 'hello hello hello hello\n' }, { name: 'c.txt', data: 'stored', method: 'store' }, { name: 'd/', dir: true }]));
  const r = spawnSync('unzip', ['-t', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /No errors detected/);
});
