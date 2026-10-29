# Review policy, scheduler and quality score

All three are deterministic, configurable, and covered by unit tests
(`tests/review.test.ts`, `tests/mistakes.test.ts`). None of them uses audio playback as input.

## Mistake lifecycle (`src/core/review/policy.ts`)

States: **new → needs practice / under review / improved → resolved → reopened**.

| Recall outcome | Status change | Streak | Other |
|---|---|---|---|
| Correct without difficulty | under review, or **improved** once the streak reaches 2 | +1, at most once per session | (resolved stays resolved) |
| Correct but difficult | under review | unchanged | |
| Needed a prompt | needs practice (resolved → reopened) | reset to 0 | marked "assisted" |
| Made a mistake again | needs practice (resolved → reopened) | reset to 0 | lapse +1 |

* **In revision sessions no outcome resolves a mistake**; resolution is an explicit action (after
  3 easy recalls in separate sessions the UI *suggests* it). **Exception, chosen by the user: in a
  Test, "Correct without difficulty" (without hints) marks that mistake resolved.** A resolved
  mistake that fails a later test ("Needed a prompt" or "Mistake again") is reopened.
* Resolved mistakes are shown in green; unresolved ones in red.
* Marking the same word or ayah again does not create a duplicate. It records a recurrence
  (lapse) on the existing record, or reopens it if it was resolved.
* Resolved mistakes and all their events stay in history unless the user deletes them.
* Several marked words in one ayah share one recall: one answer is applied to all of them.
* A mark on the first word of an ayah pre-selects the type "Linking ayat (transition)" (changeable).
* Test answers are recorded exactly like revision answers (session type "test"). In a test, using
  a hint limits the answer to "Needed a prompt" or "Mistake again". With several mistakes in one
  ayah, each is a separate step whose answer is recorded only for that mistake (the quality score
  still counts one recall per ayah per session).

## Scheduler (`src/core/review/scheduler.ts`)

```
interval = ladder[step] × severity × category × lapses × difficulty × overdue bonus
ladder   = 1, 2, 4, 7, 14, 30, 60 days   (step = success streak; reset after a mistake or prompt)
severity = 1 (minor), 0.8 (moderate), 0.6 (serious)
category = 0.75 for "confused with a similar ayah" and "linking ayat (transition)", otherwise 1
lapses   = max(0.4, 1 − 0.15 × lapses)
difficulty override = easier 1.5, normal 1, harder 0.6
overdue bonus (easy recall after a longer gap than planned) = min(1.5, elapsed / planned)
clamped to 1–120 days and rounded
```

New mistakes are due immediately. Users can set a specific next-review date (cleared by the
next recorded review) and a per-mistake difficulty override.

## Estimated revision quality (`src/core/review/scoring.ts`)

For each ayah **with at least one recorded mistake** in the chosen scope:

1. Take its recall outcomes, keeping only the last one per session, then the most recent 5.
2. Value = recency-weighted mean (weights 1, 0.8, 0.6, 0.45, 0.35) of outcome values:
   easy 1, difficult 0.7, prompt 0.35, mistake 0. Never reviewed = 0.25.
3. If the last correct recall is older than 14 days, subtract 0.005 per extra day (max 0.3).
4. If every mistake of the ayah is resolved, the value is at least 0.8.

Score = round(100 × mean). No mistakes in scope gives no score (shown as "No score yet").
Historical trend points apply exactly the same rules to the data as it was at the end of each day.

**Why it can't be gamed by listening:** the function's inputs are mistakes and review events
only; playback is stored separately (`RevisionSession.playedAyahIndexes`) and never read
by the scorer. Repeating answers within one session counts once.

**Assumptions and limits:** the weights are judgement calls, not research-derived. The score
reflects only ayat where you have recorded mistakes, so it says nothing about portions you
never marked. Treat it as a direction indicator, not a validated measure. All constants live in
`DEFAULT_SCORING` / `DEFAULT_SCHEDULER` / `DEFAULT_POLICY` and can be changed in one place.
