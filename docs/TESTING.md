# Testing

| Command | What it runs |
|---|---|
| `npm test` | 123 unit and integration tests (Node's built-in `node:test`, TypeScript run natively by Node ≥ 22.18) |
| `npm run typecheck` | `tsc` in strict mode (`noUncheckedIndexedAccess`, `erasableSyntaxOnly`, …) |
| `npm run lint` | Project rules: no HTML injection, no `eval`, no `console.log`, no TODOs, and `src/core` must not touch the DOM or import UI/browser code |
| `npm run test:e2e` | Builds the browser harness `dist-harness/harness.html`; open it in a browser to run 21 end-to-end journeys |
| `npm run test:data` | Checks the real dataset in `public/data` (after `npm run data:fetch`); skipped if absent |
| `npm run verify` | lint, typecheck, tests, and production build |

## Unit and integration tests (`tests/`)

| File | Tests | Covers |
|---|---|---|
| `quran.test.ts` | 23 | 6236 total; index ↔ reference for every ayah; cross-surah navigation; canonical sorting; verified juz ranges; Hizb 5 = 2:253–3:14; quarters/eighths tile hizbs exactly; dataset validation rejects wrong anchors, counts, order, the 3:92 Juz 4 variant, inconsistent eighths; scopes |
| `data.test.ts` | 18 | Tokenizer keeps every character, skips pause marks; basmala-prefix detection; AlQuran.cloud parser derives boundaries and rejects bad counts/sequences; Tanzil `quran-data.js` parser; eighths import; data service: anchors-only start, download → cache → offline reload, /meta mismatch rejection, mirror fallback, eighths import/removal |
| `mistakes.test.ts` | 13 | Word and ayah marking; validation; no duplicates (recurrence instead); note editing; resolve/reopen with preserved history; status rules; one recall applied to all words of an ayah; never auto-resolves; schedule override; explicit deletion; filters |
| `review.test.ts` | 15 | Policy table; streak once per session; scheduler ladder and factors; quality score: null without data, unaffected by playback, moves with outcomes, per-session dedupe, staleness, reopened mistakes, scope |
| `playlist.test.ts` | 14 | Only in-scope unresolved mistakes; Quran order; one entry per ayah with grouped words; per-word practice; context only on request; overlapping windows merge; surah-bounded context; category/status filters; empty playlist; exact repetition counts (5 = five plays); group and playlist passes; pauses; combined sessions; duration estimate |
| `playback.test.ts` | 14 | Mocked audio: exact plays per ayah in order; pauses; 3/5 indicator; missing audio stops with an explicit error, retry, explicit skip recorded; offline-unavailable error; mid-play network error; next/prev/restart/next-mistake/restart-playlist/stop; pause during gap; assessment pause; stale-load race; playback rate; URL templates |
| `plan-dashboard-backup.test.ts` | 11 | One plan per date; session completion completes plan and resolves nothing; next-portion suggestion; dashboard zero state and real-history aggregation; backup round-trip, rejection of invalid/orphaned/future backups, merge semantics, wipe; demo data flagged and removable; preferences repair |
| `test-mode.test.ts` | 11 | Auto "linking ayat" type for first words and its review interval; test cards: one per ayah, Quran order, unresolved by default; hide from the first marked word; transition/first-word/whole-ayah cards show the previous ayah (across surahs; none before 1:1); deterministic shuffle; hint/reveal and allowed answers; answers recorded, nothing resolved |
| `session.test.ts` | 4 | Mistakes / full / combined session assembly; reminder decision; .ics generation |

## Browser end-to-end harness (`harness/harness.ts`)

The harness bundles the **real UI and the real IndexedDB adapter** with a mocked audio
backend (15 ms per "file") and synthetic placeholder text, then drives the DOM like a user.
Result in this environment, from the in-app preview browser: **21/21 passed with IndexedDB**:

1. Open Hizb 5 with verified boundaries (2:253 to 3:14), four quarters and eight eighths listed.
2. Text is RTL.
3. Selecting a subdivision navigates to its start.
4. Mark a whole ayah (2:260).
5. Mark a word (2:255, word 2) with type and note.
6. Re-marking the same word records a recurrence, no duplicate.
7. Mark a mistake outside the assignment (18:28).
8. Mistakes persist after restarting the app on the same IndexedDB.
9. Set today's revision to Hizb 5 (2 unresolved, 18:28 excluded).
10. Playlist preview is in Quran order (2:255 before 2:260 although marked later); 3 plays each gives 6 total.
11. Playback loads 002255 ×3 then 002260 ×3, pauses for recall, records answers.
12. Finishing completes the plan; nothing is auto-resolved (statuses under review / needs practice).
13. Dashboard counts reflect only recorded data.
14. Resolve and reopen from My mistakes, with history kept.
15. Missing audio: explicit error, nothing skipped until the user chooses "Skip this ayah".
16. Tapping the first word of an ayah pre-selects "Linking ayat".
17. Test (Hizb 5): the card for 2:255 shows word 1 and hides from the marked word 2 to the end; a hint uncovers one word; after a hint "correct" answers are disabled.
18. Test: the linking card for 2:256 shows 2:255 in full and hides all of 2:256; a whole-ayah mistake (2:260) shows 2:259; answers and the test session are saved; nothing is resolved.
19. Test: two mistakes in 2:257 (words 2 and 4): reveal shows words 2–3 and keeps word 4 hidden; after answering, the second step reveals the rest; each mistake gets its own answer.
20. Backup export/restore round-trip.
21. Every button and link on each page (including Test) has an accessible name.

`showcase-*.html` files in `dist-harness/` run the same journeys and stop on a given screen for
visual review.

## Not automated here

* ESLint/Prettier, Playwright and React Testing Library could not be installed (no package-registry
  access in the build environment). The project lint script and the in-browser harness stand in
  for them; adding Playwright to run `harness.html` headlessly in CI is a natural next step.
* Real network audio and real AlQuran.cloud downloads were not exercised (no internet in the build
  environment). Parsers are tested against the documented response shape; `npm run test:data`
  validates the real dataset once downloaded.
* Docker image build was not run (no Docker in the build environment).
