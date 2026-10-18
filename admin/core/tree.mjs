// Folders as tools/index_site.py and tools/add_ghost.py walk them: os.walk top-down (each folder's files, then its
// sub-folders one after another), names in Python's sorted() order (code points), unreadable folders skipped as
// os.walk skips them. Links: a linked file is followed for the index, as os.walk and getsize follow it; a linked
// folder is never entered (os.walk's followlinks=False; a junction, which Python enters, is not entered here either).
// add_ghost's source listing never follows a link at all (reported as left out): a copy must not reach outside the
// ghost folder. A tree is removed without following a link either (removeTree): a junction is removed as a link.
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { sortedPy } from './py.mjs';
import { isSkipDir, skipCode } from './rules.mjs';
import { message } from './codes.mjs';

/** A folder's entries as os.walk splits them: {dirs, files} of names (sorted), and `links` (name -> 'dir'|'file'). */
export function scan(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return null;                         // os.walk's onerror=None: an unreadable folder is skipped
  }
  const dirs = [], files = [], links = new Map();
  for (const e of ents) {
    if (e.isSymbolicLink()) {
      let st = null;
      try { st = fs.statSync(path.join(dir, e.name)); } catch (err) { st = null; }
      const isDir = !!(st && st.isDirectory());
      links.set(e.name, isDir ? 'dir' : 'file');
      (isDir ? dirs : files).push(e.name);
    } else if (e.isDirectory()) {
      if (isLink(path.join(dir, e.name))) {             // a junction a runtime reports as a folder
        links.set(e.name, 'dir');
      }
      dirs.push(e.name);
    } else files.push(e.name);
  }
  return { dirs: sortedPy(dirs), files: sortedPy(files), links };
}

/**
 * A link of any kind (symbolic link, junction): lstat says so, or a folder answers readlink (Node reports a junction as
 * a link, another runtime may report it as a folder; readlink fails on a real folder).
 */
export function isLink(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch (e) {
    return false;
  }
  if (st.isSymbolicLink()) return true;
  if (!st.isDirectory()) return false;
  try {
    fs.readlinkSync(p);
    return true;
  } catch (e) {
    return false;
  }
}

/** os.listdir sorted (any entry kind), or [] when the folder cannot be listed. */
export function listdir(dir) {
  try {
    return sortedPy(fs.readdirSync(dir));
  } catch (e) {
    return [];
  }
}

export function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch (e) { return false; }
}

export function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

/**
 * os.walk(root) top-down: yields {rel ('' for the root), dirs, files, links}; `prune(name, rel)` drops a sub-folder
 * before it is entered (add_ghost's SKIP_DIRS). Linked folders are listed in `dirs` but never entered.
 */
export function* walk(root, prune = null) {
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const s = scan(rel ? path.join(root, ...rel.split('/')) : root);
    if (!s) continue;
    if (prune) s.dirs = s.dirs.filter(d => !prune(d, rel));
    yield { rel, ...s };
    for (let i = s.dirs.length - 1; i >= 0; i--) {
      if (s.links.has(s.dirs[i])) continue;
      stack.push(rel ? `${rel}/${s.dirs[i]}` : s.dirs[i]);
    }
  }
}

/** width, height from a PNG's IHDR (PNA masks too), or null; a header cut short fails as struct.unpack fails. */
export function pngSize(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(24);
    const n = fs.readSync(fd, head, 0, 24, 0);
    const h = head.subarray(0, n);
    if (h.subarray(1, 4).toString('latin1') !== 'PNG' || h.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
    if (n < 24) throw new Error(`${file}: a PNG header cut short (index_site.py png_size fails on it too)`);
    return [h.readUInt32BE(16), h.readUInt32BE(20)];
  } finally {
    fs.closeSync(fd);
  }
}

/** index_site.py file_list: [[rel, size, w?, h?]] in os.walk order, PNG and PNA sizes from their header. */
export function fileList(root) {
  const out = [];
  for (const { rel, files } of walk(root)) {
    for (const f of files) {
      const p = rel ? path.join(root, ...rel.split('/'), f) : path.join(root, f);
      const entry = [rel ? `${rel}/${f}` : f, fs.statSync(p).size];
      const low = f.toLowerCase();
      if (low.endsWith('.png') || low.endsWith('.pna')) {
        const wh = pngSize(p);
        if (wh) entry.push(...wh);
      }
      out.push(entry);
    }
  }
  return out;
}

const left = (p, code, params) => ({ path: p, code, ...(params ? { params } : {}), why: message(code, params || {}) });

/**
 * add_ghost.py source_files: {folders, files} to copy, ghost-root-relative ('.' for the root folder), personal folders
 * never entered; plus `excluded` [{path, code, params?, why}] for the admin's view (a folder path ends with '/') and
 * `sizes` (rel -> bytes) of the files to copy. A link is left out (not in Python's listing rule: see the head of this
 * file).
 */
export function sourceFiles(src) {
  const folders = [], files = [], excluded = [], sizes = new Map();
  for (const { rel, dirs, files: names, links } of walk(src, (d, r) => {
    if (!isSkipDir(d)) return false;
    excluded.push(left(`${r ? r + '/' : ''}${d}/`, 'personal.profile'));
    return true;
  })) {
    folders.push(rel || '.');
    for (const d of dirs) {
      if (links.get(d) === 'dir') excluded.push(left(`${rel ? rel + '/' : ''}${d}/`, 'link.folder'));
    }
    for (const f of names) {
      const p = rel ? `${rel}/${f}` : f;
      if (links.has(f)) {
        excluded.push(left(p, 'link.file'));
        continue;
      }
      const skip = skipCode(p);
      if (skip) {
        excluded.push(left(p, skip.code, skip.params));
        continue;
      }
      files.push(p);
      sizes.set(p, fs.statSync(path.join(src, ...p.split('/'))).size);
    }
  }
  return { folders, files, excluded, sizes };
}

/**
 * add_ghost.py copy_tree: every folder made (empty ones too), every file copied (data only, as shutil.copyfile).
 * tick(done, total, rel): progress per file.
 */
export function copyTree(src, dst, folders, files, tick = () => {}) {
  for (const d of folders) fs.mkdirSync(d === '.' ? dst : path.join(dst, ...d.split('/')), { recursive: true });
  files.forEach((p, i) => {
    tick(i, files.length, p);
    const to = path.join(dst, ...p.split('/'));
    fs.copyFileSync(path.join(src, ...p.split('/')), to);
    const st = fs.statSync(to);
    if (!(st.mode & 0o200)) fs.chmodSync(to, st.mode | 0o200);      // copyfile never copies a read-only flag
  });
  tick(files.length, files.length, null);
  return files.length;
}

/**
 * Removes a file or folder tree without ever following a link: a symbolic link or junction (at the top too) is removed
 * as a link, what it points to stays; read-only files go too. tick(done): progress per entry removed.
 */
export function removeTree(p, tick = () => {}) {
  let done = 0;
  const unlinkLink = q => {
    try {
      fs.unlinkSync(q);
    } catch (e) {
      fs.rmdirSync(q);                   // a directory link some runtimes unlink only as a folder (not followed)
    }
  };
  const rm = q => {
    let st;
    try {
      st = fs.lstatSync(q);
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    if (isLink(q)) unlinkLink(q);
    else if (st.isDirectory()) {
      for (const name of fs.readdirSync(q)) rm(path.join(q, name));
      fs.rmdirSync(q);
    } else {
      try {
        fs.unlinkSync(q);
      } catch (e) {
        if (e.code !== 'EPERM' && e.code !== 'EACCES') throw e;
        fs.chmodSync(q, 0o666);
        fs.unlinkSync(q);
      }
    }
    tick(++done);
  };
  rm(p);
  return done;
}
