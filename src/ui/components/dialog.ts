import { h, type Child } from '../dom.ts';

export interface DialogHandle {
  readonly el: HTMLDialogElement;
  close(): void;
}

/** Native modal dialog (focus trapping, Esc to close). Removed from the DOM on close. */
export function openDialog(opts: { title: string; body: Child; actions: (close: () => void) => Child; onClose?: () => void }): DialogHandle {
  const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
  const el = h('dialog', { 'aria-labelledby': titleId });
  const close = () => {
    if (el.open) el.close();
  };
  el.addEventListener('close', () => {
    el.remove();
    opts.onClose?.();
  });
  el.append(
    h('div', { class: 'dialog-body' }, h('h2', { id: titleId }, opts.title), opts.body),
    h('div', { class: 'dialog-actions' }, opts.actions(close)),
  );
  document.body.append(el);
  if (typeof el.showModal === 'function') el.showModal();
  else el.setAttribute('open', '');
  return { el, close };
}

export function confirmDialog(title: string, message: string, confirmLabel: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title,
      body: h('p', null, message),
      actions: (close) => [
        h('button', { type: 'button', onclick: close }, 'Cancel'),
        h('button', { type: 'button', class: danger ? 'danger' : 'primary', onclick: () => { result = true; close(); } }, confirmLabel),
      ],
      onClose: () => resolve(result),
    });
  });
}
