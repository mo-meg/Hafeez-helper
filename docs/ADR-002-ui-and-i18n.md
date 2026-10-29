# ADR-002: Interface design system and Arabic/English localization

Status: accepted (2026-10-29)

## Context

The app is a framework-free TypeScript PWA (ADR-001): esbuild bundles `src/main.ts`, a tiny typed
DOM builder (`src/ui/dom.ts`, no `innerHTML`) renders views, and one global stylesheet
(`src/ui/styles.css`) is imported by the entry and emitted as `main.css`. The interface was
English-only and left-to-right, with a blue accent.

The goals were a calmer, mushaf-inspired interface and full Arabic and English support from the
start, with Arabic as the default, without changing the stack or duplicating business logic.

## Decision

**Stay on TypeScript + esbuild + plain CSS.** No framework, no Tailwind, no component library.
esbuild already bundles CSS imports, and the existing DOM builder is enough for the components
we need. Lucide was considered for icons, but the package registry is not reachable from the
build environment; the existing inline stroke icons (`src/ui/components/icons.ts`) follow the
same 24×24, 1.8-stroke style and need no network or extra dependency.

**Design tokens in CSS custom properties** (`:root` and `:root[data-theme='dark']`):
warm cream paper, deep green for actions and navigation, a muted gilt reserved for Quran
structure (ayah markers, surah bands, division markers, the inner rule of the mushaf frame), red
only for marked mistakes, leaf green for resolved marks. The mushaf page is the one visually
distinctive element; everything else stays quiet.

**Logical CSS everywhere** (`inset-inline-*`, `margin-inline-*`, `border-inline-end`,
`text-align: start`, flex/grid alignment), so one stylesheet serves RTL and LTR. Media controls
keep a left-to-right order in both languages (the platform convention for transport controls).
Numeric and reference inputs stay `dir="ltr"` so "2:255" is typed naturally.

**Localization module** in `src/ui/i18n/`:

* `locales/en.ts` defines the message keys; `locales/ar.ts` is typed `Record<MessageKey, Message>`,
  so a missing Arabic key is a compile error. `tests/i18n.test.ts` also checks key parity and
  placeholders.
* `t(key, params)` and `tn(key, count, params)`; plural forms follow CLDR categories via
  `Intl.PluralRules` (Arabic uses zero/one/two/few/many/other).
* Numbers, dates, relative days and lists use `Intl` with the active locale (CLDR decides digit
  shapes). Ayah-end markers inside the Quran text keep Arabic-Indic digits as before.
* `labels.ts` localizes domain values (surah names, references, divisions, statuses, outcomes,
  reciter names, errors). Core modules keep their English labels for tests, logs and backups.
* The selected language is part of the persisted `Preferences` (`language: 'ar' | 'en'`,
  default `'ar'`); older stored preferences without the field are repaired to Arabic.
  `App.applyAppearance()` sets `lang`/`dir` on `<html>`; switching re-renders the shell and the
  current view in place, without touching data, route, session or playback.
* Session titles are computed at render time (`App.prepare(config, title)`), so a running session
  follows the language; the stored `SessionConfig.label` stays a stable English string.

**Quran text is never part of localization.** It is rendered verbatim from the verified dataset,
always `lang="ar" dir="rtl"`, in both interface languages. Locale catalogs are checked to contain
no Quranic annotation marks.

## Consequences

* Every interface string lives in the two locale files; views call `t()`.
* Core error messages remain English internally; `errorText()` maps known error classes to
  localized messages and shows technical details (browser or parser messages) as supplied.
* Adding a third language means one new catalog typed against `MessageKey` plus a `Locale` entry.
* No new runtime or development dependencies were added.
