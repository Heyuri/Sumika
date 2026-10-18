// The Ghosts screen: the site's ghosts in Change ghost ▸'s order (SSP's name order, as the
// program sends them, never sorted here; folders the index lacks among them, marked, with a way to Check), each with
// its folder id, its engine or what it needs, the balloons it brings, and Remove: a confirmation dialog, then one
// removal job per ghost.
import { el, fill, code, ghostText, tNodes } from '../dom.js';
import { t, findingText } from '../strings.js';
import { ghostRows, engineName } from '../ghostlist.js';
import { Messages, ask } from '../ui.js';

export function ghostsScreen(app, section) {
  const $ = sel => section.querySelector(sel);
  const msgs = new Messages($('[data-part="messages"]'), app.lang);
  const body = $('[data-part="body"]');
  const dialog = app.doc.getElementById('remove-dialog');
  const dialogText = dialog.querySelector('[data-part="text"]');
  let rows = null;                 // null: not loaded
  let problems = [];
  let loading = false;

  async function load() {
    if (!app.site) {
      rows = null;
      render();
      return;
    }
    loading = true;
    render();
    try {
      const r = await app.api.ghosts();
      rows = ghostRows(r && r.ghosts);
      problems = (r && Array.isArray(r.problems)) ? r.problems : [];
    } catch (e) {
      rows = null;
      if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
    } finally {
      loading = false;
    }
    render();
  }

  async function remove(g, button) {
    const L0 = app.lang();
    const balloons = Array.isArray(g.balloons) ? g.balloons : [];
    const name = g.name || g.id;
    const folder = `ghost/${g.id}/`;
    const drawText = L => [
      el('p', null, tNodes('remove.text', L, { name: ghostText(name), id: code(g.id), folder: code(folder) })),
      balloons.length ? el('p', null, tNodes(balloons.length === 1 ? 'remove.balloon.one' : 'remove.balloon.many', L,
        { balloons: el('span', null, balloons.map((b, i) => [i ? (L === 'ja' ? '、' : ', ') : null, ghostText(b.name || b.id)])) })) : null,
      el('p', null, t('remove.later', L)),
    ];
    fill(dialogText, drawText(L0));
    if (!await ask(dialog, { opener: button, fallback: section.querySelector('h2') })) return;
    msgs.clear();
    const job = await app.runJob(() => app.api.remove(g.id), msgs);
    if (!job) return;
    if (job.state === 'done') {
      const r = job.result || {};
      msgs.set('ok', L => tNodes('remove.done', L, { name: ghostText(name), id: code(g.id) }));
      if (r.link) msgs.add('info', L => t('remove.link', L));
      msgs.add('info', L => tNodes('remove.hostNote', L, { folder: code(r.deleteOnHost || folder) }));
      app.refreshSite();
    } else msgs.set('error', L => findingText(job.error, L));
    await load();
    app.refocus(section.querySelector('h2'));             // the row and its button are gone
  }

  function render() {
    const L = app.lang();
    if (!app.site) {
      fill(body, app.noSiteNotice());
      return;
    }
    if (loading && !rows) {
      fill(body, el('p', { class: 'state' }, t('ghosts.loading', L)));
      return;
    }
    if (!rows) {
      fill(body);
      return;
    }
    const readOnly = !!app.site.readOnly;
    const list = problems.length ? el('ul', { class: 'problems' }, problems.map(p => el('li', null, findingText(p, L)))) : null;
    if (!rows.length) {
      fill(body, app.readOnlyNotice(), list, el('p', null, t('ghosts.empty', L)));
      return;
    }
    const th = key => el('th', { scope: 'col' }, t(key, L));
    fill(body, app.readOnlyNotice(), list, el('table', { class: 'ghosts' },
      el('caption', null, t('ghosts.caption', L)),
      el('thead', null, el('tr', null, th('ghosts.col.name'), th('ghosts.col.id'), th('ghosts.col.engine'),
        th('ghosts.col.balloons'), th('ghosts.col.actions'))),
      el('tbody', null, rows.map(g => {
        const name = g.name || g.id;
        const balloons = Array.isArray(g.balloons) ? g.balloons : [];
        const removeBtn = el('button', {
          type: 'button', class: 'danger', disabled: readOnly,
          'aria-label': t('ghosts.removeLabel', L, { name }),
        }, t('ghosts.remove', L));
        removeBtn.addEventListener('click', () => remove(g, removeBtn));
        return el('tr', { class: g.indexed === false || g.folder === false ? 'unindexed' : null },
          el('th', { scope: 'row' }, ghostText(name)),
          el('td', null, code(g.id)),
          el('td', null, g.needs ? t('ghosts.needs', L, { engine: g.needs }) : engineName(g.engine)),
          el('td', null, balloons.length ? balloons.map((b, i) => [i ? el('br') : null, ghostText(b.name || b.id), ' ', code(b.id)])
            : el('span', { class: 'none' }, t('common.none', L))),
          el('td', { class: 'row-actions' },
            g.folder === false ? null : removeBtn,
            g.indexed === false || g.folder === false ? el('span', { class: 'flag' }, ' ',
              t(g.folder === false ? 'ghosts.noFolder' : 'ghosts.notIndexed', L), ' ',
              el('button', { type: 'button', class: 'link', onclick: () => app.show('check') }, t('ghosts.toCheck', L))) : null));
      }))));
  }

  return {
    /** keep: the lines another screen just left here (the Add screen's results) stay */
    enter({ keep = false } = {}) {
      if (!keep) msgs.clear();
      return load();
    },
    render() {
      msgs.render();
      render();
    },
    reload: load,
    messages: msgs,
  };
}
