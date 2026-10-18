// The system's file and folder dialogs from the page (CONTRACTS "Admin API" /api/pick).
// The program opens them: it does all file work and needs full paths, which no
// <input type=file> gives. One Picker per page (App.picker): pick(purpose) waits while the dialog is open (/api/pick,
// then /api/pick/wait for as long as the program answers {open}), cancel() closes it (/api/pick/cancel), also one
// another tab opened, which watch() waits out with /api/pick/wait (the 409 picker-open names it, and hello and status
// do: seen(), so a reloaded page shows its open dialog at once). Where the program
// has none (hello's `picker` false, or a pick answered no-picker) the screens show the in-page file browser
// (browser.js) instead: the fallback. Pure but waitingLine().
import { el } from './dom.js';
import { t } from './strings.js';

export class Picker {
  /**
   * @param {{api: object, lang: () => string, available?: boolean, onChange?: () => void}} o available: hello's
   *   `picker`; onChange: the dialog opened or closed, or the page fell back (the screens draw their buttons again)
   */
  constructor({ api, lang, available = false, onChange = () => {} }) {
    this.api = api;
    this.lang = lang;
    this.available = !!available;
    this.onChange = onChange;
    this.open = null;          // the purpose of the dialog this page waits for
    this.owner = null;         // what it was opened for (the compared entry), as the caller gave it
    this.elsewhere = false;    // the program has a dialog open that this page did not open (another tab, a reload)
    this.watching = null;      // the id of that dialog, while this page waits for it to close
    this.problem = null;       // why there is no dialog (the no-picker finding), once a pick said so
  }

  /** A dialog is open, or the program said one is. */
  get busy() {
    return !!this.open || this.elsewhere;
  }

  /**
   * Opens the dialog of a purpose and waits for it to close.
   * @param {'files'|'folders'|'site'|'compare'} purpose
   * @param {{near?: string|null, owner?: *}} [o] near: where to open when this purpose has no folder of its own yet;
   *   owner: kept in `owner` while open, for the screen to tell which button opened it
   * @returns {Promise<{paths: string[]} | {canceled: true} | {fallback: true, problem?: object} | {elsewhere: true}>}
   *   fallback: no dialog here (use the in-page browser); elsewhere: one is open already. A stopped program and other
   *   refusals are thrown.
   */
  async pick(purpose, { near = null, owner = null } = {}) {
    if (!this.available) return { fallback: true, problem: this.problem };
    if (this.busy) return { elsewhere: true };
    this.open = purpose;
    this.owner = owner;
    this.onChange();
    try {
      let r = await this.api.pick({ purpose, lang: this.lang(), ...(near ? { near } : {}) });
      while (r && r.open && r.id) r = await this.api.pickWait(r.id);
      return r && Array.isArray(r.paths) && r.paths.length ? { paths: r.paths } : { canceled: true };
    } catch (e) {
      if (e && e.code === 'no-picker') {
        this.available = false;
        this.problem = typeof e.toJSON === 'function' ? e.toJSON() : e;
        return { fallback: true, problem: this.problem };
      }
      if (e && e.code === 'picker-open') {
        this.elsewhere = true;
        this.watch(e.params && e.params.id);
        return { elsewhere: true };
      }
      throw e;
    } finally {
      this.open = null;
      this.owner = null;
      this.onChange();
    }
  }

  /**
   * The program says a dialog is open (hello's and status's `pick`: {id, purpose}): one this page is not waiting for
   * (another tab's, or this page's before a reload) shows the waiting line and Cancel at once, and is waited out.
   */
  seen(pick) {
    if (!pick || typeof pick.id !== 'string' || !pick.id || this.open || this.watching === pick.id) return;
    this.elsewhere = true;
    this.onChange();
    this.watch(pick.id);
  }

  /**
   * Waits for the dialog another tab (or this page before a reload) opened to close, then the buttons are free again
   * (else they would wait until Cancel was pressed). Its answer is that tab's: the program keeps it for it.
   */
  async watch(id) {
    if (typeof id !== 'string' || !id || this.watching === id) return;
    this.watching = id;
    try {
      let r = { open: true };
      while (r && r.open && this.watching === id) r = await this.api.pickWait(id);
    } catch (e) {
      if (e && e.code === 'no-picker') {
        this.available = false;
        this.problem = typeof e.toJSON === 'function' ? e.toJSON() : e;
      }
      if (e && (e.offline || e.auth)) return;               // the page's dead() says it
    }
    if (this.watching !== id) return;
    this.watching = null;
    this.elsewhere = false;
    this.onChange();
  }

  /** Closes the open dialog, this page's or another's; a stopped program is said by the page's dead(). */
  async cancel() {
    try {
      await this.api.pickCancel();
    } catch (e) {
      if (!(e && (e.offline || e.auth))) throw e;
    }
    if (this.elsewhere) {
      this.elsewhere = false;
      this.watching = null;
      this.onChange();
    }
  }
}

/**
 * "A file window is open" (and where it may be) with its Cancel button, or null while none is. `mine`: whether this
 * place opened it (else the line shows only for one open elsewhere).
 */
export function waitingLine(picker, lang, { mine = true, onCancel = () => picker.cancel() } = {}) {
  const open = !!picker.open && mine;
  if (!open && !picker.elsewhere) return null;
  return el('p', { class: 'msg msg-info pick-wait' }, t(open ? 'common.pickOpen' : 'common.pickElsewhere', lang), ' ',
    el('button', { type: 'button', onclick: () => { Promise.resolve(onCancel()).catch(() => {}); } }, t('common.cancel', lang)));
}
