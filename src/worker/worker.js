// Engine host, running inside a Web Worker. Owns one SHIORI engine, the SAORI stand-ins it calls, and the
// persistence of the files the engine writes (save data), which go straight to IndexedDB from here: a page can
// disappear at any moment, so we never rely on an unload.
// Protocol: docs/ARCHITECTURE.md "Worker protocol".
import { createEngine } from './engines/index.js';
import { saoriBridge } from './saori/index.js';
import { Store } from '../core/storage.js';
import { PortStore } from '../core/portstore.js';
import { personalFile, visitorFile } from '../core/engine-files.js';

let engine = null;
let store = null;
let storeKey = null;
let persisted = {};      // path -> ArrayBuffer | null (a shipped file the ghost deleted), mirror of what is in the store
let saveTimer = null;
let lastSaveCost = 0;
let lastSaveAt = 0;

// user actions saved right away; mouse moves, hovers, enter/leave and wheel turns (up to one per frame) wait for the
// debounce, since one save costs ~15 requests
export const IMPORTANT = /^On(ChoiceSelect|ChoiceSelectEx|AnchorSelect|AnchorSelectEx|UserInput|Communicate|Mouse(Down|Up|Click|DoubleClick|DragEnd)(Ex)?|KeyPress|FileDrop2|Close\w*)$/;
const SAVE_DEBOUNCE_MS = 1000;
const SLOW_SAVE_MS = 50;
const SLOW_SAVE_INTERVAL_MS = 30000;

function reply(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function log(level, text) {
  reply({ t: 'log', level, text: String(text) });
}

/** What failed, as text: Emscripten's FS.ErrnoError is no Error (no message, no stack), so its name and errno. */
export function errorText(e, stack = false) {
  if (e && stack && e.stack) return String(e.stack);
  if (e && e.message) return String(e.message);
  if (e && e.errno !== undefined) return `${e.name || 'ErrnoError'} (errno ${e.errno})`;
  return String(e);
}

saoriBridge.notifyPage = (name, cmd, args) => reply({ t: 'saori', name, cmd, args });
saoriBridge.log = log;

/**
 * Write the save files; warn once when the browser refused them (storage full, e.g. by dropped files: TS §3.4). They
 * then live only in this worker, and the next page resumes from the last save that was stored.
 * @returns {Promise<boolean>} stored
 */
export async function writeSave(st, key, value, warn) {
  const ok = await st.set(key, value);
  if (!ok && st.kind !== 'memory' && !writeSave.warned) {
    writeSave.warned = true;
    warn('the browser did not store the save data (storage full or blocked): it is kept until this page closes');
  }
  return ok;
}
writeSave.warned = false;

/**
 * The stored files after an engine's report: bytes and null (a tombstone: a shipped file the ghost deleted) are kept,
 * false forgets the key (a file of its own the ghost deleted). Satori reports bytes only.
 * @param {Record<string, ArrayBuffer|null>} prev  @param {Record<string, ArrayBuffer|null|false>} files
 */
export function mergeFiles(prev, files) {
  const out = { ...prev };
  for (const [p, v] of Object.entries(files || {})) {
    if (v === false) delete out[p];
    else out[p] = v;
  }
  return out;
}

/** Whether the store holds a save: some file, not only tombstones. */
export const hasSave = files => Object.values(files || {}).some(v => v);

/**
 * The stored save files before the engine sees them (safe updates: schema.js `files`, whose version is the key):
 * {path: ArrayBuffer | null}, {} when none is stored. A read that fails (Store.read rejects where get() would answer
 * "nothing") or a value of another shape is no "no save": ok false, and the worker then runs memory-only for this
 * page, never writing over the stored record.
 * @returns {Promise<{files: Object<string, ArrayBuffer|null>, ok: boolean}>}
 */
export async function readFiles(st, key) {
  let v;
  try { v = await st.read(key); } catch (e) { return { files: {}, ok: false }; }
  if (v === undefined || v === null) return { files: {}, ok: true };
  const map = !!v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
  if (!map || !Object.values(v).every(x => x === null || x instanceof ArrayBuffer)) return { files: {}, ok: false };
  return { files: v, ok: true };
}

/**
 * What an engine's stored keys put before a path inside its ghost/master: 'ghost/master/' for a root engine (YAYA,
 * Kawari: ghost-root-relative keys, ghostDir under ghostRoot), '' for Satori (ghost/master-relative keys).
 */
export function keyPrefix(eng) {
  const root = eng && typeof eng.ghostRoot === 'string' ? eng.ghostRoot : '';
  const dir = eng && typeof eng.ghostDir === 'string' ? eng.ghostDir : '';
  return root && dir.startsWith(root) ? dir.slice(root.length) : '';
}

/**
 * --param-input-file's bytes (EV §4.15) as the worker hands them out: null for a personal file (personalFile) and for
 * a file the visitor's own run wrote (a stored key with bytes: kawari-wasm.md §12 [decision]), both
 * judged on the path as resolved; else the engine's file.
 * @returns {ArrayBuffer|null}
 */
export function readForUpload(eng, stored, rel) {
  if (!eng || typeof eng.readMasterFile !== 'function') return null;
  if (personalFile(rel) || visitorFile(stored, rel, keyPrefix(eng))) return null;
  return eng.readMasterFile(rel);
}

async function storeChanged(files) {
  const names = Object.keys(files);
  if (!names.length) return names;
  persisted = mergeFiles(persisted, files);
  if (store) await writeSave(store, storeKey, persisted, text => log('warn', text));
  reply({ t: 'saved', files: names });
  return names;
}

function saveNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!engine) return Promise.resolve([]);
  const t0 = performance.now();
  engine.save();
  lastSaveCost = performance.now() - t0;
  lastSaveAt = Date.now();
  if (lastSaveCost > SLOW_SAVE_MS) log('info', `save took ${lastSaveCost.toFixed(0)} ms; saving less often`);
  return storeChanged(engine.changedFiles());
}

function scheduleSave(urgent) {
  if (!engine) return;
  if (!urgent && saveTimer !== null) return;     // a steady stream of requests must not postpone the pending save
  let delay = urgent ? 0 : SAVE_DEBOUNCE_MS;
  if (lastSaveCost > SLOW_SAVE_MS) delay = Math.max(delay, lastSaveAt + SLOW_SAVE_INTERVAL_MS - Date.now());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveNow().catch(e => log('error', `save: ${errorText(e)}`)); }, Math.max(0, delay));
}

/**
 * One 'req': the page's FMO text first, when the message has one and the engine reads an FMO (Satori P8:
 * Module.fmoText), then the request.
 * @returns {string} the response text
 */
export function engineRequest(eng, m) {
  if (typeof m.fmo === 'string' && typeof eng.setFmo === 'function') eng.setFmo(m.fmo);
  // kind / self: the page's call, for a SHIORI/2.x engine's bridge (shiori2.js); the other engines take the text only
  return eng.request(m.text, { kind: m.kind || '', self: m.self || '' });
}

async function init(m) {
  const t0 = Date.now();
  if (m.storeNamespace && m.storeKey) {
    // the storage hub's store when the page has one (data-hub: a MessagePort, CONTRACTS core/portstore.js), else
    // IndexedDB of the page's origin
    store = m.storePort ? await PortStore.open(m.storePort) : await Store.open(m.storeNamespace);
    storeKey = m.storeKey;
    const got = await readFiles(store, storeKey);
    persisted = got.files;
    if (!got.ok) {
      store = null;           // memory-only for this page: the record it could not read is never written over
      log('warn', 'the stored save data could not be read: the ghost starts without it, and this page stores none');
    }
  }
  // engineOpts: the page's engine-specific options, plain JSON (YAYA: module, ghost id, placeholders, the site);
  // wasmUrl: the page's hashed .wasm (safe updates; null: the one next to engineUrl)
  const opts = m.engineOpts || null;
  engine = await createEngine(m.engine, { engineUrl: m.engineUrl, wasmUrl: m.wasmUrl || null, ghostDir: m.ghostDir, log, saori: saoriBridge, opts });
  const hadSave = hasSave(persisted);
  // the page's stored engine state, for an engine that decides its resume from it (YAYA's dictionary stamp)
  const volatile = m.resume ? m.volatile || null : null;
  // sessionEndMs: when the ghost's last session ended (its state's last write), for Kawari's D6 (kawari-wasm.md §8);
  // Satori and YAYA ignore it
  const ok = engine.init(m.files, persisted, {
    resume: !!m.resume && hadSave, bootEpochMs: m.bootEpochMs, volatile, sessionEndMs: m.sessionEndMs || 0,
  });
  if (m.resume && m.volatile) engine.setVolatileState(m.volatile);
  // the engine's first report, stored at once: YAYA's holds what load wrote or deleted (a save moved from an old
  // module, on a resume rewritten from the restored variables); Satori's base takes its baseline after load
  await storeChanged(engine.changedFiles());
  // the ghost's master folder as the engine sees it: \![execute,http-*]'s R3 names files there (EV §4.15)
  return { ok, hadSave, ms: Date.now() - t0, ghostDir: engine.ghostDir || '' };
}

self.onmessage = async ev => {
  const m = ev.data || {};
  try {
    switch (m.t) {
      case 'init': {
        const r = await init(m);
        reply({ t: 'loaded', id: m.id, ...r });
        break;
      }
      case 'req': {
        if (!engine) { reply({ t: 'res', id: m.id, text: '' }); break; }
        const t0 = performance.now();
        const text = engineRequest(engine, m);
        // reloads inside a request and ＄手動セーブ write the save file on their own: the files it changed, found before
        // the reply so that `ms` holds the scan too (a root engine scans only after a request that wrote: ssproot.js)
        let files = {};
        let failed = null;
        try { files = engine.changedFiles(); } catch (e) { failed = e; }
        const ms = performance.now() - t0;
        const idm = /\r\nID: ([^\r\n]*)/.exec(m.text);
        const eventId = idm ? idm[1] : '';
        reply({ t: 'res', id: m.id, text, ms, vol: engine.getVolatileState() });
        if (failed) throw failed;         // the reply is out first; the failure is logged and posted as an error
        await storeChanged(files);
        if (!/^NOTIFY/.test(m.text) || IMPORTANT.test(eventId)) {
          scheduleSave(IMPORTANT.test(eventId) || /\\q\[|\\__q\[/.test(text));
        }
        break;
      }
      case 'persist': {
        const files = await saveNow();
        reply({ t: 'persisted', id: m.id, files });
        break;
      }
      case 'write': {
        // \![execute,http-*]'s download (EV §4.15): into ghost/master/<path> before the event that reads it; written
        // before the first await, and stored at once like any file the ghost writes
        if (!engine || typeof engine.writeMasterFile !== 'function') throw new Error('no engine to take the file');
        const path = engine.writeMasterFile(m.path, m.data);
        reply({ t: 'written', id: m.id, path });
        await storeChanged(engine.changedFiles());
        break;
      }
      case 'read': {
        // --param-input-file's bytes (EV §4.15): never a personal file, never one the visitor's run wrote [decision]
        const data = readForUpload(engine, persisted, m.path);
        reply({ t: 'read', id: m.id, data }, data ? [data] : []);
        break;
      }
      case 'unload': {
        clearTimeout(saveTimer);
        const files = engine ? engine.unload() : {};
        await storeChanged(files);
        engine = null;
        reply({ t: 'unloaded', id: m.id, files: Object.keys(files) });
        break;
      }
      case 'forget': {
        // the ghost's save data is being reset (e.g. a fresh start requested by the user)
        persisted = {};
        if (store) await store.delete(storeKey);
        reply({ t: 'forgotten', id: m.id });
        break;
      }
      default:
        reply({ t: 'error', id: m.id, error: `unknown message ${m.t}` });
    }
  } catch (e) {
    log('error', errorText(e, true));
    if (m.t === 'init') reply({ t: 'loaded', id: m.id, ok: false, error: errorText(e) });
    else reply({ t: 'error', id: m.id, error: errorText(e) });
  }
};
