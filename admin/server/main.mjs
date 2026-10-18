// sumika-admin's entry (CLAUDE.md "The admin tool"): a small local program that serves the admin
// page to the admin's own browser on 127.0.0.1 only and does all file work itself.
//   node admin/server/main.mjs [--no-browser] [--settings FILE] [--temp DIR] [--fake-picker FILE]   (dev runs, tests)
//   sumika-admin[.exe] [the same flags]                                            (the compiled program: admin/build.mjs)
// Start: the settings; the per-user temp root, where a live instance (instance.json answering with its key) is opened
// in the browser instead of starting a second one; an unfinished job's journal read; a new key; a free port on
// 127.0.0.1; instance.json; the console lines (English, then Japanese); the browser; then the run folders of dead
// instances deleted and the site's work folder settled (what the page then says of that job; jobs wait for it). From
// then on the console gets no line until the stop (a console in QuickEdit selection blocks whoever writes to it):
// errors nothing caught go to sumika-admin.log in the temp root and the program keeps serving (log.mjs). Stop: closing
// the console window (SIGHUP), Ctrl+C, SIGTERM, Quit in the page; with no terminal at all (a Linux file manager's
// start) also after 10 minutes without a request or a job. A dev run builds the page in-process and refuses the
// project's own site/ folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { removeTree } from '../core/tree.mjs';
import { recoverWork, workLeftovers } from '../core/staging.mjs';
import { serve } from './serve.mjs';
import { createApp } from './app.mjs';
import { Jobs, workerRunner } from './jobs.mjs';
import { Drops } from './drops.mjs';
import { settingsPlace, loadSettings } from './settings.mjs';
import {
  tempRoot, makeRoot, liveInstance, runFolders, makeRun, takeJournal, dropJournal, journal, writeInstance, removeInstance,
  settleStart,
} from './instance.mjs';
import { errorLog, catchStray, errorText } from './log.mjs';
import { openBrowser } from './open.mjs';
import { fakePicker, systemPicker } from './picker.mjs';
import { loadStrings, sayBoth, APP } from './say.mjs';

/* global __SUMIKA_ADMIN_COMPILED__, __SUMIKA_ADMIN_VERSION__ */
/** Set by admin/build.mjs for the compiled program (esbuild define); undefined in a dev run. */
export const COMPILED = typeof __SUMIKA_ADMIN_COMPILED__ !== 'undefined' && __SUMIKA_ADMIN_COMPILED__ === true;
const BUILT_VERSION = typeof __SUMIKA_ADMIN_VERSION__ === 'string' ? __SUMIKA_ADMIN_VERSION__ : null;

/** Minutes without a request or a job after which a program with no terminal stops. */
export const IDLE_MINUTES = 10;

/** The environment variables the program reads (the compiled program may read no others: --allow-env). */
export const ENV_NAMES = Object.freeze(['APPDATA', 'USERPROFILE', 'HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TMP', 'TEMP', 'TMPDIR']);

export function readEnv(source = process.env) {
  const env = {};
  for (const k of ENV_NAMES) {
    try {
      const v = source[k];
      if (typeof v === 'string' && v) env[k] = v;
    } catch (e) { /* not allowed: as unset */ }
  }
  return env;
}

/**
 * The flags: --no-browser, --settings FILE, --temp DIR (dev runs, tests and the build's smoke); --fake-picker FILE
 * (dev runs and tests only: the file dialogs answer from FILE, picker.mjs fakePicker), refused by the compiled program.
 */
export function parseArgs(argv, { compiled = COMPILED } = {}) {
  const o = { browser: true, settings: null, temp: null, fakePicker: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-browser') o.browser = false;
    else if (a === '--settings' && i + 1 < argv.length) o.settings = argv[++i];
    else if (a === '--temp' && i + 1 < argv.length) o.temp = argv[++i];
    else if (a === '--fake-picker' && compiled) throw new Error(`--fake-picker is for development runs of ${APP} only`);
    else if (a === '--fake-picker' && i + 1 < argv.length) o.fakePicker = argv[++i];
    else throw new Error(`unknown argument ${a} (usage: ${APP} [--no-browser] [--settings FILE] [--temp DIR])`);
  }
  return o;
}

function devVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
    return `${pkg.version}-dev`;
  } catch (e) {
    return '0.0.0-dev';
  }
}

/** A page that says the admin page could not be built (a dev run whose admin/page/ is missing or broken). */
function placeholderPage(error) {
  const esc = s => String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  return {
    html: `<!doctype html><html lang="en"><meta charset="utf-8"><title>${APP}</title><h1>${APP}</h1>`
      + `<p>The admin page is not built: ${esc(error)}</p></html>`,
    csp: 'default-src \'none\'; base-uri \'none\'; form-action \'none\'; frame-ancestors \'none\'',
  };
}

/** A dev run's page: admin/build.mjs's buildPage, in-process and in memory (never bundled into the compiled program). */
async function devPage() {
  try {
    const spec = '../build.mjs';
    const m = await import(new URL(spec, import.meta.url).href);
    return await m.buildPage({ write: false });
  } catch (e) {
    return placeholderPage(String((e && e.message) || e).split('\n')[0]);
  }
}

/**
 * Starts the program.
 * @param {string[]} argv the flags
 * @param {object} [o] page: the built page (the compiled program's); out: a console line; exit: the process's end;
 *   signals: listen to the stop signals; recover: (site, runner) => Promise<recoverWork's answer>, how the start
 *   settles a site's work folder (tests' stand-in; settleSite)
 * @returns {Promise<{already: true, url: string} | {url: string, port: number, key: string, run: string, root: string,
 *   log: {file: string, write: Function}, settled: Promise<void>, stop: (code?: number) => Promise<void>}>} settled:
 *   the start has settled what an earlier one left (jobs wait for it)
 */
export async function start(argv, {
  page = null, compiled = COMPILED, version = BUILT_VERSION || devVersion(), out = line => console.log(line),
  exit = code => process.exit(code), signals = true, env = readEnv(), platform = process.platform, recover = settleSite,
} = {}) {
  const flags = parseArgs(argv, { compiled });
  await loadStrings();
  const programDir = compiled ? path.dirname(process.execPath) : null;
  const st = loadSettings(settingsPlace({ given: flags.settings, compiled, programDir, platform, env }));
  const root = makeRoot(tempRoot({ given: flags.temp, platform, env }));
  const live = await liveInstance(root);
  if (live) {
    const url = `http://127.0.0.1:${live.port}/?key=${live.key}`;
    for (const l of sayBoth('console.already')) out(l);
    out(url);
    if (flags.browser) openBrowser(url, { platform });
    return { already: true, url };
  }
  const log = errorLog(root);
  const forbidden = compiled ? [] : [fileURLToPath(new URL('../../site', import.meta.url))];
  // an earlier start's cut-off job: read now, deleted once its site's work folder is settled (below), so a start cut
  // off before that leaves it for the next one
  const cut = takeJournal(root, { keep: true, log });
  const run = makeRun(root);
  const key = crypto.randomBytes(32).toString('hex');
  const thePage = page || await devPage();
  const runner = workerRunner();
  const jobs = new Jobs({ runner, journal: journal(root, { log }), log });
  const drops = new Drops(run);
  let app = null;
  let idle = null;
  const server = await serve((req, info) => app.handle(req, info), { hostname: '127.0.0.1', port: 0 });
  let stopping = null;
  const stop = (code = 0) => {
    if (!stopping) {
      // the files first, synchronously: a closing console window may end the process at any moment (the next start
      // deletes whatever is left, and an unfinished job's journal stays for it)
      jobs.close();
      runner.stop();                                         // the start's settling too, when it is still at work
      if (idle) clearInterval(idle);
      try { app.closePicker(); } catch (e) { /* a dialog's worker blocked in Show() is not waited for */ }
      try { removeTree(run); } catch (e) { /* the next start deletes it */ }
      removeInstance(root, key);
      stopping = (async () => {
        try { await app.stopPreview(); } catch (e) { /* closing anyway */ }
        await Promise.race([server.close().catch(() => {}), new Promise(r => setTimeout(r, 500))]);
        for (const l of sayBoth('console.stopped')) {
          try { out(l); } catch (e) { /* the console is going */ }
        }
      })().then(() => exit(code));
    }
    return stopping;
  };
  app = createApp({
    port: server.port, key, page: thePage, st, jobs, drops, xDir: path.join(run, 'x'), serve, forbidden, programDir,
    version, platform, env, interrupted: null, starting: true, log, onQuit: () => stop(0),
    picker: flags.fakePicker ? fakePicker(path.resolve(flags.fakePicker)) : systemPicker({ platform }),
  });
  writeInstance(root, { pid: process.pid, port: server.port, key, version, startedAt: Date.now() });
  const url = `http://127.0.0.1:${server.port}/?key=${key}`;
  for (const l of sayBoth('console.version', { version })) out(l);
  for (const l of sayBoth('console.open', { url })) out(l);
  for (const l of sayBoth('console.stop')) out(l);
  if (flags.browser) openBrowser(url, { platform });
  // What earlier starts left (their run folders, the work folder of the journal's site and of the chosen site) is
  // tidied up only now, with the page served and instance.json written (a second start finds this one): a cut-off
  // job's big leftover takes seconds (2.1 s for 5,000 files, 10.8 s for 20,000 [measured], a blank window
  // and no instance.json while it ran first), so it is deleted in the job worker. A job asked for meanwhile waits for
  // it (Jobs.hold); hello and status say `starting`. Closed meanwhile: its worker stopped, nothing logged, and the
  // journal left for the next start.
  const startLog = { file: log.file, write: (...a) => { if (!stopping) log.write(...a); } };
  const settled = (async () => {
    try {
      if (runFolders(root, { keep: path.basename(run) }).length) await runner('clean', { root, keep: path.basename(run) }, () => {});
    } catch (e) {
      startLog.write('a start could not delete the run folders of earlier starts', errorText(e));
    }
    // closed meanwhile (the run folders' worker stopped): no site is settled any more, so none is settled in the exit's
    // last moments with the journal left behind, which the next start would misread (an old folder put back would
    // look like the new one placed)
    return settleStart({
      journal: cut, site: st.data.site, forbidden, log: startLog,
      recover: s => (stopping ? Promise.reject(new Error(`${APP} is closing`)) : recover(s, runner)),
    });
  })()
    .catch(e => {
      startLog.write('a start could not settle what an earlier one left', errorText(e));
      return null;
    })
    .then(it => {
      if (stopping) return;
      dropJournal(root, { log });                            // no job wrote one meanwhile: they wait for this
      app.started(it);
    });
  jobs.hold(settled);
  if (signals) {
    // Ctrl+C, Ctrl+Break, SIGTERM, and SIGHUP: a closed terminal, and on Windows a closed console window. Deno's own
    // listeners in the compiled program (its node:process registers none of these on Windows: measured), Node's else.
    const onSignal = () => stop(0);
    const D = globalThis.Deno;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
      try {
        if (D && typeof D.addSignalListener === 'function') D.addSignalListener(sig, onSignal);
        else process.on(sig, onSignal);
      } catch (e) { /* not on this system */ }
    }
  }
  if (!process.stdout.isTTY) {
    // no terminal (a file manager's start): no window to close, so an idle program stops by itself
    idle = setInterval(() => {
      if (!jobs.running && Date.now() - app.lastActivity > IDLE_MINUTES * 60000) {
        for (const l of sayBoth('console.idle', { minutes: IDLE_MINUTES })) out(l);
        stop(0);
      }
    }, 30000);
  }
  return { url, port: server.port, key, run, root, log, settled, stop };
}

/**
 * How a start settles one site's work folder (core recoverWork): in the job worker when anything is there (deleting
 * a big leftover blocks its thread for seconds, and the server must answer meanwhile), else at once in this thread.
 * @param {string} site
 * @param {Function} runner workerRunner's
 */
export function settleSite(site, runner) {
  return workLeftovers(site).length ? runner('settle', { site }, () => {}) : recoverWork(site);
}

/** A start that failed: the reason in both languages, and with a terminal a wait for Enter (a double-clicked console
 * would close before it could be read). */
async function fatal(e) {
  const error = String((e && e.message) || e);
  for (const l of sayBoth('console.failed', { error })) console.error(l);
  if (process.stdin.isTTY) {
    for (const l of sayBoth('console.enter')) console.error(l);
    await new Promise(resolve => {
      process.stdin.once('data', resolve);
      if (typeof process.stdin.resume === 'function') process.stdin.resume();
    });
  }
  process.exit(1);
}

/** The program: the flags from the command line. */
export async function main({ page = null } = {}) {
  const argv = globalThis.Deno ? [...globalThis.Deno.args] : process.argv.slice(2);
  let r;
  try {
    r = await start(argv, { page });
  } catch (e) {
    await fatal(e);
    return;
  }
  if (r && r.log) catchStray(r.log);
}

// run as a script (a dev run); the compiled program's entry calls main() itself (admin/build.mjs)
if (import.meta.main) main();
