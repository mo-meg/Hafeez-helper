import type { SurahInfo } from './types.ts';

/**
 * Surah names and ayah counts (Hafs 'an 'Asim, Kufan count: 6236 ayat in total).
 * These counts are independently checked at runtime against every downloaded dataset;
 * a dataset that disagrees is rejected. Names are surah titles, not Quranic text.
 */
const RAW: ReadonlyArray<readonly [number, string, string]> = [
  [7, 'الفاتحة', 'Al-Fatihah'], [286, 'البقرة', 'Al-Baqarah'], [200, 'آل عمران', "Al 'Imran"],
  [176, 'النساء', "An-Nisa'"], [120, 'المائدة', "Al-Ma'idah"], [165, 'الأنعام', "Al-An'am"],
  [206, 'الأعراف', "Al-A'raf"], [75, 'الأنفال', 'Al-Anfal'], [129, 'التوبة', 'At-Tawbah'],
  [109, 'يونس', 'Yunus'], [123, 'هود', 'Hud'], [111, 'يوسف', 'Yusuf'],
  [43, 'الرعد', "Ar-Ra'd"], [52, 'إبراهيم', 'Ibrahim'], [99, 'الحجر', 'Al-Hijr'],
  [128, 'النحل', 'An-Nahl'], [111, 'الإسراء', "Al-Isra'"], [110, 'الكهف', 'Al-Kahf'],
  [98, 'مريم', 'Maryam'], [135, 'طه', 'Ta-Ha'], [112, 'الأنبياء', "Al-Anbiya'"],
  [78, 'الحج', 'Al-Hajj'], [118, 'المؤمنون', "Al-Mu'minun"], [64, 'النور', 'An-Nur'],
  [77, 'الفرقان', 'Al-Furqan'], [227, 'الشعراء', "Ash-Shu'ara'"], [93, 'النمل', 'An-Naml'],
  [88, 'القصص', 'Al-Qasas'], [69, 'العنكبوت', "Al-'Ankabut"], [60, 'الروم', 'Ar-Rum'],
  [34, 'لقمان', 'Luqman'], [30, 'السجدة', 'As-Sajdah'], [73, 'الأحزاب', 'Al-Ahzab'],
  [54, 'سبأ', "Saba'"], [45, 'فاطر', 'Fatir'], [83, 'يس', 'Ya-Sin'],
  [182, 'الصافات', 'As-Saffat'], [88, 'ص', 'Sad'], [75, 'الزمر', 'Az-Zumar'],
  [85, 'غافر', 'Ghafir'], [54, 'فصلت', 'Fussilat'], [53, 'الشورى', 'Ash-Shura'],
  [89, 'الزخرف', 'Az-Zukhruf'], [59, 'الدخان', 'Ad-Dukhan'], [37, 'الجاثية', 'Al-Jathiyah'],
  [35, 'الأحقاف', 'Al-Ahqaf'], [38, 'محمد', 'Muhammad'], [29, 'الفتح', 'Al-Fath'],
  [18, 'الحجرات', 'Al-Hujurat'], [45, 'ق', 'Qaf'], [60, 'الذاريات', 'Adh-Dhariyat'],
  [49, 'الطور', 'At-Tur'], [62, 'النجم', 'An-Najm'], [55, 'القمر', 'Al-Qamar'],
  [78, 'الرحمن', 'Ar-Rahman'], [96, 'الواقعة', "Al-Waqi'ah"], [29, 'الحديد', 'Al-Hadid'],
  [22, 'المجادلة', 'Al-Mujadilah'], [24, 'الحشر', 'Al-Hashr'], [13, 'الممتحنة', 'Al-Mumtahanah'],
  [14, 'الصف', 'As-Saff'], [11, 'الجمعة', "Al-Jumu'ah"], [11, 'المنافقون', 'Al-Munafiqun'],
  [18, 'التغابن', 'At-Taghabun'], [12, 'الطلاق', 'At-Talaq'], [12, 'التحريم', 'At-Tahrim'],
  [30, 'الملك', 'Al-Mulk'], [52, 'القلم', 'Al-Qalam'], [52, 'الحاقة', 'Al-Haqqah'],
  [44, 'المعارج', "Al-Ma'arij"], [28, 'نوح', 'Nuh'], [28, 'الجن', 'Al-Jinn'],
  [20, 'المزمل', 'Al-Muzzammil'], [56, 'المدثر', 'Al-Muddaththir'], [40, 'القيامة', 'Al-Qiyamah'],
  [31, 'الإنسان', 'Al-Insan'], [50, 'المرسلات', 'Al-Mursalat'], [40, 'النبأ', "An-Naba'"],
  [46, 'النازعات', "An-Nazi'at"], [42, 'عبس', "'Abasa"], [29, 'التكوير', 'At-Takwir'],
  [19, 'الانفطار', 'Al-Infitar'], [36, 'المطففين', 'Al-Mutaffifin'], [25, 'الانشقاق', 'Al-Inshiqaq'],
  [22, 'البروج', 'Al-Buruj'], [17, 'الطارق', 'At-Tariq'], [19, 'الأعلى', "Al-A'la"],
  [26, 'الغاشية', 'Al-Ghashiyah'], [30, 'الفجر', 'Al-Fajr'], [20, 'البلد', 'Al-Balad'],
  [15, 'الشمس', 'Ash-Shams'], [21, 'الليل', 'Al-Layl'], [11, 'الضحى', 'Ad-Duha'],
  [8, 'الشرح', 'Ash-Sharh'], [8, 'التين', 'At-Tin'], [19, 'العلق', "Al-'Alaq"],
  [5, 'القدر', 'Al-Qadr'], [8, 'البينة', 'Al-Bayyinah'], [8, 'الزلزلة', 'Az-Zalzalah'],
  [11, 'العاديات', "Al-'Adiyat"], [11, 'القارعة', "Al-Qari'ah"], [8, 'التكاثر', 'At-Takathur'],
  [3, 'العصر', "Al-'Asr"], [9, 'الهمزة', 'Al-Humazah'], [5, 'الفيل', 'Al-Fil'],
  [4, 'قريش', 'Quraysh'], [7, 'الماعون', "Al-Ma'un"], [3, 'الكوثر', 'Al-Kawthar'],
  [6, 'الكافرون', 'Al-Kafirun'], [3, 'النصر', 'An-Nasr'], [5, 'المسد', 'Al-Masad'],
  [4, 'الإخلاص', 'Al-Ikhlas'], [5, 'الفلق', 'Al-Falaq'], [6, 'الناس', 'An-Nas'],
];

export const SURAHS: readonly SurahInfo[] = RAW.map(([ayahCount, nameArabic, nameTransliterated], i) => ({
  number: i + 1,
  ayahCount,
  nameArabic,
  nameTransliterated,
}));

export const TOTAL_AYAT = 6236;
export const SURAH_COUNT = 114;

export function surahInfo(surah: number): SurahInfo {
  const info = SURAHS[surah - 1];
  if (!info) throw new RangeError(`Surah ${surah} does not exist (1..114)`);
  return info;
}
