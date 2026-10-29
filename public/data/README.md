# Bundled Quran data (optional)

This folder is empty in the repository on purpose. Quran text is never typed or edited by hand.

Run `npm run data:fetch` (needs internet) to download and verify:

* `quran-text.json`: Tanzil Uthmani text via AlQuran.cloud (`quran-uthmani`), CC BY 3.0, verbatim.
* `divisions.json`: juz / hizb-quarter / page starts derived from the same source and cross-checked
  against AlQuran.cloud `/meta`, Tanzil `quran-data.js`, and the verified anchors bundled in the app.

When these files exist, the app loads them on first start (no runtime download needed).
If they are absent, users can download the same data from Settings → Quran text and divisions.
See `docs/DATA_SOURCES.md` for provenance and licences.
