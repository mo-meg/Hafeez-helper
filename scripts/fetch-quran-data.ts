// Downloads and verifies the juz / hizb-quarter / page metadata into public/data/divisions.json
// (needs internet). Does NOT write Quran text: that comes from `npm run data:import` (KFGQPC).
// Usage: npm run data:fetch
//
// Sources:
//  - AlQuran.cloud /v1/quran/quran-simple  (Tanzil Simple Hafs text, CC BY 3.0)
//  - AlQuran.cloud /v1/meta                  (independent division references)
//  - Tanzil quran-data.js                    (original Tanzil metadata, CC BY 3.0)
// Every list must agree across sources AND with the verified anchors, or nothing is written.
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ALQURAN_CLOUD, diffStartLists, parseAlQuranCloudFullQuran, parseAlQuranCloudMeta } from '../src/core/data/alquranCloud.ts';
import { parseTanzilQuranDataJs } from '../src/core/data/tanzilMetadata.ts';
import { validateDivisionDataset } from '../src/core/quran/divisionValidation.ts';

const TANZIL_METADATA_URL = 'https://tanzil.net/res/text/metadata/quran-data.js';
const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');

async function get(url: string, as: 'json' | 'text'): Promise<unknown> {
  process.stdout.write(`GET ${url} … `);
  const res = await fetch(url, { headers: { 'user-agent': 'hafeez-helfer-data-fetch/0.1' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  console.log('ok');
  return as === 'json' ? res.json() : res.text();
}

const retrievedAt = new Date().toISOString();
const full = await get(`${ALQURAN_CLOUD.baseUrl}${ALQURAN_CLOUD.fullQuranPath(ALQURAN_CLOUD.defaultEdition)}`, 'json');
const parsed = parseAlQuranCloudFullQuran(full, retrievedAt);
const meta = parseAlQuranCloudMeta(await get(`${ALQURAN_CLOUD.baseUrl}${ALQURAN_CLOUD.metaPath}`, 'json'));

const problems: string[] = [];
const compare = (label: string, a: ReadonlyArray<readonly [number, number]>, b: ReadonlyArray<readonly [number, number]>) => {
  const d = diffStartLists(a, b);
  if (d.length) problems.push(`${label}: ${d.slice(0, 5).join(', ')}${d.length > 5 ? ` (+${d.length - 5} more)` : ''}`);
  else console.log(`✓ ${label} agree (${a.length} entries)`);
};
compare('per-ayah quarters vs /meta', parsed.divisions.quarterStarts ?? [], meta.quarterStarts);
compare('per-ayah juz vs /meta', parsed.divisions.juzStarts, meta.juzStarts);
if (meta.pageStarts) compare('per-ayah pages vs /meta', parsed.divisions.pageStarts ?? [], meta.pageStarts);

try {
  const tanzil = parseTanzilQuranDataJs(String(await get(TANZIL_METADATA_URL, 'text')));
  compare('quarters vs Tanzil quran-data.js', parsed.divisions.quarterStarts ?? [], tanzil.quarterStarts);
  compare('juz vs Tanzil quran-data.js', parsed.divisions.juzStarts, tanzil.juzStarts);
  compare('pages vs Tanzil quran-data.js', parsed.divisions.pageStarts ?? [], tanzil.pageStarts);
} catch (e) {
  console.warn(`! Tanzil cross-check skipped: ${e instanceof Error ? e.message : e}`);
}

const validation = validateDivisionDataset(parsed.divisions);
if (!validation.ok) problems.push(...validation.errors);
else console.log('✓ divisions match all verified juz and hizb anchors');

if (problems.length) {
  console.error('\nVerification failed; nothing was written:\n- ' + problems.join('\n- '));
  process.exit(1);
}

// Division metadata only: the Quran TEXT is the KFGQPC Hafs V30 dataset written by
// `npm run data:import`. Writing a text here would silently replace it, so this script never does.
await mkdir(outDir, { recursive: true });
await writeFile(join(outDir, 'divisions.json'), JSON.stringify(parsed.divisions, null, 1));
console.log(`\nWrote public/data/divisions.json (${parsed.divisions.juzStarts.length} juz, ${parsed.divisions.quarterStarts?.length ?? 0} quarters, ${parsed.divisions.pageStarts?.length ?? 0} pages).`);
console.log('Quran text is NOT written by this script: run `npm run data:import` for the KFGQPC text.');
console.log('Attribution required: division metadata from Tanzil.net (CC BY 3.0), via AlQuran.cloud.');
