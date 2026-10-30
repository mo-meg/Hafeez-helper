# Bundled Quran data

`quran-text.json` and `divisions.json` are committed here: the app has no runtime text download, so
static hosting (GitHub Pages, Docker) serves `dist/data/` from these files. They are generated, never
edited by hand — regenerate both after changing the app or its sources and commit the result.

* `npm run data:import` (no network) converts the KFGQPC Hafs V30 DOCX in
  `public/KFGQPC-Hafs-V30/` into `quran-text.json` and verifies it: 114 surah titles, 6236 ayat,
  Hafs per-surah counts, 1..n numbering, and every division start inside the text.
* `npm run data:fetch` (needs internet) downloads and verifies `divisions.json`: juz / hizb-quarter
  / page starts derived from AlQuran.cloud's per-ayah metadata (Tanzil, CC BY 3.0) and cross-checked
  against AlQuran.cloud `/meta`, Tanzil `quran-data.js`, and the verified anchors bundled in the app.

Run the import after the fetch, so it can also check the divisions against the text. When these
files exist, the build ships them and the app loads them on first start (no runtime download).
Users can download the divisions again from Settings → Quran text and divisions.
See `docs/DATA_SOURCES.md` for provenance and licences.
