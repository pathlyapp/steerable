/**
 * 渲染层用户可见文案必须是英文源句。中文只允许留在注释里。
 * 译文在应用仓库 locales/，不在本包。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/src');
const CJK = /[\u3400-\u9fff]/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source
    .split('\n')
    .map((line) => (line.includes('i18n:allow') ? '' : line))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const violations = [];
for (const file of walk(ROOT)) {
  const text = stripComments(readFileSync(file, 'utf8'));
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!CJK.test(lines[i])) continue;
    violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${lines[i].trim().slice(0, 160)}`);
  }
}

if (violations.length > 0) {
  console.error(`[shell-english] ${violations.length} user-visible lines still contain Chinese:`);
  for (const line of violations.slice(0, 80)) console.error(line);
  if (violations.length > 80) console.error(`… and ${violations.length - 80} more`);
  process.exit(1);
}
console.log('[shell-english] OK — renderer user-visible copy is English.');
