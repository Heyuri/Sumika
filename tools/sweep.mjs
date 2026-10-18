// Ghost sweep: runs many ghosts through tools/sweep/ghost.mjs (one process each, several at a time) and summarises
// what the runtime cannot do yet, ranked by how many ghosts each problem affects.
//
// usage: node tools/sweep.mjs <folder of .nar/.zip archives or ghost folders | archive | ghost folder>...
//          [--out DIR] [--jobs N] [--only REGEX] [--seconds N] [--timeout S] [--picks N]
//          [--engine satori,yaya,kawari,kawari7|all] [--clock fixed|real|YYYY-MM-DDTHH:MM[:SS]]
// --clock (tools/sweep/clock.mjs): fixed (the default: 2026-10-07 20:00:00 local for the page side and the engines,
// so two runs compare without time-of-day noise), another fixed local start, or real (the earlier sweep's clocks).
// Writes DIR/ghosts/<id>.json (one report per ghost), DIR/summary.json and DIR/summary.md. Satori, YAYA, Kawari and
// Kawari 7 ghosts run (--engine picks; default all four), as tools/sweep/views.mjs sweepEngine decides them; the others
// are listed with their SHIORI. Ghost archives are read in place, never extracted.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openZip } from './sweep/zip.mjs';
import { sweepEngine } from './sweep/views.mjs';
import { GhostFiles, decodeText, parseDescript } from '../src/core/loader.js';
import { RESUME_KEY } from '../src/worker/engines/kawari.js';
import { RESUME_KEY7 } from '../src/worker/engines/kawari7.js';
import { parseClock } from './sweep/clock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(HERE, 'sweep', 'ghost.mjs');

const argv = process.argv.slice(2);
const flags = {};
const inputs = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];
  else inputs.push(argv[i]);
}
if (!inputs.length) { console.error('usage: node tools/sweep.mjs <ghost archives or folders>... [--out DIR] [--jobs N] [--only REGEX] [--engine satori,yaya,kawari,kawari7|all] [--clock fixed|real|YYYY-MM-DDTHH:MM[:SS]]'); process.exit(2); }
const OUT = path.resolve(flags.out || 'sweep-out');
const JOBS = Number(flags.jobs) || Math.max(1, os.cpus().length - 2);
const ONLY = flags.only ? new RegExp(flags.only, 'i') : null;
const TIMEOUT_MS = (Number(flags.timeout) || 180) * 1000;
let CLOCK;
try { CLOCK = parseClock(flags.clock); } catch (e) { console.error(e.message); process.exit(2); }
const passOn = ['seconds', 'picks', 'clock'].flatMap(k => (flags[k] ? ['--' + k, flags[k]] : []));
const RUNNABLE = ['satori', 'yaya', 'kawari', 'kawari7'];
const ENGINES = !flags.engine || flags.engine === 'all' ? RUNNABLE : flags.engine.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
if (ENGINES.some(e => !RUNNABLE.includes(e))) { console.error(`--engine: one or more of ${RUNNABLE.join(', ')}, or all`); process.exit(2); }
const LOAD_STATUS = { '-1': 'no engine', 0: 'normal', 1: 'emergency', 2: 'suppressed', 3: 'shell mode' };    // yaya_load_status()

// ---------------------------------------------------------------- what to run

const isArchive = p => /\.(nar|zip)$/i.test(p);
const isGhostDir = p => fs.existsSync(path.join(p, 'ghost', 'master', 'descript.txt'));
const sources = [];
for (const inp of inputs) {
  const p = path.resolve(inp);
  if (isArchive(p) || isGhostDir(p)) { sources.push(p); continue; }
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const q = path.join(p, e.name);
    if ((e.isFile() && isArchive(q)) || (e.isDirectory() && isGhostDir(q))) sources.push(q);
  }
}
sources.sort((a, b) => a.localeCompare(b));

/** A ghost root inside an archive or a folder for sweepEngine: GhostFiles' paths (any case), bytes read in place. */
class SourceFiles extends GhostFiles {
  constructor(paths, read) {
    super('mem:/', paths.map(p => [p, 0]));
    this._read = read;
  }
  async bytes(p) {
    const r = this.resolve(p);
    if (r === null) throw new Error(`no such file ${p}`);
    const b = this._read(r);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}

/**
 * The ghost's engine without running anything: sweepEngine (the index's rule; Satori by its DLL without a `shiori`
 * line; the proxies' YAYA module), as tools/sweep/ghost.mjs decides it again. {engine, module?, by, name}
 */
async function engineOf(src) {
  let names, read;
  if (isArchive(src)) {
    const z = openZip(src);
    names = z.entries.map(e => e.name);
    read = n => z.entries.find(e => e.name === n).read();
  } else {
    names = [];
    (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/'); else names.push(rel + e.name); } })(src, '');
    read = n => fs.readFileSync(path.join(src, n));
  }
  const desc = names.filter(n => /(^|\/)ghost\/master\/descript\.txt$/i.test(n)).sort((a, b) => a.length - b.length)[0];
  if (!desc) return { engine: 'not a ghost' };
  const d = parseDescript(decodeText(read(desc)));
  const dir = desc.slice(0, -'descript.txt'.length).toLowerCase();
  const dlls = names.filter(n => n.toLowerCase().startsWith(dir) && /\.dll$/i.test(n)).map(n => path.posix.basename(n).toLowerCase());
  const prefix = desc.slice(0, desc.length - 'ghost/master/descript.txt'.length);
  const files = new SourceFiles(names.filter(n => n.startsWith(prefix)).map(n => n.slice(prefix.length)), p => read(prefix + p));
  const e = await sweepEngine(files, d, dlls);
  const engine = e.engine === 'shiori' && !d.get('shiori') ? 'shiori (no shiori line)' : e.engine;
  return { ...e, engine, name: d.get('name') || '' };
}

const engineKey = e => (e.module ? `${e.engine}/${e.module}` : e.engine);

// ---------------------------------------------------------------- run

function runOne(src) {
  return new Promise(resolve => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [RUNNER, src, ...passOn], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { if (err.length < 20000) err += d; });
    const kill = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', code => {
      clearTimeout(kill);
      const i = out.lastIndexOf('@@REPORT@@');
      let r = null;
      if (i >= 0) { try { r = JSON.parse(out.slice(i + 10)); } catch (e) { /* truncated */ } }
      if (!r) r = { source: path.basename(src), ok: false, fatal: Date.now() - t0 >= TIMEOUT_MS ? `timeout after ${TIMEOUT_MS / 1000} s` : `no report (exit ${code}) ${err.slice(-1500)}` };
      r.exit = code;
      resolve(r);
    });
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
      done++;
      process.stderr.write(`\r${done}/${items.length} ${path.basename(items[i]).slice(0, 40).padEnd(40)}`);
    }
  }));
  process.stderr.write('\n');
  return out;
}

// ---------------------------------------------------------------- summary

/** A warning without its specifics, so the same problem in two ghosts counts once per ghost. */
function normalize(msg) {
  return String(msg)
    .replace(/^\[sumika\]\s*/, '')
    .replace(/(cannot load image|no surface|has no surface|cannot read)\s+\S+/g, '$1 <file>')
    .replace(/\\!\[([a-z]+),([a-z]+),[^\]]*\]/gi, '\\![$1,$2,…]')
    .replace(/"[^"]{1,80}"/g, '"…"')
    .replace(/\d+/g, 'N')
    .slice(0, 140);
}

function tally(reports, pick) {
  const m = new Map();
  for (const r of reports) {
    const seen = new Map();
    for (const [key, example] of pick(r)) if (!seen.has(key)) seen.set(key, example);
    for (const [key, example] of seen) {
      let e = m.get(key);
      if (!e) { e = { key, ghosts: [], example }; m.set(key, e); }
      e.ghosts.push(r.id || r.source);
    }
  }
  return [...m.values()].sort((a, b) => b.ghosts.length - a.ghosts.length || a.key.localeCompare(b.key));
}

/** The host of a URL a ghost asked for ('?' when it does not parse). */
function hostOf(u) {
  try { return new URL(u).host || '?'; } catch (e) { return '?'; }
}

/** One of YAYA's log lines without its file and line ("/…/x.dic(12) : "), quoted text collapsed. */
function normalizeEngine(l) {
  return `${l.mode}: ${String(l.text).replace(/^.*?\(\d+\)\s*:\s*/, '').replace(/^-\(-\)\s*:\s*/, '')}`
    .replace(/"[^"]{1,80}"/g, '"…"').slice(0, 160);
}

/**
 * One of Kawari's log lines (tools/sweep/ghost.mjs keeps them without file and line): double-quoted text, quoted hex
 * ids (KEEPS logs a random Ghost ID at each load) and numbers collapsed; the lexer's `')'`, `':'` … stay apart.
 */
function normalizeKawari(l) {
  return `${l.mode}: ${String(l.text)}`.replace(/"[^"]{1,80}"/g, '"…"').replace(/'[0-9a-f]{8,}'/gi, "'…'")
    .replace(/\d+/g, 'N').slice(0, 160);
}

const KAWARI_EVENTS = ['version', 'OnFirstBoot', 'OnBoot', 'OnMouseDoubleClick', 'OnClose'];
/** The statuses a report's GET <id> got, as `200` or `200/204` ('' when it was never sent). */
const statuses = (r, id) => [...new Set(Object.keys(r.requests || {}).filter(k => k.startsWith(`GET ${id} `))
  .map(k => k.split(' ').pop()))].sort().join('/');

/**
 * A Kawari ghost's counts (kawari-wasm.md §15): load, parse errors (the lexer's error lines while its own engine
 * loaded), the boot events' statuses, the slowest request, heap, the worker's saves, the files its run stored, the
 * resume check.
 */
function kawariRow(r) {
  const k = r.kawari || {};
  const log = k.log || {};
  const run = { error: 0, warning: 0, log: 0 };
  for (const [key, n] of Object.entries(log)) {
    const [phase, mode] = key.split(' ');
    if (phase !== 'engine' && phase !== 'resume' && mode in run) run[mode] += n;
  }
  return {
    ghost: r.id || r.source, failed: r.loadFailed || '', dll: r.engineDll || '', dicFiles: r.dicFiles, encrypted: r.encrypted,
    entries: k.entries ?? null, moduleMs: r.engineTiming ? r.engineTiming.module : null,
    loadMs: r.engineTiming ? r.engineTiming.load : null, parseErrors: log['engine error'] || 0,
    loadWarnings: log['engine warning'] || 0, loadLog: log['engine log'] || 0, run,
    requests: Object.fromEntries(KAWARI_EVENTS.map(id => [id, statuses(r, id)])),
    slowest: r.slowest ? { request: r.slowest.request, ms: Math.round(r.slowest.ms * 10) / 10, phase: r.slowest.phase } : null,
    heapMB: k.heapMB ?? null, saves: k.saves || null, marker: k.marker ?? null, restarts: r.restarts || 0,
    runaway: (r.runaway || []).length,
    written: (r.stored || []).filter(p => p !== RESUME_KEY && p !== RESUME_KEY7 && !p.endsWith(' (deleted)')), resume: r.resume || null,
  };
}

function summarise(reports, skipped) {
  const ran = reports.filter(r => r.stage);
  const yaya = ran.filter(r => r.engine === 'yaya');
  const kawari = ran.filter(r => r.engine === 'kawari' || r.engine === 'kawari7');      // both Phases: one table
  const count = (list, key) => list.reduce((m, r) => { const k = key(r); m[k] = (m[k] || 0) + 1; return m; }, {});
  const s = {
    // date: when the sweep ran (the real clock); clock: what the ghosts saw (--clock)
    date: new Date().toISOString(), clock: CLOCK.label, sources: sources.length, ran: reports.length, skipped, engines: ENGINES,
    byEngine: count(reports, r => r.engine || '?'),
    decided: count(reports, r => `${engineKey(r)} by ${r.engineBy || '?'}`),
    ok: reports.filter(r => r.ok && !r.fatal).length,
    crashed: reports.filter(r => r.crashed).map(r => ({ ghost: r.id || r.source, ...r.crashed })),
    fatal: reports.filter(r => r.fatal).map(r => ({ ghost: r.id || r.source, stage: r.stage, fatal: r.fatal.slice(0, 600) })),
    saori: tally(ran, r => (r.saori || []).filter(x => !x.standIn).map(x => [x.name, ''])),
    unknownTags: tally(ran, r => (r.unknownTags || []).map(t => [normalize(t.tag.replace(/^(\\!\[[^,\]]*(,[^,\]]*)?)[^\]]*\]?$/, '$1]')), t.tag])),
    warnings: tally(ran, r => (r.logs || []).filter(l => l.level === 'warn' || l.level === 'error').map(l => [normalize(l.msg), l.msg.slice(0, 300)])),
    requestErrors: tally(ran, r => (r.errors || []).map(e => [`${e.request} ${e.status}: ${normalize(e.error)}`, JSON.stringify(e).slice(0, 400)])),
    slow: ran.filter(r => (r.slow || []).length).map(r => ({ ghost: r.id, worst: r.slow.sort((a, b) => b.ms - a.ms)[0] })),
    boxes: tally(ran, r => (r.boxes || []).map(b => [b.kind, ''])),
    media: tally(ran, r => (r.media || []).filter(m => !m.found && !m.drop).map(m => [`${m.kind}: ${m.path}`, ''])),
    menuless: ran.filter(r => r.menu && r.menu[0] && !r.menu[0].items).map(r => r.id),
    // \![execute,http-*] the ghosts made, by method, host and fetch mode: counted, never sent (EV §4.15)
    http: tally(ran, r => (r.http || []).map(h => [`${h.method} ${hostOf(h.url)} (${h.mode})`, `${h.phase}: ${h.url}`])),
    // \![change,shell|balloon] the ghosts' own scripts asked for, by outcome (tools/sweep/views.mjs; EV §2.6)
    changes: tally(ran, r => (r.changes || []).map(c => [`${c.kind} ${c.result}${c.raiseEvent ? ' (raise-event)' : ''}`,
      `${c.phase}: ${c.from} -> ${c.target} = ${c.to}`])),
    tags: tally(ran, r => Object.keys(r.tags || {}).map(k => [k, ''])).map(e => ({ key: e.key, ghosts: e.ghosts.length })),
    // the property names the ghosts read (%: %property, get: \![get,property]) or set, and whether each failed
    // (properties.md; tools/sweep/ghost.mjs countProp); the Preferences box pages they asked for (UI §2.13)
    properties: tally(ran, r => Object.entries(r.properties || {}).map(([k, n]) => [k, String(n)])),
    settings: tally(ran, r => (r.settings || [])
      .map(x => [`${x.page === '' ? '(no page)' : x.page}: ${x.opens ? 'the box' : 'nothing'}`, x.phase])),
    // YAYA: its own log lines, how the dictionaries loaded, and the resume check (tools/sweep/ghost.mjs resumeCheck)
    engineLog: tally(yaya, r => (r.engineLog || []).map(l => [normalizeEngine(l), String(l.text).slice(0, 300)])),
    loadStatus: yaya.map(r => {
      const first = (r.engineLog || []).find(l => l.mode === 'fatal' || l.mode === 'error');
      return { ghost: r.id, status: r.loadStatus, name: LOAD_STATUS[r.loadStatus] ?? String(r.loadStatus), failed: !!r.loadFailed,
        why: first ? String(first.text).slice(0, 300) : '' };
    }),
    resume: yaya.filter(r => !r.loadFailed).map(r => ({
      ghost: r.id, status: r.resume ? r.resume.status : null, save: r.resume ? r.resume.save : null,
      changed: r.resume ? r.resume.changed : null, added: r.resume ? r.resume.added : null, diff: r.resume ? r.resume.diff : [],
      stampReload: r.resume ? r.resume.stampReload : null,
    })),
    // Kawari: its log lines (each line once per ghost), its counts and the resume check (ghost.mjs kawariResumeCheck)
    kawariLog: tally(kawari, r => (r.engineLog || []).map(l => [normalizeKawari(l), String(l.text).slice(0, 300)])),
    runaway: tally(kawari, r => (r.runaway || []).map(x => [`${x.request || '?'} ${x.ref0 || ''}`.trim(), x.error])),
    kawari: kawari.map(kawariRow),
    ghosts: reports.map(r => ({
      id: r.id || r.source, source: r.source, name: r.name, ok: !!r.ok && !r.fatal, stage: r.stage, engine: r.engine,
      module: r.module, engineBy: r.engineBy, indexEngine: r.indexEngine, loadStatus: r.loadStatus, engineDll: r.engineDll,
      satoriDll: r.satoriDll, ownBalloon: r.ownBalloon, shells: r.shells, shell: r.shell, scripts: r.scripts,
      picks: (r.picks || []).length, chars: r.chars, changes: (r.changes || []).filter(c => c.result === 'switched').length,
      errors: (r.errors || []).length, unknownTags: (r.unknownTags || []).length,
      warnings: (r.logs || []).filter(l => l.level === 'warn' || l.level === 'error').length, ms: r.wallMs && r.wallMs.total,
    })),
  };
  return s;
}

/** summary.md's Kawari sections (kawari-wasm.md §15): the ghosts' counts, Kawari's log lines, the resume check. */
function kawariMarkdown(s, list, names, code, L) {
  const rows = s.kawari;
  const up = rows.filter(x => !x.failed);
  const cell = v => (v === '' || v == null ? '–' : String(v).replace(/\|/g, '\\|'));
  const some = (xs, n = 6) => cell(xs.slice(0, n).join(', ') + (xs.length > n ? ', …' : ''));
  L.push('## Kawari ghosts', '',
    `${up.length} of ${rows.length} Kawari ghosts loaded. Parse errors and load warnings: the lexer's lines while the `
    + 'ghost\'s own engine loaded (one load). The event columns: the statuses each GET got in the run (OnBoot only '
    + 'after an OnFirstBoot that answered 204, or a reboot). Slowest: the slowest request of the run. Saves: the '
    + 'worker\'s snapshot, every 5 s while idle and before the resume check (the longest in ms), and the largest stored '
    + 'snapshot in bytes. Files written: what the run stored, the snapshot key left out.', '');
  L.push(`| ghost | DLL | entries | load ms | parse errors | load warnings | ${KAWARI_EVENTS.join(' | ')} | slowest ms | heap MB | `
    + 'saves (max ms) | snapshot max bytes | files written |', `|${'---|'.repeat(11 + KAWARI_EVENTS.length)}`);
  for (const x of rows) {
    if (x.failed) { L.push(`| ${x.ghost} | ${cell(x.dll)} | **did not load**: ${cell(x.failed.slice(0, 120))} |`); continue; }
    L.push(`| ${x.ghost} | ${cell(x.dll)} | ${cell(x.entries)} | ${cell(x.loadMs)} | ${x.parseErrors} | ${x.loadWarnings} | `
      + `${KAWARI_EVENTS.map(id => cell(x.requests[id])).join(' | ')} | ${x.slowest ? x.slowest.ms : '–'} | ${cell(x.heapMB)} | `
      + `${x.saves ? `${x.saves.n} (${x.saves.maxMs.toFixed(1)})` : '–'} | ${x.saves ? x.saves.maxBytes : '–'} | ${some(x.written, 8)} |`);
  }
  L.push('');
  list('Kawari: runaway recursions (ghosts)', s.runaway, e => `- ${e.ghosts.length} × ${code(e.key)}: ${names(e.ghosts)}`, 60,
    'A request whose recursion ran out of stack (RangeError): it answered 500 and the engine went on, as the stack guard '
    + 'makes it (kawari-wasm.md D8). Kawari has no recursion limit; the DLL would run out of stack too [infer].');
  const restarted = rows.filter(x => x.restarts);
  if (restarted.length) {
    L.push(`Closed mid-run by their own scripts, then booted cold on a new engine from the stored files: `
      + `${restarted.map(x => `${x.ghost} (${x.restarts})`).join(', ')}.`, '');
  }
  list('Kawari engine log (ghosts)', s.kawariLog, e => `- ${e.ghosts.length} × ${code(e.key)}: ${names(e.ghosts)}`, 80,
    'Each line once per ghost, without its file and line. `log`: a line without the lexer\'s marker (a KIS command\'s '
    + 'error, or a line the ghost logs itself).');
  const res = up.filter(x => x.resume);
  const back = res.filter(x => x.resume.changed && !x.resume.changed.length);
  const whole = res.filter(x => x.resume.missed && !x.resume.missed.length);
  const stamp = res.filter(x => x.resume.stampReload && x.resume.stampReload.ok);
  const d6 = res.filter(x => x.resume.d6 && x.resume.d6.ok);
  const finished = d6.filter(x => x.resume.d6.resumed === 'finished');
  const noEffect = res.filter(x => x.resume.d6 && x.resume.d6.outcome === 'no effect');
  L.push('## Kawari resume', '',
    `Of the ${up.length} Kawari ghosts that loaded, ${res.length} ran the resume check: ${back.length} got every entry of their `
    + `snapshot back (adjacent string literals joined), and for ${whole.length} the snapshot held every entry the session `
    + `changed; the reload after a dictionary change worked for ${stamp.length}; D6 worked for ${d6.length} `
    + `(${finished.length} finished the session from its snapshot and wrote the files the session's own close and unload `
    + `write: ssp.exe's close when Windows ends the session, OnCloseAll / OnClose \`system\` and OnTranslate, then the `
    + `unload; the others had nothing to finish); D6 had no effect for ${noEffect.length}`
    + `${noEffect.length ? ` (${noEffect.map(x => x.ghost).join(', ')})` : ''}: they save nothing when they close, so the `
    + 'session is lost (as in SSP). Each entry that '
    + 'differs after the resume is one of: back different (in the snapshot); missed (the session changed it, the '
    + 'snapshot did not carry it); load-set (the session left it as `load` made it, and the next load makes it '
    + 'otherwise: a definition read from a file the session rewrote; the snapshot carries what load\'s scripts wrote).', '',
    '| ghost | snapshot entries | bytes | restored | resume ms | entries | back different | missed | load-set entries '
    + '| stamp reload | D6 | D6 ms | OnBoot after D6 | D6 close | D6 saves |', `|${'---|'.repeat(15)}`);
  for (const x of res) {
    const r = x.resume;
    const st = r.stampReload;
    const d = r.d6;
    const n = xs => (xs ? (xs.length ? `${xs.length}: ${some(xs)}` : '0') : '–');
    L.push(`| ${x.ghost} | ${r.snapshot.entries} | ${cell(r.snapshot.bytes)} | ${r.restored} | ${cell(r.resumeMs)} | `
      + `${cell(r.entries)} | ${r.changed && r.changed.length ? `**${n(r.changed)}**` : n(r.changed)} | `
      + `${r.missed && r.missed.length ? `**${n(r.missed)}**` : n(r.missed)} | ${n(r.loadSet)} | `
      + `${st ? (st.ok ? 'ok' : `**failed** (logged ${st.logged}, ${st.resumed || 'none'}, ${cell(st.version)})`) : 'not run'} | `
      + `${d ? (d.ok ? `ok (${d.resumed || 'nothing to finish'})` : d.outcome === 'no effect' ? 'no effect (its close and unload save nothing)'
        : `**failed** (${d.resumed || 'none'}; differ: ${some(d.differ)})`) : 'not run'} | `
      + `${d ? d.ms : '–'} | ${d ? cell(d.onBoot) : '–'} | ${d && d.close ? `${d.close} (${d.closeMs} ms)` : '–'} | `
      + `${d ? some(d.saves) : '–'} |`);
  }
  L.push('');
}

function markdown(s) {
  const L = [];
  const list = (title, rows, fmt, limit = 60, intro = '') => {
    L.push(`## ${title}`, '');
    if (intro) L.push(intro, '');
    if (!rows.length) { L.push('None.', ''); return; }
    for (const r of rows.slice(0, limit)) L.push(fmt(r));
    if (rows.length > limit) L.push(`- … ${rows.length - limit} more in summary.json`);
    L.push('');
  };
  const names = g => g.slice(0, 6).join(', ') + (g.length > 6 ? ', …' : '');
  const code = t => `\`${String(t).replace(/`/g, "'").replace(/\n/g, ' ')}\``;
  L.push(`# Ghost sweep (${s.date.slice(0, 10)})`, '');
  const failedLoads = s.loadStatus.filter(x => x.failed).length;
  const kawariFailed = (s.kawari || []).filter(x => x.failed).length;
  const withKawari = (s.engines.includes('kawari') ? `, Kawari ${s.byEngine.kawari || 0}` : '')
    + (s.engines.includes('kawari7') ? `, Kawari 7 ${s.byEngine.kawari7 || 0}` : '');
  L.push(`${s.sources} sources: ${s.ran} ghosts ran (Satori ${s.byEngine.satori || 0}, YAYA ${s.byEngine.yaya || 0}${withKawari}), ${s.ok} `
    + `finished without an engine crash or runner error${failedLoads ? `, ${failedLoads} YAYA ghosts did not load (Load status)` : ''}`
    + `${kawariFailed ? `, ${kawariFailed} Kawari ghosts did not load` : ''}; `
    + `${s.skipped.length} skipped (other engines${s.engines.length < RUNNABLE.length ? `, or not ${s.engines.join(', ')}` : ''}).`, '');
  L.push(`Clock: ${s.clock === 'real' ? 'real (the engines on the real date and time; the page side from 2026-10-07 20:00:00)'
    : `${s.clock}, local time, the page side and the engines`} (\`--clock\`).`, '');
  list('How the engines were decided', Object.entries(s.decided).sort((a, b) => b[1] - a[1]), ([k, n]) => `- ${n} × ${k}`);
  list('Engine crashes', s.crashed, c => `- **${c.ghost}** in ${c.phase}, ${c.request || ''}: \`${String(c.error).slice(0, 200).replace(/`/g, "'")}\``);
  list('Runner or runtime failures', s.fatal, f => `- **${f.ghost}** (${f.stage}): \`${f.fatal.slice(0, 240).replace(/\n/g, ' ').replace(/`/g, "'")}\``);
  list('SAORI DLLs without a stand-in (ghosts)', s.saori, e => `- ${e.ghosts.length} × \`${e.key}\`: ${names(e.ghosts)}`);
  list('Unsupported script tags (ghosts)', s.unknownTags, e => `- ${e.ghosts.length} × \`${e.key}\` e.g. \`${String(e.example).slice(0, 100)}\`: ${names(e.ghosts)}`);
  list('Warnings and errors the runtime logged (ghosts)', s.warnings, e => `- ${e.ghosts.length} × ${e.key.replace(/\n/g, ' ')}: ${names(e.ghosts)}`, 80);
  list('SHIORI errors (ghosts)', s.requestErrors, e => `- ${e.ghosts.length} × ${e.key}: ${names(e.ghosts)}`);
  if (s.loadStatus.length) {
    list('Engine errors and warnings (ghosts)', s.engineLog, e => `- ${e.ghosts.length} × ${code(e.key)}: ${names(e.ghosts)}`, 80);
    list('Load status', s.loadStatus.filter(x => x.status !== 0), x => `- **${x.ghost}**: ${x.status} (${x.name})`
      + `${x.failed ? ', the boot fails' : ''}${x.why ? `: ${code(x.why)}` : ''}`, 60,
      `${s.loadStatus.filter(x => x.status === 0).length} of ${s.loadStatus.length} YAYA ghosts loaded normally (status 0); the others:`);
    const differs = s.resume.filter(x => !x.changed || x.changed.length || x.added.length || !x.stampReload || !x.stampReload.ok);
    const pair = v => `${code(v.before || '(none)')} → ${code(v.after || '(none)')}`;
    list('Resume differences', differs, x => {
      const d = !x.changed ? `no saved variables compared (status ${x.status}, save ${x.save || 'none'})`
        : `${x.changed.length} saved values not brought back, ${x.added.length} variables only load made: ${x.diff.map(pair).join('; ')}`;
      const st = x.stampReload;
      return `- **${x.ghost}**: ${d}; stamp reload ${st ? `${st.ok ? 'ok' : '**failed**'} (logged ${st.logged}, status ${st.status}, version ${st.version})` : 'not run'}`;
    }, 80, `Of the ${s.resume.length} YAYA ghosts that loaded, ${s.resume.filter(x => x.changed && !x.changed.length).length} got every `
      + `saved value back on a resume (${s.resume.filter(x => x.changed && !x.changed.length && x.added.length).length} of them with variables `
      + `only load made, which keep load's value); the reload after a dictionary change worked for `
      + `${s.resume.filter(x => x.stampReload && x.stampReload.ok).length}. The others:`);
  }
  if ((s.kawari || []).length) kawariMarkdown(s, list, names, code, L);
  list('Slow requests (> 300 ms)', s.slow, x => `- ${x.ghost}: ${x.worst.request} ${x.worst.ms} ms (${x.worst.phase})`);
  list('Input boxes opened (ghosts)', s.boxes, e => `- ${e.ghosts.length} × ${e.key}`);
  list('Sounds and music not found in the ghost (ghosts)', s.media, e => `- ${e.ghosts.length} × ${e.key}: ${names(e.ghosts)}`);
  list('No right-click menu items for \\0', s.menuless, g => `- ${g}`);
  list('HTTP requests the ghosts made, never sent (ghosts)', s.http || [], e => `- ${e.ghosts.length} × ${e.key} e.g. ${String(e.example).slice(0, 120)}: ${names(e.ghosts)}`);
  list('Shell and balloon changes the ghosts asked for (ghosts)', s.changes, e => `- ${e.ghosts.length} × ${e.key} e.g. ${String(e.example).slice(0, 100)}: ${names(e.ghosts)}`);
  list('Properties read or set (ghosts)', s.properties || [],
    e => `- ${e.ghosts.length} × \`${e.key}\`: ${names(e.ghosts)}`, 120,
    '`%` = `%property[…]`, `get` = `\\![get,property]`, `set` = `\\![set,property]`; `fails`: the name has no value in Sumika.');
  list('Preferences box asked for (ghosts)', s.settings || [], e => `- ${e.ghosts.length} × ${e.key}: ${names(e.ghosts)}`);
  list('Script tags in use (ghosts)', s.tags, e => `- ${e.ghosts} × \`${e.key}\``, 150);
  list('Skipped (other engines)', s.skipped, x => `- ${x.source}: ${x.engine}${x.module ? `/${x.module}` : ''}`, 400);
  L.push('## Ghosts', '', '| ghost | ok | engine | DLL | scripts | choices | switches | errors | tags | warnings | ms |', '|---|---|---|---|---|---|---|---|---|---|---|');
  for (const g of s.ghosts) L.push(`| ${g.id} (${g.name || ''}) | ${g.ok ? 'yes' : '**no**'} | ${g.engine ? engineKey(g) : ''} | ${g.engineDll || g.satoriDll || ''} | ${g.scripts ?? ''} | ${g.picks} | ${g.changes ?? ''} | ${g.errors} | ${g.unknownTags} | ${g.warnings} | ${g.ms ?? ''} |`);
  return L.join('\n') + '\n';
}

// ---------------------------------------------------------------- main

const todo = [], skipped = [];
const decided = new Map();         // source -> engineOf()
for (const src of sources) {
  if (ONLY && !ONLY.test(path.basename(src))) continue;
  let e;
  try { e = await engineOf(src); } catch (err) { skipped.push({ source: path.basename(src), engine: 'unreadable: ' + err.message }); continue; }
  decided.set(src, e);
  if (ENGINES.includes(e.engine)) todo.push(src);
  else skipped.push({ source: path.basename(src), engine: e.engine, ...(e.module ? { module: e.module } : {}), name: e.name });
}
const counts = ENGINES.map(n => `${todo.filter(s => decided.get(s).engine === n).length} ${n}`).join(', ');
process.stderr.write(`${todo.length} ghosts to run (${counts}), ${skipped.length} skipped, ${JOBS} at a time\n`);
fs.mkdirSync(path.join(OUT, 'ghosts'), { recursive: true });
const reports = await pool(todo, JOBS, async src => {
  const r = await runOne(src);
  // a runner that died before its report still counts under the engine this sweep picked
  const e = decided.get(src);
  if (!r.engine) Object.assign(r, { engine: e.engine, module: e.module, engineBy: e.by });
  const id = r.id || path.basename(src).replace(/\.(nar|zip)$/i, '').replace(/[^\w.-]+/g, '_');
  fs.writeFileSync(path.join(OUT, 'ghosts', id + '.json'), JSON.stringify(r, null, 1));
  return r;
});
const summary = summarise(reports, skipped);
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify(summary, null, 1));
fs.writeFileSync(path.join(OUT, 'summary.md'), markdown(summary));
process.stderr.write(`${summary.ok}/${summary.ran} ok; report: ${path.join(OUT, 'summary.md')}\n`);
