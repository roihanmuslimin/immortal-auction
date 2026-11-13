// Lint runner: scans src/ and prints violations. Exit code 1 when any are found.
// Usage: node tools/lint/run.mjs [--root <dir>] [--json]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintSource, toPosix } from './rules.mjs';

export function listSourceFiles(root) {
  const out = [];
  const base = path.join(root, 'src');
  if (!fs.existsSync(base)) return out;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        out.push({ rel: toPosix(path.relative(root, full)), symlink: true });
      } else if (entry.isDirectory()) walk(full);
      else if (/\.(m?js|cjs)$/.test(entry.name)) out.push({ rel: toPosix(path.relative(root, full)), full });
    }
  };
  walk(base);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function lintTree(root) {
  const violations = [];
  const files = listSourceFiles(root);
  for (const f of files) {
    if (f.symlink) {
      violations.push({ file: f.rel, line: 1, rule: 'symlink', message: 'symbolic links are not allowed in src/' });
      continue;
    }
    if (f.rel.endsWith('.cjs')) {
      violations.push({ file: f.rel, line: 1, rule: 'no-require', message: 'CommonJS files are not allowed; use ES modules' });
      continue;
    }
    violations.push(...lintSource(f.rel, fs.readFileSync(f.full, 'utf8')));
  }
  return { files: files.length, violations };
}

function main(argv) {
  const rootIdx = argv.indexOf('--root');
  const root = path.resolve(rootIdx >= 0 ? argv[rootIdx + 1] : '.');
  const json = argv.includes('--json');
  const { files, violations } = lintTree(root);
  if (json) {
    console.log(JSON.stringify({ files, violations }, null, 2));
  } else {
    for (const v of violations) console.log(`${v.file}:${v.line}  [${v.rule}]  ${v.message}`);
    console.log(`lint: ${files} file(s) scanned, ${violations.length} violation(s)`);
  }
  process.exit(violations.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
