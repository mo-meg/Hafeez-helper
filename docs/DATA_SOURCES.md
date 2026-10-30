# Quran data and audio: provenance, verification, licences

Hafeez Helfer never types, generates, paraphrases or re-spells Quranic text. All text and
division boundaries come from published datasets and are verified before use.

## Quran text

There is exactly **one** text edition — the app has no text-style switch and never downloads a
second text at runtime, so a word position saved with a mistake always points at the same word.

| Item | Source | Licence | How it reaches the app |
|---|---|---|---|
| Quran text (`kfgqpc-hafs-v30`) | King Fahd Glorious Quran Printing Complex, Madinah — the published *KFGQPC Hafs V30* DOCX in `public/KFGQPC-Hafs-V30/` | KFGQPC release; reproduced unmodified, not sold (see `public/KFGQPC-Hafs-V30/README.txt`) | `npm run data:import` writes `public/data/quran-text.json`; the app loads it (bundled, then cached offline) |
| Quran font | the matching *KFGQPC Hafs V30* TTF in `public/KFGQPC-Hafs-V30/` | Electronic end-user licence embedded in the font: free to use, copy and distribute; may not be sold, modified or decompiled ([full text](../public/fonts/LICENSE-KFGQPC-Hafs.txt)) | The build copies it to `/fonts/KFGQPC-Hafs-V30.ttf`; `public/fonts/fonts.css` declares it and it is the only Quran font |

Handling rules:

* The text is Hafs 'an 'Asim, Kufan count (6236 ayat), Uthmani orthography. It is the DOCX's own
  characters: surah titles separate the surahs, each ayah is followed by its marker `۝N`, and
  the basmala stands on its own line for every surah except Al-Fatihah (where it *is* 1:1) and
  At-Tawbah. Line breaks inside the document switch the bidirectional direction or wrap a word;
  they are **not** word boundaries and are dropped, never turned into spaces.
* The import refuses to write anything unless it finds 114 surah titles, the verified per-surah
  ayah counts (6236 in total), 1..n numbering inside every surah, and every juz / quarter / page
  start of `divisions.json` inside the text. Normalization (`skeleton()` in
  `src/core/quran/tokenize.ts`) is used **only for comparisons**, never for display.
* This edition encodes sukun as U+06E1 (not U+06D2-style tatweel + U+06E7 as Tanzil does) and
  attaches the sajda sign U+06E9 to the word it marks; `tests/data/realdata.datatest.ts` pins
  both. A SHA-256 of the text is recorded by the import and shown in Settings.
* UI strings are never Quran text: the app displays only what the dataset contains.
* Word references are `(edition, surah, ayah, position)` where position counts whitespace-separated
  tokens that contain at least one Arabic letter (pause marks such as ۖ ۗ ۚ and ۩ are kept
  but are not words). A verbatim snapshot of the token is stored with each word mistake; if
  the loaded edition changes, the UI flags "Edition changed" instead of silently pointing at a
  different word. No Quran.com word IDs are used (see "Why not the Quran.com API" below).

## Division metadata (juz, hizb, quarter, page)

Division boundaries are the only thing AlQuran.cloud is used for now. They are derived from the
per-ayah `juz`, `hizbQuarter` and `page` fields of its `quran-simple` response (Tanzil metadata,
Madani mushaf) — the ayah text in that response is validated for structure but never displayed.
A boundary is the first ayah where the number changes. Nothing is computed by dividing ayah or page counts. A hizb is by definition four
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
and every dataset — the downloaded divisions and the imported KFGQPC text — is checked against
them. Settings offers "Download the divisions again", which re-fetches and re-verifies them,
including agreement with the loaded text's structure.

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
