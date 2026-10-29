// Project lint: architecture and safety rules that a generic linter would not enforce.
// (ESLint/Prettier were not available in the build environment; see docs/TESTING.md.)
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (/\.(ts|mjs|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

const RULES = [
  { re: /\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML/, msg: 'Do not inject HTML strings (XSS risk with user notes).', dirs: ['src'] },
  { re: /\beval\s*\(|new Function\s*\(/, msg: 'No eval / new Function.', dirs: ['src', 'scripts'] },
  { re: /\bconsole\.log\b/, msg: 'No console.log in application code.', dirs: ['src'] },
  { re: /\b(TODO|FIXME|XXX)\b/, msg: 'No unfinished TODO/FIXME markers.', dirs: ['src'] },
  { re: /\b(document|window|navigator)\s*\.|\b(localStorage|sessionStorage|indexedDB|HTMLElement)\b/, msg: 'src/core must stay UI/platform independent.', dirs: ['src/core'] },
  { re: /\bfrom ['"](\.\.\/)+(ui|browser)\//, msg: 'src/core must not import UI or browser modules.', dirs: ['src/core'] },
];

for (const file of await walk(join(root, 'src')).then(async (a) => [...a, ...(await walk(join(root, 'scripts')))])) {
  const rel = relative(root, file).split('\\').join('/');
  const text = await readFile(file, 'utf8');
  if (!text.endsWith('\n')) problems.push(`${rel}: file must end with a newline`);
  if (/\t/.test(text)) problems.push(`${rel}: use spaces, not tabs`);
  text.split('\n').forEach((line, i) => {
    if (/\s+$/.test(line)) problems.push(`${rel}:${i + 1}: trailing whitespace`);
    const code = line.replace(/\/\*.*?\*\//g, '').replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
    for (const r of RULES) {
      if (r.dirs.some((d) => rel.startsWith(`${d}/`)) && r.re.test(code)) problems.push(`${rel}:${i + 1}: ${r.msg}`);
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} lint problem(s).`);
  process.exit(1);
}
console.log('Lint passed.');
