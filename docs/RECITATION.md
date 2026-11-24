# Recitation tracker

Status: engine replaced 2026-11-24 (the local NeMo server and the shared tunnel are gone). Route
`#/recite` ("Recitation tracker" / «متابعة التلاوة»).

## How it works

```
microphone ─► src/browser/micCapture.ts        16 kHz mono float, in memory only
           ─► core/recitation/engine.ts         RecitationEngine interface (streaming takes)
                ◄─ browser/tajweedEngine.ts      @quran-lab/tajweedformer 4.0.2 → Quran Lab frame + Worker
           ─► core/recitation/controller.ts     settled words only, once each
           ─► core/recitation/tracker.ts        two-stage matching against the corpus
           ─► core/recitation/mistakeBridge.ts  ─► existing MistakeService (markWord)
UI: src/ui/views/recite.ts (no recognition logic in the UI)
```

**The model.** TajweedFormer V4 by Quran Lab (65 M parameters, streaming). It is a *sound-unit*
model: it does not write Arabic words but the units it heard (38 in all), grouped into words at
the word bar, with timing and confidence, every 320 ms. Licence NPL-1.2: free, never charge for a
feature it powers, and show that automatic feedback can be wrong (shown on the page).

**Comparison text.** Because the model writes no Arabic, the tracker compares sound units with
sound units: the model ships a reference table with the expected units of every ayah
(`model.reference.units(surah, ayah)`). After the model loads, `core/recitation/unitCorpus.ts`
reads all 6236 ayat once and gives every canonical KFGQPC word its expected units as comparison
form (`corpus.kind === 'units'`). Display, word positions and mistake snapshots still use the
canonical text only. If the table counts the words of an ayah differently, its forms are spread
over the canonical words (`mapForms`); the count of such ayat is logged in the console.
Isti'adha/basmala forms are taken from where those words occur in the text.

**Word boundaries (measured 2026-11-24, first real test, 3:33).** The model heard the ayah
correctly but emitted **no word bar** in continuous recitation, so the SDK's `decoded.words` was one
giant word and nothing matched. The app therefore ignores the model's word grouping:
`core/recitation/segment.ts` aligns the flat stream of heard units with the expected units of the
text (unit-level edit distance; near the tracker's cursor, or — while searching — in the whole
Quran via unit 6-grams, locked only with a clear margin so refrains wait for more), and every heard
unit takes the word of the expected unit it lines up with. Extra sounds that fit nowhere (noise,
preamble) are dropped; a wrong sound inside a word stays a substitution for the tracker.

**Streaming.** One take per listening stretch. Every update carries the whole take; settled units
are segmented, and a word is handed to the tracker once, when the next word has begun; the rest at
the end of the take. Pause ends the take, resume opens a new one; a take the SDK ends by
itself (20-minute limit) is continued in a new one. Session time counts fed audio only.

The tracker itself (stage A global search, stage B focused, word states, self-correction window,
hesitation, saving) is unchanged and engine-agnostic; see the code comments in `tracker.ts`.

## Setup (once)

1. Sign in at <https://sdk.quranlab.ai> (Hugging Face account), accept the licence, create the app.
2. Create **web keys** for the origins: a development key for `http://127.0.0.1:5173` /
   `http://localhost:*`, and a production key for `https://mo-meg.github.io`.
3. Local: put `HAFEEZ_QURANLAB_KEY=qlk_v1_…` (the development key) in `.env`, then
   `npm run build && npm start`. The key is compiled into the build (it is public by design).
4. GitHub Pages: set the repository **variable** `HAFEEZ_QURANLAB_KEY` (Settings → Secrets and
   variables → Actions → Variables) to the production key and re-run the deploy workflow.

Without a key the tracker is hidden in production builds (shown with a notice in `--watch` builds
or with `HAFEEZ_ENABLE_RECITE=1`).

SDK 4.x (required: keys refuse 3.x with `sdk_too_old`; 3.x stops getting the model on
2027-01-15) is a tiny wrapper, bundled into main.js. On the first start it loads Quran Lab's hosted
loader (`https://web.quranlab.ai/4/loader.js`, with fallback hosts), which runs the engine and the
encrypted model in a Quran Lab iframe and Worker; our page never sees the model files. The
Docker/nginx CSP lists Quran Lab's hosts in `script-src` and `frame-src` (`connect-src https:`
already covers the rest). Needs a secure context (https or localhost/127.0.0.1) and a current
browser.

## Privacy

Recognition runs in the browser (inside Quran Lab's frame). Quran Lab receives: the key check and
model lease, the model download (first time, ~55 MB, then cached; offline afterwards), anonymous
daily usage totals and anonymous failure reports (always on in 4.x; no audio, text or identifiers).
In 4.x every learner may be asked by the SDK's own sheet (never right after install, not before the
3rd completed take) whether to share recordings; nothing is uploaded unless the learner says "Share".

## Tests

`tests/recitation.test.ts`: tracker behaviour (synthetic fixture), the sound-unit corpus built from a
fake reference table, mapping of the SDK's decoded layer (`toUpdate`), and the controller with a fake
streaming engine (settled words once, end of take, engine take end/error, pause/resume, microphone and
model failures). **Not verified yet with the real model**: this needs a web key, which the sandbox
does not have. First real check: open `#/recite`, start, recite e.g. Al-Kahf 18:10 and confirm the
location appears; check the console for mismatched ayat.

## Data note

KFGQPC's own `hafsData_v18.json` gives page starts that differ from the app's `divisions.json` on
25 of 604 pages; the tracker uses the app's divisions (an open, app-wide decision).
