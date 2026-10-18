// UI glue of the admin page: message areas whose lines are drawn again in a new language, and the modal dialog
// (<dialog> with showModal(), Esc closes, focus goes back to the opener by hand).
import { el, fill, clear } from './dom.js';

/**
 * A screen's message area: each line is a function of the language, so a language change redraws it.
 * kind: 'ok' | 'info' | 'error'. The area is a polite live region, there before its lines, so a screen reader reads
 * what an action answered.
 */
export class Messages {
  constructor(node, lang) {
    this.node = node;
    this.lang = lang;
    this.lines = [];
    node.classList.add('messages');
    node.setAttribute('aria-live', 'polite');
  }

  /** Replaces every line. */
  set(kind, draw) {
    this.lines = [];
    return this.add(kind, draw);
  }

  add(kind, draw) {
    this.lines.push({ kind, draw });
    this.render();
    return this;
  }

  clear() {
    this.lines = [];
    clear(this.node);
    return this;
  }

  render() {
    const L = this.lang();
    fill(this.node, this.lines.map(({ kind, draw }) => el('div', { class: ['msg', `msg-${kind}`] }, draw(L))));
  }
}

/** Visually hidden text for screen readers ("opens in a new tab"). */
export const srOnly = text => el('span', { class: 'sr-only' }, text);

/**
 * Asks in the modal dialog; resolves true when the confirm button was pressed. Focus returns to `opener` (or, when it
 * has left the page, to `fallback`). Without <dialog> support: window.confirm with the dialog's text.
 * @param {HTMLDialogElement} dialog  holds [data-confirm] and [data-cancel] buttons
 * @param {{opener?: HTMLElement|null, fallback?: HTMLElement|null}} o
 */
export function ask(dialog, { opener = null, fallback = null } = {}) {
  const back = () => {
    const target = opener && opener.isConnected && !opener.disabled ? opener : fallback;
    if (target && typeof target.focus === 'function') target.focus();
  };
  if (typeof dialog.showModal !== 'function') {
    const ok = window.confirm(dialog.textContent.replace(/\s+/g, ' ').trim());
    back();
    return Promise.resolve(ok);
  }
  return new Promise(resolve => {
    const confirmBtn = dialog.querySelector('[data-confirm]');
    const cancelBtn = dialog.querySelector('[data-cancel]');
    let answer = false;
    const onConfirm = () => {
      answer = true;
      dialog.close();
    };
    const onCancel = () => dialog.close();
    const onClose = () => {
      confirmBtn.removeEventListener('click', onConfirm);
      cancelBtn.removeEventListener('click', onCancel);
      dialog.removeEventListener('close', onClose);
      back();
      resolve(answer);
    };
    confirmBtn.addEventListener('click', onConfirm);
    cancelBtn.addEventListener('click', onCancel);
    dialog.addEventListener('close', onClose);
    dialog.showModal();
    cancelBtn.focus();                                       // a removal is never the default
  });
}
