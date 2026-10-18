// Drag-and-drop uploads (CONTRACTS "Admin API"): the page reads what was dropped (a ghost folder, a folder of ghosts, a
// .nar / .zip), sends each file it would copy with its own PUT, and then names the dropped roots; each root becomes a
// source of an inspect job. Files land in the run folder, `r-…/drops/<drop>/<n>/<rel>` (n: the dropped root's number,
// rel: its path with the root's name first), each made with 'wx' (never over another), every path through
// safeRelPath and checked to stay inside the drop. No size or count cap; a write error (a full disk) deletes the drop.
// A drop's folder goes when it is cancelled, when an add used it, or with the run folder.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { removeTree } from '../core/tree.mjs';
import { ApiError } from './codes.mjs';
import { safeRelPath, inside } from './paths.mjs';

export const DROP_ID = /^[0-9a-f]{16}$/;
const N = /^(0|[1-9][0-9]{0,8})$/;

export class Drops {
  /** @param {string} runDir the run folder (its drops/ holds one folder per drop) */
  constructor(runDir) {
    this.root = path.join(runDir, 'drops');
    fs.mkdirSync(this.root, { recursive: true });
    this.map = new Map();
  }

  /** A new drop: its id. */
  create() {
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(this.root, id);
    fs.mkdirSync(dir);
    this.map.set(id, { id, dir, closed: false, files: 0 });
    return id;
  }

  get(id) {
    const d = DROP_ID.test(id) ? this.map.get(id) : null;
    if (!d) throw new ApiError(404, 'drop-missing');
    return d;
  }

  /**
   * One dropped file: its bytes (a web ReadableStream, or null for an empty file) to `<n>/<rel>`.
   * @param {string} id
   * @param {string} n the dropped root's number
   * @param {string|null} header X-Sumika-Path: encodeURIComponent of the '/'-separated path, the root's name first
   * @param {ReadableStream<Uint8Array>|null} body
   */
  async put(id, n, header, body) {
    const d = this.get(id);
    if (d.closed) throw new ApiError(409, 'drop-closed');
    let rel = null;
    try {
      rel = header == null ? null : decodeURIComponent(header);
    } catch (e) {
      rel = null;
    }
    const segs = N.test(n) ? safeRelPath(rel) : null;
    if (!segs) throw new ApiError(400, 'drop-bad-path', { path: String(rel ?? header ?? '') });
    const target = path.join(d.dir, n, ...segs);
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (e) {
      throw new ApiError(409, 'drop-exists', { path: rel });      // a file sent where a folder of this path is
    }
    if (!inside(d.dir, target)) throw new ApiError(400, 'drop-bad-path', { path: rel });
    let fh;
    try {
      fh = await fs.promises.open(target, 'wx');
    } catch (e) {
      if (e.code === 'EEXIST') throw new ApiError(409, 'drop-exists', { path: rel });
      this.fail(id);
      throw new ApiError(500, 'drop-write', { error: e.code || e.message });
    }
    try {
      if (body) {
        for await (const chunk of body) await fh.write(chunk);
      }
    } catch (e) {
      await fh.close().catch(() => {});
      this.fail(id);
      throw new ApiError(500, 'drop-write', { error: e.code || e.message });
    }
    await fh.close();
    d.files++;
  }

  /**
   * The drop is complete: its roots as inspect sources [{path, archive: null, dropped: {name}}]. A dropped folder
   * none of whose files was sent (the page sends only what a copy would take) is made empty, so the inspect says
   * what it is not; a dropped file that never arrived is refused.
   * @param {string} id
   * @param {{n: number, name: string, kind: 'dir'|'file'}[]} roots
   */
  done(id, roots) {
    const d = this.get(id);
    if (d.closed) throw new ApiError(409, 'drop-closed');
    if (!Array.isArray(roots) || !roots.length) throw new ApiError(400, 'bad-request', { detail: 'roots must be a non-empty list' });
    const sources = [];
    for (const r of roots) {
      const n = r && Number.isInteger(r.n) && r.n >= 0 ? String(r.n) : null;
      const segs = r && typeof r.name === 'string' ? safeRelPath(r.name) : null;
      if (!n || !segs || segs.length !== 1 || (r.kind !== 'dir' && r.kind !== 'file')) {
        throw new ApiError(400, 'drop-bad-root', { name: String(r && r.name) });
      }
      const p = path.join(d.dir, n, r.name);
      let st = null;
      try { st = fs.lstatSync(p); } catch (e) { st = null; }
      if (r.kind === 'dir' && !st) fs.mkdirSync(p, { recursive: true });
      else if (!st || (r.kind === 'dir' ? !st.isDirectory() : !st.isFile())) throw new ApiError(400, 'drop-bad-root', { name: r.name });
      sources.push({ path: p, archive: null, dropped: { name: r.name } });
    }
    d.closed = true;
    return sources;
  }

  /** Deletes a drop's files (cancel, or a failed write); its id is gone. */
  fail(id) {
    const d = this.map.get(id);
    if (!d) return;
    this.map.delete(id);
    try { removeTree(d.dir); } catch (e) { /* the run folder goes at the end anyway */ }
  }

  cancel(id) {
    this.get(id);
    this.fail(id);
  }

  /** The drop a path lies in (an inspect source of it), or null. */
  dropOf(p) {
    for (const d of this.map.values()) if (inside(d.dir, p)) return d.id;
    return null;
  }
}
