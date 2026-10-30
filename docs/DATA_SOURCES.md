# Quran data and audio: provenance, verification, licences

Hafeez Helfer never types, generates, paraphrases or re-spells Quranic text. All text and
division boundaries come from published datasets and are verified before use.

## Quran text

| Item | Source | Licence | How it reaches the app |
|---|---|---|---|
| Uthmani text (`quran-uthmani`) | [Tanzil.net](https://tanzil.net) via [AlQuran.cloud](https://alquran.cloud/api) `GET /v1/quran/quran-uthmani` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/): attribution to Tanzil required | Downloaded from Settings and cached for offline use; can also be bundled with `npm run data:fetch` |
| Simple text (`quran-simple`) | [Tanzil.net](https://tanzil.net) via [AlQuran.cloud](https://alquran.cloud/api) `GET /v1/quran/quran-simple` | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/): attribution to Tanzil required | Downloaded on selection in Settings and cached for offline use |

Handling rules:

* Both styles use Hafs narration and the same ayah numbering. Text follows Tanzil's
  published text-encoding updates (including tatweel + U+06E7 for
  medial U+06E6 small yeh); word-final U+06E6 is retained. Other text remains verbatim
  (diacritics, Uthmani orthography, pause marks). Normalization
  (`skeleton()` in `src/core/quran/tokenize.ts`) is used **only for comparisons**, never for display.
* AlQuran.cloud prepends the basmala to the first ayah of each surah (except 1 and 9). The app
  detects it by comparing with the dataset's **own** text of 1:1 and shows it as a header, so
  word positions in ayah 1 start at the first word of the ayah itself.
* A SHA-256 of the text is recorded at download time and shown in Settings.
* Word references are `(edition, surah, ayah, position)` where position counts whitespace-separated
  tokens that contain at least one Arabic letter (pause marks such as ۖ ۗ ۚ and ۩ are kept
  but are not words). A verbatim snapshot of the token is stored with each word mistake; if
  the loaded edition changes, the UI flags "Edition changed" instead of silently pointing at a
  different word. No Quran.com word IDs are used (see "Why not the Quran.com API" below).

## Division metadata (juz, hizb, quarter, page)

Derived from the per-ayah `juz`, `hizbQuarter` and `page` fields of the same AlQuran.cloud
response (Tanzil metadata, Madani mushaf). A boundary is the first ayah where the number
changes. Nothing is computed by dividing ayah or page counts. A hizb is by definition four
quarters, so hizb *n* starts where quarter 4n−3 starts.

Before any dataset is used, `validateDivisionDataset()` checks:

1. Exact counts (30 juz, 240 quarters, 604 pages), valid references, strictly increasing order, first entry 1:1.
2. Every 8th quarter coincides with the corresponding juz start.
3. All 30 juz starts equal the **bundled verified anchors**, and hizb 1–11 starts equal the bundled hizb anchors (`src/core/quran/anchors.ts`):
   * Juz 1–14: [assabile.com/quran/juz](https://www.assabile.com/quran/juz); Juz 15–30: [quran411.com/juz-breakdown](https://quran411.com/juz-breakdown) (corroborated by myislam.org and versesurah.com).
   * Hizb 1–11: [Wikipedia, "Juz'"](https://en.wikipedia.org/wiki/Juz') hizb table.
   * Note: some Indo-Pak tables start Juz 4 at 3:92; the Madani mushaf and Tanzil use 3:93. A dataset with 3:92 is rejected for this edition rather than mixed in.
4. In the browser, the per-ayah boundaries must also agree with AlQuran.cloud `/v1/meta`.
   `npm run data:fetch` additionally compares with Tanzil's original
   [`quran-data.js`](https://tanzil.net/res/text/metadata/quran-data.js) (CC BY 3.0). Any disagreement means nothing is saved.

Surah ayah counts (Hafs/Kufan, 6236 in total) are bundled in `src/core/quran/surahs.ts`
and every downloaded dataset is checked against them.

### Eighths (thumn)

Eighths are a Maghrebi division and are **not** part of the Madani/Hafs metadata published by
Tanzil, AlQuran.cloud or Quran.com. The only verified eighth dataset found during research
([nuralhifz-data](https://github.com/smartmaker-devs/nuralhifz-data), CC BY 4.0) uses Warsh
numbering (6214 ayat) and some eighths start mid-ayah, so it cannot be combined with Hafs text.

The app therefore supports eighths through **import** (Settings, Quran text and divisions):

```json
{
  "label": "My mushaf's eighths",
  "source": { "name": "…", "url": "…", "license": "…" },
  "eighthStarts": [[1, 1], [2, 1], ...]
}
```

Also accepted: a bare array of `[surah, ayah]`, of `{ "surah", "ayah" }`, or of
`{ "start": { "surah", "ayah" } }`. Exactly 480 entries in mushaf order, using the same ayah
numbering as the loaded text; every odd eighth must coincide with a quarter start, otherwise
the file is rejected with an explanation.

## Why not the Quran.com API

The Quran.com v4 API at `api.quran.com` is described by the Quran Foundation as the "old
integration"; the current Content APIs require OAuth2 client credentials, which a client-only
app cannot keep secret ([migration guide](https://api-docs.quran.foundation/docs/quickstart/migration/)).
Adding a backend proxy only for word IDs was not justified for the MVP. A future optional proxy
could add Quran.com word IDs and word-level audio segments.

## Audio

Nothing is bundled. Files are streamed per ayah from the selected host, or played from the
local offline copy if the user explicitly saved them.

| Reciter preset | Host and URL pattern | Status |
|---|---|---|
| Mahmoud Khalil Al-Husary (Murattal) | `https://everyayah.com/data/Husary_128kbps/{surah3}{ayah3}.mp3` | Folder documented publicly |
| Al-Husary (Mujawwad) | `…/Husary_128kbps_Mujawwad/…` | Folder documented publicly |
| Ali Al-Hudhaify | `…/Hudhaify_128kbps/…` | Folder documented publicly |
| Muhammad Ayyoub | `…/Muhammad_Ayyoub_128kbps/…` | Folder documented publicly |
| Al-Minshawi (Murattal), Abdul Basit (Murattal), Alafasy | EveryAyah folders | Unverified: use **Test** in Settings |
| Al-Husary (Islamic Network CDN) | `https://cdn.islamic.network/quran/audio/128/ar.husary/{global}.mp3` | Unverified: use **Test** |

EveryAyah states no open licence; recordings belong to the reciters and their publishers.
The app streams them, and offline copies are personal and made only on explicit request (and
only if the host permits cross-origin downloads). Users can add their own source with a URL
template (`{surah3}{ayah3}`, `{surah}`, `{ayah}` or `{global}`).

Word-level audio positioning is not available: no verified per-word timing data is
integrated, so the whole ayah is played and the UI says so.

## Licences of dependencies

| Package | Use | Licence |
|---|---|---|
| zod 3.25 | runtime validation | MIT |
| esbuild 0.28 | bundler (dev) | MIT |
| typescript 7.0 | type checking (dev) | Apache-2.0 |
| @types/node | types (dev) | MIT |
