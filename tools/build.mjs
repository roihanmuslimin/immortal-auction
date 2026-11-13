// Production build: bundles src/main.js with esbuild and writes dist/size-report.json.
// Usage: node tools/build.mjs
// esbuild is a pinned devDependency (npm install). Without it this script exits with code 2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { measureFile, checkBudgets, formatTable } from './size-report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let esbuild;
try {
  esbuild = await import(process.env.ESBUILD_MODULE ?? 'esbuild');
} catch {
  console.error('esbuild is not installed. Run "npm install" first (it is a pinned devDependency).');
  process.exit(2);
}

const outdir = path.join(root, 'dist');
fs.rmSync(outdir, { recursive: true, force: true });
fs.mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(root, 'src/main.js')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  minify: true,
  legalComments: 'none',
  outfile: path.join(outdir, 'app.js'),
  logLevel: 'warning',
});

const rows = [measureFile(path.join(outdir, 'app.js'))].map((r) => ({ ...r, file: path.relative(root, r.file) }));
const budget = checkBudgets(rows);
fs.writeFileSync(path.join(outdir, 'size-report.json'), JSON.stringify({ rows, budget }, null, 2) + '\n');
console.log(formatTable(rows));
console.log(`initial payload: ${budget.totalGzip} bytes gzip; budget ${budget.ok ? 'met' : 'EXCEEDED'}`);
for (const p of budget.problems) console.error(p);
process.exit(budget.ok ? 0 : 1);
