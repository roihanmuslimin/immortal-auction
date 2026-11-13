// Minimal JavaScript scanner used by the project lint rules.
// It separates code from comments, string literals, template text and regex
// literals so the rules never fire on text inside them. Zero dependencies.

const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

/**
 * @param {string} src
 * @returns {{ masked: string, literals: Array<{start:number,end:number,value:string,line:number,kind:'string'|'template'}>, lineStarts: number[] }}
 *   masked: same length as src; comments, string/template text and regex bodies are replaced by spaces (newlines kept).
 *   literals: every string literal and template text chunk with its decoded value and 1-based line.
 */
export function tokenize(src) {
  const out = src.split('');
  const literals = [];
  const lineStarts = [0];
  for (let k = 0; k < src.length; k++) if (src[k] === '\n') lineStarts.push(k + 1);

  let i = 0;
  let line = 1;
  let lastSig = '';
  let prevWord = '';

  const blank = (a, b) => {
    for (let k = a; k < b && k < out.length; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  const regexAllowed = () => {
    if (lastSig === '' ) return true;
    if (lastSig === 'w') return REGEX_KEYWORDS.has(prevWord);
    if (lastSig === '0') return false;
    return !(lastSig === ')' || lastSig === ']' || lastSig === '}');
  };

  function scanString(q) {
    const start = i;
    const startLine = line;
    i++;
    let value = '';
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') {
        const e = src[i + 1];
        if (e === 'n') value += '\n';
        else if (e === 't') value += '\t';
        else if (e === '\n') line++;
        else if (e !== undefined) value += e;
        i += 2;
        continue;
      }
      if (c === q) break;
      if (c === '\n') break; // unterminated, stop at end of line
      value += c;
      i++;
    }
    const end = Math.min(i + 1, src.length);
    literals.push({ start, end, value, line: startLine, kind: 'string' });
    blank(start + 1, i);
    i = end;
  }

  function scanTemplate() {
    i++; // opening backtick
    let chunkStart = i;
    let chunkLine = line;
    const flush = (endIdx) => {
      const raw = src.slice(chunkStart, endIdx);
      literals.push({ start: chunkStart, end: endIdx, value: raw, line: chunkLine, kind: 'template' });
      blank(chunkStart, endIdx);
    };
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { if (src[i + 1] === '\n') line++; i += 2; continue; }
      if (c === '`') { flush(i); i++; return; }
      if (c === '$' && src[i + 1] === '{') {
        flush(i);
        i += 2;
        scanCode(true);
        i++; // skip the closing brace
        chunkStart = i;
        chunkLine = line;
        continue;
      }
      if (c === '\n') line++;
      i++;
    }
    flush(i);
  }

  function scanRegex() {
    const start = i;
    i++;
    let inClass = false;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { i++; break; }
      else if (c === '\n') break;
      i++;
    }
    while (i < src.length && /[a-z]/.test(src[i])) i++;
    blank(start, i);
  }

  function scanCode(untilBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (c === '\n') { line++; i++; continue; }
      if (c === '/' && d === '/') {
        const s = i;
        while (i < src.length && src[i] !== '\n') i++;
        blank(s, i);
        continue;
      }
      if (c === '/' && d === '*') {
        const s = i;
        i += 2;
        while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
          if (src[i] === '\n') line++;
          i++;
        }
        i = Math.min(i + 2, src.length);
        blank(s, i);
        continue;
      }
      if (c === '"' || c === "'") { scanString(c); lastSig = c; prevWord = ''; continue; }
      if (c === '`') { scanTemplate(); lastSig = '`'; prevWord = ''; continue; }
      if (c === '/' && regexAllowed()) { scanRegex(); lastSig = '/'; prevWord = ''; continue; }
      if (untilBrace) {
        if (c === '{') depth++;
        else if (c === '}') {
          if (depth === 0) return;
          depth--;
        }
      }
      if (/\s/.test(c)) { i++; continue; }
      if (/[A-Za-z_$]/.test(c)) {
        const s = i;
        while (i < src.length && /[\w$]/.test(src[i])) i++;
        prevWord = src.slice(s, i);
        lastSig = 'w';
        continue;
      }
      if (/[0-9]/.test(c)) {
        while (i < src.length && /[\w.]/.test(src[i])) i++;
        lastSig = '0';
        prevWord = '';
        continue;
      }
      lastSig = c;
      prevWord = '';
      i++;
    }
  }

  scanCode(false);
  return { masked: out.join(''), literals, lineStarts };
}

/** 1-based line number of a character offset. */
export function lineAt(lineStarts, offset) {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}
