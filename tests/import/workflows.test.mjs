import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const dir = new URL('../../.github/workflows/', import.meta.url);
const workflows = fs.readdirSync(dir).filter((f) => f.endsWith('.yml')).map((f) => ({ name: f, text: fs.readFileSync(new URL(f, dir), 'utf8') }));

/** Lines inside `run:` scripts (block scalars), found by indentation. */
function runScriptLines(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:-\s+)?run:\s*(\|[-+]?)?\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (!m[2]) { out.push({ line: i + 1, text: m[3] }); continue; }
    const indent = m[1].length;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j];
      if (t.trim() !== '' && t.search(/\S/) <= indent) break;
      out.push({ line: j + 1, text: t });
    }
  }
  return out;
}

test('there are workflows to check', () => {
  assert.deepEqual(workflows.map((w) => w.name).sort(), ['ci.yml', 'import.yml']);
});

test('no workflow uses pull_request_target', () => {
  for (const w of workflows) assert.doesNotMatch(w.text, /pull_request_target/, w.name);
});

test('every workflow declares top-level permissions', () => {
  for (const w of workflows) assert.match(w.text, /^permissions:/m, w.name);
});

test('expressions never appear inside run scripts (script-injection hardening)', () => {
  for (const w of workflows) {
    for (const l of runScriptLines(w.text)) assert.doesNotMatch(l.text, /\$\{\{/, `${w.name}:${l.line}`);
  }
});

test('only official actions are used', () => {
  for (const w of workflows) {
    for (const m of w.text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)) assert.match(m[1], /^actions\/[a-z-]+@v\d+$/, `${w.name}: ${m[1]}`);
  }
});

test('the import workflow is manual only, validates before applying, and writes only through a pull request', () => {
  const w = workflows.find((x) => x.name === 'import.yml').text;
  assert.match(w, /^on:\n  workflow_dispatch:/m);
  assert.doesNotMatch(w, /^\s+(push|pull_request|schedule):/m);
  assert.match(w, /needs: validate/);
  assert.match(w, /gh pr create/);
  assert.doesNotMatch(w, /git push origin (main|HEAD:main|master)/);
  assert.match(w, /contents: read/);
});

test('workflow files are valid YAML (checked with python3 + PyYAML when available)', (t) => {
  const probe = spawnSync('python3', ['-c', 'import yaml'], { encoding: 'utf8' });
  if (probe.status !== 0) return t.skip('python3 with PyYAML not available');
  for (const w of workflows) {
    const r = spawnSync('python3', ['-c', 'import sys, yaml; yaml.safe_load(sys.stdin.read())'], { input: w.text, encoding: 'utf8' });
    assert.equal(r.status, 0, `${w.name}: ${r.stderr}`);
  }
});
