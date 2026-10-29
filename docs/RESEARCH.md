# Reference project research (2026-10-28)

The build environment had no direct access to GitHub, F-Droid or Google Play, so this research
relies on web-search summaries of public pages, not on reading the source code. Claims below
are limited to what those pages state.

| Project | What is documented | What we took as inspiration |
|---|---|---|
| [Warattil](https://github.com/nresan/warattil) (MIT, Kotlin/Swift) | Offline Madinah Mushaf (604 pages, KFGQPC text and font), daily wird and memorisation, no ads/accounts/tracking | Offline-first, privacy, faithful KFGQPC/Uthmani text |
| Tahfeez (com.nagy.tahfeez; iOS listing "Tahfeez: Quran Memorization") | Pick surah, page, juz or ayah range, loop it, 44 reciters, configurable repeat with pause between rounds | Range repetition with pauses; reciter choice |
| [Quran Revision Companion](https://f-droid.org/en/packages/com.wqar.quran_mem_helper/) ([source](https://github.com/Waqar144/quran_memorization_helper), MIT, Flutter) | Several mushaf layouts, mark ayat with mistakes or for revision, per-juz ayah lists, mutashabihat lists, quiz, page bookmarks, no network | Ayah mistake marking; "confused with similar ayah" category; mutashabihat-aware scheduling |
| [Quran for Android](https://android.quran.com/) (quran_android) | Gapless audio, verse/range repeat, bookmarks and tags with import/export, verse highlighting, audio download for offline, lock-screen controls, speed control | Repeat semantics, media-session controls, explicit offline audio |
| [Quran.com / Quran Foundation API](https://api-docs.quran.foundation/) | v4 content with word objects (`id`, `position`, `text_uthmani`), juz/hizb/rub/page numbers; now requires OAuth2 client credentials | Stable reference model `(surah, ayah, word position)`; reasons not to call it directly from a browser |

None of the referenced apps (as documented) combines all of: persistent per-word mistake
records with a lifecycle, automatically generated **mistake-only** audio playlists in Quran
order scoped to the day's assignment, and recall-based (not listening-based) progress. That
combination is the original core of Hafeez Helfer. No code was copied from these projects.
