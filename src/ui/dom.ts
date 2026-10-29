/** Tiny typed DOM builder. Never uses innerHTML, so user notes cannot inject markup. */
export type Child = Node | string | number | null | undefined | false | readonly Child[];
export type Props = { [key: string]: unknown };

const PROPERTY_KEYS = new Set(['value', 'checked', 'selected', 'disabled', 'indeterminate', 'open']);

function append(parent: Node, child: Child): void {
  if (child === null || child === undefined || child === false) return;
  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);
    return;
  }
  parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
}

function applyProps(el: Element, props: Props | null | undefined): void {
  if (!props) return;
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      el.setAttribute('class', String(value));
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (v !== undefined && v !== null) (el as HTMLElement).dataset[k] = String(v);
      }
    } else if (key === 'style' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, string>)) (el as HTMLElement).style.setProperty(k, v);
    } else if (PROPERTY_KEYS.has(key)) {
      (el as unknown as Record<string, unknown>)[key] = value;
    } else {
      el.setAttribute(key, value === true ? '' : String(value));
    }
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props?: Props | null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  applyProps(el, props);
  for (const c of children) append(el, c);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag: string, props?: Props | null, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG_NS, tag) as SVGElement;
  applyProps(el, props);
  for (const c of children) append(el, c);
  return el;
}

export function frag(...children: Child[]): DocumentFragment {
  const f = document.createDocumentFragment();
  for (const c of children) append(f, c);
  return f;
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  for (const c of children) append(el, c);
}

/** Arabic-Indic digits for ayah numbers inside Arabic text. */
export function arabicDigits(n: number): string {
  return String(n).replace(/\d/g, (d) => String.fromCharCode(0x0660 + Number(d)));
}

// Locale-aware formatting lives in ./i18n; these re-exports keep existing view imports stable.
export { fmtDate as formatDate, fmtDateTime as formatDateTime, fmtDuration as formatDuration, fmtRelativeDays as relativeDays } from './i18n/index.ts';
