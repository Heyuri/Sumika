// The Sharing screen (docs/guide.md "Pages on other sites"): sumika/hub.json as rows of addresses
// (add, remove, each judged as you type, Save: the program checks again and writes the file, an empty list deletes
// it), the script line for pages elsewhere from the Sumika host's address (a field, not stored), Copy, and the short
// notes on what a host must allow. With the host's address, the control page's (`sumika/`: where visitors turn Sumika
// on or off for their browser; Sumika itself never links to it, the admin does [decision]), and what a visitor
// who has not chosen gets (a select, not stored either: data-default-state on the line, none for the default).
import { el, fill, code, tNodes } from '../dom.js';
import { t, findingText, PARAMS } from '../strings.js';
import { rowProblems, rowFinding, rowsToSave, scriptUrl, snippet, EXAMPLE } from '../hub.js';
import { Messages } from '../ui.js';

/** The hint under the default-state select, per value (the default, shown, needs none). */
const DEFAULT_HINTS = Object.freeze({ tucked: 'sharing.defaultHint.tucked', off: 'sharing.defaultHint.off' });

export function sharingScreen(app, section) {
  const $ = sel => section.querySelector(sel);
  const msgs = new Messages($('[data-part="messages"]'), app.lang);
  const state = $('[data-part="state"]');
  const list = $('[data-part="rows"]');
  const addBtn = $('[data-part="add"]');
  const saveBtn = $('[data-part="save"]');
  const saveMsg = $('[data-part="save-msg"]');
  const host = $('[data-part="host"]');
  const hostProblem = $('[data-part="host-problem"]');
  const snippetEl = $('[data-part="snippet"]');
  const copyBtn = $('[data-part="copy"]');
  const copyMsg = $('[data-part="copy-msg"]');
  const notes = $('[data-part="notes"]');
  const controlEl = $('[data-part="control"]');
  const controlState = $('[data-part="control-state"]');
  const defaultState = $('[data-part="default-state"]');
  const defaultHint = $('[data-part="default-hint"]');
  let rows = [];
  let serverProblems = [];      // the program's verdicts of the last load or save: {code, params}
  let hub = null;               // the last /api/hub answer
  let dirty = false;
  let loaded = false;
  let saveState = null;         // null | 'saved' | 'savedEmpty' | 'fix'

  const scheme = () => scriptUrl(host.value).scheme;

  /** The program's problem for row i, matched by index or by entry. */
  const serverProblem = i => serverProblems.find(p => p && p.params
    && (p.params.index === i || (p.params.entry !== undefined && String(p.params.entry).trim() === String(rows[i]).trim())));

  /** A row's problem as text: the gate's finding names the entry's own code as params.reason. */
  const rowText = (p, L) => (p && typeof p === 'object' && p.params && p.params.reason ? findingText(p.params.reason, L) : findingText(p, L));

  function judge() {
    const local = rowProblems(rows, { scheme: scheme() });
    const L = app.lang();
    let any = false;
    rows.forEach((r, i) => {
      const li = list.children[i];
      if (!li) return;
      const input = li.querySelector('input');
      const out = li.querySelector('.problem');
      const p = local[i] ? rowFinding(local[i], { scheme: scheme() }) : (dirty ? null : serverProblem(i));
      any = any || !!local[i];
      input.setAttribute('aria-invalid', p ? 'true' : 'false');
      out.textContent = p ? rowText(p, L) : '';
    });
    saveBtn.disabled = !hub || !!(app.site && app.site.readOnly);
    saveBtn.setAttribute('aria-disabled', any ? 'true' : 'false');   // still focusable: a press says what to fix
    return !any;
  }

  function rowItem(i) {
    const L = app.lang();
    const id = `hub-row-${i}`;
    const input = el('input', {
      type: 'text', id, value: rows[i], inputmode: 'url', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off',
      'aria-describedby': `${id}-problem`, disabled: !!(app.site && app.site.readOnly),
      oninput: ev => {
        rows[i] = ev.target.value;
        dirty = true;
        saveState = null;
        saveMsg.textContent = '';
        judge();
      },
    });
    const remove = el('button', { type: 'button', 'aria-label': t('sharing.removeRowLabel', L, { n: i + 1 }),
      disabled: !!(app.site && app.site.readOnly),
      onclick: () => {
        rows.splice(i, 1);
        dirty = true;
        saveState = null;
        renderRows();
        const next = list.querySelectorAll('input')[Math.min(i, rows.length - 1)];
        (next || addBtn).focus();
      } }, t('sharing.removeRow', L));
    return el('li', null, el('label', { for: id }, t('sharing.row', L, { n: i + 1 })), ' ', input, ' ', remove,
      el('span', { class: 'problem', id: `${id}-problem` }));
  }

  function renderRows() {
    fill(list, rows.map((r, i) => rowItem(i)));
    judge();
  }

  addBtn.addEventListener('click', () => {
    rows.push('');
    dirty = true;
    renderRows();
    const inputs = list.querySelectorAll('input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  saveBtn.addEventListener('click', async () => {
    if (!judge()) {
      saveState = 'fix';
      renderSaveMsg();
      return;
    }
    const origins = rowsToSave(rows);
    msgs.clear();
    try {
      const r = await app.api.hubSave(origins);
      serverProblems = (r && Array.isArray(r.problems)) ? r.problems : [];
      if (r && r.ok) {
        dirty = false;
        rows = origins.length ? origins : [];
        saveState = origins.length ? 'saved' : 'savedEmpty';
        if (hub) hub.exists = origins.length > 0;
        renderAll();
        app.refreshSite();
      } else {
        dirty = false;
        saveState = 'fix';
        renderRows();
        renderSaveMsg();
        renderFileProblems();
      }
    } catch (e) {
      if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
    }
  });

  function renderSaveMsg() {
    const L = app.lang();
    saveMsg.textContent = saveState ? t(`sharing.${saveState === 'fix' ? 'fixFirst' : saveState}`, L) : '';
    saveMsg.classList.toggle('error', saveState === 'fix');
  }

  /** Problems of the file as a whole (not of one row): shown above the rows. */
  function renderFileProblems() {
    const whole = serverProblems.filter(p => !(p && p.params && (p.params.index !== undefined || p.params.entry !== undefined)));
    if (whole.length) msgs.set('error', L => el('ul', { class: 'problems' }, whole.map(p => el('li', null, findingText(p, L)))));
  }

  // ---- the script line ----

  function renderSnippet() {
    const L = app.lang();
    const s = scriptUrl(host.value);
    hostProblem.textContent = s.problem ? t('sharing.hostBad', L) : '';
    host.setAttribute('aria-invalid', s.problem ? 'true' : 'false');
    snippetEl.textContent = snippet(s.url, { defaultState: defaultState.value });
    snippetEl.classList.toggle('example', !s.url);
    controlEl.textContent = s.control || EXAMPLE.control;
    controlEl.classList.toggle('example', !s.control);
    const hint = DEFAULT_HINTS[defaultState.value];
    defaultHint.textContent = hint ? t(hint, L) : '';
    // a runtime from before the control page: the address would answer "not found" (SiteInfo runtime.control)
    const rt = app.site && app.site.runtime;
    fill(controlState, rt && !rt.control
      ? el('p', { class: 'msg msg-info' }, tNodes('sharing.noControl', L, { controlHtml: code(PARAMS.controlHtml) })) : null);
  }

  host.addEventListener('input', () => {
    renderSnippet();
    copyMsg.textContent = '';
    judge();
  });

  defaultState.addEventListener('change', () => {
    renderSnippet();
    copyMsg.textContent = '';
  });

  copyBtn.addEventListener('click', async () => {
    const text = snippetEl.textContent;
    const L = app.lang();
    try {
      if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
      await navigator.clipboard.writeText(text);
      copyMsg.textContent = t('sharing.copied', L);
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents(snippetEl);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      copyMsg.textContent = t('sharing.copyManual', L);
    }
  });

  function renderNotes() {
    const L = app.lang();
    fill(notes,
      el('li', null, tNodes('sharing.note.cors', L, { acao: code(PARAMS.acao) })),
      el('li', null, tNodes('sharing.note.frame', L, { hubHtml: code(PARAMS.hubHtml), xfo: code(PARAMS.xfo) })),
      el('li', null, t('sharing.note.own', L)),
      el('li', null, t('sharing.note.site', L)),
      el('li', null, tNodes('sharing.note.same', L, { dataHub: code(PARAMS.dataHub) })));
  }

  function renderState() {
    const L = app.lang();
    const lines = [app.readOnlyNotice()];
    if (hub && !hub.runtimeHasHub) lines.push(el('p', { class: 'msg msg-error' }, tNodes('sharing.noHub', L, { hubHtml: code(PARAMS.hubHtml) })));
    if (hub && !hub.exists && !rows.length) lines.push(el('p', null, t('sharing.noFile', L)));
    fill(state, lines);
  }

  function renderAll() {
    if (!app.site) {
      fill(state, app.noSiteNotice());
      section.querySelector('[data-part="editor"]').hidden = true;
      renderNotes();
      renderSnippet();
      return;
    }
    section.querySelector('[data-part="editor"]').hidden = false;
    renderState();
    renderRows();
    renderSaveMsg();
    renderSnippet();
    renderNotes();
  }

  async function load() {
    if (!app.site) {
      renderAll();
      return;
    }
    try {
      hub = await app.api.hub();
      rows = Array.isArray(hub.origins) ? hub.origins.map(String) : [];
      serverProblems = Array.isArray(hub.problems) ? hub.problems : [];
      dirty = false;
      saveState = null;
      loaded = true;
      msgs.clear();
      renderFileProblems();
    } catch (e) {
      if (!app.handleError(e, msgs)) msgs.set('error', L => findingText(e, L));
    }
    renderAll();
  }

  return {
    enter() {
      if (!loaded || !dirty) return load();
      renderAll();
      return undefined;
    },
    /** another site was chosen: what was loaded belongs to the old one */
    siteChanged() {
      loaded = false;
      dirty = false;
      rows = [];
      hub = null;
    },
    render() {
      msgs.render();
      renderAll();
    },
  };
}
