# Wird Planner (multi-plan revision planner)

The Wird Planner replaces the single week/month "Period Plan". It runs any number of independent
revision plans in parallel (e.g. *Madinah: Hizb 13–30, Sun–Thu, Friday full revision, Saturday rest*
next to *Morocco: Hizb 1–10, Sun–Thu, Friday rest, Saturday full revision*), tracks completion per
Quran unit, and carries unfinished revision forward without ever discarding it silently.

## Decisions (agreed with the user, 2026-11-23)

| Topic | Decision |
|---|---|
| Old Period Plan | Replaced. An active Period Plan is migrated once into a Wird plan; the old panel and `periodPlan` preference are retired (the preference is still read for the migration). |
| Completion | Only an explicit tap completes units (per unit, so partial completion works). *Listen* starts the normal listening session for the range; when it ends a one-tap toast offers "Mark done". Nothing is ever completed automatically. |
| Cycle | Per plan: **Whole range each week** (auto-balanced or manual range per weekday) or **Fixed daily amount** (N units per revision day, in order, wrapping around; optional target date). |
| Overdue vs next cycle | When an open unit is scheduled again as a fresh daily assignment, the old copy is closed as `merged` (kept in history, counts as missed). The backlog never exceeds one copy of the range. |
| Carry-over modes | **Strict**: overdue stacked on top of today. **Priority**: today's load capped at the normal daily amount, overdue fills it first, the rest is *postponed* and slides forward in order. **Flexible**: like Strict until the user approves a proposal that spreads overdue over the coming revision days (rest of the plan week, or next 3 revision days). |
| Plan edits | Past tasks are frozen snapshots. A new configuration applies from today (from tomorrow if something was already ticked today). Open overdue units outside the new range are closed as `removed` (history, not missed). |
| Day boundary | Device local midnight for all plans. |
| Quality | Optional per unit (Excellent / Good / Needs practice / Weak) + optional note per task. Used in statistics; weak units get a "Practise mistakes" shortcut. No mistakes are created, the review scheduler is untouched. |
| Navigation | One **Wird / الورد** nav item with tabs Today · Week · Plans · Statistics · History. The dashboard shows the Today's Wird cards. |
| Full revision day | Separate `full` task with per-unit ticks; never carried over (recorded as complete / partial / missed). Per-plan overdue behaviour: full only · full + overdue (default) · overdue first. |
| Statistics | Day per plan = Complete / Partial / Missed on its scheduled units. Combined *forgiving* streak: consecutive days where at least one unit of every plan due that day was done; rest, paused and full-revision-only days never break it. |

## Quran reference system

Units are `juz` (1–30), `hizb` (1–60) and `quarter` = rub' (1–240). The structural relation
(1 juz = 2 hizb = 8 rub') is fixed, so every unit maps to a **quarter span** without any downloaded
data (`src/core/wird/units.ts`). Quarter spans are the internal common currency: overlap,
"inside the range", merging and equivalents (e.g. *Hizb 13–30 = Juz 7–15 = Rub' 49–120*) are
computed on them. Ayah boundaries (for *Listen*/*Read* and the surah:ayah label) come from the
existing `DivisionIndex`, which needs the downloaded divisions data; without it the planner still
works, only Listen/Read show the usual "download the Quran data" error.

## Data model (IndexedDB, synced like every other table)

`wirdPlans` — one record per plan:
`{ id, name, color, status: active|paused|archived, startDate, configs: WirdConfig[], pauses: {from,to|null}[], createdAt, updatedAt }`.
`configs` is a history: each entry has `effectiveFrom`; the task for a date is generated with the
config in force on that date, so edits never rewrite the past.

`wirdTasks` — one record per plan, date and kind, with a **deterministic id**
`wt:<planId>:<date>:<daily|full>`. Generating twice (refresh, two devices) writes the same id, so
tasks cannot be duplicated. A task stores the units it scheduled (a snapshot) and, per unit, the
completion record: `doneAt`, `doneOn` (local date it was done), `quality`, `dueOn` (Flexible
reassignment), `closed` (`merged`/`removed`) with `closedOn` and `mergedInto`.

Carry-over is **not** stored as copies: the overdue list of a day is computed from the open units of
earlier tasks. Completing an overdue unit writes the completion onto the task that scheduled it.
This keeps one source of truth for scheduled vs completed vs pending vs overdue.

Schema: IndexedDB version 2 adds the two object stores (index `planId` on tasks); backup schema 2
adds `wirdPlans`/`wirdTasks` (v1 backups migrate with empty lists); Supabase: run
`supabase/migrations/002_wird.sql` (extends the `tbl` check constraint) **before** using a build with
the planner, otherwise pushes of the new tables are rejected.

## Engine (`src/core/wird/`, pure and UI-free)

- `units.ts` — unit kinds, counts, quarter spans, equivalents, range validation.
- `distribution.ts` — balanced weekly split (`4,4,4,3,3`), manual per-weekday ranges with
  gap/overlap validation, fixed-daily rolling window.
- `engine.ts` — `materialize()` (idempotent task generation up to today, merge rule),
  `planDay()` (scheduled / overdue / postponed / optional-on-rest-day for one plan and date),
  `proposeSpread()` (Flexible), `applyEdit()`, pause/resume.
- `stats.ts` — completion rates, day statuses, weekly/monthly consistency, streak, quality, difficult
  units, per-plan comparison — all from completion records only.
- `wirdService.ts` — persistence around the engine (store tables, clock, ids).

## Tests

`tests/wird.test.ts` (27 tests, no UI): distribution (4,4,4,3,3, manual gaps/repeats, fixed-daily
wrap), independent and overlapping plans, Strict / Priority / Flexible, rest days, full revision
days, partial completion, overdue-only and today-only completion, idempotent generation, week
boundary + merge into the next cycle, edits (history kept, apply-from rule, removed units), pause /
resume, fixed-daily continuation after an edit, delete isolation, undo, statistics and streak,
backup round-trip and v1 migration, Period Plan migration. The browser harness adds a journey that
creates a plan through the editor and ticks units; showcases: `showcase-wird(-ar)`,
`showcase-wird-week(-ar)`, `showcase-wird-plans(-ar)`, `showcase-wird-stats`.

## Limitations

- Sync is last-write-wins per task record (like daily plans): ticking the same task on two offline
  devices at once keeps the later write.
- The old Period Plan's daily records stay in the `plans` table as history; the migrated Wird plan
  starts on the migration day and is open-ended (archive it when the old period is over).
- "Target completion date" is informational for fixed-daily plans (projected finish and a suggested
  daily amount); it does not change the schedule by itself.
