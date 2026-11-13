// Project lint rules for Stage A (design document, sections 5.2 and 5.7 task A1).
// Rules: dependency boundaries, simulation purity (no random/time/float), no display text.
import path from 'node:path';
import { tokenize, lineAt } from './scan.mjs';

/** Which layers each layer may import. 'app' is src/main.js and may import everything. */
export const LAYERS = {
  app: null,
  core: ['core'],
  data: ['core', 'data'],
  i18n: ['core', 'data', 'i18n'],
  persistence: ['core', 'data', 'persistence'],
  gameplay: ['core', 'data', 'gameplay'],
  ui: ['core', 'data', 'i18n', 'gameplay', 'ui'],
  dev: ['core', 'data', 'i18n', 'persistence', 'gameplay', 'dev'],
};

/** Layers whose code feeds the deterministic simulation. */
export const SIM_LAYERS = new Set(['core', 'data', 'gameplay']);
/** Layers that must not contain player-facing text. */
export const TEXT_FREE_LAYERS = new Set(['core', 'data', 'gameplay']);

const FLOAT_MATH = /\bMath\s*\.\s*(sqrt|pow|exp|expm1|log|log1p|log2|log10|sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|asinh|acosh|atanh|hypot|cbrt|fround)\b/g;
const RANDOM_TIME = [
  /\bMath\s*\.\s*random\b/g,
  /\bDate\s*\.\s*(now|parse|UTC)\b/g,
  /\bnew\s+Date\b/g,
  /\bperformance\s*\.\s*now\b/g,
  /\bcrypto\s*\.\s*(getRandomValues|randomUUID)\b/g,
  /\b(setTimeout|setInterval|requestAnimationFrame)\b/g,
];
const FLOAT_LITERAL_DECIMAL = /(?<![\w$.])(?:\d[\d_]*\.\d[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?(?![\w$])/g;
const FLOAT_LITERAL_EXPONENT = /(?<![\w$.])\d[\d_]*[eE][+-]?\d+(?![\w$])/g;
const PARSE_FLOAT = /\b(?:Number\s*\.\s*)?parseFloat\b/g;
const POW_OPERATOR = /\*\*/g;

const ALLOW_MARKER = /lint-allow:(float|random-time|display-text)\s+(\S+)/;
const DEV_ERROR_CONTEXT = /(?:new\s+(?:Type|Range|Syntax|Reference)?Error|\bassert\w*|\bconsole\s*\.\s*\w+)\s*\(/;
const DISPLAY_TEXT = /[A-Za-z]{2,}\s+[A-Za-z]{2,}/;

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function layerOf(relPath) {
  const parts = relPath.split('/');
  if (parts[0] !== 'src') return null;
  if (parts.length === 2) return 'app';
  return parts[1];
}

function allowed(lines, lineNo, kind) {
  const here = lines[lineNo - 1] ?? '';
  const m = ALLOW_MARKER.exec(here);
  return Boolean(m && m[1] === kind);
}

function collectImports(masked, literalAt, lineStarts) {
  const found = [];
  const patterns = [
    /\b(?:import|export)\s[^;]*?\bfrom\s*(['"])/dg,
    /\bimport\s*(['"])/dg,
    /\bimport\s*\(\s*(['"])/dg,
    /\brequire\s*\(\s*(['"])/dg,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(masked)) !== null) {
      const quoteIndex = m.indices[1][0];
      const lit = literalAt.get(quoteIndex);
      if (lit) found.push({ spec: lit.value, start: quoteIndex, line: lineAt(lineStarts, quoteIndex), isRequire: /^\brequire/.test(m[0]) });
    }
  }
  return found;
}

/**
 * Lint one source file.
 * @param {string} relPath posix path relative to the repository root, for example 'src/core/x.js'
 * @param {string} source file contents
 * @returns {Array<{file:string,line:number,rule:string,message:string}>}
 */
export function lintSource(relPath, source) {
  const file = relPath;
  const violations = [];
  const layer = layerOf(relPath);
  if (layer === null) return violations;
  const add = (line, rule, message) => violations.push({ file, line, rule, message });

  if (!Object.prototype.hasOwnProperty.call(LAYERS, layer)) {
    add(1, 'unknown-layer', `directory 'src/${layer}' is not a registered layer; register it in tools/lint/rules.mjs`);
    return violations;
  }

  const { masked, literals, lineStarts } = tokenize(source);
  const lines = source.split('\n');
  const literalAt = new Map(literals.filter((l) => l.kind === 'string').map((l) => [l.start, l]));

  // 1. Dependency boundaries
  const imports = collectImports(masked, literalAt, lineStarts);
  const importStarts = new Set(imports.map((x) => x.start));
  for (const imp of imports) {
    const { spec, line } = imp;
    if (imp.isRequire) add(line, 'no-require', `require() is not allowed; use ES module imports (${spec})`);
    if (spec.startsWith('./') || spec.startsWith('../')) {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(relPath), spec));
      if (!target.startsWith('src/')) {
        add(line, 'import-outside-src', `import '${spec}' resolves outside src/`);
        continue;
      }
      const targetLayer = layerOf(target);
      const permitted = LAYERS[layer];
      if (permitted !== null && !permitted.includes(targetLayer)) {
        add(line, 'boundary', `layer '${layer}' must not import layer '${targetLayer}' (${spec})`);
      }
    } else if (spec.startsWith('node:')) {
      if (layer !== 'dev') add(line, 'node-builtin', `'${spec}' is only allowed in src/dev; browser code cannot use Node built-ins`);
    } else {
      add(line, 'bare-import', `bare or URL import '${spec}' is not allowed in src (zero runtime dependencies)`);
    }
  }

  // 2. Simulation purity
  if (SIM_LAYERS.has(layer)) {
    const checks = [];
    for (const re of RANDOM_TIME) checks.push([re, 'sim-random-time', 'random-time', (t) => `'${t}' is non-deterministic; use the seeded RNG and the simulation clock`]);
    checks.push([FLOAT_MATH, 'sim-float', 'float', (t) => `'${t}' is floating-point; use integer, basis-point or fixed-point arithmetic`]);
    checks.push([FLOAT_LITERAL_DECIMAL, 'sim-float', 'float', (t) => `float literal '${t}' is not allowed in simulation code`]);
    checks.push([FLOAT_LITERAL_EXPONENT, 'sim-float', 'float', (t) => `exponent literal '${t}' is not allowed in simulation code`]);
    checks.push([PARSE_FLOAT, 'sim-float', 'float', (t) => `'${t}' is floating-point`]);
    checks.push([POW_OPERATOR, 'sim-float', 'float', () => `the ** operator is not allowed in simulation code`]);
    for (const [re, rule, kind, msg] of checks) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(masked)) !== null) {
        const line = lineAt(lineStarts, m.index);
        if (allowed(lines, line, kind)) continue;
        add(line, rule, msg(m[0].replace(/\s+/g, '')));
      }
    }
  }

  // 3. No player-facing text
  if (TEXT_FREE_LAYERS.has(layer)) {
    for (const lit of literals) {
      if (importStarts.has(lit.start)) continue;
      if (!DISPLAY_TEXT.test(lit.value)) continue;
      const ctx = `${lines[lit.line - 2] ?? ''}\n${lines[lit.line - 1] ?? ''}`;
      if (DEV_ERROR_CONTEXT.test(ctx)) continue;
      if (allowed(lines, lit.line, 'display-text')) continue;
      const shown = lit.value.length > 40 ? `${lit.value.slice(0, 37)}...` : lit.value;
      add(lit.line, 'display-text', `string '${shown}' looks like player-facing text; use a message key (see src/i18n)`);
    }
  }

  violations.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
  return violations;
}
