import type { Mistake } from '../../core/model.ts';

/**
 * How a word mistake looks inside the Quran text: red (marked), yellow (improving — recited
 * correctly at least once since), green (resolved), or plain.
 */
export type WordMarkState = 'none' | 'marked' | 'improving' | 'resolved';

export function wordMarkState(m: Pick<Mistake, 'status'> | null | undefined): WordMarkState {
  if (!m) return 'none';
  if (m.status === 'resolved') return 'resolved';
  if (m.status === 'improved') return 'improving';
  return 'marked';
}

/** Classes for a word button (`marked` is shared by all three coloured states). */
export function wordMarkClasses(state: WordMarkState): string {
  return state === 'none' ? '' : state === 'marked' ? ' marked' : ` marked ${state}`;
}

/** Repaints a rendered word in place (no re-render, so scrolling stays smooth). */
export function paintWordMark(el: HTMLElement, state: WordMarkState): void {
  el.classList.toggle('marked', state !== 'none');
  el.classList.toggle('improving', state === 'improving');
  el.classList.toggle('resolved', state === 'resolved');
  if (state === 'none') el.removeAttribute('aria-describedby');
  else el.setAttribute('aria-describedby', 'marked-desc');
}
