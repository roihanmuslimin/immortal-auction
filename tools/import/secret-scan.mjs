// Heuristic secret scanner for task packages. Patterns are written so that this file never matches itself.
const PATTERNS = [
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
  ['slack-token', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['anthropic-or-openai-key', /\bsk-(?:ant-)?[A-Za-z0-9_-]{24,}\b/],
  ['private-key-block', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['generic-credential-assignment', /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i],
];
const SECRET_FILE_NAMES = [/(^|\/)\.env(\..*)?$/, /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/, /\.(pem|key|p12|pfx|jks|keystore)$/i, /(^|\/)\.npmrc$/, /(^|\/)credentials(\.json)?$/i];

/** @returns {Array<{path:string, rule:string, line?:number}>} */
export function scanForSecrets(filePath, text) {
  const findings = [];
  for (const re of SECRET_FILE_NAMES) if (re.test(filePath)) findings.push({ path: filePath, rule: 'secret-file-name' });
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    for (const [rule, re] of PATTERNS) if (re.test(line)) findings.push({ path: filePath, rule, line: i + 1 });
  });
  return findings;
}
