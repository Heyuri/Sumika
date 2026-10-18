// The program's settings (CLAUDE.md "The admin tool": a plain JSON file the program reads and writes):
// `sumika-admin.json` beside the program, else in the user's app-data folder; {"format": 1, "site", "recent",
// "language", "lastFolders"} with unknown keys kept, written atomically (a temporary file, then a rename) with a
// 1-space indent. `lastFolders` {files?, folders?, site?, compare?}: where each file dialog last picked (picker.mjs). A
// file that does not parse is never overwritten: defaults in memory, and the Site screen says so.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { finding } from './codes.mjs';
import { foldCase } from './paths.mjs';

export const SETTINGS_NAME = 'sumika-admin.json';
export const SETTINGS_FORMAT = 1;
export const RECENT_MAX = 10;
const LANGS = ['ja', 'en'];

/** The user's app-data folder for the program: %APPDATA%, ~/Library/Application Support, $XDG_CONFIG_HOME or ~/.config. */
export function appDataDir({ platform = process.platform, env = {} } = {}) {
  if (platform === 'win32') {
    if (env.APPDATA) return path.join(env.APPDATA, 'sumika-admin');
    return env.USERPROFILE ? path.join(env.USERPROFILE, 'AppData', 'Roaming', 'sumika-admin') : null;
  }
  if (platform === 'darwin') return env.HOME ? path.join(env.HOME, 'Library', 'Application Support', 'sumika-admin') : null;
  const base = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, '.config') : null);
  return base ? path.join(base, 'sumika-admin') : null;
}

const isFile = p => {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
};

/** Whether a folder takes a new file: `sumika-admin.json.tmp-<rand>` is made and deleted. */
export function writable(dir) {
  const probe = path.join(dir, `${SETTINGS_NAME}.tmp-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
  } catch (e) {
    return false;
  }
  try { fs.unlinkSync(probe); } catch (e) { /* made, so writable */ }
  return true;
}

/**
 * Where the settings live: {file, where}. `given` (--settings FILE: dev runs and tests): that file. A compiled program:
 * the file beside it when it is there (also when an app-data one exists too), else the app-data one when that is there,
 * else beside it when its folder takes a file, else in app-data. Run from source there is no program folder: app-data.
 */
export function settingsPlace({ given = null, compiled = false, programDir = null, platform = process.platform, env = {} } = {}) {
  if (given) return { file: path.resolve(given), where: 'given' };
  const app = appDataDir({ platform, env });
  const appFile = app ? path.join(app, SETTINGS_NAME) : null;
  if (compiled && programDir) {
    const beside = path.join(programDir, SETTINGS_NAME);
    if (isFile(beside)) return { file: beside, where: 'beside' };
    if (appFile && isFile(appFile)) return { file: appFile, where: 'appdata' };
    if (writable(programDir)) return { file: beside, where: 'beside' };
  }
  return { file: appFile, where: 'appdata' };
}

const defaults = () => ({ format: SETTINGS_FORMAT, site: null, recent: [], language: null, lastFolders: {} });

/** `lastFolders` made safe: its full-path texts only (a key it does not know is kept, as unknown keys are). */
function lastFolders(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
  return Object.fromEntries(Object.entries(v).filter(([, p]) => typeof p === 'string' && path.isAbsolute(p)));
}

/** A parsed settings object made safe to use: known keys checked, unknown ones kept as they are. */
function normalize(j) {
  const out = { ...j, format: SETTINGS_FORMAT };
  out.site = typeof j.site === 'string' && j.site ? j.site : null;
  out.recent = Array.isArray(j.recent) ? j.recent.filter(r => typeof r === 'string' && r).slice(0, RECENT_MAX) : [];
  out.language = LANGS.includes(j.language) ? j.language : null;
  out.lastFolders = lastFolders(j.lastFolders);
  return out;
}

/**
 * The settings: {file, where, problem, data, locked}. A missing file gives the defaults; one that cannot be read or is
 * no settings file gives the defaults, a problem, and `locked` (never written over).
 */
export function loadSettings(place) {
  const st = { file: place.file, where: place.where, problem: null, data: defaults(), locked: false };
  if (!place.file) return st;
  let text;
  try {
    text = fs.readFileSync(place.file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return st;
    st.problem = finding('settings-unreadable', { file: place.file, error: e.code || e.message });
    st.locked = true;
    return st;
  }
  let j;
  try {
    j = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch (e) {
    j = undefined;
  }
  const why = j === undefined ? 'no JSON' : !j || typeof j !== 'object' || Array.isArray(j) ? 'no JSON object'
    : j.format !== undefined && j.format !== SETTINGS_FORMAT ? `format ${JSON.stringify(j.format)}` : null;
  if (why) {
    st.problem = finding('settings-bad', { file: place.file, error: why });
    st.locked = true;
    return st;
  }
  st.data = normalize(j);
  return st;
}

/** The settings file's text: format, site, recent, language (absent: follow the browser), lastFolders (absent while
 * no dialog picked anything), then the unknown keys. */
export function settingsText(data) {
  const { format, site, recent, language, lastFolders: last, ...rest } = data;
  const out = { format: SETTINGS_FORMAT, site: site ?? null, recent: recent || [] };
  if (language) out.language = language;
  if (last && Object.keys(last).length) out.lastFolders = last;
  return JSON.stringify({ ...out, ...rest }, null, 1) + '\n';
}

/** Writes a file atomically: a temporary file beside it, then a rename over it. */
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* gone */ }
    throw e;
  }
}

/**
 * Applies a change to the settings and writes them; a locked file is never written (the change holds for this run).
 * @returns {boolean} written
 */
export function saveSettings(st, patch) {
  Object.assign(st.data, patch);
  if (st.locked || !st.file) return false;
  try {
    writeAtomic(st.file, settingsText(st.data));
    if (st.problem && st.problem.code === 'settings-write') st.problem = null;
    return true;
  } catch (e) {
    st.problem = finding('settings-write', { file: st.file, error: e.code || e.message });
    return false;
  }
}

/** The recent folders with p first: no duplicates (any case on Windows), at most RECENT_MAX. */
export function addRecent(list, p, platform = process.platform) {
  const key = x => (platform === 'win32' ? foldCase(x, platform) : x);
  return [p, ...(list || []).filter(x => key(x) !== key(p))].slice(0, RECENT_MAX);
}

/** What the page sees of the settings (CONTRACTS "Admin API" Settings). */
export function settingsView(st) {
  return {
    file: st.file, where: st.where, problem: st.problem, language: st.data.language, site: st.data.site,
    recent: st.data.recent,
  };
}
