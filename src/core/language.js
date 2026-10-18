// The visitor's UI language (ssp-ui.md §2.10): SSP's Language ▸ choice, kept site-wide (not per ghost, like SSP) in the
// runtime prefs (localStorage `sumika:runtime`, key `lang`: 'ja' | 'en' | 'system'; nothing stored = 'system').
// 'system' follows the browser's languages (i18n.js systemLanguage). Emits 'change' {lang, prev, pref, prevPref}
// whenever the choice or the language in effect changes; the menu, the launcher and the boxes re-label themselves, and
// the event loop sends OnLanguageChange when `lang` differs from `prev`.
import { Emitter } from './emitter.js';
import { runtimePrefs, RUNTIME_KEY } from './state.js';
import { normLangPref, resolveLanguage } from './i18n.js';
import { storageSource } from './platform.js';

export class UiLanguage extends Emitter {
  /**
   * @param {{storage?: Storage, navigator?: object}} [o] storage: where the runtime prefs live (default localStorage,
   *   else memory); navigator: whose languages "Use System Lang." follows
   */
  constructor({ storage, navigator: nav = globalThis.navigator } = {}) {
    super();
    this.storage = storage;
    this.nav = nav;
    this._pref = this._stored();
    this._lang = resolveLanguage(this._pref, this.nav);
    this._off = null;
  }

  _stored() { return normLangPref(runtimePrefs.get(this.storage).lang); }

  /** the choice: 'ja' | 'en' | 'system' */
  get pref() { return this._pref; }

  /** the language in effect: 'ja' | 'en' */
  get lang() { return this._lang; }

  /** Language ▸ pick: stored at once (every page of the site); true when the language in effect changed. */
  set(pref) {
    const p = normLangPref(pref);
    runtimePrefs.set({ lang: p }, this.storage);
    return this._update(p);
  }

  /** Read the stored choice and the browser's languages again (another tab, the browser's settings). */
  refresh() { return this._update(this._stored()); }

  _update(pref) {
    const prev = this._lang;
    const prevPref = this._pref;
    this._pref = pref;
    this._lang = resolveLanguage(pref, this.nav);
    if (this._lang !== prev || pref !== prevPref) this.emit('change', { lang: this._lang, prev, pref, prevPref });
    return this._lang !== prev;
  }

  /**
   * Follow another tab's pick (storage event: the window's, or the storage hub's when the page has one,
   * core/platform.js storageSource) and the browser's language settings (languagechange).
   */
  bindWindow(win = typeof window !== 'undefined' ? window : null) {
    if (this._off || !win || typeof win.addEventListener !== 'function') return;
    const onStorage = ev => { if (!ev || ev.key === RUNTIME_KEY || ev.key === null) this.refresh(); };
    const onLang = () => this.refresh();
    const src = storageSource(win);
    src.addEventListener('storage', onStorage);
    win.addEventListener('languagechange', onLang);
    this._off = () => {
      src.removeEventListener('storage', onStorage);
      win.removeEventListener('languagechange', onLang);
    };
  }

  dispose() {
    if (this._off) this._off();
    this._off = null;
  }
}

let shared = null;

/** The page's one UiLanguage (the runtime's; components given none show English). */
export function sharedLanguage() {
  return shared || (shared = new UiLanguage());
}
