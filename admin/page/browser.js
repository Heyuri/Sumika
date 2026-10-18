// The in-page file browser: the program lists any folder of the computer (POST /api/fs/roots,
// /api/fs/list); the listing is a native <select> (multiple when picking sources): arrows, type-ahead, Shift / Ctrl
// selection, Enter or a double-click opens a folder, Backspace goes up; a path field (Enter = go), Up, Open and the
// mode's own button. One tab stop for the list, no custom grid. Modes: 'sources' (ghost folders, folders of ghosts,
// archives: several at once), 'folder' (the folder shown is the answer: the site folder), 'file' (one file the filter
// accepts: an archive or update list to compare with).
import { el, fill, clear, applyStrings } from './dom.js';
import { t, findingText } from './strings.js';
import { joinPath } from './format.js';

let uid = 0;

// a link opens as the folder it points to (its target 'dir', or unknown); a link to a file is a file
const isFolder = e => e.kind === 'dir' || (e.kind === 'link' && e.target !== 'file');
const ARCHIVE_NAME = /\.(nar|zip)$/i;
const isSource = e => isFolder(e) || !!e.archive || !!e.ghost || (e.kind === 'link' && ARCHIVE_NAME.test(e.name));

export class FileBrowser {
  /**
   * @param {{api: object, lang: () => string}} app
   * @param {{mode: 'sources'|'folder'|'file', onChoose: Function, onCancel?: Function,
   *   accept?: (e: object) => boolean, hint?: () => [string, object]}} o  accept: which listed file (an entry of
   *   /api/fs/list) 'file' mode may choose; hint: the key and parameters of the line above the list
   */
  constructor(app, { mode, onChoose, onCancel = null, accept = null, hint = null }) {
    this.app = app;
    this.mode = mode;
    this.onChoose = onChoose;
    this.onCancel = onCancel;
    this.accept = accept;
    this.hint = hint;
    this.path = null;
    this.parent = null;
    this.entries = [];
    this.roots = null;
    this.busy = false;
    this.problem = null;
    const id = `fb${++uid}`;
    const lang = () => app.lang();
    this.hintEl = el('p', { class: 'hint', id: `${id}-hint` });
    this.placesEl = el('div', { class: 'places' });
    this.pathInput = el('input', {
      type: 'text', id: `${id}-path`, class: 'path', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
      onkeydown: e => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.go(this.pathInput.value);
        }
      },
    });
    this.goBtn = el('button', { type: 'button', 'data-t': 'browser.go', onclick: () => this.go(this.pathInput.value) });
    this.upBtn = el('button', { type: 'button', 'data-t': 'browser.up', onclick: () => this.up() });
    this.list = el('select', {
      id: `${id}-list`, class: 'listing', size: '16', multiple: mode === 'sources', 'aria-describedby': `${id}-hint`,
      onchange: () => this.updateButtons(),
      onkeydown: e => this.onKey(e),
      ondblclick: e => {
        if (e.target && e.target.tagName === 'OPTION') this.activate();
      },
    });
    this.stateEl = el('p', { class: 'state', role: 'status' });
    this.openBtn = el('button', { type: 'button', 'data-t': 'browser.open', onclick: () => this.openSelected() });
    const chooseKey = { sources: 'browser.addSelected', folder: 'site.use', file: 'browser.useFile' }[mode];
    this.chooseBtn = el('button', { type: 'button', class: 'primary', 'data-t': chooseKey, onclick: () => this.choose() });
    this.cancelBtn = onCancel ? el('button', { type: 'button', 'data-t': 'common.cancel', onclick: () => onCancel() }) : null;
    this.el = el('div', { class: 'browser' },
      this.hintEl,
      this.placesEl,
      el('div', { class: 'pathbar' },
        el('label', { for: `${id}-path`, 'data-t': 'browser.path' }), this.pathInput, this.goBtn, this.upBtn),
      el('label', { for: `${id}-list`, class: 'listing-label', 'data-t': 'browser.list' }),
      this.list,
      this.stateEl,
      el('div', { class: 'actions' }, this.openBtn, this.chooseBtn, this.cancelBtn));
    applyStrings(this.el, lang());
  }

  get lang() {
    return this.app.lang();
  }

  /** Opens the browser at `path`, else where it was, else the first recent place or home. */
  async start(path = null) {
    await this.loadRoots();
    const first = path || this.path || this.firstPlace();
    if (first) await this.go(first);
    else this.render();
  }

  firstPlace() {
    const places = (this.roots && this.roots.places) || [];
    const recent = places.find(p => p.kind === 'recent');
    const home = places.find(p => p.kind === 'home');
    const drives = (this.roots && this.roots.drives) || [];
    return (recent && recent.path) || (home && home.path) || (drives.length ? driveOf(drives[0]).path : null);
  }

  async loadRoots() {
    if (this.roots) return;
    try {
      this.roots = await this.app.api.roots();
    } catch (e) {
      this.roots = { drives: [], places: [] };
    }
    this.renderPlaces();
  }

  async go(path) {
    const p = String(path || '').trim();
    if (!p || this.busy) return;
    this.busy = true;
    this.problem = null;
    this.stateEl.textContent = t('browser.loading', this.lang);
    try {
      const r = await this.app.api.list(p);
      this.path = r.path || p;
      this.parent = r.parent || null;
      this.entries = Array.isArray(r.entries) ? r.entries : [];
    } catch (e) {
      this.problem = e;
    } finally {
      this.busy = false;
    }
    this.render();
    if (!this.problem) this.list.selectedIndex = -1;
    this.updateButtons();
  }

  up() {
    if (this.parent) this.go(this.parent);
  }

  selected() {
    return Array.from(this.list.options).filter(o => o.selected && !o.disabled).map(o => this.entries[Number(o.value)])
      .filter(Boolean);
  }

  /** Enter / double-click: a folder opens; in 'file' mode an accepted file is chosen. */
  activate() {
    const sel = this.selected();
    if (sel.length !== 1) return;
    const e = sel[0];
    if (isFolder(e)) this.go(joinPath(this.path, e.name));
    else if (this.mode === 'file' && this.accepts(e)) this.choose();
  }

  openSelected() {
    const sel = this.selected();
    if (sel.length === 1 && isFolder(sel[0])) this.go(joinPath(this.path, sel[0].name));
  }

  onKey(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      this.activate();
    } else if (e.key === 'Backspace') {
      e.preventDefault();
      this.up();
    }
  }

  accepts(e) {
    return (e.kind === 'file' || (e.kind === 'link' && e.target === 'file')) && (!this.accept || !!this.accept(e));
  }

  choose() {
    if (this.mode === 'folder') {
      if (this.path) this.onChoose(this.path);
      return;
    }
    const sel = this.selected();
    if (this.mode === 'file') {
      if (sel.length === 1 && this.accepts(sel[0])) this.onChoose(joinPath(this.path, sel[0].name));
      return;
    }
    const picked = sel.filter(isSource).map(e => joinPath(this.path, e.name));
    if (picked.length) this.onChoose(picked);
  }

  updateButtons() {
    const sel = this.selected();
    this.upBtn.disabled = !this.parent || this.busy;
    this.openBtn.disabled = !(sel.length === 1 && isFolder(sel[0]));
    if (this.mode === 'folder') this.chooseBtn.disabled = !this.path || !!this.problem;
    else if (this.mode === 'file') this.chooseBtn.disabled = !(sel.length === 1 && this.accepts(sel[0]));
    else this.chooseBtn.disabled = !sel.some(isSource);
  }

  optionText(e) {
    const L = this.lang;
    if (e.ghost) return t('browser.kind.ghost', L, { name: e.name, ghost: e.ghost.name ?? '' });
    if (e.kind === 'dir') return t('browser.kind.dir', L, { name: e.name });
    if (e.kind === 'link') return t('browser.kind.link', L, { name: e.name });
    if (e.archive) return t('browser.kind.archive', L, { name: e.name });
    if (e.list) return t('browser.kind.list', L, { name: e.name });
    return e.name;                                           // a file name is data, the same in both languages
  }

  disabled(e) {
    if (this.mode === 'folder') return !isFolder(e);
    if (this.mode === 'file') return !isFolder(e) && !this.accepts(e);
    return false;
  }

  renderPlaces() {
    const L = this.lang;
    const roots = this.roots || { drives: [], places: [] };
    const group = (labelKey, items) => (items.length ? el('div', { class: 'place-group', role: 'group', 'aria-label': t(labelKey, L) },
      el('span', { class: 'place-label', 'aria-hidden': 'true' }, t(labelKey, L)), items) : null);
    const all = [...(roots.drives || []).map(driveOf), ...(roots.unavailable || []).map(d => ({ path: String(d), available: false }))];
    const drives = all.map(d => el('button', {
      type: 'button', disabled: !d.available, onclick: () => this.go(d.path),
    }, d.available ? d.path : t('browser.unavailable', L, { drive: d.path })));
    const places = (roots.places || []).filter(p => p && p.kind !== 'recent' && p.path)
      .map(p => el('button', { type: 'button', title: p.path, onclick: () => this.go(p.path) },
        t(`browser.place.${p.kind}`, L)));
    const recent = (roots.places || []).filter(p => p && p.kind === 'recent' && p.path)
      .map(p => el('button', { type: 'button', class: 'recent', onclick: () => this.go(p.path) }, p.path));
    fill(this.placesEl, group('browser.drives', drives), group('browser.places', places), group('browser.recent', recent));
  }

  render() {
    const L = this.lang;
    applyStrings(this.el, L);
    if (this.hint) {
      const [key, params] = this.hint();
      this.hintEl.textContent = t(key, L, params);
    }
    this.renderPlaces();
    if (!this.problem) this.pathInput.value = this.path || '';      // a path that failed stays as typed
    const keep = new Set(Array.from(this.list.options).filter(o => o.selected).map(o => o.value));
    clear(this.list);
    this.entries.forEach((e, i) => {
      this.list.append(el('option', { value: String(i), disabled: this.disabled(e), selected: keep.has(String(i)) }, this.optionText(e)));
    });
    if (this.problem) this.stateEl.textContent = findingText(this.problem, L);
    else if (this.busy) this.stateEl.textContent = t('browser.loading', L);
    else this.stateEl.textContent = this.entries.length ? '' : t('browser.empty', L);
    this.stateEl.classList.toggle('error', !!this.problem);
    this.updateButtons();
  }

  focus() {
    (this.entries.length ? this.list : this.pathInput).focus();
  }
}

/** A drive as /api/fs/roots gives it: 'C:\\' or {path, available?}. */
function driveOf(d) {
  if (d && typeof d === 'object') return { path: String(d.path), available: d.available !== false && d.ok !== false };
  return { path: String(d), available: true };
}
