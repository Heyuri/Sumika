// The system's own file and folder dialogs (CLAUDE.md "The admin tool";
// CONTRACTS "Admin API" /api/pick). The program opens them because it does all file work and
// needs full paths, which a page's <input type=file> never gives. One dialog at a time; where there is none the page
// keeps its in-page file browser (admin/page/browser.js) as the fallback.
//   Windows (Deno): IFileOpenDialog through FFI, in a worker of its own (pickwin.mjs);
//   macOS (Deno): osascript's choose file / choose folder [untested on a Mac];
//   Linux (Deno): zenity, else kdialog [untested on Linux];
//   Node (dev runs, tests): none, unless --fake-picker FILE answers from a JSON file (fakePicker).
// A picker: {kind, available, open(request) → Promise<{paths} | {canceled: true}>, cancel(), close()}; open rejects
// with a PickerError when no dialog could be shown, and the picker is then off for the rest of the run (the page falls
// back). A request: {purpose, title, start, folders, multi, filters: [{name, spec, patterns}], guid} (pickRequest).
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { say } from './say.mjs';
import { closeDialogs as closeWindows } from './pickwin.mjs';

/**
 * What each dialog picks: 'files' (sources: several .nar / .zip), 'folders' (sources: ghost folders and folders of
 * ghosts), 'site' (one folder), 'compare' (one archive or update list). `guid`: the Windows dialog's client GUID, so it
 * keeps its own size and place per purpose.
 */
export const PURPOSES = Object.freeze({
  files: Object.freeze({ folders: false, multi: true, filter: 'archives', guid: '6b1f7c52-3e0a-4d6b-9a71-5c2e8f0d4a11' }),
  folders: Object.freeze({ folders: true, multi: true, filter: null, guid: '6b1f7c52-3e0a-4d6b-9a71-5c2e8f0d4a12' }),
  site: Object.freeze({ folders: true, multi: false, filter: null, guid: '6b1f7c52-3e0a-4d6b-9a71-5c2e8f0d4a13' }),
  compare: Object.freeze({ folders: false, multi: false, filter: 'compare', guid: '6b1f7c52-3e0a-4d6b-9a71-5c2e8f0d4a14' }),
});

/** The file kinds a file dialog shows (inspect takes .nar and .zip; a comparison also an update list). */
export const FILTERS = Object.freeze({
  archives: Object.freeze(['*.nar', '*.zip']),
  compare: Object.freeze(['*.nar', '*.zip', 'updates2.dau', 'updates.txt']),
});

/** A dialog that could not be shown (no dialog program, a failed system call): the page falls back. */
export class PickerError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PickerError';
  }
}

/** The dialog's request: its purpose's kind, its title and filter names in the page's language, where it starts. */
export function pickRequest(purpose, lang, start = null) {
  const p = PURPOSES[purpose];
  const l = lang === 'ja' ? 'ja' : 'en';
  const filters = p.filter ? [{
    name: say(`pick.filter.${p.filter}`, l, { patterns: FILTERS[p.filter].join(', ') }),
    spec: FILTERS[p.filter].join(';'), patterns: [...FILTERS[p.filter]],
  }] : [];
  return {
    purpose, title: say(`pick.title.${purpose}`, l, { exts: '.nar / .zip', sumikaDir: 'sumika' }), start: start || null,
    folders: p.folders, multi: p.multi, filters, guid: p.guid,
  };
}

/** Marks a picker off after a failure, and gives the failure as a PickerError. */
function off(picker, e) {
  picker.available = false;
  return e instanceof PickerError ? e : new PickerError(String((e && e.message) || e));
}

// ---- Windows ----

/** How long cancel() tries to close a Windows dialog before it gives the dialog up. */
export const CANCEL_MS = 5000;

/**
 * The Windows dialog: one worker per dialog, made with env: {} (a worker made without it asks for env permission and
 * the compiled program has none to give: --no-prompt, admin/build.mjs). cancel() sets the worker's flag (before Show)
 * and posts WM_CLOSE to its dialog windows from this thread, again every 200 ms (a dialog that was not up yet); a
 * dialog still there after cancelMs (CANCEL_MS) is given up: its request answers {canceled: true} and the next one
 * gets a worker of its own (a dialog that took no posted message was seen once: with the lock screen in front, before
 * pickwin.mjs NO_BORROW [measured]). A worker blocked in Show() cannot be terminated, and nothing here
 * waits for it.
 */
export function windowsPicker({
  url = new URL('./pickwin.mjs', import.meta.url), WorkerClass = Worker, closeDialogs = closeWindows, cancelMs = CANCEL_MS,
} = {}) {
  const D = globalThis.Deno;
  let current = null;                                          // {flag, thread, closing, give}
  const picker = {
    kind: 'windows',
    available: !!(D && typeof D.dlopen === 'function'),
    open(req) {
      return new Promise((resolve, reject) => {
        const flag = new SharedArrayBuffer(4);
        const c = { flag: new Int32Array(flag), thread: 0, closing: null, give: () => end(resolve, { canceled: true }) };
        let settled = false, w = null;
        const end = (fn, v) => {
          if (settled) return;
          settled = true;
          if (current === c) current = null;
          Promise.resolve().then(() => w && w.terminate()).catch(() => {});
          fn(v);
        };
        // a failure turns the picker off only while this dialog is unanswered: the worker's own exit after its answer
        // (terminate) is no failure [measured: it turned the picker off after each dialog]
        const fail = e => {
          if (!settled) end(reject, off(picker, e));
        };
        try {
          w = new WorkerClass(url, { workerData: { pick: req, flag }, env: {} });
        } catch (e) {
          reject(off(picker, e));
          return;
        }
        current = c;
        w.on('message', m => {
          if (!m || typeof m !== 'object') return;
          if (m.type === 'owner') c.thread = Number(m.thread) || 0;
          else if (m.type === 'done') end(resolve, { paths: (Array.isArray(m.paths) ? m.paths : []).filter(p => typeof p === 'string' && p) });
          else if (m.type === 'canceled') end(resolve, { canceled: true });
          else if (m.type === 'error') fail(new PickerError(String(m.error)));
        });
        w.on('error', fail);
        // `exit`: the page says the code in plain words (app.mjs no-picker), the log has this line
        w.on('exit', code => fail(Object.assign(new PickerError(`the dialog's worker exited (${code})`), { exit: code })));
      });
    },
    cancel() {
      const c = current;
      if (!c) return false;
      Atomics.store(c.flag, 0, 1);
      if (!c.closing) {
        const t0 = Date.now();
        const tick = () => {
          if (current !== c) return;
          if (c.thread) {
            try { closeDialogs(c.thread); } catch (e) { /* tried */ }
          }
          if (current !== c) return;
          if (Date.now() - t0 < cancelMs) c.closing = setTimeout(tick, 200);
          else c.give();
        };
        c.closing = setTimeout(tick, 0);
      }
      return true;
    },
    close() {
      picker.cancel();
    },
  };
  return picker;
}

// ---- macOS and Linux: a dialog program ----

/** A program run to its end under Deno: {code, stdout, stderr}; onChild gets the child (to kill it). */
async function denoRun(cmd, args, onChild) {
  const child = new globalThis.Deno.Command(cmd, { args, stdin: 'null', stdout: 'piped', stderr: 'piped' }).spawn();
  onChild(child);
  const o = await child.output();
  const dec = new TextDecoder();
  return { code: o.code, stdout: dec.decode(o.stdout), stderr: dec.decode(o.stderr) };
}

const lines = text => String(text).split(/\r?\n/).filter(Boolean);
const noTrailingSlash = p => (p.length > 1 ? p.replace(/\/+$/, '') : p);

/** A picker that runs a dialog program per request: tries(req) → [[cmd, args, parse(stdout), canceled(result)], …],
 * the first one installed. A cancel holds for the whole request: one that comes between two programs (zenity not
 * installed, kdialog not started yet) keeps the next from opening, and one before a program's child is there kills
 * it as it comes. */
function programPicker(kind, tries, { run = denoRun } = {}) {
  let child = null, opening = false, killed = false;
  const kill = c => {
    try { c.kill(); } catch (e) { /* gone */ }
  };
  const picker = {
    kind,
    available: !!(globalThis.Deno && typeof globalThis.Deno.Command === 'function') || run !== denoRun,
    async open(req) {
      opening = true;
      killed = false;
      try {
        let last = null;
        for (const [cmd, args, parse, canceled] of tries(req)) {
          if (killed) return { canceled: true };
          let r;
          try {
            r = await run(cmd, args, c => {
              child = c;
              if (killed) kill(c);
            });
          } catch (e) {
            last = e;                                          // not installed: the next one
            continue;
          } finally {
            child = null;
          }
          if (r.code === 0) return { paths: parse(r.stdout) };
          if (killed || canceled(r)) return { canceled: true };
          throw off(picker, new PickerError(`${cmd}: ${r.stderr.trim() || `exit ${r.code}`}`));
        }
        if (killed) return { canceled: true };
        throw off(picker, new PickerError(`no dialog program (${(last && last.message) || kind})`));
      } finally {
        opening = false;
      }
    },
    cancel() {
      if (!opening) return false;
      killed = true;
      if (child) kill(child);
      return true;
    },
    close() {
      picker.cancel();
    },
  };
  return picker;
}

/** AppleScript's lines for a request; argv: the title, the start folder ('' for none). */
export function appleScript(req) {
  const exts = req.filters.length ? [...new Set(req.filters[0].patterns.map(p => p.split('.').pop()))] : [];
  const choose = (...more) => ['set picked to', req.folders ? 'choose folder' : 'choose file', 'with prompt (item 1 of argv)',
    exts.length ? `of type {${exts.map(x => `"${x}"`).join(', ')}}` : null, ...more,
    req.multi ? 'with multiple selections allowed' : null].filter(Boolean).join(' ');
  return [
    'on run argv',
    'activate',
    'if item 2 of argv is "" then',
    choose(),
    'else',
    choose('default location (POSIX file (item 2 of argv))'),
    'end if',
    'set out to ""',
    'repeat with f in (picked as list)',
    'set out to out & POSIX path of f & linefeed',
    'end repeat',
    'return out',
    'end run',
  ];
}

/** macOS: osascript (--allow-run=open,osascript); cancel: error -128. */
export function macPicker(o = {}) {
  return programPicker('macos', req => [[
    'osascript', [...appleScript(req).flatMap(l => ['-e', l]), req.title, req.start || ''],
    out => lines(out).map(noTrailingSlash),
    r => /\(-128\)/.test(r.stderr),                           // "User canceled. (-128)"
  ]], o);
}

/** Linux: zenity, else kdialog (--allow-run=xdg-open,zenity,kdialog); kdialog picks one folder at a time. */
export function linuxPicker(o = {}) {
  return programPicker('linux', req => {
    const pats = req.filters.length ? req.filters[0].patterns.flatMap(p => (p.startsWith('*.') ? [p, p.toUpperCase()] : [p])) : [];
    const start = req.start ? `${req.start.replace(/\/+$/, '')}/` : null;
    const zenity = ['--file-selection', `--title=${req.title}`];
    if (req.folders) zenity.push('--directory');
    if (req.multi) zenity.push('--multiple', '--separator=\n');
    if (start) zenity.push(`--filename=${start}`);
    if (pats.length) zenity.push(`--file-filter=${req.filters[0].name} | ${pats.join(' ')}`);
    const kdialog = ['--title', req.title];
    if (req.folders) kdialog.push('--getexistingdirectory', start || '.');
    else {
      kdialog.push('--getopenfilename', start || '.', `${req.filters.length ? req.filters[0].name : ''} (${pats.join(' ')})`);
      if (req.multi) kdialog.push('--multiple', '--separate-output');
    }
    const parse = out => lines(out).map(noTrailingSlash);
    const canceled = r => r.code === 1;                        // both: 1 is Cancel (stderr may hold GTK warnings)
    return [['zenity', zenity, parse, canceled], ['kdialog', kdialog, parse, canceled]];
  }, o);
}

// ---- a fake, for dev runs and tests ----

/**
 * --fake-picker FILE (never in the compiled program): each request reads FILE, a JSON object whose purpose keys answer:
 * a list of paths, "canceled", "open" (stays open until cancelled) or "no-picker" (a dialog that cannot be shown: the
 * picker is then off, as a real one after a failure); a missing key is "canceled"; "delayMs" (all) waits before
 * answering. `requests` keeps what was asked (tests).
 */
export function fakePicker(file) {
  let open = null;
  const picker = {
    kind: 'fake',
    available: true,
    requests: [],
    open(req) {
      picker.requests.push(req);
      let spec;
      try {
        spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        return Promise.reject(new PickerError(`the fake picker's file ${file}: ${e.code || e.message}`));
      }
      const a = spec && typeof spec === 'object' ? spec[req.purpose] : undefined;
      if (a === 'no-picker') return Promise.reject(off(picker, new PickerError('the fake picker shows no dialog for this')));
      const answer = Array.isArray(a) ? { paths: a.filter(p => typeof p === 'string' && path.isAbsolute(p)) } : { canceled: true };
      return new Promise(resolve => {
        const me = { resolve, timer: null };
        open = me;
        if (a !== 'open') {
          me.timer = setTimeout(() => {
            if (open === me) open = null;
            resolve(answer);
          }, Math.max(0, Number(spec.delayMs) || 0));
        }
      });
    },
    cancel() {
      const me = open;
      if (!me) return false;
      open = null;
      clearTimeout(me.timer);
      me.resolve({ canceled: true });
      return true;
    },
    close() {
      picker.cancel();
    },
  };
  return picker;
}

/** This run's picker: the system's under Deno, none under Node (null). */
export function systemPicker({ platform = process.platform } = {}) {
  if (!globalThis.Deno) return null;
  if (platform === 'win32') return windowsPicker();
  if (platform === 'darwin') return macPicker();
  if (platform === 'linux') return linuxPicker();
  return null;
}
