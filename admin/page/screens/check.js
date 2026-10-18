// The Check and upload screen: Check (a job: the stale index, personal files, the
// hub.json gate, the runtime set, 404.html, links) lists the problems with their fix ("Update the index" runs the
// index job, then checks again); Prepare upload, enabled after a clean check, asks first whether the site was ever
// uploaded when prune has no ledger, offers Start a new record when its ledger does not read, then shows what to
// upload, in order, and what to delete on the host.
import { el, fill, code, tNodes } from '../dom.js';
import { t, plural, findingText, findingCode, knownFinding, template } from '../strings.js';
import { uploadGroups, uploadText, prepareAsks } from '../upload.js';
import { ledgerName } from '../format.js';
import { Messages } from '../ui.js';

// problems an index run fixes: the program's index-stale / no-index / bad-index / index-old (ghosts.json is written
// anew), the core's index.missing / index.differs, and what a cut-off job left in the work folder (work.leftover:
// every write job settles it first)
const INDEX_CODES = new Set(['index-stale', 'no-index', 'bad-index', 'index-old', 'index.missing', 'index.differs',
  'work.leftover']);
const isIndexProblem = p => INDEX_CODES.has(String((p && (p.code ?? p.why)) || ''));

/** A file a finding names: a path, or {path, code?, …}. */
const fileOf = f => (typeof f === 'string' ? { path: f } : f || { path: '' });

export function checkScreen(app, section) {
  const $ = sel => section.querySelector(sel);
  const msgs = new Messages($('[data-part="messages"]'), app.lang);
  const runBtn = $('[data-part="run"]');
  const resultEl = $('[data-part="result"]');
  const prepareBtn = $('[data-part="prepare"]');
  const question = $('[data-part="question"]');
  const questionText = $('[data-part="question-text"]');
  const goBtn = $('[data-part="go"]');
  const cancelBtn = $('[data-part="cancel"]');
  const prepared = $('[data-part="prepared"]');
  let problems = null;          // null: not checked; [] clean
  let groups = null;            // the last Prepare upload's answer
  let asking = false;

  async function check() {
    msgs.clear();
    groups = null;
    const job = await app.runJob(() => app.api.check(), msgs);
    if (!job) return;
    if (job.state !== 'done') {
      problems = null;
      msgs.set('error', L => findingText(job.error, L));
    } else problems = (job.result && Array.isArray(job.result.problems)) ? job.result.problems : [];
    render();
  }

  async function reindex() {
    msgs.clear();
    const job = await app.runJob(() => app.api.index(), msgs);
    if (!job) return;
    if (job.state !== 'done') {
      msgs.set('error', L => findingText(job.error, L));
      return;
    }
    app.refreshSite();
    await check();
    app.refocus(runBtn);                                    // the fix button went with the list
  }

  async function prepare(opts = {}) {
    msgs.clear();
    groups = null;
    const job = await app.runJob(() => app.api.prepare(opts), msgs, { quiet: ['needs-first'] });
    const asks = prepareAsks(job);
    if (asks === 'first') {
      ask();
      return;
    }
    if (!job) return;
    if (asks === 'newRecord') {
      offerNewRecord(job.error);
      return;
    }
    if (job.state !== 'done') {
      const err = job.error || {};
      const list = Array.isArray(err.problems) ? err.problems : Array.isArray(err.params && err.params.problems) ? err.params.problems : [];
      msgs.set('error', L => findingText(err, L));
      if (list.length) {
        problems = list;                     // Prepare checked again (check-failed): the list shows what it found
        render();
      }
      return;
    }
    groups = uploadGroups(job.result);
    render();
    const head = prepared.querySelector('h3');
    if (head) head.focus();
  }

  /**
   * The record of earlier uploads does not read (ledger-unreadable): its text, which says what the file is, and the one
   * button, Start a new record (the program renames it aside and goes on as for a lost record).
   */
  function offerNewRecord(err) {
    msgs.set('error', L => [findingText(err, L), ' ', el('button', {
      type: 'button', class: 'link', 'data-part': 'new-record', onclick: () => prepare({ newRecord: true }),
    }, t('prepare.newRecord', L))]);
    const b = section.querySelector('[data-part="new-record"]');
    if (b) b.focus();
  }

  function ask() {
    asking = true;
    question.hidden = false;
    renderQuestion();
    const first = question.querySelector('input[type="radio"]');
    if (first) first.focus();
  }

  function renderQuestion() {
    if (!asking) return;
    const L = app.lang();
    const ledger = ledgerName(app.site ? app.site.path : 'site');
    fill(questionText,
      el('legend', null, t('prepare.question', L)),
      el('p', null, el('input', { type: 'radio', name: 'prepare-kind', id: 'prepare-first', value: 'first', checked: true }), ' ',
        el('label', { for: 'prepare-first' }, t('prepare.first', L))),
      el('p', null, el('input', { type: 'radio', name: 'prepare-kind', id: 'prepare-retire', value: 'retireAll' }), ' ',
        el('label', { for: 'prepare-retire' }, tNodes('prepare.retireAll', L, { ledger: code(ledger) }))));
  }

  goBtn.addEventListener('click', () => {
    const picked = question.querySelector('input[name="prepare-kind"]:checked');
    asking = false;
    question.hidden = true;
    prepare(picked && picked.value === 'retireAll' ? { retireAll: true } : { first: true });
  });
  cancelBtn.addEventListener('click', () => {
    asking = false;
    question.hidden = true;
    prepareBtn.focus();
  });
  runBtn.addEventListener('click', check);
  prepareBtn.addEventListener('click', () => prepare({}));

  function problemItem(p, L) {
    const files = Array.isArray(p.files) ? p.files : [];
    // a path the problem's own text does not show ('index.missing' says "missing") goes in front of it
    const shown = knownFinding(p) && /\{path\}/.test(template(`code.${findingCode(p)}`, 'en'));
    const path = typeof p.path === 'string' ? p.path
      : (!shown && p.params && typeof p.params.path === 'string' ? p.params.path : null);
    return el('li', null, path ? [code(path), ': '] : null, findingText(p, L),
      files.length ? el('ul', { class: 'files' }, files.map(fileOf).map(f => el('li', null, code(f.path),
        (f.code ?? f.why) ? [' — ', findingText(f, L)] : null))) : null);
  }

  function renderPrepared(L) {
    if (!groups) return [];
    const g = groups;
    const kept = [...g.retired, ...g.kept];
    const opt = e => (e.optional ? [' ', el('span', { class: 'tag' }, t('prepare.optional', L))] : null);
    const ledger = g.ledger || ledgerName(app.site ? app.site.path : 'site');
    const textArea = el('textarea', { readonly: true, rows: '8', class: 'filelist', 'aria-label': t('prepare.result', L) }, uploadText(g));
    const copy = el('button', { type: 'button', onclick: async () => {
      try {
        await navigator.clipboard.writeText(uploadText(g));
      } catch (e) {
        textArea.select();
      }
    } }, t('prepare.copyList', L));
    return [
      el('h3', { tabindex: '-1' }, t('prepare.result', L)),
      el('p', null, t('prepare.order', L)),
      el('ol', { class: 'upload-order' },
        el('li', null, el('details', null, el('summary', null, t('prepare.rest', L), ' (', plural('common.files', g.rest.length, L), ')'),
          el('ul', { class: 'files' }, g.rest.map(e => el('li', null, code(e.path), opt(e)))))),
        el('li', null, t('prepare.last', L), el('ol', null, g.last.map(e => el('li', null, code(e.path), opt(e)))))),
      g.rest.some(e => e.optional) ? el('p', { class: 'hint' }, t('prepare.optionalNote', L)) : null,
      el('p', null, copy), textArea,
      g.deleted.length ? [el('p', null, t('prepare.deleted', L)), el('ul', { class: 'files' }, g.deleted.map(p => el('li', null, code(p))))] : null,
      // retired today, and retired earlier but inside their 14 days (prune's `kept`): both stay until a later run
      kept.length ? [el('p', null, t('prepare.retired', L)), el('ul', { class: 'files' }, kept.map(p => el('li', null, code(p))))] : null,
      el('p', { class: 'msg msg-info' }, tNodes('prepare.ledger', L, { ledger: code(ledger) })),
      g.setAside ? el('p', { class: 'msg msg-info' }, tNodes('prepare.setAside', L, { path: code(g.setAside) })) : null,
    ];
  }

  function render() {
    const L = app.lang();
    fill(section.querySelector('[data-part="read-only"]'), app.readOnlyNotice());
    if (!app.site) {
      fill(resultEl, app.noSiteNotice());
      runBtn.disabled = true;
      prepareBtn.disabled = true;
      fill(prepared);
      return;
    }
    if (problems === null) fill(resultEl, el('p', null, t('check.notRun', L)));
    else if (!problems.length) fill(resultEl, el('p', { class: 'msg msg-ok' }, t('check.ok', L)));
    else {
      fill(resultEl,
        el('p', null, plural('check.problems', problems.length, L)),
        el('ul', { class: 'problems' }, problems.map(p => problemItem(p, L))),
        problems.some(isIndexProblem) ? el('p', null, el('button', { type: 'button', 'data-part': 'reindex', onclick: reindex },
          t('check.fixIndex', L))) : null);
    }
    const needs = section.querySelector('[data-part="needs"]');
    if (needs) needs.textContent = problems && !problems.length ? '' : t('prepare.needsCheck', L);
    renderQuestion();
    fill(prepared, renderPrepared(L));
    renderButtons();
  }

  // Buttons are not disabled while a job runs (a focused button would drop the keyboard's place): the program answers
  // 409 busy, which the screen says.
  function renderButtons() {
    const readOnly = !!(app.site && app.site.readOnly);
    runBtn.disabled = !app.site;
    prepareBtn.disabled = readOnly || !app.site || !(problems && !problems.length);
    const re = resultEl.querySelector('[data-part="reindex"]');
    if (re) re.disabled = readOnly;
  }

  return {
    /** run: Check at once; prepare: Prepare upload at once (the notice of a cut-off job's one button) */
    enter({ run = false, prepare: again = false } = {}) {
      render();
      if (again) prepare({});
      else if (run) check();
    },
    render() {
      msgs.render();
      render();
    },
    siteChanged() {
      problems = null;
      groups = null;
      asking = false;
      question.hidden = true;
    },
  };
}
