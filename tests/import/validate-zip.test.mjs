import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { validateArchive, checkEntryName } from '../../tools/import/validate-zip.mjs';
import { scanForSecrets } from '../../tools/import/secret-scan.mjs';
import { writeZip } from '../../tools/import/zip-writer.mjs';
import { pkg, config, codes, STATE } from '../helpers/zips.mjs';

const ok = { 'src/core/a.js': 'export const a = 1;\n', 'docs/x.md': '# x\n' };
const run = (buf, over = {}, extra = {}) => validateArchive(buf, { config: config(over), state: STATE, ...extra });

test('a well-formed package validates and returns its files', () => {
  const res = run(pkg(ok));
  assert.deepEqual(res.errors, []);
  assert.equal(res.ok, true);
  assert.deepEqual(res.files.map((f) => f.path).sort(), ['docs/x.md', 'src/core/a.js']);
});

// ---- path safety
test('path traversal, absolute and malformed paths are rejected', () => {
  const evil = ['../evil.js', 'src/../../evil.js', '/etc/passwd.js', 'src\\evil.js', 'C:evil.js', 'src//x.js', './src/x.js', 'src/./x.js', 'src/na\u00efve.js', 'src/with space.js'];
  for (const name of evil) {
    const res = run(writeZip([{ name: 'TASK.json', data: '{}' }, { name, data: 'x' }]));
    assert.ok(codes(res).includes('bad-path'), `${name} -> ${codes(res)}`);
  }
});

test('checkEntryName accepts normal paths', () => {
  for (const p of ['src/core/a.js', 'docs/', '.github/workflows/ci.yml', 'package.json']) assert.equal(checkEntryName(p), null, p);
});

test('symlinks, devices and FIFOs are rejected', () => {
  for (const [mode, code] of [[0o120777, 'symlink'], [0o060644, 'special-file'], [0o010644, 'special-file'], [0o140644, 'special-file']]) {
    const res = run(pkg(ok, { entry: { 'src/core/a.js': { mode } } }));
    assert.ok(codes(res).includes(code), `${mode.toString(8)} -> ${codes(res)}`);
  }
});

test('duplicate paths and case collisions are rejected', () => {
  const files = { 'src/core/a.js': 'x\n' };
  let res = run(pkg(files, { extra: [{ name: 'src/core/a.js', data: 'x\n' }] }));
  assert.ok(codes(res).includes('duplicate-path'));
  res = run(pkg({ 'src/core/a.js': 'x\n', 'src/core/A.js': 'y\n' }));
  assert.ok(codes(res).includes('case-collision'));
});

// ---- archive structure and limits
test('garbage that is not a ZIP is rejected', () => {
  assert.ok(codes(run(Buffer.from('not a zip file at all, just text'))).includes('zip-structure'));
  assert.ok(codes(run(Buffer.alloc(5))).includes('zip-structure'));
});

test('encrypted entries and unsupported compression methods are rejected', () => {
  assert.ok(codes(run(pkg(ok, { entry: { 'src/core/a.js': { flags: 1 } } }))).includes('encrypted'));
  assert.ok(codes(run(pkg(ok, { entry: { 'src/core/a.js': { methodCode: 12 } } }))).includes('compression-method'));
});

test('size, count and expansion limits', () => {
  assert.ok(codes(run(pkg(ok), { maxArchiveBytes: 100 })).includes('archive-too-large'));
  assert.ok(codes(run(pkg(ok), { maxFiles: 1 })).includes('too-many-files'));
  assert.ok(codes(run(pkg({ 'src/core/a.js': 'x'.repeat(500) }), { maxFileBytes: 100 })).includes('file-too-large'));
  assert.ok(codes(run(pkg({ 'src/core/a.js': 'a'.repeat(300), 'src/core/b.js': 'b'.repeat(300) }), { maxExpandedBytes: 500 })).includes('expanded-too-large'));
});

test('highly compressible data (zip bomb shape) is rejected by the ratio limit', () => {
  const res = run(pkg({ 'src/core/a.js': '0'.repeat(1_000_000) }));
  assert.ok(codes(res).includes('compression-ratio'));
});

test('declared size mismatch and CRC failure are rejected', () => {
  const buf = pkg(ok, { entry: { 'src/core/a.js': { central: { usize: 3 } } } });
  assert.ok(codes(run(buf)).some((c) => ['size-mismatch', 'inflate'].includes(c)));
  assert.ok(codes(run(pkg(ok, { entry: { 'src/core/a.js': { method: 'store', corrupt: true } } }))).includes('crc'));
});

test('overlapping entries are rejected', () => {
  const buf = writeZip([{ name: 'TASK.json', data: '{}' }, { name: 'src/core/a.js', data: 'aaaa' }, { name: 'src/core/b.js', data: 'bbbb', sameLocalAs: 1 }]);
  assert.ok(codes(run(buf)).includes('overlapping-entries'));
});

test('zip64 markers are rejected', () => {
  const buf = Buffer.from(pkg(ok));
  buf.writeUInt16LE(0xffff, buf.length - 22 + 10);
  assert.ok(codes(run(buf)).includes('zip64'));
});

// ---- allowlists and protected paths
test('extensions and paths outside the allowlist are rejected', () => {
  for (const [p, code] of [['src/core/run.sh', 'extension-not-allowed'], ['src/core/x.wasm', 'extension-not-allowed'], ['secret/x.js', 'outside-allowlist'], ['.github/workflows/evil.yml', 'outside-allowlist'], ['package-lock.json', 'outside-allowlist'], ['.git/config', 'outside-allowlist']]) {
    assert.ok(codes(run(pkg({ [p]: 'x\n' }))).includes(code), `${p} -> ${codes(run(pkg({ [p]: 'x\n' })))}`);
  }
});

test('protected paths cannot be changed by a normal import', () => {
  for (const p of ['tools/import/validate-zip.mjs', 'tools/import/config.json', '.github/workflows/import.yml']) {
    assert.ok(codes(run(pkg({ [p]: 'x\n' }))).includes('protected-path'), p);
  }
});

test('tasks/state.json is protected even in bootstrap mode', () => {
  const res = run(pkg({ 'tasks/state.json': '{}' }, { manifest: { taskId: 'A1', requires: null } }), {}, { state: null, bootstrap: true });
  assert.ok(codes(res).some((c) => c === 'outside-allowlist' || c === 'protected-path'));
});

test('bootstrap mode allows protected import tooling only for A1 on an empty repo', () => {
  const files = { 'tools/import/x.mjs': 'export {};\n', '.github/workflows/import.yml': 'name: x\n' };
  const a1 = { manifest: { taskId: 'A1', requires: null } };
  assert.deepEqual(validateArchive(pkg(files, a1), { config: config(), state: null, bootstrap: true }).errors, []);
  assert.ok(codes(validateArchive(pkg(files, a1), { config: config(), state: STATE, bootstrap: true })).includes('bootstrap-not-allowed'));
  assert.ok(codes(validateArchive(pkg(files), { config: config(), state: null, bootstrap: true })).includes('bootstrap-not-allowed'));
});

// ---- manifest
test('manifest problems', () => {
  assert.ok(codes(run(pkg(ok, { noManifest: true }))).includes('manifest-missing'));
  assert.ok(codes(run(pkg(ok, { manifest: { schema: 2 } }))).includes('manifest-invalid'));
  assert.ok(codes(run(pkg(ok, { manifest: { taskId: 'lowercase' } }))).includes('manifest-invalid'));
  assert.ok(codes(run(pkg(ok, { manifest: { title: 'bad $(title)' } }))).includes('manifest-invalid'));
  assert.ok(codes(run(pkg(ok, { manifest: { surprise: true } }))).includes('manifest-invalid'));
});

test('files must match the manifest exactly', () => {
  assert.ok(codes(run(pkg(ok, { extra: [{ name: 'src/core/extra.js', data: 'x\n' }] }))).includes('not-in-manifest'));
  assert.ok(codes(run(pkg(ok, { manifest: { files: [{ path: 'src/core/a.js', size: 19, sha256: 'a'.repeat(64) }, { path: 'docs/x.md', size: 4, sha256: 'b'.repeat(64) }, { path: 'src/core/ghost.js', size: 1, sha256: 'c'.repeat(64) }] } }))).includes('manifest-file-missing'));
  const wrongHash = pkg(ok, { manifest: { files: [{ path: 'src/core/a.js', size: 19, sha256: 'a'.repeat(64) }, { path: 'docs/x.md', size: 4, sha256: 'b'.repeat(64) }] } });
  assert.ok(codes(run(wrongHash)).includes('hash-mismatch'));
});

test('a manifest cannot widen the allowlist or let files escape its own declared scope', () => {
  assert.ok(codes(run(pkg(ok, { manifest: { allowedPrefixes: ['src/', 'secret/'] } }))).includes('manifest-widens-allowlist'));
  assert.ok(codes(run(pkg(ok, { manifest: { allowedPrefixes: ['src/'] } }))).includes('outside-task-scope'));
});

test('task order: requires and duplicate imports', () => {
  assert.ok(codes(validateArchive(pkg(ok), { config: config(), state: { completed: [] } })).includes('requires-not-completed'));
  assert.ok(codes(validateArchive(pkg(ok), { config: config(), state: { completed: ['A1', 'A2'] } })).includes('already-imported'));
});

test('deletes follow the same path rules', () => {
  assert.deepEqual(run(pkg(ok, { manifest: { deletes: ['src/core/old.js'], allowedPrefixes: [...Object.keys(ok), 'src/core/old.js'] } })).errors, []);
  assert.ok(codes(run(pkg(ok, { manifest: { deletes: ['tools/import/validate-zip.mjs'] } }))).includes('bad-delete'));
  assert.ok(codes(run(pkg(ok, { manifest: { deletes: ['../x.js'] } }))).includes('bad-delete'));
});

// ---- secrets and package.json
test('secrets are detected in file contents and names', () => {
  const secrets = {
    aws: ['AKIA', 'IOSFODNN7EXAMPLE'].join(''),
    github: ['ghp_', 'a'.repeat(36)].join(''),
    key: ['-----BEGIN ', 'RSA PRIVATE KEY-----'].join(''),
    assign: `${['pass', 'word'].join('')} = "${'x'.repeat(10)}"`,
    anthropic: ['sk-', 'ant-', 'a'.repeat(30)].join(''),
  };
  for (const [name, value] of Object.entries(secrets)) {
    const res = run(pkg({ 'src/core/a.js': `export const v = '${value}';\n` }));
    assert.ok(codes(res).includes('secret-detected'), name);
  }
  assert.ok(scanForSecrets('docs/.env', 'A=1').some((f) => f.rule === 'secret-file-name'));
  assert.ok(scanForSecrets('docs/server.pem', 'x').some((f) => f.rule === 'secret-file-name'));
  assert.deepEqual(scanForSecrets('src/core/a.js', "const key = 'auction.bid.rejected';\n"), []);
});

test('package.json lifecycle scripts are rejected and dependencies are flagged for review', () => {
  const base = { name: 'x', scripts: { test: 'node --test' } };
  assert.deepEqual(run(pkg({ 'package.json': JSON.stringify(base) })).errors, []);
  const bad = run(pkg({ 'package.json': JSON.stringify({ ...base, scripts: { postinstall: 'node x.js' } }) }));
  assert.ok(codes(bad).includes('lifecycle-script'));
  const dev = run(pkg({ 'package.json': JSON.stringify({ ...base, devDependencies: { esbuild: '0.28.2' } }) }));
  assert.ok(dev.warnings.some((w) => w.code === 'dev-dependencies'));
  const rt = run(pkg({ 'package.json': JSON.stringify({ ...base, dependencies: { lodash: '4.17.21' } }) }));
  assert.ok(rt.warnings.some((w) => w.code === 'runtime-dependency'));
});

test('deflate and stored entries both round-trip', () => {
  const res = run(pkg(ok, { entry: { 'src/core/a.js': { method: 'store' } } }));
  assert.deepEqual(res.errors, []);
  assert.equal(zlib.crc32(res.files.find((f) => f.path === 'src/core/a.js').data), zlib.crc32(Buffer.from(ok['src/core/a.js'])));
});
