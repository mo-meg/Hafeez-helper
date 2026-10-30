KFGQPC Hafs V30 — Quran text source and font
=============================================

This folder holds the verified release the app's Quran text and font come from, unmodified:

* `KFGQPC Hafs V30.docx` — the Uthmani text (Hafs 'an 'Asim, Kufan count, 6236 ayat) as published,
  with surah titles, the basmala of every surah (except Al-Fatihah and At-Tawbah), and each ayah
  followed by its number marker (۝N).
* `KFGQPC Hafs V30.ttf` — "KFGQPC HAFS Uthmanic Script Regular", version 3.0. The text is laid out
  for exactly this font, which is why the app renders the Quran with it.

Source: King Fahd Glorious Quran Printing Complex, Madinah — https://fonts.qurancomplex.gov.sa/
Font licence: see `public/fonts/LICENSE-KFGQPC-Hafs.txt` (free to use, copy and distribute the
font unmodified; it may not be sold, modified or decompiled).

`npm run data:import` converts the DOCX into `public/data/quran-text.json` (the app's single text
edition) and checks it: 114 surah titles, 6236 ayat, Hafs ayah counts, numbered 1..n per surah,
and every juz/quarter/page division start inside the text. The build copies the TTF to
`/fonts/KFGQPC-Hafs-V30.ttf`. Do not edit either file by hand.
