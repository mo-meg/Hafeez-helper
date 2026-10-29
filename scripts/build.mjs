// Build script: bundles the app with esbuild into dist/ (or the browser test harness into dist-harness/).
// Usage: node scripts/build.mjs [--watch] [--serve] [--harness]
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const harness = args.has('--harness');

const SHOWCASES = { '': 'harness', dashboard: '#/dashboard', quran: '#/quran?hizb=5', revision: '#/revision', mistakes: '#/mistakes', test: 'live-test', progress: '#/progress', settings: '#/settings', session: 'live-session' };

async function buildHarness() {
  const out = join(root, 'dist-harness');
  // Outputs have fixed names and are overwritten in place (no deletion needed).
  await mkdir(out, { recursive: true });
  for (const [name, route] of Object.entries(SHOWCASES)) await buildHarnessPage(out, name, name ? route : '');
}

async function buildHarnessPage(out, name, showcase) {
  const res = await esbuild.build({
    define: showcase ? { SHOWCASE: JSON.stringify(showcase) } : {},
    entryPoints: [join(root, 'harness/harness.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    outdir: out,
    minify: false,
    legalComments: 'none',
  });
  const js = res.outputFiles.find((f) => f.path.endsWith('.js'))?.text ?? '';
  const css = res.outputFiles.find((f) => f.path.endsWith('.css'))?.text ?? '';
  const safeJs = js.replace(/<\/script/gi, '<\\/script');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hafeez Helfer browser test harness</title><style>${css}</style></head>
<body><div id="harness-report"></div><div id="app"></div><script type="module">${safeJs}</script></body></html>`;
  const file = name ? `showcase-${name}.html` : 'harness.html';
  await writeFile(join(out, file), html);
  console.log(`Wrote dist-harness/${file} (${(html.length / 1024).toFixed(0)} KB)`);
}

/** Recursive copy that overwrites files in place (never unlinks). */
async function copyDir(from, to, filter) {
  await mkdir(to, { recursive: true });
  for (const e of await readdir(from, { withFileTypes: true })) {
    const src = join(from, e.name);
    if (!filter(src)) continue;
    if (e.isDirectory()) await copyDir(src, join(to, e.name), filter);
    else await writeFile(join(to, e.name), await readFile(src));
  }
}

async function buildApp() {
  const out = join(root, 'dist');
  if (args.has('--clean')) await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });
  const options = {
    entryPoints: [join(root, 'src/main.ts')],
    bundle: true,
    format: 'esm',
    target: 'es2022',
    outdir: out,
    entryNames: '[name]',
    sourcemap: true,
    minify: !args.has('--watch'),
    legalComments: 'linked',
    logLevel: 'info',
  };
  const copyPublic = async () => {
    await copyDir(join(root, 'public'), out, (src) => !src.endsWith('sw.js') && !src.endsWith('README.md'));
    const files = ['./', './index.html', './main.js', './main.css', './manifest.webmanifest', './icon.svg'];
    const hash = createHash('sha256');
    for (const f of ['main.js', 'main.css']) hash.update(await readFile(join(out, f)).catch(() => ''));
    const sw = (await readFile(join(root, 'public/sw.js'), 'utf8'))
      .replace('__BUILD_ID__', hash.digest('hex').slice(0, 12))
      .replace('__SHELL_FILES__', JSON.stringify(files));
    await writeFile(join(out, 'sw.js'), sw);
  };
  if (args.has('--watch')) {
    const ctx = await esbuild.context({ ...options, plugins: [{ name: 'copy-public', setup: (b) => b.onEnd(() => copyPublic()) }] });
    await ctx.watch();
    if (args.has('--serve')) await import('./serve.mjs');
    return;
  }
  await esbuild.build(options);
  await copyPublic();
  const listing = await readdir(out);
  console.log(`Built dist/: ${listing.join(', ')}`);
}

if (harness) await buildHarness();
else await buildApp();
