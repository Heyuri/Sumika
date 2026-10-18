// The Site screen: the site folder in use (its path, the runtime build, whether it has the
// storage hub, its ghost count, why it is read only), choosing it (POST /api/site) in the system's folder dialog
// (picker.js), or in the in-page file browser in folder mode where there is none or when asked, and where the settings
// are saved.
import { el, fill, code, tNodes } from '../dom.js';
import { t, plural, findingText } from '../strings.js';
import { FileBrowser } from '../browser.js';
import { parentOf } from '../format.js';
import { Messages } from '../ui.js';
import { waitingLine } from '../picker.js';

/** A SiteInfo's ghost count (`ghosts` is a count or the list). */
export const ghostCount = info => (Array.isArray(info && info.ghosts) ? info.ghosts.length : Number((info && info.ghosts) || 0));

/**
 * The siteError codes with an end of their own instead of "choose it again": those whose text says what to do, and
 * the project's own site/ in a dev run, which choosing again cannot make usable.
 */
const OWN_END = Object.freeze({ 'not-a-site': 'site.errorNotSite', internal: 'site.errorNotSite', 'project-site': 'site.errorProject' });

/**
 * Why the settings' site folder cannot be used (hello's siteError), with one thing to do: a folder that is no site
 * has it in its own text ("Choose the folder that holds the sumika folder"), so does an unexpected error ("Try
 * again…"); the project's own site/ (a dev run) gets "choose another site folder"; anything else "choose it again".
 */
export function siteErrorText(err, L) {
  // a sentence of its own: the path texts end with the path ("No such file or folder: D:\site"), which would run into
  // "Choose it again"
  const why = findingText(err, L);
  const ended = /[.!?。！？]$/.test(why) ? why : `${why}${L === 'ja' ? '。' : '.'}`;
  const own = err && Object.prototype.hasOwnProperty.call(OWN_END, err.code) ? OWN_END[err.code] : null;
  return t(own || 'site.error', L, { why: ended });
}

export function siteScreen(app, section) {
  const $ = sel => section.querySelector(sel);
  const msgs = new Messages($('[data-part="messages"]'), app.lang);
  const info = $('[data-part="info"]');
  const chooseBtn = $('[data-part="choose"]');
  const inPageBtn = $('[data-part="in-page"]');
  const waitBox = $('[data-part="pick-wait"]');
  const pick = $('[data-part="pick"]');
  const settingsEl = $('[data-part="settings"]');
  let browser = null;

  const closePicker = () => {
    pick.hidden = true;
    chooseBtn.hidden = false;
    renderPick();
    chooseBtn.focus();
  };

  const choose = async path => {
    msgs.clear();
    try {
      const site = await app.api.site(path);
      if (app.hello) app.hello.siteError = null;
      app.setSite(site);
      pick.hidden = true;
      chooseBtn.hidden = false;
      renderPick();
      msgs.set('ok', L => tNodes('site.chosen', L, { path: code(site.path || path) }));
      app.focusHeading(section);
    } catch (e) {
      if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
    }
  };

  /** The in-page file browser in folder mode: the fallback, and "Browse in this page instead". */
  async function openBrowser() {
    if (!browser) {
      browser = new FileBrowser(app, {
        mode: 'folder', onChoose: choose, onCancel: closePicker, hint: () => ['browser.hint.folder', {}],
      });
      pick.append(browser.el);
    }
    pick.hidden = false;
    chooseBtn.hidden = true;
    renderPick();
    // the folder that holds the current site (another site is most likely beside it), else a recent place or home
    await browser.start(app.site && app.site.path ? parentOf(app.site.path) : null);
    browser.focus();
  }

  chooseBtn.addEventListener('click', async () => {
    if (!app.picker.available) {
      await openBrowser();
      return;
    }
    msgs.clear();
    if (app.jobs.busy) {                                     // /api/site would refuse the folder picked (409 busy)
      const kind = app.jobs.job && app.jobs.job.kind;
      msgs.set('error', L => findingText({ code: 'busy', params: { kind } }, L));
      return;
    }
    let r;
    try {
      r = await app.picker.pick('site');
    } catch (e) {
      if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
      return;
    }
    if (r.paths) await choose(r.paths[0]);
    else if (r.fallback) {
      if (r.problem) msgs.set('info', L => findingText(r.problem, L));
      await openBrowser();
    }
  });
  inPageBtn.addEventListener('click', () => openBrowser());

  /** The dialog's buttons and its line: they wait while a dialog is open; the link only beside a dialog. */
  function renderPick() {
    const L = app.lang();
    chooseBtn.disabled = app.picker.busy;
    inPageBtn.hidden = !app.picker.available || !pick.hidden;
    // any dialog of this page (one the Add screen opened too): the button waits for it, so the line says why
    fill(waitBox, waitingLine(app.picker, L, { mine: !!app.picker.open }));
  }

  function renderInfo() {
    const L = app.lang();
    const s = app.site;
    if (!s) {
      const err = app.hello && app.hello.siteError;
      fill(info, err ? el('p', { class: 'msg msg-error' }, siteErrorText(err, L)) : null, el('p', null, t('site.none', L)));
      return;
    }
    const row = (key, ...value) => [el('dt', null, t(key, L)), el('dd', null, value)];
    const rt = s.runtime;
    const n = ghostCount(s);
    fill(info, el('dl', { class: 'facts' },
      row('site.path', code(s.path)),
      row('site.build', rt && rt.build ? code(rt.build) : t('site.noRuntime', L)),
      rt ? row('site.hub', rt.hub ? tNodes('site.hubYes', L) : t('site.hubNo', L)) : null,
      row('site.ghosts', plural('site.ghostCount', n, L)),
      s.readOnly ? row('site.readOnly', findingText(s.readOnlyInfo || s.readOnly, L)) : null));
  }

  function renderSettings() {
    const L = app.lang();
    const st = app.settings || {};
    if (!st.file) {
      fill(settingsEl);
      return;
    }
    fill(settingsEl,
      el('p', null, tNodes('settings.file', L, { path: code(st.file) }), ' ',
        st.where === 'appdata' ? t('settings.appdata', L) : st.where === 'beside' ? t('settings.beside', L) : null),
      st.problem ? el('p', { class: 'msg msg-error' }, t('settings.problem', L, { problem: findingText(st.problem, L) })) : null);
  }

  return {
    enter() {
      renderInfo();
      renderSettings();
      renderPick();
    },
    render() {
      renderInfo();
      renderSettings();
      renderPick();
      msgs.render();
      if (browser) browser.render();
    },
    pickerChanged: renderPick,
  };
}
