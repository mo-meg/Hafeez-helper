import { s } from '../dom.ts';

/** Minimal stroke icons (24×24). Decorative: always paired with visible or aria labels. */
const PATHS: Record<string, string[]> = {
  dashboard: ['M4 13h7V4H4z', 'M13 20h7v-9h-7z', 'M13 4v5h7V4z', 'M4 20h7v-5H4z'],
  quran: ['M12 6c-2-1.5-5-2-8-1.5V19c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V4.5C17 4 14 4.5 12 6z', 'M12 6v14.5'],
  revision: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v4', 'M16 3v4', 'M9 15l2 2 4-4'],
  mistakes: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  test: ['M9 5h11', 'M9 12h11', 'M9 19h11', 'M3.5 5l1.5 1.5L7.5 4', 'M3.5 12l1.5 1.5 2.5-2.5', 'M4 18h3v3H4z'],
  progress: ['M4 20V10', 'M10 20V4', 'M16 20v-7', 'M22 20H2'],
  settings: ['M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M19 12a7 7 0 0 0-.1-1.2l2-1.5-2-3.4-2.3.9a7 7 0 0 0-2-1.2L14.2 3h-4.4l-.4 2.6a7 7 0 0 0-2 1.2l-2.3-.9-2 3.4 2 1.5a7 7 0 0 0 0 2.4l-2 1.5 2 3.4 2.3-.9a7 7 0 0 0 2 1.2l.4 2.6h4.4l.4-2.6a7 7 0 0 0 2-1.2l2.3.9 2-3.4-2-1.5c.1-.4.1-.8.1-1.2z'],
  play: ['M7 4l13 8-13 8z'],
  pause: ['M7 4h4v16H7z', 'M13 4h4v16h-4z'],
  next: ['M5 4l10 8-10 8z', 'M19 4v16'],
  prev: ['M19 4L9 12l10 8z', 'M5 4v16'],
  restart: ['M4 12a8 8 0 1 0 2.5-5.8', 'M4 4v4h4'],
  stop: ['M6 6h12v12H6z'],
  flagNext: ['M4 21V4h9l-1.5 3.5L13 11H4', 'M16 8l4 4-4 4'],
};

export function icon(name: keyof typeof PATHS | string): SVGElement {
  return s(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    (PATHS[name] ?? []).map((d) => s('path', { d })),
  );
}
