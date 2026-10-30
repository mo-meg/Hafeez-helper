// Build script: bundles the app with esbuild into dist/ (or the browser test harness into dist-harness/).
// Usage: node scripts/build.mjs [--watch] [--serve] [--harness]
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));

// Optional cloud accounts (Supabase). Read from the environment or a local .env file; when both
// are empty the app is built in local-only mode. The anon key is public by design (RLS protects data).
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  /* no .env file */
}
const cloudDefine = {
  __CLOUD_URL__: JSON.stringify(process.env.HAFEEZ_SUPABASE_URL ?? ''),
  __CLOUD_ANON_KEY__: JSON.stringify(process.env.HAFEEZ_SUPABASE_ANON_KEY ?? ''),
};
const harness = args.has('--harness');

const SHOWCASES = { '': 'harness', dashboard: '#/dashboard', quran: '#/quran?hizb=5', revision: '#/revision', mistakes: '#/mistakes', test: 'live-test', progress: '#/progress', settings: '#/settings', session: 'live-session', login: 'login-screen' };
/** Arabic (RTL) variants of the showcase screens. */
const AR_SHOWCASES = ['dashboard', 'quran', 'revision', 'mistakes', 'test', 'progress', 'settings', 'session', 'login'];

async function buildHarness() {
  const out = join(root, 'dist-harness');
  // Outputs have fixed names and are overwritten in place (no deletion needed).
  await mkdir(out, { recursive: true });
  for (const [name, route] of Object.entries(SHOWCASES)) await buildHarnessPage(out, name, name ? route : '', 'en');
  for (const name of AR_SHOWCASES) await buildHarnessPage(out, `${name}-ar`, SHOWCASES[name], 'ar');
}

async function buildHarnessPage(out, name, showcase, lang) {
  const res = await esbuild.build({
    define: showcase ? { SHOWCASE: JSON.stringify(showcase), SHOWCASE_LANG: JSON.stringify(lang) } : {},
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
    define: cloudDefine,
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
  /** Copies the bundled KFGQPC font under a stable, URL-safe name (the release file name has spaces). */
  const font = async () => {
    await mkdir(join(out, 'fonts'), { recursive: true });
    await writeFile(join(out, 'fonts', 'KFGQPC-Hafs-V30.ttf'), await readFile(join(root, 'public', 'KFGQPC-Hafs-V30', 'KFGQPC Hafs V30.ttf')));
    await writeFile(join(out, 'fonts', 'LICENSE-KFGQPC-Hafs.txt'), await readFile(join(root, 'public', 'fonts', 'LICENSE-KFGQPC-Hafs.txt')));
  };
  const copyPublic = async () => {
    // The KFGQPC source folder (DOCX + font) is not part of the built app: the font is copied to
    // ./fonts/ by `font()` in copyPublic, and the dataset to ./data/ from public/data/.
    await copyDir(join(root, 'public'), out, (src) => !src.endsWith('sw.js') && !src.endsWith('README.md') && !src.startsWith(join(root, 'public', 'KFGQPC-Hafs-V30')));
    await font();
    // The reader is useless without its text; say so at build time instead of silently shipping a
    // build that only lists ayat by reference. `data:import` needs no network, data:fetch does.
    const missing = [];
    for (const f of ['quran-text.json', 'divisions.json']) if (!(await readFile(join(out, 'data', f)).catch(() => null))) missing.push(f);
    if (missing.length) {
      console.warn(`\n⚠ dist/data is missing ${missing.join(' and ')} — the Quran reader will only list ayat by reference.\n  Run \`npm run data:import\` (KFGQPC text, offline) and \`npm run data:fetch\` (divisions, needs internet).\n`);
    }
    const files = ['./', './index.html', './main.js', './main.css', './fonts/fonts.css', './fonts/KFGQPC-Hafs-V30.ttf', './manifest.webmanifest', './icon.svg'];
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
  console.log(cloudDefine.__CLOUD_URL__ !== '""' ? 'Cloud accounts: enabled (sign-in required).' : 'Cloud accounts: not configured (local-only mode).');
  const listing = await readdir(out);
  console.log(`Built dist/: ${listing.join(', ')}`);
}

if (harness) await buildHarness();
else await buildApp();
