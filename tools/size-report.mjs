// Size measurement and budget checks for build output (design document section 4.2).
import fs from 'node:fs';
import zlib from 'node:zlib';

/** Budgets in bytes. Initial payload (code plus critical CSS) must stay at or under 1.5 MB compressed. */
export const BUDGETS = { initialPayloadGzipBytes: 1_500_000 };

export function measure(buffer) {
  return {
    raw: buffer.length,
    gzip: zlib.gzipSync(buffer, { level: 9 }).length,
    brotli: zlib.brotliCompressSync(buffer).length,
  };
}

export function measureFile(file) {
  return { file, ...measure(fs.readFileSync(file)) };
}

export function checkBudgets(rows, budgets = BUDGETS) {
  const totalGzip = rows.reduce((n, r) => n + r.gzip, 0);
  const problems = [];
  if (totalGzip > budgets.initialPayloadGzipBytes) problems.push(`initial payload is ${totalGzip} bytes gzip (budget ${budgets.initialPayloadGzipBytes})`);
  return { totalGzip, ok: problems.length === 0, problems };
}

export function formatTable(rows) {
  const pad = (s, n) => String(s).padStart(n);
  const lines = [`${'file'.padEnd(28)}${pad('raw', 10)}${pad('gzip', 10)}${pad('brotli', 10)}`];
  for (const r of rows) lines.push(`${r.file.padEnd(28)}${pad(r.raw, 10)}${pad(r.gzip, 10)}${pad(r.brotli, 10)}`);
  return lines.join('\n');
}
