import { ANCHOR_ONLY_DATASET, DivisionIndex, type DivisionDataset } from '../quran/divisions.ts';
import { validateDivisionDataset, type ValidationResult } from '../quran/divisionValidation.ts';
import { QuranText, type QuranTextDataset } from '../quran/text.ts';
import { TOTAL_AYAT } from '../quran/surahs.ts';
import type { KeyValue } from '../storage/store.ts';
import { ALQURAN_CLOUD, DataFormatError, diffStartLists, parseAlQuranCloudFullQuran, parseAlQuranCloudMeta, QURAN_TEXT_EDITIONS, type QuranTextEdition } from './alquranCloud.ts';
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
const KEY_ACTIVE_EDITION = 'activeTextEdition';
const textKey = (edition: QuranTextEdition) => `text:${edition}`;
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

function isTextDataset(x: unknown): x is QuranTextDataset {
  const o = x as QuranTextDataset | undefined;
  return !!o && o.schema === 'hafeez-text/1' && Array.isArray(o.ayat) && o.ayat.length === TOTAL_AYAT && o.ayat.every((a) => typeof a === 'string');
}

/**
 * Loads Quran text and division metadata from local storage or bundled data. If Hafs Simple
 * text is not available locally, startup downloads it from AlQuran.cloud; a failed request
 * leaves any local text or verified division anchors available. Divisions are validated
 * against the verified anchors before use.
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
    const [activeEdition, legacyText, divisions] = await Promise.all([
      this.cache.get<QuranTextEdition>(KEY_ACTIVE_EDITION),
      this.cache.get<unknown>(KEY_TEXT),
      this.cache.get<DivisionDataset>(KEY_DIVISIONS),
    ]);
    if (divisions) {
      try {
        const validActiveEdition = activeEdition === QURAN_TEXT_EDITIONS.simple || activeEdition === QURAN_TEXT_EDITIONS.uthmani ? activeEdition : undefined;
        const selectedText = validActiveEdition ? await this.cache.get<unknown>(textKey(validActiveEdition)) : undefined;
        const simpleText = await this.cache.get<unknown>(textKey(QURAN_TEXT_EDITIONS.simple));
        const text = isTextDataset(selectedText) && selectedText.edition === validActiveEdition
          ? selectedText
          : isTextDataset(legacyText) ? legacyText : null;
        const state = this.activate(text, divisions, text ? 'cache' : 'none');
        const edition = text?.edition === QURAN_TEXT_EDITIONS.simple ? QURAN_TEXT_EDITIONS.simple : text?.edition === QURAN_TEXT_EDITIONS.uthmani ? QURAN_TEXT_EDITIONS.uthmani : undefined;
        if (edition && text && !isTextDataset(selectedText)) await this.cache.set(textKey(edition), text);
        if (edition) await this.cache.set(KEY_ACTIVE_EDITION, edition);
        // Preserve Uthmani only when Simple is also cached, which means the user selected
        // Uthmani after Simple became the default. Older installs only have Uthmani cached.
        const keepUthmani = validActiveEdition === QURAN_TEXT_EDITIONS.uthmani && isTextDataset(simpleText) && simpleText.edition === QURAN_TEXT_EDITIONS.simple;
        if (state.text?.edition === QURAN_TEXT_EDITIONS.simple || keepUthmani) return state;
        return await this.loadDefaultSimple(state);
      } catch {
        // Corrupt or outdated cache: fall through to bundled data.
      }
    }
    try {
      const [t, d] = await Promise.all([this.fetchJson(`${this.bundledBase}/quran-text.json`), this.fetchJson(`${this.bundledBase}/divisions.json`)]);
      if (isTextDataset(t) && d) {
        const state = this.activate(t, d as DivisionDataset, 'bundled');
        await this.persist(t, d as DivisionDataset);
        return state.text?.edition === QURAN_TEXT_EDITIONS.simple ? state : await this.loadDefaultSimple(state);
      }
    } catch {
      // No bundled data available — expected unless `npm run data:fetch` was run.
    }
    this.current = anchorState();
    return await this.loadDefaultSimple(this.current);
  }

  private async loadDefaultSimple(fallback: QuranDataState): Promise<QuranDataState> {
    try {
      return await this.setEdition(QURAN_TEXT_EDITIONS.simple);
    } catch {
      return fallback;
    }
  }

  private async fetchJson(url: string): Promise<unknown> {
    const res = await this.fetcher(url);
    if (!res.ok) throw new DataFormatError(`HTTP ${res.status} for ${url}`);
    return res.json();
  }

  private async persist(text: QuranTextDataset | null, divisions: DivisionDataset) {
    if (text) {
      await this.cache.set(KEY_TEXT, text);
      const edition = text.edition === QURAN_TEXT_EDITIONS.simple ? QURAN_TEXT_EDITIONS.simple : text.edition === QURAN_TEXT_EDITIONS.uthmani ? QURAN_TEXT_EDITIONS.uthmani : undefined;
      if (edition) {
        await this.cache.set(textKey(edition), text);
        await this.cache.set(KEY_ACTIVE_EDITION, edition);
      }
    }
    await this.cache.set(KEY_DIVISIONS, divisions);
  }

  /** Downloads text + per-ayah metadata (one request) and cross-checks against /meta. */
  async downloadFromAlQuranCloud(onProgress: (msg: string) => void = () => {}): Promise<QuranDataState> {
    return this.setEdition(QURAN_TEXT_EDITIONS.uthmani, onProgress);
  }

  async setEdition(edition: QuranTextEdition, onProgress: (msg: string) => void = () => {}): Promise<QuranDataState> {
    const cached = await this.cache.get<unknown>(textKey(edition));
    if (isTextDataset(cached) && cached.edition === edition) {
      const state = this.activate(cached, this.current.divisions, 'cache');
      await this.cache.set(KEY_ACTIVE_EDITION, edition);
      return state;
    }
    onProgress('Downloading Quran text and metadata from AlQuran.cloud…');
    let base: string = ALQURAN_CLOUD.baseUrl;
    let json: unknown;
    try {
      json = await this.fetchJson(`${base}${ALQURAN_CLOUD.fullQuranPath(edition)}`);
    } catch (first) {
      onProgress('Main server unreachable; trying the official mirror…');
      base = ALQURAN_CLOUD.mirrorBaseUrl;
      try {
        json = await this.fetchJson(`${base}${ALQURAN_CLOUD.fullQuranPath(edition)}`);
      } catch {
        throw new DataFormatError(`Could not download the Quran data (${first instanceof Error ? first.message : String(first)}). Check your connection and try again.`);
      }
    }
    onProgress('Verifying text structure and division boundaries…');
    const parsed = parseAlQuranCloudFullQuran(json, new Date().toISOString());
    try {
      const meta = parseAlQuranCloudMeta(await this.fetchJson(`${base}${ALQURAN_CLOUD.metaPath}`));
      const diffs = [...diffStartLists(parsed.divisions.quarterStarts ?? [], meta.quarterStarts), ...diffStartLists(parsed.divisions.juzStarts, meta.juzStarts)];
      if (diffs.length) throw new DataFormatError(`Per-ayah metadata and /meta disagree: ${diffs.slice(0, 3).join(', ')}`);
    } catch (e) {
      if (e instanceof DataFormatError && e.message.startsWith('Per-ayah')) throw e;
      onProgress('Note: the /meta cross-check could not be performed; anchor verification still applies.');
    }
    const sha = await sha256Hex(parsed.text.ayat.join('\n'));
    const text: QuranTextDataset = { ...parsed.text, ...(sha ? { sha256: sha } : {}) };
    const existingDivisions = this.current.divisions.quarterStarts ? this.current.divisions : parsed.divisions;
    if (this.current.divisions.quarterStarts) {
      const diffs = [
        ...diffStartLists(parsed.divisions.juzStarts, this.current.divisions.juzStarts),
        ...diffStartLists(parsed.divisions.quarterStarts ?? [], this.current.divisions.quarterStarts),
      ];
      if (diffs.length) throw new DataFormatError(`Selected edition divisions disagree with the loaded dataset: ${diffs.slice(0, 3).join(', ')}`);
    }
    const state = this.activate(text, existingDivisions, 'download');
    await this.cache.set(textKey(edition), text);
    await this.cache.set(KEY_ACTIVE_EDITION, edition);
    await this.cache.set(KEY_DIVISIONS, existingDivisions);
    onProgress('Quran data verified and saved for offline use.');
    return state;
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

  async clearCache(): Promise<QuranDataState> {
    await this.cache.delete(KEY_TEXT);
    await this.cache.delete(textKey(QURAN_TEXT_EDITIONS.uthmani));
    await this.cache.delete(textKey(QURAN_TEXT_EDITIONS.simple));
    await this.cache.delete(KEY_ACTIVE_EDITION);
    await this.cache.delete(KEY_DIVISIONS);
    this.current = anchorState();
    return this.current;
  }

  /** Used by tests and the browser harness only. Synthetic datasets are flagged in the UI. */
  useFixture(text: QuranTextDataset | null, divisions: DivisionDataset): QuranDataState {
    return this.activate(text, divisions, 'fixture');
  }
}
