// Drag-and-drop on the Add screen. The page reads each dropped item as the core's inspectSource
// reads a path: a ghost root (ghost/master/descript.txt, any case), a folder of ghosts (only its ghost-root sub-folders
// and .nar / .zip files are sent), or a .nar / .zip; anything else is reported and not sent. Inside a ghost, what the
// copy would leave out anyway is never read nor sent (the core's own predicates, admin/core/rules.mjs: a profile/
// folder is not entered, saves, logs, DLLs and EXEs are not sent), so a user's personal files never leave their
// folder, as the CLI never reads them. Folders are read with readEntries() until it returns nothing (Chromium gives at
// most 100 entries a call); 64 folder levels inside a ghost stop the walk (a link loop), reported. Then the files go
// to the program 4 at a time (PUT /api/drop/<drop>/<n>, n = the dropped item), and `done` starts the inspection.
// Pure: entries (DataTransferItem.webkitGetAsEntry) and the API are passed in; tests/admin/page.test.mjs uses fakes.

export const MAX_DEPTH = 64;
export const ARCHIVE = /\.(nar|zip)$/i;
export const CONCURRENCY = 4;

/**
 * The dropped items as file-system entries; call it inside the drop event (the items are gone after it). null when
 * the browser has no entry API (then only dataTransfer.files can be read: fileRoots).
 */
export function droppedEntries(dataTransfer) {
  const items = dataTransfer && dataTransfer.items;
  if (!items) return null;
  const out = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || item.kind !== 'file') continue;
    const get = item.getAsEntry || item.webkitGetAsEntry;      // MDN: the standard name first
    if (typeof get !== 'function') return null;
    out.push(get.call(item));
  }
  return out;
}

const readBatch = reader => new Promise((resolve, reject) => reader.readEntries(resolve, reject));

/** Every entry of a folder: readEntries() on one reader until it gives an empty batch. */
export async function readAll(dir) {
  const reader = dir.createReader();
  const out = [];
  for (;;) {
    const batch = await readBatch(reader);
    if (!batch || !batch.length) return out;
    out.push(...batch);
  }
}

/** The File of a file entry. */
export const fileOf = entry => new Promise((resolve, reject) => entry.file(resolve, reject));

class Refused extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

/**
 * What a drop would send.
 * @param {(FileSystemEntry|null)[]} entries  droppedEntries' result (null: an item that is no file or folder)
 * @param {{skip: (rel: string) => ({code: string, params?: object}|null), skipDir: (name: string) => boolean,
 *   maxDepth?: number}} rules  the core's skipCode / isSkipDir (ghost-root-relative paths, '/'-separated)
 * @returns {Promise<{roots: {n: number, name: string, kind: 'dir'|'file', files: {rel: string, file: Blob}[],
 *   bytes: number}[], refused: {name: string, code: string, params?: object}[], left: {root: string, path: string,
 *   code: string, params?: object}[]}>} roots: what is sent, each file at `rel` (starting with the item's own name)
 *   inside its root's folder; refused: items not sent and why (drop.* codes); left: files the copy leaves out, not sent
 */
export async function walkDrop(entries, { skip, skipDir, maxDepth = MAX_DEPTH }) {
  const listings = new WeakMap();
  const list = dir => {
    let p = listings.get(dir);
    if (!p) {
      p = readAll(dir);
      listings.set(dir, p);
    }
    return p;
  };
  const find = (ents, name, folder) => ents.find(e => e && String(e.name).toLowerCase() === name
    && (folder ? e.isDirectory : e.isFile));
  const isGhostRoot = async dir => {
    const g = find(await list(dir), 'ghost', true);
    const m = g && find(await list(g), 'master', true);
    return !!(m && find(await list(m), 'descript.txt', false));
  };
  // a ghost's files, ghost-root-relative for the rules, sent as `${prefix}/${rel}`
  const ghostFiles = async (dir, prefix, files, left) => {
    const walk = async (d, rel, depth) => {
      for (const e of await list(d)) {
        if (!e) continue;
        const p = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory) {
          if (skipDir(e.name)) {
            left.push({ root: prefix, path: `${p}/`, code: 'personal.profile' });
            continue;
          }
          if (depth + 1 > maxDepth) throw new Refused('drop.tooDeep');
          await walk(e, p, depth + 1);
        } else if (e.isFile) {
          const s = skip(p);
          if (s) left.push({ root: prefix, path: p, ...s });
          else files.push({ rel: `${prefix}/${p}`, file: await fileOf(e) });
        }
      }
    };
    await walk(dir, '', 0);
  };

  const roots = [], refused = [], left = [];
  for (const entry of entries || []) {
    if (!entry) continue;                                    // dragged text or a link: no file, nothing to say
    const name = String(entry.name);
    try {
      if (entry.isFile) {
        if (ARCHIVE.test(name)) roots.push({ name, kind: 'file', files: [{ rel: name, file: await fileOf(entry) }] });
        else refused.push({ name, code: 'drop.notSource' });
        continue;
      }
      if (!entry.isDirectory) {
        refused.push({ name, code: 'drop.notSource' });
        continue;
      }
      const files = [], skipped = [];
      if (await isGhostRoot(entry)) await ghostFiles(entry, name, files, skipped);
      else {
        for (const e of await list(entry)) {
          if (!e) continue;
          if (e.isDirectory && await isGhostRoot(e)) await ghostFiles(e, `${name}/${e.name}`, files, skipped);
          else if (e.isFile && ARCHIVE.test(e.name)) files.push({ rel: `${name}/${e.name}`, file: await fileOf(e) });
        }
        if (!files.length) {
          refused.push({ name, code: 'drop.noGhost' });
          continue;
        }
      }
      roots.push({ name, kind: 'dir', files });
      left.push(...skipped);
    } catch (e) {
      refused.push(e instanceof Refused ? { name, code: e.code, params: { max: maxDepth } } : { name, code: 'drop.unreadable' });
    }
  }
  roots.forEach((r, n) => {
    r.n = n;
    r.bytes = r.files.reduce((a, f) => a + ((f.file && f.file.size) || 0), 0);
  });
  return { roots, refused, left };
}

/**
 * Whether a dropped File can be read (a folder in dataTransfer.files cannot: reading it fails [infer: the usual test
 * in pages that take drops; no browser the admin uses lacks the entry API]); its first byte only.
 */
export async function readable(file) {
  try {
    await (file.size ? file.slice(0, 1) : file).arrayBuffer();
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * A browser without the entry API: the dropped files only. Archives are sent; a file that cannot be read is a folder,
 * which this browser cannot read either (`folders`: the page then points to the folder dialog); anything else is no
 * source (drop.notSource).
 * @param {Iterable<File>} files
 * @param {{readable?: (file: File) => Promise<boolean>}} [o] tests' stand-in
 * @returns {Promise<{roots: object[], refused: object[], left: [], folders: string[]}>}
 */
export async function fileRoots(files, { readable: canRead = readable } = {}) {
  const roots = [], refused = [], folders = [];
  for (const file of Array.from(files || [])) {
    if (ARCHIVE.test(file.name)) roots.push({ n: roots.length, name: file.name, kind: 'file', files: [{ rel: file.name, file }], bytes: file.size || 0 });
    else if (!(await canRead(file))) folders.push(file.name);
    else refused.push({ name: file.name, code: 'drop.notSource' });
  }
  return { roots, refused, left: [], folders };
}

const abortError = () => {
  try {
    return new DOMException('stopped', 'AbortError');
  } catch (e) {
    const err = new Error('stopped');
    err.name = 'AbortError';
    return err;
  }
};

/**
 * Sends a walked drop and starts its inspection: POST /api/drop, each file PUT (CONCURRENCY at a time), then
 * POST …/done with the roots, which answers the inspect Job. A failed or stopped send cancels the drop (the program
 * deletes its folder) and throws (an AbortError when `signal` stopped it). A stop ends it at once, also while a call
 * waits for a program that gives no answer (api.js): the cancel then goes on by itself.
 * @param {ReturnType<import('./api.js').createApi>} api
 * @param {{roots: {n: number, name: string, kind: string, files: {rel: string, file: Blob}[]}[]}} walked
 * @param {{concurrency?: number, signal?: AbortSignal|null, onProgress?: (p: {done: number, total: number,
 *   bytes: number, totalBytes: number, item: string|null}) => void}} [o]
 */
export async function sendDrop(api, walked, { concurrency = CONCURRENCY, signal = null, onProgress = () => {} } = {}) {
  const queue = walked.roots.flatMap(r => r.files.map(f => ({ n: r.n, rel: f.rel, file: f.file })));
  const total = queue.length;
  const totalBytes = queue.reduce((a, q) => a + ((q.file && q.file.size) || 0), 0);
  if (signal && signal.aborted) throw abortError();
  const { drop } = await api.dropStart({ signal });
  const stop = new AbortController();
  const onAbort = () => stop.abort();
  if (signal) {
    if (signal.aborted) stop.abort();                        // stopped as the drop was made: nothing is sent
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  let next = 0, done = 0, bytes = 0, failure = null;
  onProgress({ done, total, bytes, totalBytes, item: null });
  const worker = async () => {
    while (!failure && !stop.signal.aborted && next < queue.length) {
      const q = queue[next++];
      try {
        await api.dropPut(drop, q.n, q.rel, q.file, { signal: stop.signal });
      } catch (e) {
        if (!failure) failure = e;
        stop.abort();
        return;
      }
      done++;
      bytes += (q.file && q.file.size) || 0;
      onProgress({ done, total, bytes, totalBytes, item: q.rel });
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, worker));
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
  const cancel = async () => {
    try {
      await api.dropCancel(drop);
    } catch (e) { /* the program deletes the run folder at its end anyway */ }
  };
  if (failure || stop.signal.aborted) {
    const stopped = (signal && signal.aborted) || !failure;
    if (stopped) cancel();                                   // not waited for: a stop is said at once
    else await cancel();
    throw stopped ? abortError() : failure;
  }
  try {
    return await api.dropDone(drop, walked.roots.map(r => ({ n: r.n, name: r.name, kind: r.kind })), { signal });
  } catch (e) {
    // stopped while it waited: an inspection that started may be reading the files, which go with the run folder
    if (e && e.name === 'AbortError') throw e;
    await cancel();                                          // no inspection (busy): the sent files are of no use
    throw e;
  }
}
