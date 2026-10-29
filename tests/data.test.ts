import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataFormatError, diffStartLists, parseAlQuranCloudFullQuran, parseAlQuranCloudMeta } from '../src/core/data/alquranCloud.ts';
import { parseEighthsFile } from '../src/core/data/eighthsImport.ts';
import { QuranDataService, type Fetcher } from '../src/core/data/quranDataService.ts';
import { parseTanzilQuranDataJs } from '../src/core/data/tanzilMetadata.ts';
import { QuranText } from '../src/core/quran/text.ts';
import { skeleton, tokenize } from '../src/core/quran/tokenize.ts';
import { MemoryKeyValue } from '../src/core/storage/memoryStore.ts';
import { syntheticAlQuranCloudResponse, syntheticDivisions, syntheticText } from './fixtures/synthetic.ts';

describe('tokenizer (synthetic strings only)', () => {
  it('keeps every character and skips pause marks when numbering words', () => {
    const src = 'كلمة ۖ أخرى ثالثة ۩';
    const t = tokenize(src);
    assert.equal(t.map((x) => x.text).join(' '), src);
    assert.deepEqual(t.map((x) => x.position), [1, null, 2, 3, null]);
  });
  it('skeleton strips harakat only for comparison', () => {
    assert.equal(skeleton('كَلِمَةٌ'), 'كلمة');
  });
});

describe('QuranText edition wrapper', () => {
  const text = new QuranText(syntheticText());
  it('detects and separates the source-prepended opening on ayah 1 using the dataset\'s own 1:1', () => {
    const a = text.ayah({ surah: 2, ayah: 1 });
    assert.ok(a.basmalaPrefix);
    assert.equal(a.tokens[0]?.text, 'كلمة');
    assert.equal(text.ayah({ surah: 9, ayah: 1 }).basmalaPrefix, null);
    assert.equal(text.ayah({ surah: 1, ayah: 1 }).basmalaPrefix, null);
  });
  it('returns verbatim tokens by word position', () => {
    assert.equal(text.wordAt({ surah: 2, ayah: 2 }, 1), 'كلمة');
    assert.equal(text.wordAt({ surah: 2, ayah: 2 }, 99), null);
  });
  it('refuses incomplete editions', () => {
    assert.throws(() => new QuranText({ ...syntheticText(), ayat: ['x'] }));
  });
});

describe('AlQuran.cloud parser', () => {
  it('derives division starts from per-ayah metadata', () => {
    const parsed = parseAlQuranCloudFullQuran(syntheticAlQuranCloudResponse(), '2026-01-01T00:00:00Z');
    assert.equal(parsed.text.ayat.length, 6236);
    assert.deepEqual(parsed.divisions.quarterStarts, syntheticDivisions().quarterStarts);
    assert.equal(parsed.divisions.juzStarts.length, 30);
    assert.equal(parsed.divisions.pageStarts?.length, 604);
  });
  it('rejects a source whose ayah count differs from the verified count', () => {
    const r = syntheticAlQuranCloudResponse() as { data: { surahs: Array<{ ayahs: unknown[] }> } };
    r.data.surahs[1]?.ayahs.pop();
    assert.throws(() => parseAlQuranCloudFullQuran(r, 'x'), DataFormatError);
  });
  it('rejects decreasing or skipping quarter numbers', () => {
    const r = syntheticAlQuranCloudResponse() as { data: { surahs: Array<{ ayahs: Array<{ hizbQuarter: number }> }> } };
    const ayah = r.data.surahs[1]?.ayahs[100];
    if (ayah) ayah.hizbQuarter = 1;
    assert.throws(() => parseAlQuranCloudFullQuran(r, 'x'), /decreases/);
  });
  it('parses /meta references and diffs lists', () => {
    const meta = parseAlQuranCloudMeta({
      code: 200,
      data: { juzs: { count: 1, references: [{ surah: 1, ayah: 1 }] }, hizbQuarters: { count: 1, references: [{ surah: 1, ayah: 1 }] } },
    });
    assert.deepEqual(meta.juzStarts, [[1, 1]]);
    assert.deepEqual(diffStartLists([[1, 1], [2, 5]], [[1, 1], [2, 6]]), ['#2: 2:5 vs 2:6']);
  });
});

describe('Tanzil quran-data.js parser (format fixture)', () => {
  it('reads numeric arrays without executing the file and drops sentinels', () => {
    const js = `// comment\nvar QuranData = {};\nQuranData.Sura = [[], [0, 7, 5, 1, 'x', "y", 'z', 'Meccan']];\nQuranData.Juz = [ [], [1, 1], [2, 142], [115, 1] ];\nQuranData.HizbQaurter = [\n [], [1, 1], [2, 26],\n];\nQuranData.Page = [[], [1, 1], [2, 1]];`;
    const r = parseTanzilQuranDataJs(js);
    assert.deepEqual(r.juzStarts, [[1, 1], [2, 142]]);
    assert.deepEqual(r.quarterStarts, [[1, 1], [2, 26]]);
    assert.deepEqual(r.pageStarts, [[1, 1], [2, 1]]);
  });
  it('fails loudly when an array is missing', () => {
    assert.throws(() => parseTanzilQuranDataJs('QuranData.Juz = [[1,1]];'), DataFormatError);
  });
});

describe('eighths import parsing', () => {
  it('accepts the documented shapes', () => {
    assert.deepEqual(parseEighthsFile([[1, 1]]).eighthStarts, [[1, 1]]);
    assert.deepEqual(parseEighthsFile([{ surah: 2, ayah: 3 }]).eighthStarts, [[2, 3]]);
    assert.deepEqual(parseEighthsFile({ eighthStarts: [{ start: { surah: 2, ayah: 4 } }], label: 'L' }).eighthStarts, [[2, 4]]);
    assert.throws(() => parseEighthsFile([{ foo: 1 }]), DataFormatError);
  });
});

function fakeFetcher(routes: Record<string, unknown>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    if (!(url in routes)) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => structuredClone(routes[url]) };
  }) as Fetcher & { calls: string[] };
  f.calls = calls;
  return f;
}

describe('QuranDataService', () => {
  const quarters = syntheticDivisions().quarterStarts ?? [];
  const meta = {
    code: 200,
    data: {
      juzs: { count: 30, references: syntheticDivisions().juzStarts.map(([surah, ayah]) => ({ surah, ayah })) },
      hizbQuarters: { count: 240, references: quarters.map(([surah, ayah]) => ({ surah, ayah })) },
    },
  };
  const routes = {
    'https://api.alquran.cloud/v1/quran/quran-uthmani': syntheticAlQuranCloudResponse(),
    'https://api.alquran.cloud/v1/meta': meta,
  };

  it('starts with verified anchors only when nothing is cached or bundled', async () => {
    const svc = new QuranDataService({ cache: new MemoryKeyValue(), fetcher: fakeFetcher({}) });
    const st = await svc.init();
    assert.equal(st.origin, 'none');
    assert.equal(st.text, null);
    assert.equal(st.index.has('hizb'), false);
  });

  it('downloads, cross-checks, caches, and reloads offline from cache', async () => {
    const cache = new MemoryKeyValue();
    const svc = new QuranDataService({ cache, fetcher: fakeFetcher(routes) });
    const st = await svc.downloadFromAlQuranCloud();
    assert.equal(st.origin, 'download');
    assert.ok(st.text);
    assert.match(st.text.dataset.sha256 ?? '', /^[0-9a-f]{64}$/);
    const offline = new QuranDataService({ cache, fetcher: fakeFetcher({}) });
    const st2 = await offline.init();
    assert.equal(st2.origin, 'cache');
    assert.deepEqual(st2.index.range('hizb', 5).start, { surah: 2, ayah: 253 });
  });

  it('rejects data when /meta disagrees with the per-ayah metadata', async () => {
    const badMeta = structuredClone(meta);
    badMeta.data.hizbQuarters.references[50] = { surah: 9, ayah: 9 };
    const svc = new QuranDataService({ cache: new MemoryKeyValue(), fetcher: fakeFetcher({ ...routes, 'https://api.alquran.cloud/v1/meta': badMeta }) });
    await assert.rejects(svc.downloadFromAlQuranCloud(), /disagree/);
    assert.equal(svc.state.origin, 'none');
  });

  it('falls back to the official mirror when the main host fails', async () => {
    const mirror = {
      'https://alquran.api.islamic.network/v1/quran/quran-uthmani': routes['https://api.alquran.cloud/v1/quran/quran-uthmani'],
      'https://alquran.api.islamic.network/v1/meta': meta,
    };
    const fetcher = fakeFetcher(mirror);
    const svc = new QuranDataService({ cache: new MemoryKeyValue(), fetcher });
    const st = await svc.downloadFromAlQuranCloud();
    assert.equal(st.origin, 'download');
    assert.equal(fetcher.calls[0], 'https://api.alquran.cloud/v1/quran/quran-uthmani');
    assert.ok(fetcher.calls.includes('https://alquran.api.islamic.network/v1/meta'));
  });

  it('reports a clear error when no host is reachable and keeps the previous state', async () => {
    const svc = new QuranDataService({ cache: new MemoryKeyValue(), fetcher: fakeFetcher({}) });
    await assert.rejects(svc.downloadFromAlQuranCloud(), /Could not download/);
    assert.equal(svc.state.origin, 'none');
  });

  it('imports a consistent eighths list and rejects an inconsistent one', async () => {
    const svc = new QuranDataService({ cache: new MemoryKeyValue(), fetcher: fakeFetcher(routes) });
    await svc.downloadFromAlQuranCloud();
    const eighths = syntheticDivisions({ withEighths: true }).eighthStarts ?? [];
    const st = await svc.importEighths({ label: 'Test eighths', eighthStarts: eighths });
    assert.equal(st.index.count('eighth'), 480);
    await assert.rejects(svc.importEighths({ eighthStarts: eighths.slice(1) }), DataFormatError);
    assert.equal(svc.state.index.count('eighth'), 480, 'previous valid data kept');
    const removed = await svc.removeEighths();
    assert.equal(removed.index.has('eighth'), false);
  });
});
