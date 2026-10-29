import { h } from '../dom.ts';
import { dir, t, type Locale } from '../i18n/index.ts';

/** Arabic / English segmented control. Each option is labelled in its own language. */
export function languageSwitch(current: Locale, onPick: (l: Locale) => void): HTMLElement {
  return h(
    'div',
    { class: 'lang-switch', role: 'group', 'aria-label': t('lang.label') },
    (['ar', 'en'] as const).map((l) =>
      h('button', { type: 'button', lang: l, dir: dir(l), 'aria-pressed': String(l === current), 'data-key': `lang-${l}`, onclick: () => onPick(l) }, t(l === 'ar' ? 'lang.ar' : 'lang.en')),
    ),
  );
}
