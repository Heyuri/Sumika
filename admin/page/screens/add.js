// The Add screen: sources picked in the system's dialogs ("Choose .nar / .zip files…",
// "Choose folders…": several at once, picker.js) or dropped on the drop zone (the walker of drop.js), or, where the
// program has no dialog or when asked ("Browse in this page instead"), in the in-page file browser; each pick is
// inspected by the program at once, then one fieldset per ghost: its name, site folder, engine, size, its terms (ghost text, read before
// publishing), what the copy leaves out, the archive comparison's findings (each file left out unless ticked), Kawari
// save files (from a folder a refusal: such a ghost is added from its .nar / .zip, whose own ones are kept, a note),
// its balloon, and "replace" when the site already has the folder.
// "Add N ghosts" adds the ready ones in one job, then the Ghosts screen shows each result.
import { el, fill, code, ghostText, tNodes } from '../dom.js';
import { t, plural, findingText, joinList } from '../strings.js';
import { FileBrowser } from '../browser.js';
import { droppedEntries, walkDrop, fileRoots, sendDrop, ARCHIVE } from '../drop.js';
import { verdict, addable, entryOf, planOf, mergeItems, addResults, codeOf } from '../addplan.js';
import { engineName } from '../ghostlist.js';
import { formatBytes, joinPath, baseName, parentOf } from '../format.js';
import { Throttled } from '../jobs.js';
import { Messages } from '../ui.js';
import { waitingLine } from '../picker.js';

const LIST_FILE = /^updates2?\.(dau|txt)$/i;

export function addScreen(app, section) {
  const $ = sel => section.querySelector(sel);
  const msgs = new Messages($('[data-part="messages"]'), app.lang);
  const sourcesBox = $('[data-part="sources"]');
  const pickers = $('[data-part="pickers"]');
  const pickFilesBtn = $('[data-part="pick-files"]');
  const pickFoldersBtn = $('[data-part="pick-folders"]');
  const waitBox = $('[data-part="pick-wait"]');
  const pickRow = $('[data-part="pick-row"]');
  const inPageRow = $('[data-part="in-page-row"]');
  const inPageBtn = $('[data-part="in-page"]');
  const browseBox = $('[data-part="browse"]');
  const zone = $('[data-part="drop"]');
  const zoneText = $('[data-part="drop-text"]');
  const sendingBox = $('[data-part="sending"]');
  const sendingText = $('[data-part="sending-text"]');
  const sendingBar = $('[data-part="sending-bar"]');
  const stopBtn = $('[data-part="stop"]');
  const compareBox = $('[data-part="compare"]');
  const resultsHead = $('[data-part="results-head"]');
  const results = $('[data-part="results"]');
  const goBtn = $('[data-part="go"]');
  const clearBtn = $('[data-part="clear"]');
  const noneReady = $('[data-part="none-ready"]');
  const readOnlyBox = $('[data-part="read-only"]');
  let entries = [];
  let seq = 0;
  let browser = null;
  let browserAsked = false;    // "Browse in this page instead" was pressed
  let compareBrowser = null;
  let comparing = null;        // the entry a comparison file is being picked for
  let sending = null;          // {ctrl, progress}
  let reading = false;
  const say = new Throttled(text => { sendingText.textContent = text; });

  /** What was dropped, as the item came from it: the dropped name, and the ghost's own folder inside it. */
  const droppedLabel = item => {
    const name = item.dropped && item.dropped.name ? String(item.dropped.name) : null;
    if (!name) return null;
    const own = item.source && item.source.path ? baseName(item.source.path) : name;
    return own === name ? name : `${name}/${own}`;
  };

  const makeEntry = (item, old) => {
    const e = entryOf(item, { key: ++seq, dropped: droppedLabel(item) || (old ? old.dropped : null) });
    if (old) {
      e.include = old.include;
      e.replace = old.replace;
    }
    return e;
  };

  // ---- inspection ----

  async function inspect(sources) {
    msgs.clear();
    const job = await app.runJob(() => app.api.inspect(sources), msgs);
    if (job) took(job);
  }

  function took(job) {
    if (job.state !== 'done') {
      msgs.set('error', L => findingText(job.error, L));
      return;
    }
    const items = (job.result && Array.isArray(job.result.items)) ? job.result.items : [];
    if (!items.length) {
      msgs.add('info', L => t('add.noneFound', L));
      return;
    }
    entries = mergeItems(entries, items, makeEntry).entries;
    render();
    resultsHead.focus();
  }

  async function compareWith(entry, archive) {
    msgs.clear();
    const job = await app.runJob(() => app.api.inspect([{ path: entry.item.source.path, archive }]), msgs);
    if (!job) return;
    if (job.state !== 'done') {
      msgs.set('error', L => findingText(job.error, L));
      return;
    }
    const item = job.result && Array.isArray(job.result.items) ? job.result.items[0] : null;
    const i = entries.indexOf(entry);
    if (item && i >= 0) {
      entries[i] = makeEntry(item, entry);
      render();
      const legend = results.querySelector(`[data-key="${entries[i].key}"] legend`);
      if (legend) legend.focus();
    }
  }

  // ---- the system's dialogs (picker.js) ----

  /** A dialog's refusal, said once; a stopped program is said by the page itself. */
  const pickFailed = e => {
    if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
  };

  /** A job runs: the inspection that follows a dialog or a drop could not start (409 busy), so it is said first,
   * before the admin picks or sends anything that would be lost. */
  const busyNow = () => {
    if (!app.jobs.busy) return false;
    const kind = app.jobs.job && app.jobs.job.kind;
    msgs.set('error', L => findingText({ code: 'busy', params: { kind } }, L));
    return true;
  };

  /** No dialog after all (no-picker): why, and the in-page browser in its place. */
  async function fallBack(problem) {
    if (problem) msgs.set('info', L => findingText(problem, L));
    render();
    await ensureBrowser();
  }

  /** "Choose .nar / .zip files…" and "Choose folders…": what is picked is inspected at once. */
  async function pickSources(purpose) {
    msgs.clear();
    if (app.picker.available && busyNow()) return;
    let r;
    try {
      r = await app.picker.pick(purpose);
    } catch (e) {
      pickFailed(e);
      return;
    }
    if (r.paths) await inspect(r.paths.map(path => ({ path })));
    else if (r.fallback) await fallBack(r.problem);
  }
  pickFilesBtn.addEventListener('click', () => pickSources('files'));
  pickFoldersBtn.addEventListener('click', () => pickSources('folders'));
  inPageBtn.addEventListener('click', async () => {
    browserAsked = true;
    render();
    await ensureBrowser();
    if (browser) browser.focus();
  });

  /** A folder's archive or update list: the file dialog (its own filter), else the in-page browser in file mode. */
  async function startCompare(entry) {
    const src = entry.item.source && entry.item.source.path;
    const near = src && !entry.dropped ? parentOf(src) : null;
    if (app.picker.available) {
      msgs.clear();
      if (busyNow()) return;
      let r;
      try {
        r = await app.picker.pick('compare', { near, owner: entry });
      } catch (e) {
        pickFailed(e);
        return;
      }
      if (r.paths) {
        await compareWith(entry, r.paths[0]);
        return;
      }
      if (!r.fallback) {
        const btn = results.querySelector(`[data-key="${entry.key}"] [data-part="compare-btn"]`);
        if (btn) btn.focus();
        return;
      }
      if (r.problem) msgs.set('info', L => findingText(r.problem, L));
    }
    browseCompare(entry, near);
  }

  function browseCompare(entry, near) {
    comparing = entry;
    if (!compareBrowser) {
      compareBrowser = new FileBrowser(app, {
        mode: 'file',
        accept: e => !!(e.archive || e.list || ARCHIVE.test(e.name) || LIST_FILE.test(e.name)),
        onChoose: path => {
          const target = comparing;
          stopCompare(false);
          if (target) compareWith(target, path);
        },
        onCancel: () => stopCompare(true),
        hint: () => ['browser.hint.compare', { name: comparing ? comparing.item.name || comparing.item.id : '' }],
      });
      compareBox.append(compareBrowser.el);
    }
    compareBox.hidden = false;
    compareBrowser.render();                                 // its hint names this ghost
    compareBrowser.start(near).then(() => compareBrowser.focus());
  }

  function stopCompare(refocus) {
    const was = comparing;
    comparing = null;
    compareBox.hidden = true;
    if (refocus && was) {
      const btn = results.querySelector(`[data-key="${was.key}"] [data-part="compare-btn"]`);
      if (btn) btn.focus();
    }
  }

  // ---- drag-and-drop (drop.js) ----

  const hasFiles = e => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  const over = on => {
    if (zone.classList.contains('over') === on) return;
    zone.classList.toggle('over', on);
    if (on) zoneText.textContent = t('add.dropOver', app.lang());
    else renderZone();
  };
  zone.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    over(!busy());
  });
  zone.addEventListener('dragover', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = busy() ? 'none' : 'copy';
    over(!busy());
  });
  zone.addEventListener('dragleave', e => {
    if (!zone.contains(e.relatedTarget)) over(false);
  });
  zone.addEventListener('drop', e => {
    e.preventDefault();
    over(false);
    if (busy() || !hasFiles(e)) return;
    if (busyNow()) return;                                   // its inspection could not start: said before sending
    const found = droppedEntries(e.dataTransfer);          // only inside the event
    const files = Array.from(e.dataTransfer.files || []);
    dropped(found, files);
  });

  const busy = () => !!sending || reading || !app.site || !!(app.site && app.site.readOnly);

  async function dropped(found, files) {
    msgs.clear();
    let walked;
    if (found === null) {
      walked = await fileRoots(files);
      // folders this browser cannot read, and the way to pick them here instead: the folder dialog, else the in-page
      // file list (a plain file that is no archive is said as drop.notSource, below)
      const folders = walked.folders;
      if (folders.length) {
        msgs.add('error', L => t(app.picker.available ? 'drop.noEntries' : 'drop.noEntriesInPage', L, { names: joinList(folders, L) }));
      }
    } else {
      reading = true;
      msgs.add('info', L => t('add.reading', L));
      try {
        walked = await walkDrop(found, app.rules);
      } finally {
        reading = false;
      }
      msgs.clear();
    }
    for (const r of walked.refused) msgs.add('error', L => t(r.code, L, { name: r.name, ...(r.params || {}) }));
    if (walked.left.length) {
      const left = walked.left;
      msgs.add('info', L => [plural('drop.left', left.length, L), el('details', null,
        el('summary', null, plural('common.files', left.length, L)),
        el('ul', { class: 'files' }, left.map(x => el('li', null, code(`${x.root}/${x.path}`), ' — ', findingText(x, L)))))]);
    }
    if (!walked.roots.length) return;
    const ctrl = new AbortController();
    sending = { ctrl };
    sendingBox.hidden = false;
    sendingBar.removeAttribute('value');
    stopBtn.focus();
    let job;
    try {
      job = await sendDrop(app.api, walked, {
        signal: ctrl.signal,
        onProgress: p => {
          sending.progress = p;
          if (p.totalBytes) {
            sendingBar.max = p.totalBytes;
            sendingBar.value = p.bytes;
          }
          say.set(progressText(p), `${p.done === p.total}`);
        },
      });
    } catch (e) {
      if (e && e.name === 'AbortError') msgs.add('info', L => t('drop.stopped', L));
      else if (!app.handleError(e, msgs)) msgs.add('error', L => t('drop.failed', L, { why: findingText(e, L) }));
      return;
    } finally {
      sending = null;
      sendingBox.hidden = true;
      say.dispose();
    }
    took(await app.jobs.follow(job));
  }

  const progressText = p => t('drop.sending', app.lang(), { done: p.done, total: p.total, size: formatBytes(p.totalBytes, app.lang()) });
  stopBtn.addEventListener('click', () => {
    if (sending) sending.ctrl.abort();
  });

  // ---- adding ----

  goBtn.addEventListener('click', async () => {
    const plan = planOf(entries);
    if (!plan.length) return;
    msgs.clear();
    const job = await app.runJob(() => app.api.add(plan), msgs);
    if (!job) return;
    if (job.state !== 'done') {
      msgs.set('error', L => findingText(job.error, L));
      render();
      return;
    }
    const rows = addResults(job.result, entries);
    const ok = rows.filter(r => r.ok);
    const bad = rows.filter(r => !r.ok);
    entries = entries.filter(e => !ok.some(r => r.entry === e));
    for (const r of bad) if (r.entry) r.entry.error = r.error;
    render();
    const indexRefusal = job.result && job.result.indexRefusal;
    const lines = [
      ...ok.map(r => ['ok', L => tNodes('add.added', L, { name: ghostText(r.name || r.id || ''), id: code(r.id || '') })]),
      ...bad.map(r => ['error', L => tNodes('add.failed', L, { name: ghostText(r.name || r.id || ''), why: findingText(r.error, L) })]),
      ...(indexRefusal ? [['error', L => t('add.indexRefused', L, { why: findingText(indexRefusal, L) })]] : []),
    ];
    app.refreshSite();
    if (ok.length) {
      const target = app.screens.ghosts.messages;
      target.clear();
      for (const [kind, draw] of lines) target.add(kind, draw);
      app.show('ghosts', { keep: true });
    } else for (const [kind, draw] of lines) msgs.add(kind, draw);
  });

  clearBtn.addEventListener('click', () => {
    entries = [];
    msgs.clear();
    render();
  });

  // ---- drawing ----

  function itemBox(entry) {
    const L = app.lang();
    const item = entry.item;
    const v = verdict(item);
    const id = `add-${entry.key}`;
    const name = item.name || item.id || (item.source && baseName(item.source.path)) || '';
    const readOnly = !!(app.site && app.site.readOnly);
    const row = (key, ...value) => [el('dt', null, t(key, L)), el('dd', null, value)];
    const parts = [];

    // the tick: add it (or, for a folder the site has, replace it)
    if (!v.blocked && !v.conflict) {
      const box = el('input', { type: 'checkbox', id: `${id}-inc`, checked: entry.include, disabled: readOnly,
        onchange: ev => { entry.include = ev.target.checked; renderGo(); } });
      parts.push(el('p', { class: 'tick' }, box, ' ', el('label', { for: `${id}-inc` }, t('add.item.include', L))));
    }

    const runs = item.runs;
    const engine = item.engine ? engineName(item.engine) : null;
    parts.push(el('dl', { class: 'facts' },
      row('add.item.source', entry.dropped ? t('add.dropped', L, { name: entry.dropped }) : code(item.source ? item.source.path : '')),
      item.id ? row('add.item.id', code(`ghost/${item.id}/`)) : null,
      engine || runs ? row('add.item.engine', runs && runs.ok === false
        ? t('add.item.cannotRun', L, { why: runs.code ? findingText(runs, L) : (runs.note || engine || '') }) : engine) : null,
      item.fileCount ? row('add.item.size', t('add.item.sizeValue', L,
        { size: formatBytes(item.sizeBytes, L), files: plural('common.files', item.fileCount, L) })) : null,
      item.archive ? row('add.item.archive', code(item.archive)) : null));

    // comparing a folder with its archive or update list
    if (item.source && item.source.kind === 'folder' && item.token) {
      const btns = [];
      if (item.updateList && !item.archive) {
        btns.push(el('button', { type: 'button', disabled: readOnly, onclick: () => compareWith(entry, joinPath(item.source.path, item.updateList)) },
          t('add.item.compareList', L, { file: item.updateList })));
      }
      btns.push(el('button', {
        type: 'button', 'data-part': 'compare-btn', disabled: readOnly || app.picker.busy, onclick: () => startCompare(entry),
      }, t('add.item.compare', L)));
      parts.push(el('p', { class: 'actions' }, btns));
      parts.push(el('div', { 'data-part': 'compare-wait', 'aria-live': 'polite' }, compareWaiting(entry, L)));
    }

    // a refusal that blocks it (a Kawari save file's KAWARI_SHIPPED_SAVES `line` is the CLI's, for developers: not
    // shown [decision: such a ghost is added from its .nar / .zip])
    if (item.refusal && v.blocked && !v.flagged.length) {
      const files = Array.isArray(item.refusal.files) ? item.refusal.files : [];
      parts.push(el('div', { class: 'refusal', role: 'note' },
        el('p', null, el('strong', null, t('add.item.refused', L)), ' ', findingText(item.refusal, L)),
        files.length ? el('ul', { class: 'files' }, files.map(f => el('li', null, code(f.path),
          codeOf(f) ? [' — ', findingText(f, L)] : null))) : null));
    } else if (!item.token && !item.refusal) {
      parts.push(el('p', { class: 'refusal' }, el('strong', null, t('add.item.refused', L))));
    }

    // the archive comparison: each flagged file left out unless ticked
    if (v.flagged.length) {
      const archiveName = baseName((item.refusal.params && (item.refusal.params.archive || item.refusal.params.archiveName)) || item.archive || '');
      parts.push(el('fieldset', { class: 'flagged' },
        el('legend', null, tNodes('add.item.flagged', L, { archive: code(archiveName) })),
        el('ul', { class: 'files' }, v.flagged.map((f, i) => {
          const fid = `${id}-keep-${i}`;
          return el('li', null, el('input', {
            type: 'checkbox', id: fid, checked: entry.keep.has(f.path), disabled: readOnly,
            onchange: ev => { if (ev.target.checked) entry.keep.add(f.path); else entry.keep.delete(f.path); },
          }), ' ', el('label', { for: fid }, tNodes('add.item.flaggedFile', L, { path: code(f.path), why: findingText(f, L) })));
        }))));
    }

    // its balloons
    for (const b of Array.isArray(item.balloons) ? item.balloons : []) {
      parts.push(el('p', null, b.from === 'ssp'
        ? tNodes('add.item.balloonSsp', L, { name: ghostText(b.name || b.dir), path: code(b.path || b.dir) })
        : tNodes('add.item.balloon', L, { name: ghostText(b.name || b.dir), dir: code(b.dir) })));
    }

    // the site has this folder
    if (v.conflict) {
      parts.push(el('p', null, tNodes('add.item.exists', L, { folder: code(`ghost/${item.id}/`) })));
      if (v.lost.length) {
        parts.push(el('p', { class: 'refusal' }, tNodes('add.item.lost', L,
          { balloons: el('span', null, v.lost.map((b, i) => [i ? (L === 'ja' ? '、' : ', ') : null, ghostText(b.name || b.dir)])) })));
      } else if (!v.blocked) {
        const box = el('input', { type: 'checkbox', id: `${id}-rep`, checked: entry.replace, disabled: readOnly,
          onchange: ev => { entry.replace = ev.target.checked; renderGo(); } });
        parts.push(el('p', { class: 'tick' }, box, ' ', el('label', { for: `${id}-rep` }, t('add.item.replace', L))));
      }
    }

    // a failed add of this entry (the message area has said it once)
    if (entry.error) parts.push(el('p', { class: 'refusal' }, findingText(entry.error, L)));

    // its terms: ghost text, read before publishing
    const terms = item.terms;
    if (terms && terms.excerpt) {
      parts.push(el('details', { class: 'terms', open: true },
        el('summary', null, tNodes(terms.kind === 'terms' ? 'add.item.terms' : 'add.item.readme', L, { file: code(terms.file) }),
          terms.truncated ? [' ', t('add.item.termsShort', L)] : null),
        el('pre', { lang: '', class: 'excerpt' }, terms.excerpt),
        el('p', { class: 'hint' }, t('add.item.termsNote', L))));
    } else if (item.token) parts.push(el('p', { class: 'hint' }, t('add.item.termsNone', L)));

    // what the copy leaves out
    const left = Array.isArray(item.excluded) ? item.excluded : [];
    if (left.length) {
      parts.push(el('details', { class: 'left' },
        el('summary', null, plural('add.item.left', left.length, L)),
        el('ul', { class: 'files' }, left.map(x => el('li', null, code(x.path), ' — ', findingText(x, L))))));
    }

    // notes
    const notes = Array.isArray(item.notes) ? item.notes : [];
    if (notes.length) {
      parts.push(el('div', { class: 'notes' }, el('p', null, t('add.item.notes', L)),
        el('ul', null, notes.map(n => el('li', null, findingText(n, L))))));
    }

    parts.push(el('p', { class: 'actions' }, el('button', { type: 'button', onclick: () => {
      entries = entries.filter(e => e !== entry);
      render();
      resultsHead.focus();
    } }, t('add.item.drop', L))));

    return el('fieldset', { class: ['item', v.blocked ? 'blocked' : null], 'data-key': String(entry.key) },
      el('legend', { tabindex: '-1' }, ghostText(name)), parts);
  }

  function renderGo() {
    const L = app.lang();
    const n = entries.filter(addable).length;
    goBtn.textContent = plural('add.add', n, L);
    goBtn.disabled = !n || !app.site || !!(app.site && app.site.readOnly);
    clearBtn.disabled = !entries.length;
    noneReady.textContent = entries.length && !n ? t('add.noneReady', L) : '';
  }

  function renderZone() {
    const L = app.lang();
    const os = app.hello && app.hello.os;
    const fm = os === 'windows' ? 'Explorer' : os === 'macos' ? 'Finder' : t('add.fileManager', L);
    zoneText.textContent = t('add.drop', L, { fileManager: fm });
  }

  /** The line under a compare button while its dialog is open. */
  const compareWaiting = (entry, L) => (app.picker.open === 'compare' && app.picker.owner === entry ? waitingLine(app.picker, L) : null);

  /** The dialogs' buttons and lines, which wait while a dialog is open (drawn alone: the ghosts' boxes keep their state). */
  function renderPick() {
    const L = app.lang();
    const p = app.picker;
    pickFilesBtn.disabled = p.busy;
    pickFoldersBtn.disabled = p.busy;
    // the line goes under its compare button while that ghost is listed, else here: every dialog that makes the buttons
    // wait is said with its Cancel (one from the Site screen, a compared ghost taken off the list)
    const underEntry = p.open === 'compare' && entries.includes(p.owner);
    fill(waitBox, waitingLine(p, L, { mine: !!p.open && !underEntry }));
    const readOnly = !!(app.site && app.site.readOnly);
    for (const box of results.querySelectorAll('fieldset.item[data-key]')) {
      const entry = entries.find(e => String(e.key) === box.getAttribute('data-key'));
      const btn = box.querySelector('[data-part="compare-btn"]');
      if (btn) btn.disabled = readOnly || p.busy;
      const line = box.querySelector('[data-part="compare-wait"]');
      if (line && entry) fill(line, compareWaiting(entry, L));
    }
  }

  function render() {
    const L = app.lang();
    if (!app.site) {
      sourcesBox.hidden = true;
      zone.hidden = true;
      fill(readOnlyBox);
      fill(results, app.noSiteNotice());
      renderGo();
      return;
    }
    // with the system's dialogs: their buttons, the drop zone under them, the in-page browser on request only
    const dialogs = app.picker.available;
    sourcesBox.hidden = false;
    pickers.hidden = !dialogs;
    pickRow.classList.toggle('stacked', dialogs);
    browseBox.hidden = dialogs && !browserAsked;
    inPageRow.hidden = !dialogs || browserAsked;
    zone.hidden = !!app.site.readOnly;
    fill(readOnlyBox, app.readOnlyNotice());
    renderZone();
    fill(results, entries.length ? entries.map(itemBox) : el('p', null, t('add.empty', L)));
    if (comparing && compareBrowser) compareBrowser.render();
    if (sending && sending.progress) sendingText.textContent = progressText(sending.progress);
    renderGo();
    renderPick();
  }

  async function ensureBrowser() {
    if (browser || !app.site || (app.picker.available && !browserAsked)) return;
    browser = new FileBrowser(app, {
      mode: 'sources',
      onChoose: paths => inspect(paths.map(path => ({ path }))),
      hint: () => ['browser.hint.sources', {}],
    });
    browseBox.append(browser.el);
    await browser.start();
  }

  return {
    async enter() {
      render();
      await ensureBrowser();                                 // where there is no dialog
    },
    render() {
      msgs.render();
      render();
      if (browser) browser.render();
    },
    pickerChanged: renderPick,
  };
}

