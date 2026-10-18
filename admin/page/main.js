// sumika-admin's page: the shell (a header with the screens, the language and Quit; one <section>
// per screen; the status line with its <progress>), the boot (the key from ?key= into the tab's sessionStorage, the
// address cleaned to /, GET /api/hello), polling (jobs.js), the wait for a program that gives no answer (a line, then
// the stopped state, which ends by itself when it answers: api.js), and the screens. admin/build.mjs --page bundles
// this file (ESM → IIFE, es2020) with style.css into index.html and hashes both for the page's CSP; no external
// resource.
import { systemLanguage } from '../../src/core/i18n.js';
import { skipCode, isSkipDir } from '../core/rules.mjs';
import { createApi, takeKey } from './api.js';
import { t, uiLang, LANGS, findingText as findingTextOf } from './strings.js';
import { settles } from '../server/outcome.mjs';
import { interruptedNotice, wasDismissed, rememberDismissed } from './interrupted.js';
import { el, fill, applyStrings } from './dom.js';
import { Jobs, Throttled, statusText } from './jobs.js';
import { Messages } from './ui.js';
import { Picker } from './picker.js';
import { siteScreen } from './screens/site.js';
import { ghostsScreen } from './screens/ghosts.js';
import { addScreen } from './screens/add.js';
import { sharingScreen } from './screens/sharing.js';
import { checkScreen } from './screens/check.js';
import { previewScreen } from './screens/preview.js';

export const SCREENS = Object.freeze(['site', 'ghosts', 'add', 'sharing', 'check', 'preview']);
const FACTORIES = { site: siteScreen, ghosts: ghostsScreen, add: addScreen, sharing: sharingScreen, check: checkScreen,
  preview: previewScreen };

class App {
  constructor(win, key) {
    this.win = win;
    this.doc = win.document;
    this.langValue = systemLanguage(win.navigator);
    this.lang = () => this.langValue;
    this.api = createApi({ key, onAuthLost: () => this.dead('auth'), onState: s => this.connection(s) });
    this.jobs = new Jobs({ api: this.api, onChange: s => this.onStatus(s), onEnd: why => this.dead(why) });
    this.rules = { skip: skipCode, skipDir: isSkipDir };     // the core's own: what a drop never sends
    this.hello = null;
    this.site = null;
    this.settings = null;
    this.screens = {};
    this.picker = null;                    // the system's file dialogs (picker.js), after hello
    this.current = null;
    this.ended = false;
    this.offline = null;                   // 'waiting' | 'stopped' while the program gives no answer (api.js onState)
    this.interrupted = null;               // hello's `interrupted` while its notice shows
    this.starting = false;                 // the program is still settling what an earlier start left (hello, status)
    this.startingLine = L => t('boot.starting', L);
    this.lastPreview = undefined;
    this.statusEl = this.doc.getElementById('status');
    this.progressEl = this.doc.getElementById('progress');
    this.itemEl = this.doc.getElementById('status-item');
    this.bannerEl = this.doc.getElementById('banner');
    this.waitEl = this.doc.getElementById('waiting');
    this.say = new Throttled(text => { this.statusEl.textContent = text; });
    this.notices = new Messages(this.doc.getElementById('notices'), this.lang);
  }

  async start() {
    this.applyLang();
    this.statusEl.textContent = t('boot.connecting', this.langValue);
    let hello;
    try {
      hello = await this.api.hello();                        // no answer: the client waits for the program (api.js)
    } catch (e) {
      if (!this.ended) this.dead(e && e.auth ? 'auth' : 'failed', e);
      return;
    }
    this.hello = hello || {};
    this.settings = this.hello.settings || {};
    this.site = this.hello.site || null;
    this.langValue = uiLang(this.settings.language) || this.langValue;
    this.picker = new Picker({
      api: this.api, lang: this.lang, available: this.hello.picker === true,
      onChange: () => { for (const s of Object.values(this.screens)) if (s.pickerChanged) s.pickerChanged(); },
    });
    for (const name of SCREENS) this.screens[name] = FACTORIES[name](this, this.doc.getElementById(`screen-${name}`));
    this.wire();
    this.applyLang();
    // hello's open dialog goes to the picker through onStatus, as status's does
    this.starting = this.hello.starting === true;
    this.jobs.update({ job: this.hello.job ?? null, preview: this.hello.preview ?? null, pick: this.hello.pick ?? null, starting: this.starting });
    this.jobs.start();
    // the start still settling what an earlier one left: a line until status says it is done, then hello's notice
    if (this.starting) this.notices.set('info', this.startingLine);
    else this.showInterrupted(this.hello.interrupted);
    this.show(this.site ? 'ghosts' : 'site');
  }

  /**
   * A job an earlier start did not finish (hello's `interrupted`): what it did to the site and the one thing to do (or
   * nothing), unless this tab dismissed it; the server keeps it until a job settles it, which the polls then show (a
   * job running at hello's time too).
   */
  showInterrupted(cut) {
    if (!cut || typeof cut !== 'object' || wasDismissed(this.win, cut)) return;
    const it = { ...cut };
    this.interrupted = it;
    this.notices.set('info', L => interruptedLine(this, it, L));
  }

  /** The start has settled what an earlier one left (status's `starting` went false): its line goes, hello's notice. */
  async startDone() {
    this.starting = false;
    let h = null;
    try {
      h = await this.api.hello();
    } catch (e) { /* dead() has run for a stopped program */ }
    if (this.ended) return;
    const lines = this.notices.lines;
    if (lines.length === 1 && lines[0].draw === this.startingLine) this.notices.clear();
    if (h) {
      if (this.hello) this.hello.interrupted = h.interrupted ?? null;
      this.showInterrupted(h.interrupted);
    }
    // the ghost list as the tidying up left it: a replaced ghost's folder it put back no longer shows as missing
    if (this.current === 'ghosts' && this.screens.ghosts.reload) this.screens.ghosts.reload();
  }

  /**
   * The cut-off job's notice is done with: a job settled it (outcome.mjs settles), or the admin dismissed it, which this
   * tab remembers (a reload does not bring it back; the server keeps it until a job starts).
   */
  endInterrupted({ dismissed = false } = {}) {
    if (!this.interrupted) return;
    if (dismissed) rememberDismissed(this.win, this.interrupted);
    this.interrupted = null;
    this.notices.clear();
  }

  /** "Finish adding" / "Finish removing" / "Update the index": the index job, then the ghost list again. */
  async finishIndex() {
    const job = await this.runJob(() => this.api.index(), this.notices);
    if (!job) return;
    if (job.state !== 'done') {
      this.notices.set('error', L => findingTextOf(job.error, L));
      return;
    }
    this.endInterrupted();
    this.notices.set('ok', L => t('job.interrupted.finished', L));
    this.refreshSite();
    if (this.current === 'ghosts' && this.screens.ghosts.reload) this.screens.ghosts.reload();
  }

  wire() {
    for (const b of this.doc.querySelectorAll('[data-screen]')) {
      b.addEventListener('click', () => this.show(b.getAttribute('data-screen')));
    }
    for (const b of this.doc.querySelectorAll('[data-lang]')) b.addEventListener('click', () => this.setLang(b.getAttribute('data-lang')));
    this.doc.getElementById('quit').addEventListener('click', () => this.quit());
    // a drop that misses the drop zone must not open the file in this tab
    const guard = e => {
      if (e.target && e.target.closest && e.target.closest('.dropzone')) return;
      e.preventDefault();
      if (e.type === 'dragover' && e.dataTransfer) e.dataTransfer.dropEffect = 'none';
    };
    this.doc.addEventListener('dragover', guard);
    this.doc.addEventListener('drop', guard);
  }

  // ---- screens ----

  show(name, opts = {}) {
    if (this.ended || !this.screens[name]) return;
    this.current = name;
    for (const s of SCREENS) this.doc.getElementById(`screen-${s}`).hidden = s !== name;
    for (const b of this.doc.querySelectorAll('[data-screen]')) {
      if (b.getAttribute('data-screen') === name) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    }
    const r = this.screens[name].enter(opts);
    this.focusHeading(this.doc.getElementById(`screen-${name}`));
    return r;
  }

  focusHeading(section) {
    const h = section && section.querySelector('h2');
    if (h) h.focus();
  }

  /** After a list was drawn again: when the focused element went with it, focus `fallback` (the keyboard's place). */
  refocus(fallback) {
    const a = this.doc.activeElement;
    if ((!a || a === this.doc.body || !a.isConnected) && fallback) fallback.focus();
  }

  /** "Choose the site folder first", with the way there. */
  noSiteNotice() {
    const L = this.langValue;
    return el('p', null, t('common.noSite', L), ' ',
      el('button', { type: 'button', class: 'link', onclick: () => this.show('site') }, t('common.toSite', L)));
  }

  /** Why the site cannot be changed (another Sumika version's index or stored data), or null. */
  readOnlyNotice() {
    if (!this.site || !this.site.readOnly) return null;
    const L = this.langValue;
    return el('p', { class: 'msg msg-info' }, t('common.readOnly', L, { why: findingTextOf(this.site.readOnlyInfo || this.site.readOnly, L) }));
  }

  setSite(info) {
    this.site = info || null;
    if (this.settings && info) this.settings.site = info.path;
    for (const s of Object.values(this.screens)) if (s.siteChanged) s.siteChanged();
    this.renderAll();
  }

  /** The site's facts again (ghost count, hub, read only) after a change: GET /api/hello has no side effect. */
  async refreshSite() {
    try {
      const h = await this.api.hello();
      if (h) {
        this.site = h.site || null;
        if (this.hello) this.hello.siteError = h.siteError || null;
        if (h.settings) this.settings = h.settings;
        if (this.screens.site) this.screens.site.render();
      }
    } catch (e) { /* dead() has run for a stopped program */ }
  }

  renderAll() {
    for (const s of Object.values(this.screens)) s.render();
  }

  // ---- the language ----

  applyLang() {
    const L = this.langValue;
    this.doc.documentElement.lang = L;
    applyStrings(this.doc, L);
    for (const b of this.doc.querySelectorAll('[data-lang]')) b.setAttribute('aria-pressed', String(b.getAttribute('data-lang') === L));
    const v = this.doc.getElementById('version');
    if (v) v.textContent = this.hello && this.hello.version ? t('app.version', L, { version: this.hello.version }) : '';
  }

  setLang(l) {
    const L = uiLang(l);
    if (!L || this.ended) return;
    const changed = L !== this.langValue;
    this.langValue = L;
    this.applyLang();
    if (changed) {
      this.renderAll();
      this.notices.render();
      this.renderConnection();
      this.say.set(statusText(this.jobs.job, L), `lang|${L}`);
    }
    this.api.settings({ language: L }).catch(() => { /* a stopped program is reported by dead() */ });
  }

  // ---- jobs and the status line ----

  /**
   * Starts a job and follows it. A refusal to start (busy, read only …) is said in `msgs` and gives null; a code in
   * `quiet` is returned as it is instead (the caller asks something).
   */
  async runJob(start, msgs, { quiet = [] } = {}) {
    let job;
    try {
      job = await start();
    } catch (e) {
      if (e && quiet.includes(e.code)) return e.code;
      if (!this.handleError(e, msgs)) msgs.set('error', L => findingTextOf(e, L));
      return null;
    }
    return this.jobs.follow(job);
  }

  /** Errors every screen treats alike: this tab's key is old, or the page has ended (dead() says it). */
  handleError(e) {
    return !!(e && (e.offline || e.auth));
  }

  // ---- the program's answers ----

  /**
   * The program gives no answer, or answers again (api.js onState). 'waiting': a line, the page stays usable (its calls
   * wait); 'stopped' (no answer for WAIT_MS): closed or stuck, said in the banner, nothing can be pressed, and the
   * client asks on; 'ok': everything goes on where it was, the site's facts read again.
   */
  connection(state) {
    if (this.ended) return;
    const was = this.offline;
    this.offline = state === 'ok' ? null : state;
    this.renderConnection();
    if (state === 'stopped') {
      this.block(true);
      this.statusEl.textContent = '';                       // not "Ready.": the banner says what is going on
      this.progressEl.hidden = true;
      this.itemEl.textContent = '';
      this.bannerEl.focus();
    } else if (was === 'stopped') {
      this.block(false);
      this.say.set(statusText(this.jobs.job, this.langValue), `back|${Date.now()}`);
      if (this.current) this.focusHeading(this.doc.getElementById(`screen-${this.current}`));
      if (this.hello) this.refreshSite();
    }
  }

  renderConnection() {
    if (this.ended) return;
    const L = this.langValue;
    this.waitEl.hidden = this.offline !== 'waiting';
    this.waitEl.textContent = this.offline === 'waiting' ? t('boot.waiting', L) : '';
    if (this.offline === 'stopped') {
      fill(this.bannerEl, el('p', null, t('boot.stopped', L)), el('p', null, t('boot.stoppedNext', L)));
      this.bannerEl.hidden = false;
    } else {
      this.bannerEl.hidden = true;
      fill(this.bannerEl);
    }
  }

  /** Nothing can be pressed (the stopped state, the end): the screens greyed and inert, the header's buttons off. */
  block(on) {
    const main = this.doc.getElementById('main');
    if (on) main.setAttribute('inert', '');
    else main.removeAttribute('inert');
    main.classList.toggle('ended', on);
    for (const b of this.doc.querySelectorAll('header button')) b.disabled = on;
    // a dialog (Remove's) is outside <main> and above the banner: closed as by Cancel (ui.js ask answers no)
    if (on) for (const d of this.doc.querySelectorAll('dialog[open]')) d.close();
  }

  onStatus({ job, preview, pick, starting }) {
    if (this.ended) return;
    // a dialog open that this page does not wait for (another tab's, or this page's before a reload): its line now
    if (pick !== undefined && this.picker) this.picker.seen(pick);
    if (this.starting && starting === false) this.startDone();
    if (this.interrupted && job && settles(this.interrupted, job)) this.endInterrupted();
    const L = this.langValue;
    this.say.set(statusText(job, L), job ? `${job.id}|${job.state}|${job.phase}` : 'idle');
    const running = !!(job && job.state === 'running');
    this.progressEl.hidden = !running;
    if (running && typeof job.total === 'number' && job.total > 0) {
      this.progressEl.max = job.total;
      this.progressEl.value = Math.min(job.done || 0, job.total);
    } else this.progressEl.removeAttribute('value');
    this.itemEl.textContent = running && job.item ? String(job.item) : '';
    const p = JSON.stringify(preview ?? null);
    if (p !== this.lastPreview) {
      this.lastPreview = p;
      if (this.screens.preview) this.screens.preview.previewChanged();
    }
  }

  // ---- the end ----

  async quit() {
    if (this.ended) return;
    try {
      await this.api.quit();
    } catch (e) {
      if (!this.handleError(e)) this.notices.set('error', L => findingTextOf(e, L));
      return;
    }
    this.dead('quit');
  }

  /**
   * The end of this page: Quit ('quit'), this tab belongs to an earlier start ('auth'), or the page could not start
   * ('failed': hello refused, `error`); nothing works now. A program that gives no answer is no end (connection()).
   */
  dead(why, error = null) {
    if (this.ended) return;
    this.ended = true;
    this.api.end();
    this.jobs.end(why);
    this.say.dispose();
    const L = this.langValue;
    this.waitEl.hidden = true;
    const banner = this.bannerEl;
    banner.textContent = why === 'auth' ? t('boot.oldTab', L) : why === 'quit' ? t('boot.quit', L)
      : why === 'failed' ? failedText(error, L) : t('boot.stopped', L);
    banner.hidden = false;
    this.block(true);
    this.progressEl.hidden = true;
    this.statusEl.textContent = '';
    this.itemEl.textContent = '';
    banner.focus();
  }
}

/**
 * Why the page could not start (hello refused), with what to do said once: an error whose own text says to try again
 * (internal, not-sent) gets the banner's own words around its detail.
 */
export function failedText(error, L) {
  const code = error && error.code;
  const detail = error && error.params && error.params.error ? String(error.params.error) : String((error && error.message) || '');
  if (code === 'internal') return t('boot.failedInternal', L, { error: detail });
  if (code === 'not-sent') return t('boot.failedNotSent', L, { error: detail });
  return t('boot.failed', L, { why: findingTextOf(error, L) });
}

/** The cut-off job's notice (interrupted.js) with its one button. */
function interruptedLine(app, it, L) {
  const { text, action } = interruptedNotice(it, L);
  const run = {
    dismiss: () => app.endInterrupted({ dismissed: true }),
    index: () => app.finishIndex(),
    prepare: () => app.show('check', { prepare: true }),
    check: () => app.show('check', { run: true }),
  }[action.run];
  return [text, ' ', el('button', { type: 'button', class: 'link', onclick: run }, t(action.key, L))];
}

/** No key in the address nor in this tab: the page says, in both languages, where it opens from. */
function noKey(doc, lang) {
  const banner = doc.getElementById('banner');
  const order = lang === 'ja' ? LANGS : [...LANGS].reverse();
  fill(banner, order.map(L => el('p', { lang: L }, t('boot.noKey', L))));
  banner.hidden = false;
  doc.getElementById('main').hidden = true;
  for (const n of doc.querySelectorAll('header nav, header .tools')) n.hidden = true;
  doc.documentElement.lang = lang;
  applyStrings(doc, lang);
}

function boot(win) {
  const key = takeKey(win);
  if (!key) {
    noKey(win.document, systemLanguage(win.navigator));
    return;
  }
  new App(win, key).start();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') boot(window);
