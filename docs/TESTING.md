# Testing

| Command | What it runs |
|---|---|
| `npm test` | 150 unit and integration tests (Node's built-in `node:test`, TypeScript run natively by Node ≥ 22.18) |
| `npm run typecheck` | `tsc` in strict mode (`noUncheckedIndexedAccess`, `erasableSyntaxOnly`, …) |
| `npm run lint` | Project rules: no HTML injection, no `eval`, no `console.log`, no TODOs, and `src/core` must not touch the DOM or import UI/browser code |
| `npm run test:e2e` | Builds the browser harness `dist-harness/harness.html`; open it in a browser to run 30 end-to-end journeys (English, Arabic, accounts) |
| `npm run test:data` | Checks the real datasets in `public/data` (after `npm run data:import` and `npm run data:fetch`); skipped if absent |
| `npm run verify` | lint, typecheck, tests, and production build |

## Unit and integration tests (`tests/`)

| File | Tests | Covers |
|---|---|---|
| `quran.test.ts` | 23 | 6236 total; index ↔ reference for every ayah; cross-surah navigation; canonical sorting; verified juz ranges; Hizb 5 = 2:253–3:14; quarters/eighths tile hizbs exactly; dataset validation rejects wrong anchors, counts, order, the 3:92 Juz 4 variant, inconsistent eighths; scopes |
| `data.test.ts` | 18 | Tokenizer keeps every character, skips pause marks; basmala-prefix detection; AlQuran.cloud parser derives boundaries and rejects bad counts/sequences; Tanzil `quran-data.js` parser; eighths import; data service: anchors-only start, bundled text → cache → offline reload, a damaged cache never hides the bundled text, divisions download, /meta mismatch rejection, mirror fallback, eighths import/removal |
| `kfgqpc-import.test.ts` | 5 | The KFGQPC DOCX importer on a synthetic WordprocessingML document: ayat split at `۝N`, line breaks dropped (never spaced), basmala lines recognised, missing/swapped/extra ayat rejected, standalone marks reported |
| `mistakes.test.ts` | 13 | Word and ayah marking; validation; no duplicates (recurrence instead); note editing; resolve/reopen with preserved history; status rules; one recall applied to all words of an ayah; never auto-resolves; schedule override; explicit deletion; filters |
| `review.test.ts` | 15 | Policy table; streak once per session; scheduler ladder and factors; quality score: null without data, unaffected by playback, moves with outcomes, per-session dedupe, staleness, reopened mistakes, scope |
| `playlist.test.ts` | 14 | Only in-scope unresolved mistakes; Quran order; one entry per ayah with grouped words; per-word practice; context only on request; overlapping windows merge; surah-bounded context; category/status filters; empty playlist; exact repetition counts (5 = five plays); group and playlist passes; pauses; combined sessions; duration estimate |
| `playback.test.ts` | 14 | Mocked audio: exact plays per ayah in order; pauses; 3/5 indicator; missing audio stops with an explicit error, retry, explicit skip recorded; offline-unavailable error; mid-play network error; next/prev/restart/next-mistake/restart-playlist/stop; pause during gap; assessment pause; stale-load race; playback rate; URL templates |
| `plan-dashboard-backup.test.ts` | 11 | One plan per date; session completion completes plan and resolves nothing; next-portion suggestion; dashboard zero state and real-history aggregation; backup round-trip, rejection of invalid/orphaned/future backups, merge semantics, wipe; demo data flagged and removable; preferences repair |
| `test-mode.test.ts` | 12 | Auto "linking ayat" type for first words and its review interval; test cards: one per ayah, Quran order, unresolved by default; hide from the first marked word; transition/first-word/whole-ayah cards show the previous ayah (across surahs; none before 1:1); deterministic shuffle; hint/reveal and allowed answers; answers recorded, nothing resolved |
| `session.test.ts` | 4 | Mistakes / full / combined session assembly; reminder decision; .ics generation |
| `sync.test.ts` | 13 | Against a simulated Supabase server: local-only unless both config values are set; sign-up, sign-in, error codes (both GoTrue formats), email-confirmation flow, network errors; email-link fragment parsing; token refresh shared by concurrent callers and expired sessions; upload then restore on a second device; device-only settings stay local; deletions and clears propagate; pending offline edits are not overwritten; retry after 401; malformed or foreign rows ignored; delete account |
| `i18n.test.ts` | 8 | Arabic catalog has exactly the English keys and only known placeholders; Arabic is the default (RTL); stored language survives, old/invalid values repair to Arabic; Arabic plural forms; localized references and portions; locale date formatting; no Quranic marks in UI catalogs |

## Browser end-to-end harness (`harness/harness.ts`)

The harness bundles the **real UI and the real IndexedDB adapter** with a mocked audio
backend (15 ms per "file") and synthetic placeholder text, then drives the DOM like a user.
Result in this environment, from the in-app preview browser: **30/30 passed with IndexedDB**.
A fresh install is checked to start in Arabic (RTL); the established journeys 1–21 then switch to
English and drive the UI by its English labels, and journeys 22–28 cover Arabic:

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
22. A fresh install starts in Arabic: `<html lang="ar" dir="rtl">`, Arabic navigation and headings.
23. Switching to Arabic keeps the route, marks and the Quran words (compared before/after); labels,
    references and direction change; toasts move to the inline end.
24. Arabic: mark a whole ayah through the localized dialogs.
25. The playlist order is identical in Arabic and English; the session title follows the language.
26. Switching language during playback keeps the session id, step index, completed plays and
    status; controls are relabelled; playback continues after answering.
27. Arabic: every button and link on each page has an accessible name.
28. The chosen language is saved and restored after restarting the app on the same IndexedDB.
29. Sign-in screen against a simulated Supabase: email and password-match validation, sign-up,
    wrong-password message, sign-in.
30. Signed in: a mistake marked in the UI is uploaded automatically, the account section shows
    the sync status, and a second device restores the mistake; device-only settings are not uploaded.

`showcase-*.html` files in `dist-harness/` run the same journeys and stop on a given screen for
visual review; `showcase-*-ar.html` show the same screens in Arabic with the light theme.

## Not automated here

* ESLint/Prettier, Playwright and React Testing Library could not be installed (no package-registry
  access in the build environment). The project lint script and the in-browser harness stand in
  for them; adding Playwright to run `harness.html` headlessly in CI is a natural next step.
* Real network audio and real AlQuran.cloud downloads were not exercised (no internet in the build
  environment). Parsers are tested against the documented response shape; `npm run test:data`
  validates the real dataset once downloaded.
* Docker image build was not run (no Docker in the build environment).
* Sign-in and sync were tested against a simulated Supabase server (`tests/fixtures/fakeSupabase.ts`),
  not a live project; `supabase/schema.sql` was not executed here. The GitHub Pages workflow was
  not run from this environment.
