import test from 'node:test';
import assert from 'node:assert/strict';
import { measure, checkBudgets, formatTable, BUDGETS } from '../../tools/size-report.mjs';

test('measure reports raw, gzip and brotli sizes', () => {
  const m = measure(Buffer.from('abc'.repeat(1000)));
  assert.equal(m.raw, 3000);
  assert.ok(m.gzip > 0 && m.gzip < m.raw);
  assert.ok(m.brotli > 0 && m.brotli < m.raw);
});

test('budget check passes under and fails over the initial payload budget', () => {
  assert.equal(checkBudgets([{ gzip: 1000 }]).ok, true);
  const over = checkBudgets([{ gzip: BUDGETS.initialPayloadGzipBytes + 1 }]);
  assert.equal(over.ok, false);
  assert.match(over.problems[0], /initial payload/);
});

test('table formatting lists every file', () => {
  const t = formatTable([{ file: 'dist/app.js', raw: 10, gzip: 8, brotli: 7 }]);
  assert.match(t, /dist\/app\.js/);
  assert.match(t, /raw/);
});
