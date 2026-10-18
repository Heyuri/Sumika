// The Preferences box (ssp-ui.md §2.13): SSP's settings dialog (DIALOG 124, "SSP: Preferences" / "SSP:設定") cut down
// to the one part a browser has a use for, the General page's "User information" group (DIALOG 105: Name, Nickname,
// Birthday, Sex). Reached by `\![open,con…]` and Options ▸ Preferences…; one box per page, owned by the Site, as SSP
// has one dialog for every ghost [disasm CMainFrame::ShowPropertyWindow 0x46cae0]. Modeless: scripts go on. Each edit
// is stored at once (core/user.js); closing the box tells its owner whether a field was touched, and the owner sends
// OnNotifyUserInfo [disasm CSetupDefDlg::OnDestroy 0x4a4d30]. The look follows the Information window (ui/info.js).
// Phones only (the `phone` option, UI §9.11): the box follows the visual viewport (the on-screen keyboard) and its
// fields are 16 px; without it (every desktop) the CSS alone places it.
import { log } from '../core/log.js';
import { getRoot, addStyle, Z_BASE } from './root.js';
import { t } from '../core/i18n.js';
import { SEXES } from '../core/user.js';
import { visibleRect, watchVisible, zoomed } from './viewport.js';

const FIELDS = ['name', 'nickname', 'birthday', 'sex'];
const text = v => (typeof v === 'string' ? v : '');

/**
 * The box's words and values for one state, without a DOM: title, the page heading, the group, the four rows in SSP's
 * order (Name, Nickname: text; Birthday: a date, '' for none; Sex: three radios, Undefined while nothing is stored),
 * SSP's note and the Close button.
 * @param {{name?, nickname?, birthday?, sex?}} data UserProfile.data
 * @param {string} [lang] UI language
 */
export function settingsView(data, lang = 'en') {
  const d = data || {};
  return {
    title: t('settings.title', lang),
    heading: t('settings.general', lang),
    group: t('settings.user', lang),
    rows: [
      { key: 'name', kind: 'text', label: t('settings.name', lang), value: text(d.name) },
      { key: 'nickname', kind: 'text', label: t('settings.nickname', lang), value: text(d.nickname) },
      { key: 'birthday', kind: 'date', label: t('settings.birthday', lang), value: text(d.birthday) },
      { key: 'sex', kind: 'radio', label: t('settings.sex', lang), value: SEXES.includes(d.sex) ? d.sex : 'undef',
        options: SEXES.map(v => ({ value: v, label: t(`settings.sex.${v}`, lang) })) },
    ],
    note: t('settings.note', lang),
    close: t('settings.close', lang),
  };
}

const CSS = `
.smk-settings { position: fixed; z-index: ${Z_BASE + 200}; left: 50%; top: 50%; transform: translate(-50%, -50%);
  width: min(420px, calc(100vw - 32px)); max-height: calc(100vh - 32px); display: flex; flex-direction: column;
  box-sizing: border-box; margin: 0; padding: 0; color: #1f2328; background: #ffffff; border: 1px solid rgba(0,0,0,.18);
  border-radius: 6px; box-shadow: 0 10px 32px rgba(0,0,0,.28); pointer-events: auto; outline: none; color-scheme: light;
  font: 13px/1.5 "Segoe UI", "Yu Gothic UI", "Meiryo UI", system-ui, sans-serif; }
.smk-settings:lang(ja) { font-family: "Yu Gothic UI", "Meiryo UI", "Segoe UI", "Hiragino Sans", system-ui, sans-serif; }
.smk-settings .smk-settings-head { display: flex; align-items: center; gap: 8px; padding: 8px 8px 4px 16px; }
.smk-settings .smk-settings-title { flex: 1; margin: 0; font-size: 14px; font-weight: 600; overflow-wrap: anywhere; }
.smk-settings button { font: inherit; color: inherit; cursor: pointer; }
.smk-settings .smk-settings-x { flex: none; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px;
  background: transparent; font-size: 18px; line-height: 1; color: #57606a; }
.smk-settings .smk-settings-x:hover { background: rgba(0,0,0,.06); color: #1f2328; }
.smk-settings .smk-settings-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 0 16px; }
.smk-settings .smk-settings-page { margin: 4px 0 8px; font-size: 13px; font-weight: 600; }
.smk-settings fieldset { min-width: 0; margin: 0; padding: 4px 12px 12px; border: 1px solid rgba(0,0,0,.18);
  border-radius: 4px; }
.smk-settings legend { padding: 0 4px; color: #57606a; }
.smk-settings .smk-settings-grid { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 8px 10px;
  align-items: center; }
.smk-settings input[type="text"], .smk-settings input[type="date"] { box-sizing: border-box; width: 100%; min-width: 0;
  margin: 0; padding: 3px 6px; font: inherit; color: inherit; background: #ffffff; border: 1px solid rgba(0,0,0,.3);
  border-radius: 3px; }
.smk-settings .smk-settings-radios { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.smk-settings .smk-settings-radios label { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; }
.smk-settings .smk-settings-radios input { margin: 0; }
.smk-settings .smk-settings-note { margin: 10px 0 0; color: #57606a; overflow-wrap: anywhere; }
.smk-settings .smk-settings-foot { display: flex; justify-content: flex-end; padding: 10px 16px 12px; }
.smk-settings .smk-settings-close { min-width: 80px; padding: 4px 16px; border: 1px solid rgba(0,0,0,.25);
  border-radius: 4px; background: #f6f8fa; }
.smk-settings .smk-settings-close:hover { background: #eef1f4; }
.smk-settings :focus-visible { outline: 2px solid #2f6fd0; outline-offset: 1px; }
.smk-settings.smk-pulse { animation: smk-settings-pulse .6s ease-out 2; }
@keyframes smk-settings-pulse { 50% { filter: brightness(1.15) drop-shadow(0 0 4px rgba(80,120,255,.8)); } }
`;

const make = (tag, cls = '') => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
};

/**
 * The visitor is typing in a field of the page itself (an input, textarea, select or contenteditable), the input boxes'
 * test (balloon/dialogs.js). The runtime's own fields are not the page's: in a browser the focus there shows as the
 * `sumika-root` host. A box a script opens then takes no focus, so the keys meant for the page never land in Name
 * (where each one would be stored, and sent to the ghosts at Close); on Windows SSP's dialog cannot take the keyboard
 * from the app the user types in either (the foreground lock) [infer].
 */
function pageFieldFocused() {
  if (typeof document === 'undefined') return false;
  const a = document.activeElement;
  if (!a || a === document.body || a === document.documentElement) return false;
  try {
    const r = getRoot();
    if (r && typeof r.contains === 'function' && r.contains(a)) return false;
  } catch (e) { /* no root: the page's */ }
  return !!(a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName || ''));
}

/**
 * The box (UI §2.13). One per page: a second open() brings it to the front and focuses it (neither open takes the
 * focus from a page field the visitor types in: pageFieldFocused). Every edit is stored at once (UserProfile.set) and
 * marks the box touched; Close, × and Esc close it, call onClose({touched}) and give the focus back. destroy() (the
 * page going) closes it without onClose. Labels follow a language change while it is open, and the fields follow
 * another tab's edits. Without a DOM it opens and closes all the same (headless tests, the sweep).
 */
export class SettingsWindow {
  /**
   * @param {object} [o]
   * @param {object} [o.user] core/user.js UserProfile (data, set(patch), 'change')
   * @param {object} [o.language] core/language.js UiLanguage; none: English
   * @param {(r: {touched: boolean}) => void} [o.onClose]
   * @param {{short:number, long:number, mobileView:boolean}|null} [o.phone] phones only (UI §9.11): the box follows
   *   the visual viewport and its fields are 16 px; none: the desktop box
   */
  constructor({ user = null, language = null, onClose = null, phone = null } = {}) {
    this.user = user && typeof user.set === 'function' ? user : null;
    this.language = language && typeof language.on === 'function' ? language : null;
    this.onClose = typeof onClose === 'function' ? onClose : null;
    this.phone = phone || null;
    this._offVis = null;          // phones: off() of the visual viewport watcher, while open
    this.el = null;
    this.touched = false;         // a field was edited since the box opened (even back to what it was: SSP's flag)
    this.prevFocus = null;
    this._headless = false;       // open without a DOM
    this._parts = null;           // the elements that show words or values
    this._offLang = this.language ? this.language.on('change', () => this._label()) : null;
    this._offUser = this.user && typeof this.user.on === 'function' ? this.user.on('change', () => this._sync()) : null;
  }

  get lang() { return this.language ? this.language.lang : 'en'; }

  get isOpen() { return !!this.el || this._headless; }

  /** the state the box shows (settingsView) */
  view() { return settingsView(this.user ? this.user.data : {}, this.lang); }

  /** Open, the focus in Name; while the visitor types in a page field the box only shows itself (pageFieldFocused). */
  open() {
    if (this.isOpen) { this._front(); return; }
    this.touched = false;
    if (typeof document === 'undefined') { this._headless = true; return; }
    const typing = pageFieldFocused();
    this.prevFocus = typing ? null : document.activeElement;
    addStyle('settings', CSS);
    this.el = this._build();
    getRoot().appendChild(this.el);
    this._label();
    this._sync();
    if (this.phone) {
      this._offVis = watchVisible(typeof window !== 'undefined' ? window : null, vis => this._fitVisible(vis));
      this._fitVisible();
    }
    if (typing) this._pulse();
    else this._focus(this._parts.inputs.name);
  }

  /**
   * A visitor's edit of one field (the DOM's input / change events come here): stored at once [disasm OnChangeFirstname
   * 0x4a5160, OnChangeCallname 0x4a5240, OnChangeBirthday 0x4a5320, OnSexChoice 0x4a53c0], and the box is touched.
   * @param {'name'|'nickname'|'birthday'|'sex'} key
   * @param {string} value
   */
  edit(key, value) {
    if (!this.isOpen || !FIELDS.includes(key)) return;
    this.touched = true;
    if (this.user) this.user.set({ [key]: value });
  }

  /** Close (the button, ×, Esc): the focus goes back where it was, then onClose({touched}), once per close. */
  close({ restoreFocus = true } = {}) {
    if (!this.isOpen) return;
    const touched = this.touched;
    const back = this.prevFocus;
    this._remove();
    if (restoreFocus && back && typeof back.focus === 'function') this._focus(back);
    if (this.onClose) {
      try { this.onClose({ touched }); } catch (e) { log.error('settings: onClose failed', e); }
    }
  }

  /** The page goes: the box goes without onClose (nothing is sent; the next page's boot tells the ghosts). */
  destroy() {
    this._remove();
    if (this._offLang) this._offLang();
    if (this._offUser) this._offUser();
    this._offLang = this._offUser = null;
  }

  _remove() {
    if (this._offVis) this._offVis();
    this._offVis = null;
    if (this.el) this.el.remove();
    this.el = null;
    this._parts = null;
    this._headless = false;
    this.touched = false;
    this.prevFocus = null;
  }

  _build() {
    const el = make('div', 'smk-settings');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'false');
    el.setAttribute('aria-labelledby', 'smk-settings-title');
    el.tabIndex = -1;
    el.addEventListener('keydown', ev => this._onKey(ev));   // keys inside the runtime's root never reach the ghost
    if (this.phone) el.addEventListener('focusin', () => this._fitVisible());
    const head = make('div', 'smk-settings-head');
    const title = make('h2', 'smk-settings-title');
    title.id = 'smk-settings-title';
    const x = make('button', 'smk-settings-x');
    x.type = 'button';
    x.textContent = '×';
    x.addEventListener('click', () => this.close());
    head.append(title, x);
    const body = make('div', 'smk-settings-body');
    const heading = make('h3', 'smk-settings-page');
    const group = make('fieldset');
    const legend = make('legend');
    const grid = make('div', 'smk-settings-grid');
    group.append(legend, grid);
    const labels = {};
    const inputs = {};
    for (const key of ['name', 'nickname', 'birthday']) {
      const label = make('label');
      label.htmlFor = `smk-settings-${key}`;
      const input = make('input');
      input.id = `smk-settings-${key}`;
      input.type = key === 'birthday' ? 'date' : 'text';
      // what the visitor types, never the browser's saved profile [decision]; their text's language is unknown
      input.setAttribute('autocomplete', 'off');
      input.setAttribute('lang', '');
      if (key !== 'birthday') input.spellcheck = false;
      if (this.phone) input.style.fontSize = '16px';         // iOS zooms into a focused field under 16 px [verify]
      const store = () => this.edit(key, input.value);
      input.addEventListener('input', store);
      if (key === 'birthday') input.addEventListener('change', store);
      labels[key] = label;
      inputs[key] = input;
      grid.append(label, input);
    }
    const sexLabel = make('span');
    sexLabel.id = 'smk-settings-sex-label';
    labels.sex = sexLabel;
    const radios = make('div', 'smk-settings-radios');
    radios.setAttribute('role', 'radiogroup');
    radios.setAttribute('aria-labelledby', sexLabel.id);
    const options = SEXES.map(value => {
      const label = make('label');
      const input = make('input');
      input.type = 'radio';
      input.name = 'smk-settings-sex';
      input.value = value;
      input.addEventListener('change', () => { if (input.checked) this.edit('sex', value); });
      const span = make('span');
      label.append(input, span);
      radios.appendChild(label);
      return { value, input, span };
    });
    grid.append(sexLabel, radios);
    const note = make('p', 'smk-settings-note');
    body.append(heading, group, note);
    const foot = make('div', 'smk-settings-foot');
    const close = make('button', 'smk-settings-close');
    close.type = 'button';
    close.addEventListener('click', () => this.close());
    foot.appendChild(close);
    el.append(head, body, foot);
    this._parts = { title, x, body, heading, legend, labels, inputs, options, note, close };
    return el;
  }

  /**
   * Phones (UI §9.11): the box's middle at the middle of the visible part of the page and its height within it (the
   * on-screen keyboard; iOS's pan counted), then the focused field scrolled into view inside its body (scrollTop,
   * never scrollIntoView, which would scroll the page). Its left stays the CSS's 50 %: the keyboard takes no width.
   * Nothing while the page is zoomed [decision].
   * @param {{x:number, y:number, width:number, height:number, scale:number}} [vis] ui/viewport.js visibleRect()
   */
  _fitVisible(vis = visibleRect()) {
    if (!this.phone || !this.el || zoomed(vis)) return;
    this.el.style.top = vis.y + vis.height / 2 + 'px';
    this.el.style.maxHeight = Math.max(120, vis.height - 16) + 'px';
    const body = this._parts && this._parts.body, a = this._activeInside();
    if (!body || !a || !body.contains(a)) return;
    const br = body.getBoundingClientRect(), ar = a.getBoundingClientRect();
    let d = 0;
    if (ar.top + ar.height > br.top + br.height) d = ar.top + ar.height - (br.top + br.height);
    if (ar.top - d < br.top) d = ar.top - br.top;
    if (d) body.scrollTop = (body.scrollTop || 0) + d;
  }

  /** the words, in the UI language */
  _label() {
    const p = this._parts;
    if (!this.el || !p) return;
    const v = this.view();
    this.el.setAttribute('lang', this.lang);
    p.title.textContent = v.title;
    p.x.setAttribute('aria-label', v.close);
    p.x.title = v.close;
    p.heading.textContent = v.heading;
    p.legend.textContent = v.group;
    for (const r of v.rows) {
      p.labels[r.key].textContent = r.label;
      if (r.kind === 'radio') r.options.forEach((o, i) => { p.options[i].span.textContent = o.label; });
    }
    p.note.textContent = v.note;
    p.close.textContent = v.close;
  }

  /** the values, from the profile (only fields that differ: a field being typed in keeps its caret) */
  _sync() {
    const p = this._parts;
    if (!this.el || !p) return;
    for (const r of this.view().rows) {
      if (r.kind === 'radio') {
        for (const o of p.options) if (o.input.checked !== (o.value === r.value)) o.input.checked = o.value === r.value;
      } else if (p.inputs[r.key].value !== r.value) {
        p.inputs[r.key].value = r.value;
      }
    }
  }

  /** a second open: above the runtime's other boxes, the focus inside, unless the visitor types in a page field */
  _front() {
    if (!this.el) return;
    const inside = this._activeInside();
    const typing = !inside && pageFieldFocused();
    const root = getRoot();
    const kids = root.children;
    if (!kids || kids[kids.length - 1] !== this.el) { this.el.remove(); root.appendChild(this.el); }
    if (typing) this._pulse();
    else this._focus(inside || this._parts.inputs.name);
  }

  /** show itself without the focus: the input boxes' pulse (balloon/dialogs.js), again on each call */
  _pulse() {
    const c = this.el && this.el.classList;
    if (!c) return;
    c.remove('smk-pulse');
    void this.el.offsetWidth;                     // a new animation, not the one already run
    c.add('smk-pulse');
  }

  _activeInside() {
    const r = getRoot();
    const a = (r && r.activeElement) || (typeof document !== 'undefined' ? document.activeElement : null);
    return a && this.el && this.el.contains(a) ? a : null;
  }

  _focus(e) {
    try { e.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
  }

  /** the elements Tab moves between: ×, the fields, the checked radio (one stop for the group), Close */
  _stops() {
    const p = this._parts;
    const radio = (p.options.find(o => o.input.checked) || p.options[0]).input;
    return [p.x, p.inputs.name, p.inputs.nickname, p.inputs.birthday, radio, p.close];
  }

  _onKey(ev) {
    if (ev.key === 'Escape') {
      if (ev.isComposing) return;                 // Esc ends the IME's composition first
      ev.preventDefault();
      ev.stopPropagation();
      this.close();
      return;
    }
    if (ev.key === 'Tab' && this._parts) {
      const list = this._stops();
      const i = list.indexOf(this._activeInside());
      const next = ev.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i === list.length - 1 ? 0 : i + 1);
      ev.preventDefault();
      this._focus(list[next]);
    }
  }
}
