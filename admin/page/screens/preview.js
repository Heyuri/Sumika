// The Preview screen: Start / Stop the program's preview servers (the site, and two page
// addresses that load it with data-hub), links that open them in a new tab, and the note that the preview answers
// hub.json with its own two test pages (the admin's file is neither used nor changed).
// The visitor's choice: the control page is the site's own file (sumika/index.html), so the
// preview's site address serves it as it is, at the hub's address of the two pages: a choice made there holds for
// them, and each start is a new address, so a new visitor who has not chosen. What a visitor who has not chosen gets
// (data-default-state, the Sharing screen's select) is not previewed: the two pages carry the line without it.
import { el, fill, code, tNodes } from '../dom.js';
import { t, findingText } from '../strings.js';
import { Messages, srOnly } from '../ui.js';

/**
 * The links of a running preview, as [address, text key]: the site's top page when the site has one (SiteInfo
 * `front`; the project's own site/ has none), the first page on another address, and the control
 * page when the site's runtime has it (SiteInfo `runtime.control`).
 * @param {{site: string, pages?: string[]}} p  the program's Preview
 * @param {object|null} site  SiteInfo
 * @returns {Array<[string, string]>}
 */
export function previewLinks(p, site) {
  const out = [];
  if (!p || !p.site) return out;
  if (site && site.front) out.push([p.site, 'preview.openSite']);
  if (Array.isArray(p.pages) && p.pages[0]) out.push([p.pages[0], 'preview.openPage']);
  if (site && site.runtime && site.runtime.control) out.push([new URL('sumika/', p.site).href, 'preview.openControl']);
  return out;
}

export function previewScreen(app, section) {
  const $ = sel => section.querySelector(sel);
  const msgs = new Messages($('[data-part="messages"]'), app.lang);
  const startBtn = $('[data-part="start"]');
  const stopBtn = $('[data-part="stop"]');
  const state = $('[data-part="state"]');
  const links = $('[data-part="links"]');
  const note = $('[data-part="note"]');
  let pending = false;

  const preview = () => app.jobs.preview || null;

  startBtn.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    msgs.clear();
    try {
      const p = await app.api.previewStart(app.lang());
      app.jobs.update({ preview: p });
      render();
      const first = links.querySelector('a');
      if (first) first.focus();
    } catch (e) {
      if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
    } finally {
      pending = false;
    }
  });

  stopBtn.addEventListener('click', async () => {
    if (pending) return;
    pending = true;
    msgs.clear();
    try {
      await app.api.previewStop();
      app.jobs.update({ preview: null });
      render();
      startBtn.focus();
    } catch (e) {
      if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
    } finally {
      pending = false;
    }
  });

  const link = (href, key, L) => el('li', null,
    el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, t(key, L), srOnly(` ${t('common.newTab', L)}`)),
    ' ', code(href));

  function render() {
    const L = app.lang();
    if (!app.site) {
      fill(state, app.noSiteNotice());
      startBtn.disabled = true;
      stopBtn.disabled = true;
      fill(links);
      fill(note);
      return;
    }
    const p = preview();
    const running = !!(p && p.site);
    startBtn.disabled = running;
    stopBtn.disabled = !running;
    fill(state, t(running ? 'preview.running' : 'preview.stopped', L));
    fill(links, running ? previewLinks(p, app.site).map(([href, key]) => link(href, key, L)) : []);
    fill(note, tNodes('preview.note', L, { hubFile: code('sumika/hub.json') }));
  }

  return {
    enter: render,
    render() {
      msgs.render();
      render();
    },
    /** the program's preview changed (another tab, a poll) */
    previewChanged: render,
  };
}
