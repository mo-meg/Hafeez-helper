import { ANCHOR_ONLY_DATASET, DivisionIndex, type DivisionDataset } from '../quran/divisions.ts';
import { validateDivisionDataset, type ValidationResult } from '../quran/divisionValidation.ts';
import { QuranText, type QuranTextDataset } from '../quran/text.ts';
import { TOTAL_AYAT } from '../quran/surahs.ts';
import type { KeyValue } from '../storage/store.ts';
import { ALQURAN_CLOUD, DataFormatError, diffStartLists, parseAlQuranCloudFullQuran, parseAlQuranCloudMeta } from './alquranCloud.ts';
import { parseEighthsFile, withEighths } from './eighthsImport.ts';

export type Fetcher = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface QuranDataState {
  readonly text: QuranText | null;
  readonly index: DivisionIndex;
  readonly divisions: DivisionDataset;
  readonly validation: ValidationResult;
  /** Where the active data came from. */
  readonly origin: 'none' | 'cache' | 'bundled' | 'download' | 'fixture';
}

const KEY_TEXT = 'text';
const KEY_DIVISIONS = 'divisions';

export async function sha256Hex(text: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  const buf = await subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function anchorState(): QuranDataState {
  return { text: null, index: new DivisionIndex(ANCHOR_ONLY_DATASET), divisions: ANCHOR_ONLY_DATASET, validation: validateDivisionDataset(ANCHOR_ONLY_DATASET), origin: 'none' };
}

export function isTextDataset(x: unknown): x is QuranTextDataset {
  const o = x as QuranTextDataset | undefined;
  return !!o && o.schema === 'hafeez-text/1' && Array.isArray(o.ayat) && o.ayat.length === TOTAL_AYAT && o.ayat.every((a) => typeof a === 'string');
}

/**
 * Loads the KFGQPC Hafs V30 Quran text and the division metadata from local storage or from the
 * bundled data in `public/data/` (produced by `npm run data:fetch` + `npm run data:import`).
 * There is exactly one text: the app never fetches a different edition at runtime, so word
 * positions recorded in mistakes always refer to the same mushaf text.
 */
export class QuranDataService {
  private readonly cache: KeyValue;
  private readonly fetcher: Fetcher;
  private readonly bundledBase: string;
  private current: QuranDataState = anchorState();

  constructor(deps: { cache: KeyValue; fetcher: Fetcher; bundledBase?: string }) {
    this.cache = deps.cache;
    this.fetcher = deps.fetcher;
    this.bundledBase = deps.bundledBase ?? './data';
  }

  get state(): QuranDataState {
    return this.current;
  }

  private activate(text: QuranTextDataset | null, divisions: DivisionDataset, origin: QuranDataState['origin']): QuranDataState {
    const validation = validateDivisionDataset(divisions);
    if (!validation.ok) throw new DataFormatError(`Division data failed verification: ${validation.errors.slice(0, 3).join('; ')}`);
    this.current = { text: text ? new QuranText(text) : null, index: new DivisionIndex(divisions), divisions, validation, origin };
    return this.current;
  }

  async init(): Promise<QuranDataState> {
    const [cachedText, cachedDivisions] = await Promise.all([this.cache.get<unknown>(KEY_TEXT), this.cache.get<DivisionDataset>(KEY_DIVISIONS)]);
    if (isTextDataset(cachedText) && cachedDivisions) {
      try {
        return this.activate(cachedText, cachedDivisions, 'cache');
      } catch {
        // Corrupt or outdated cache: fall through to the bundled data.
      }
    }
    try {
      const [t, d] = await Promise.all([this.fetchJson(`${this.bundledBase}/quran-text.json`), this.fetchJson(`${this.bundledBase}/divisions.json`)]);
      if (isTextDataset(t) && d) {
        const state = this.activate(t, d as DivisionDataset, 'bundled');
        await this.persist(t, d as DivisionDataset);
        return state;
      }
      throw new DataFormatError('The bundled Quran data is incomplete.');
    } catch (e) {
      if (e instanceof DataFormatError && e.message.includes('incomplete')) throw e;
      // Bundled data absent: keep the verified division anchors so the app still starts.
      this.current = anchorState();
      return this.current;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await this.fetcher(url);
    if (!res.ok) throw new DataFormatError(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  private async persist(text: QuranTextDataset, divisions: DivisionDataset) {
    await this.cache.set(KEY_TEXT, text);
    await this.cache.set(KEY_DIVISIONS, divisions);
  }

  /** Downloads the division metadata (juz / quarter / page) and checks it against AlQuran.cloud /meta. */
  async downloadDivisions(onProgress: (msg: string) => void = () => { }): Promise<QuranDataState> {
    let base: string = ALQURAN_CLOUD.baseUrl;
    let json: unknown;
    onProgress('Downloading Quran division metadata from AlQuran.cloud…');
    try {
      json = await this.fetchJson(`${base}${ALQURAN_CLOUD.fullQuranPath(ALQURAN_CLOUD.defaultEdition)}`);
    } catch (first) {
      onProgress('Main server unreachable; trying the official mirror…');
      base = ALQURAN_CLOUD.mirrorBaseUrl;
      try {
        json = await this.fetchJson(`${base}${ALQURAN_CLOUD.fullQuranPath(ALQURAN_CLOUD.defaultEdition)}`);
      } catch {
        throw new DataFormatError(`Could not download the Quran data (${first instanceof Error ? first.message : String(first)}). Check your connection and try again.`);
      }
    }
    onProgress('Verifying division boundaries…');
    const parsed = parseAlQuranCloudFullQuran(json, new Date().toISOString());
    try {
      const meta = parseAlQuranCloudMeta(await this.fetchJson(`${base}${ALQURAN_CLOUD.metaPath}`));
      const diffs = [...diffStartLists(parsed.divisions.quarterStarts ?? [], meta.quarterStarts), ...diffStartLists(parsed.divisions.juzStarts, meta.juzStarts)];
      if (diffs.length) throw new DataFormatError(`Per-ayah metadata and /meta disagree: ${diffs.slice(0, 3).join(', ')}`);
    } catch (e) {
      if (e instanceof DataFormatError && e.message.startsWith('Per-ayah')) throw e;
      onProgress('Note: the /meta cross-check could not be performed; anchor verification still applies.');
    }
    if (this.current.divisions.quarterStarts) {
      const diffs = [
        ...diffStartLists(parsed.divisions.juzStarts, this.current.divisions.juzStarts),
        ...diffStartLists(parsed.divisions.quarterStarts ?? [], this.current.divisions.quarterStarts),
      ];
      if (diffs.length) throw new DataFormatError(`Downloaded divisions disagree with the loaded dataset: ${diffs.slice(0, 3).join(', ')}`);
    }
    return this.activate(this.current.text?.dataset ?? null, parsed.divisions, 'download');
  }

  async importEighths(json: unknown): Promise<QuranDataState> {
    if (!this.current.divisions.quarterStarts) throw new DataFormatError('Load the Quran division data before importing eighths.');
    const base: DivisionDataset = { ...this.current.divisions };
    delete (base as { eighthStarts?: unknown }).eighthStarts;
    const { dataset, validation } = withEighths(base, parseEighthsFile(json));
    if (!validation.ok) throw new DataFormatError(validation.errors.slice(0, 3).join(' '));
    const state = this.activate(this.current.text?.dataset ?? null, dataset, this.current.origin);
    await this.cache.set(KEY_DIVISIONS, dataset);
    return state;
  }

  async removeEighths(): Promise<QuranDataState> {
    const d: DivisionDataset = { ...this.current.divisions };
    delete (d as { eighthStarts?: unknown }).eighthStarts;
    delete (d as { eighthsSource?: unknown }).eighthsSource;
    const state = this.activate(this.current.text?.dataset ?? null, d, this.current.origin);
    await this.cache.set(KEY_DIVISIONS, d);
    return state;
  }

  /** Clears cached copies; the bundled text and divisions are loaded again. */
  async clearCache(): Promise<QuranDataState> {
    await this.cache.delete(KEY_TEXT);
    await this.cache.delete(KEY_DIVISIONS);
    this.current = anchorState();
    return this.current;
  }

  /** Used by tests and the browser harness only. Synthetic datasets are flagged in the UI. */
  useFixture(text: QuranTextDataset | null, divisions: DivisionDataset): QuranDataState {
    return this.activate(text, divisions, 'fixture');
  }
}
