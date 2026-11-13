import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { lintSource } from '../../tools/lint/rules.mjs';
import { tokenize } from '../../tools/lint/scan.mjs';
import { lintTree } from '../../tools/lint/run.mjs';

const fx = (name) => fs.readFileSync(new URL(`../fixtures/lint/${name}`, import.meta.url), 'utf8');
const ruleIds = (v) => v.map((x) => x.rule);

test('the real src tree is lint-clean', () => {
  const root = new URL('../../', import.meta.url).pathname;
  const { files, violations } = lintTree(root);
  assert.ok(files >= 7);
  assert.deepEqual(violations, []);
});

test('clean fixture passes in a simulation layer (comments, regex, strings, division are ignored)', () => {
  assert.deepEqual(lintSource('src/core/clean.js', fx('clean-core.js')), []);
});

// ---- dependency boundaries
test('boundary: core must not import persistence', () => {
  const v = lintSource('src/core/bad.js', fx('boundary-core-imports-persistence.js'));
  assert.deepEqual(ruleIds(v), ['boundary']);
  assert.match(v[0].message, /core.*persistence/);
});

test('boundary: core must not import i18n (export-from form)', () => {
  assert.deepEqual(ruleIds(lintSource('src/core/bad.js', fx('boundary-core-imports-i18n.js'))), ['boundary']);
});

test('boundary: gameplay must not import persistence (multi-line import)', () => {
  const v = lintSource('src/gameplay/bad.js', fx('boundary-gameplay-imports-persistence.js'));
  assert.deepEqual(ruleIds(v), ['boundary']);
});

test('boundary: ui must not import persistence (dynamic import)', () => {
  const v = lintSource('src/ui/bad.js', fx('boundary-ui-imports-persistence.js'));
  assert.deepEqual(ruleIds(v), ['boundary']);
});

test('boundary: bare imports are rejected everywhere in src', () => {
  for (const p of ['src/core/x.js', 'src/dev/x.js', 'src/main.js']) {
    assert.deepEqual(ruleIds(lintSource(p, fx('boundary-bare-import.js'))), ['bare-import'], p);
  }
});

test('boundary: node built-ins are allowed only in src/dev', () => {
  const src = "import fs from 'node:fs';\nexport default fs;\n";
  assert.deepEqual(lintSource('src/dev/x.js', src), []);
  assert.deepEqual(ruleIds(lintSource('src/core/x.js', src)), ['node-builtin']);
});

test('boundary: the app entry may import any layer; dev may import persistence', () => {
  const src = "import { PERSISTENCE_LAYER } from './persistence/index.js';\nexport default PERSISTENCE_LAYER;\n";
  assert.deepEqual(lintSource('src/main.js', src), []);
  const dev = "import { PERSISTENCE_LAYER } from '../persistence/index.js';\nexport default PERSISTENCE_LAYER;\n";
  assert.deepEqual(lintSource('src/dev/x.js', dev), []);
});

test('boundary: relative imports that leave src/ are rejected', () => {
  assert.deepEqual(ruleIds(lintSource('src/core/x.js', "import x from '../../tools/x.js';\n")), ['import-outside-src']);
});

test('boundary: unknown layer directories must be registered', () => {
  assert.deepEqual(ruleIds(lintSource('src/mystery/x.js', 'export const a = 1;\n')), ['unknown-layer']);
});

test('boundary: imports inside comments and strings are ignored', () => {
  const src = "// import x from '../persistence/index.js'\nconst s = \"import y from '../persistence/index.js'\";\nexport default s;\n";
  assert.deepEqual(lintSource('src/core/x.js', src), []);
});

test('boundary: require() is rejected', () => {
  assert.ok(ruleIds(lintSource('src/core/x.js', "const x = require('./version.js');\n")).includes('no-require'));
});

// ---- simulation purity
test('purity: Math.random is rejected in simulation layers', () => {
  assert.deepEqual(ruleIds(lintSource('src/core/x.js', fx('sim-math-random.js'))), ['sim-random-time']);
});

test('purity: Date.now, new Date and performance.now are rejected', () => {
  const v = lintSource('src/gameplay/x.js', fx('sim-date-now.js'));
  assert.equal(v.filter((x) => x.rule === 'sim-random-time').length, 3);
});

test('purity: float literals, exponent literals, parseFloat and ** are rejected', () => {
  const v = lintSource('src/data/x.js', fx('sim-float-literal.js'));
  assert.equal(v.length, 4);
  assert.ok(v.every((x) => x.rule === 'sim-float'));
});

test('purity: floating-point Math functions are rejected', () => {
  const v = lintSource('src/core/x.js', fx('sim-math-sqrt.js'));
  assert.equal(v.length, 2);
  assert.ok(v.every((x) => x.rule === 'sim-float'));
});

test('purity: presentation and dev layers may use floats and time', () => {
  for (const p of ['src/ui/x.js', 'src/dev/x.js', 'src/i18n/x.js', 'src/persistence/x.js', 'src/main.js']) {
    const v = lintSource(p, `${fx('sim-math-random.js')}${fx('sim-float-literal.js')}`).filter((x) => x.rule.startsWith('sim-'));
    assert.deepEqual(v, [], p);
  }
});

test('purity: allow markers need a reason and match the rule kind', () => {
  assert.deepEqual(lintSource('src/core/x.js', fx('allow-marker.js')), []);
  assert.deepEqual(ruleIds(lintSource('src/core/x.js', fx('allow-marker-no-reason.js'))), ['sim-float']);
  const wrongKind = 'export const a = 0.5; // lint-allow:random-time not the right kind\n';
  assert.deepEqual(ruleIds(lintSource('src/core/x.js', wrongKind)), ['sim-float']);
});

// ---- display text
test('display text: English sentences are rejected in core, data and gameplay', () => {
  for (const layer of ['core', 'data', 'gameplay']) {
    const v = lintSource(`src/${layer}/x.js`, fx('display-text.js'));
    assert.deepEqual(ruleIds(v), ['display-text', 'display-text'], layer);
  }
});

test('display text: keys, error messages and allow markers pass; i18n and ui layers are exempt', () => {
  const ok = "export const k = 'auction.bid.rejected';\nthrow new Error('Invalid command payload');\n";
  assert.deepEqual(lintSource('src/core/x.js', ok), []);
  const multi = "throw new TypeError(\n  'Expected an integer amount in coins',\n);\n";
  assert.deepEqual(lintSource('src/core/x.js', multi), []);
  assert.deepEqual(lintSource('src/i18n/x.js', fx('display-text.js')), []);
  assert.deepEqual(lintSource('src/ui/x.js', fx('display-text.js')), []);
});

test('display text: import specifiers are not treated as text', () => {
  assert.deepEqual(lintSource('src/core/x.js', "import { a } from './some folder/x.js';\nexport default a;\n"), []);
});

// ---- tokenizer
test('tokenizer: regex literals containing quotes do not derail string scanning', () => {
  const t = tokenize("const re = /[\"']+/g;\nconst s = 'after regex';\n");
  assert.equal(t.literals.filter((l) => l.kind === 'string').length, 1);
  assert.equal(t.literals[0].value, 'after regex');
});

test('tokenizer: division is not mistaken for a regex', () => {
  const t = tokenize("const a = (4 + 2) / 3; const b = 'x'; const c = a / 2;\n");
  assert.equal(t.literals.length, 1);
  assert.match(t.masked, /\/ 3/);
});

test('tokenizer: template expressions are scanned as code', () => {
  const t = tokenize('const a = `x ${Math.random()} y ${`n${1}`}`;\n');
  assert.match(t.masked, /Math\.random\(\)/);
  assert.ok(t.literals.every((l) => l.kind === 'template'));
});

test('tokenizer: masked output keeps length and line structure', () => {
  const src = "a // c\n/* x\ny */ 'z'\n`t\nu`\n";
  const t = tokenize(src);
  assert.equal(t.masked.length, src.length);
  assert.equal(t.masked.split('\n').length, src.split('\n').length);
});
