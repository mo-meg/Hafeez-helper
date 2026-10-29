/**
 * Independently verified division anchors for the Madani (Hafs) mushaf division system as used
 * by Tanzil / King Fahd Complex prints. They are bundled ONLY to cross-check downloaded datasets;
 * they are not used to compute any boundary by arithmetic.
 *
 * Sources (checked 2026-10-28):
 *  - Juz 1–14 starts: assabile.com/quran/juz; Juz 15–30 starts: quran411.com/juz-breakdown,
 *    corroborated by myislam.org and versesurah.com.
 *    Note: some tables (e.g. Indo-Pak naming) start Juz 4 at 3:92 ("Lan tanalu"); the Madani
 *    mushaf and Tanzil start it at 3:93. Datasets following the other convention are rejected
 *    for this edition rather than silently mixed.
 *  - Hizb 1–11 starts: en.wikipedia.org/wiki/Juz' (hizb table).
 */
export const VERIFIED_JUZ_STARTS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [2, 142], [2, 253], [3, 93], [4, 24], [4, 148], [5, 82], [6, 111], [7, 88], [8, 41],
  [9, 93], [11, 6], [12, 53], [15, 1], [17, 1], [18, 75], [21, 1], [23, 1], [25, 21], [27, 56],
  [29, 46], [33, 31], [36, 28], [39, 32], [41, 47], [46, 1], [51, 31], [58, 1], [67, 1], [78, 1],
];

/** hizb number -> [surah, ayah] of its first ayah. */
export const VERIFIED_HIZB_STARTS: ReadonlyMap<number, readonly [number, number]> = new Map([
  [1, [1, 1]], [2, [2, 75]], [3, [2, 142]], [4, [2, 203]], [5, [2, 253]], [6, [3, 15]],
  [7, [3, 93]], [8, [3, 171]], [9, [4, 24]], [10, [4, 88]], [11, [4, 148]],
]);

export const ANCHOR_SOURCES = [
  { label: 'Juz starts 1–14', url: 'https://www.assabile.com/quran/juz' },
  { label: 'Juz starts 15–30', url: 'https://quran411.com/juz-breakdown' },
  { label: 'Hizb starts 1–11', url: "https://en.wikipedia.org/wiki/Juz'" },
] as const;
