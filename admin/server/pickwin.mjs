// The Windows file and folder dialog (CLAUDE.md "The admin tool": the system's own
// dialogs): IFileOpenDialog called by hand through Deno FFI (no addon, no PowerShell), in a node:worker_threads
// worker of its own, because Show() blocks its thread until the dialog closes while the server's thread goes on
// answering. One worker per dialog (picker.mjs windowsPicker): workerData {pick: {title, start, folders, multi, filters:
// [{name, spec}], guid}, flag: SharedArrayBuffer (non-zero: cancelled before Show)} → {type: 'owner', hwnd, thread}
// once the owner window exists, then one {type: 'done', paths} | {type: 'canceled'} | {type: 'error', error}.
// Bundled on its own (admin/build/pickwin.mjs) and embedded with --include, as job.mjs.
// In front of the browser [decision]: a background process cannot take the foreground, so the dialog's owner
// is a hidden WS_EX_TOPMOST popup laid over the browser's window (GetForegroundWindow at the request; an owned window
// stays above its owner), and the thread borrows the browser thread's input state (AttachThreadInput) for one
// SetForegroundWindow on it, so the dialog that Show() activates gets the keyboard; the browser gets it back after
// (never a UWP window's input: NO_BORROW).
// Every slot and layout below is the Windows SDK's (shobjidl_core.h, winuser.h).
import { parentPort, workerData } from 'node:worker_threads';

export const SYSTEM32 = 'C:\\Windows\\System32';
/**
 * The DLLs the dialog needs, by full path, so no DLL of the same name elsewhere is ever loaded (--allow-ffi itself is
 * whole: admin/build.mjs). A Windows installed elsewhere has no dialog: dlopen fails, the page uses its file browser.
 */
export const DLLS = Object.freeze(['ole32.dll', 'shell32.dll', 'user32.dll', 'kernel32.dll'].map(n => `${SYSTEM32}\\${n}`));
const [OLE32, SHELL32, USER32, KERNEL32] = DLLS;

export const CLSID_FileOpenDialog = 'DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7';
export const IID_IFileOpenDialog = 'd57c7288-d4ad-4768-be02-9d969532d960';
export const IID_IShellItem = '43826d1e-e718-42ee-bc55-a1e261c37bfe';

/** HRESULT_FROM_WIN32(ERROR_CANCELLED): Show()'s answer when the dialog was cancelled (Cancel, Esc, the X, WM_CLOSE). */
export const E_CANCELLED = 0x800704C7;
const COINIT_APARTMENTTHREADED = 0x2, COINIT_DISABLE_OLE1DDE = 0x4;
const CLSCTX_INPROC_SERVER = 0x1;
/** FILEOPENDIALOGOPTIONS (shobjidl_core.h). */
export const FOS = Object.freeze({
  NOCHANGEDIR: 0x8, PICKFOLDERS: 0x20, FORCEFILESYSTEM: 0x40, ALLOWMULTISELECT: 0x200, PATHMUSTEXIST: 0x800,
  FILEMUSTEXIST: 0x1000,
});
const SIGDN_FILESYSPATH = 0x80058000;

// vtable slots: IUnknown 0–2, IModalWindow 3, IFileDialog 4–26, IFileOpenDialog 27–28 (shobjidl_core.h)
const DLG = Object.freeze({
  Release: 2, Show: 3, SetFileTypes: 4, SetFileTypeIndex: 5, SetOptions: 9, GetOptions: 10, SetFolder: 12, SetTitle: 17,
  SetClientGuid: 24, GetResults: 27,
});
const ITEM = Object.freeze({ Release: 2, GetDisplayName: 5 });           // IShellItem
const ARRAY = Object.freeze({ Release: 2, GetCount: 7, GetItemAt: 8 });  // IShellItemArray

const WS_POPUP = 0x80000000, WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80;
const MONITOR_DEFAULTTONEAREST = 2, MONITOR_DEFAULTTOPRIMARY = 1;
const WM_CLOSE = 0x10;
// DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2: the dialog drawn sharp on a scaled screen, not stretched (Windows 10 1703+)
const PER_MONITOR_AWARE_V2 = -4n;

/** A GUID's 16 bytes as Windows lays them out: Data1 (LE u32), Data2, Data3 (LE u16), Data4 as written. */
export function guidBytes(text) {
  const m = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(String(text));
  if (!m) throw new Error(`not a GUID: ${text}`);
  const b = new Uint8Array(16);
  const v = new DataView(b.buffer);
  v.setUint32(0, parseInt(m[1], 16), true);
  v.setUint16(4, parseInt(m[2], 16), true);
  v.setUint16(6, parseInt(m[3], 16), true);
  const tail = m[4] + m[5];
  for (let i = 0; i < 8; i++) b[8 + i] = parseInt(tail.slice(i * 2, i * 2 + 2), 16);
  return b;
}

/** A text as a NUL-terminated UTF-16 string (LPCWSTR). */
export function wide(text) {
  const s = String(text);
  const a = new Uint16Array(s.length + 1);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}

/** The dialog's options: its own defaults (GetOptions) and the request's. */
export function dialogOptions(defaults, { folders = false, multi = false } = {}) {
  let o = (defaults | FOS.FORCEFILESYSTEM | FOS.PATHMUSTEXIST | FOS.NOCHANGEDIR) >>> 0;
  if (folders) o |= FOS.PICKFOLDERS;
  else o |= FOS.FILEMUSTEXIST;
  if (multi) o |= FOS.ALLOWMULTISELECT;
  return o >>> 0;
}

export const hex = hr => `0x${(hr >>> 0).toString(16).padStart(8, '0')}`;

const D = () => globalThis.Deno;

/** The functions the dialog needs, from the four DLLs. Throws without Deno's FFI or when a DLL may not be loaded. */
export function load() {
  const Deno = D();
  if (!Deno || typeof Deno.dlopen !== 'function') throw new Error('no FFI in this runtime');
  const ole32 = Deno.dlopen(OLE32, {
    CoInitializeEx: { parameters: ['pointer', 'u32'], result: 'i32' },
    CoUninitialize: { parameters: [], result: 'void' },
    CoCreateInstance: { parameters: ['buffer', 'pointer', 'u32', 'buffer', 'buffer'], result: 'i32' },
    CoTaskMemFree: { parameters: ['pointer'], result: 'void' },
  }).symbols;
  const shell32 = Deno.dlopen(SHELL32, {
    SHCreateItemFromParsingName: { parameters: ['buffer', 'pointer', 'buffer', 'buffer'], result: 'i32' },
  }).symbols;
  const user32 = Deno.dlopen(USER32, {
    GetForegroundWindow: { parameters: [], result: 'pointer' },
    SetForegroundWindow: { parameters: ['pointer'], result: 'i32' },
    GetWindowThreadProcessId: { parameters: ['pointer', 'buffer'], result: 'u32' },
    AttachThreadInput: { parameters: ['u32', 'u32', 'i32'], result: 'i32' },
    CreateWindowExW: {
      parameters: ['u32', 'buffer', 'buffer', 'u32', 'i32', 'i32', 'i32', 'i32', 'pointer', 'pointer', 'pointer', 'pointer'],
      result: 'pointer',
    },
    DestroyWindow: { parameters: ['pointer'], result: 'i32' },
    GetWindowRect: { parameters: ['pointer', 'buffer'], result: 'i32' },
    MonitorFromWindow: { parameters: ['pointer', 'u32'], result: 'pointer' },
    GetMonitorInfoW: { parameters: ['pointer', 'buffer'], result: 'i32' },
    IsWindowVisible: { parameters: ['pointer'], result: 'i32' },
    GetClassNameW: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
    SetThreadDpiAwarenessContext: { parameters: ['isize'], result: 'isize', optional: true },
    GetDpiForWindow: { parameters: ['pointer'], result: 'u32', optional: true },
  }).symbols;
  const kernel32 = Deno.dlopen(KERNEL32, {
    GetCurrentThreadId: { parameters: [], result: 'u32' },
    GetModuleHandleW: { parameters: ['pointer'], result: 'pointer' },
  }).symbols;
  return { ole32, shell32, user32, kernel32 };
}

/** A pointer from an out-parameter's value (null for 0). */
const ptr = v => D().UnsafePointer.create(BigInt(v));

/** Calls a COM method by its vtable slot: the object itself is the first parameter (stdcall is the x64 convention). */
function method(obj, slot, parameters, args, result = 'i32') {
  const Deno = D();
  const vtbl = new Deno.UnsafePointerView(obj).getPointer(0);
  const fn = new Deno.UnsafePointerView(vtbl).getPointer(slot * 8);
  return new Deno.UnsafeFnPointer(fn, { parameters: ['pointer', ...parameters], result }).call(obj, ...args);
}

function check(hr, what) {
  if (hr < 0) throw new Error(`${what} failed (${hex(hr)})`);
  return hr;
}

const release = (obj, slot = DLG.Release) => {
  if (obj) method(obj, slot, [], [], 'u32');
};

/** A NUL-terminated UTF-16 string at p. */
function readWide(p) {
  const v = new (D().UnsafePointerView)(p);
  const units = [];
  for (let i = 0; ; i += 2) {
    const c = v.getUint16(i);
    if (!c) break;
    units.push(c);
  }
  let s = '';
  for (let i = 0; i < units.length; i += 4096) s += String.fromCharCode(...units.slice(i, i + 4096));
  return s;
}

/**
 * A new IFileOpenDialog set up for a request: its options, file types, title, client GUID (its own remembered size and
 * place per purpose) and start folder. `keep` collects the buffers it points to (alive until it is released). No
 * window yet: the plumbing test runs this and release() with nothing on screen.
 * @returns {object} the dialog's pointer
 */
export function createDialog(w, pick, keep = []) {
  const out = new BigUint64Array(1);
  const clsid = guidBytes(CLSID_FileOpenDialog), iid = guidBytes(IID_IFileOpenDialog);
  check(w.ole32.CoCreateInstance(clsid, null, CLSCTX_INPROC_SERVER, iid, out), 'CoCreateInstance');
  const dlg = ptr(out[0]);
  try {
    const opts = new Uint32Array(1);
    check(method(dlg, DLG.GetOptions, ['buffer'], [opts]), 'GetOptions');
    check(method(dlg, DLG.SetOptions, ['u32'], [dialogOptions(opts[0], pick)]), 'SetOptions');
    const filters = !pick.folders && Array.isArray(pick.filters) ? pick.filters : [];
    if (filters.length) {
      // COMDLG_FILTERSPEC[] {LPCWSTR pszName; LPCWSTR pszSpec;}: two pointers each
      const specs = new BigUint64Array(filters.length * 2);
      filters.forEach((f, i) => {
        const name = wide(f.name), spec = wide(f.spec);
        keep.push(name, spec);
        specs[i * 2] = D().UnsafePointer.value(D().UnsafePointer.of(name));
        specs[i * 2 + 1] = D().UnsafePointer.value(D().UnsafePointer.of(spec));
      });
      keep.push(specs);
      check(method(dlg, DLG.SetFileTypes, ['u32', 'buffer'], [filters.length, specs]), 'SetFileTypes');
      check(method(dlg, DLG.SetFileTypeIndex, ['u32'], [1]), 'SetFileTypeIndex');
    }
    if (pick.title) {
      const title = wide(pick.title);
      keep.push(title);
      check(method(dlg, DLG.SetTitle, ['buffer'], [title]), 'SetTitle');
    }
    if (pick.guid) {
      const g = guidBytes(pick.guid);
      keep.push(g);
      check(method(dlg, DLG.SetClientGuid, ['buffer'], [g]), 'SetClientGuid');
    }
    if (pick.start) setFolder(w, dlg, pick.start);
    return dlg;
  } catch (e) {
    release(dlg);
    throw e;
  }
}

/** Opens the dialog in a folder; a folder that is gone is no error (the dialog's own memory then). */
function setFolder(w, dlg, folder) {
  const out = new BigUint64Array(1);
  if (w.shell32.SHCreateItemFromParsingName(wide(folder), null, guidBytes(IID_IShellItem), out) < 0) return false;
  const item = ptr(out[0]);
  try {
    return method(dlg, DLG.SetFolder, ['pointer'], [item]) >= 0;
  } finally {
    release(item, ITEM.Release);
  }
}

/** The chosen paths (an item with no file-system path is left out). */
function results(w, dlg) {
  const out = new BigUint64Array(1);
  check(method(dlg, DLG.GetResults, ['buffer'], [out]), 'GetResults');
  const arr = ptr(out[0]);
  try {
    const n = new Uint32Array(1);
    check(method(arr, ARRAY.GetCount, ['buffer'], [n]), 'GetCount');
    const paths = [];
    for (let i = 0; i < n[0]; i++) {
      const o = new BigUint64Array(1);
      if (method(arr, ARRAY.GetItemAt, ['u32', 'buffer'], [i, o]) < 0) continue;
      const item = ptr(o[0]);
      try {
        const s = new BigUint64Array(1);
        if (method(item, ITEM.GetDisplayName, ['u32', 'buffer'], [SIGDN_FILESYSPATH, s]) < 0 || !s[0]) continue;
        try {
          paths.push(readWide(ptr(s[0])));
        } finally {
          w.ole32.CoTaskMemFree(ptr(s[0]));
        }
      } finally {
        release(item, ITEM.Release);
      }
    }
    return paths;
  } finally {
    release(arr, ARRAY.Release);
  }
}

/**
 * Where the owner goes: the dialog opens at its hidden owner's top-left corner [measured: (0, 0) under a
 * maximized browser], so the owner is a dialog-sized rectangle centred on the browser's window (clipped to its
 * monitor's work area), the dialog's default size (768 × 480 at 96 dpi [measured]) scaled to that monitor. Pure.
 * @param {number[]} work the monitor's work area [left, top, right, bottom]
 * @param {number[]|null} browser the foreground window's rectangle, or null
 * @returns {number[]} [x, y, width, height]
 */
export function ownerPlace(work, browser, dpi = 96) {
  let [left, top, right, bottom] = work;
  if (browser) {
    left = Math.max(left, browser[0]);
    top = Math.max(top, browser[1]);
    right = Math.max(left + 1, Math.min(right, browser[2]));
    bottom = Math.max(top + 1, Math.min(bottom, browser[3]));
  }
  const s = (Number(dpi) || 96) / 96;
  const w = Math.min(Math.round(768 * s), work[2] - work[0]), h = Math.min(Math.round(480 * s), work[3] - work[1]);
  const x = Math.max(work[0], Math.min(work[2] - w, Math.round((left + right - w) / 2)));
  const y = Math.max(work[1], Math.min(work[3] - h, Math.round((top + bottom - h) / 2)));
  return [x, y, w, h];
}

/**
 * The owner window: a hidden topmost tool popup over the foreground window (the browser), on the primary monitor when
 * nothing is in the foreground (ownerPlace). {hwnd, foreground}.
 */
export function ownerWindow(w, title = '') {
  const u = w.user32;
  const fg = u.GetForegroundWindow();
  const mi = new Int32Array(10);                               // MONITORINFO: cbSize, rcMonitor, rcWork, dwFlags
  mi[0] = 40;
  const mon = u.MonitorFromWindow(fg, fg ? MONITOR_DEFAULTTONEAREST : MONITOR_DEFAULTTOPRIMARY);
  const work = mon && u.GetMonitorInfoW(mon, mi) ? [mi[5], mi[6], mi[7], mi[8]] : [0, 0, 1024, 768];
  const r = new Int32Array(4);
  const browser = fg && u.IsWindowVisible(fg) && u.GetWindowRect(fg, r) ? [...r] : null;
  const dpi = fg && u.GetDpiForWindow ? u.GetDpiForWindow(fg) : 96;
  const [x, y, cx, cy] = ownerPlace(work, browser, dpi);
  const hwnd = u.CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, wide('STATIC'), wide(title), WS_POPUP, x, y, cx, cy,
    null, null, w.kernel32.GetModuleHandleW(null), null);
  if (!hwnd) throw new Error('CreateWindowExW failed');
  return { hwnd, foreground: fg };
}

/** Windows' own app windows, whose input state is never borrowed (the lock screen's is LockApp's CoreWindow). */
export const NO_BORROW = Object.freeze(['Windows.UI.Core.CoreWindow', 'ApplicationFrameWindow']);

/**
 * Our thread takes the foreground for its hidden owner, through the foreground thread's input state; not from a UWP
 * window: with the lock screen in front, a dialog whose thread had borrowed LockApp's input took no posted message at
 * all (no OK, no WM_CLOSE), and the same dialog without it answered [measured].
 */
function takeForeground(w, owner, fg) {
  const u = w.user32;
  const me = w.kernel32.GetCurrentThreadId();
  const name = new Uint16Array(64);
  const cls = fg ? String.fromCharCode(...name.subarray(0, Math.max(0, u.GetClassNameW(fg, name, name.length)))) : '';
  if (NO_BORROW.includes(cls)) return false;
  const theirs = fg ? u.GetWindowThreadProcessId(fg, null) : 0;
  const attached = theirs && theirs !== me ? u.AttachThreadInput(me, theirs, 1) !== 0 : false;
  try {
    return u.SetForegroundWindow(owner) !== 0;
  } finally {
    if (attached) u.AttachThreadInput(me, theirs, 0);
  }
}

/**
 * Shows the dialog for a request and waits for it to close (this thread is blocked meanwhile).
 * @param {object} pick {title, start, folders, multi, filters, guid}
 * @param {{onOwner?: (o: {hwnd: string, thread: number}) => void, canceled?: () => boolean}} [o]
 * @returns {{paths: string[]} | {canceled: true}}
 */
export function showDialog(pick, { onOwner = () => {}, canceled = () => false } = {}) {
  const w = load();
  if (w.user32.SetThreadDpiAwarenessContext) w.user32.SetThreadDpiAwarenessContext(PER_MONITOR_AWARE_V2);
  check(w.ole32.CoInitializeEx(null, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE), 'CoInitializeEx');
  const keep = [];
  let dlg = null, owner = null;
  try {
    dlg = createDialog(w, pick, keep);
    owner = ownerWindow(w, pick.title || '');
    onOwner({ hwnd: String(D().UnsafePointer.value(owner.hwnd)), thread: w.kernel32.GetCurrentThreadId() });
    if (canceled()) return { canceled: true };
    takeForeground(w, owner.hwnd, owner.foreground);
    const hr = method(dlg, DLG.Show, ['pointer'], [owner.hwnd]);
    if ((hr >>> 0) === E_CANCELLED) return { canceled: true };
    check(hr, 'Show');
    return { paths: results(w, dlg) };
  } finally {
    if (owner) {
      // the dialog was in the foreground, so this thread may hand it back to the browser
      if (owner.foreground) w.user32.SetForegroundWindow(owner.foreground);
      w.user32.DestroyWindow(owner.hwnd);
    }
    release(dlg);
    w.ole32.CoUninitialize();
  }
}

/**
 * The server thread's side of a cancel: WM_CLOSE to each dialog window (#32770: the file dialog, a message box over
 * it) of the dialog's thread, which makes Show() answer E_CANCELLED. Posted, never sent: nothing here waits for the
 * dialog's thread. Returns how many were posted.
 */
export function closeDialogs(thread, w = null) {
  const Deno = D();
  const u = w || Deno.dlopen(USER32, {
    EnumThreadWindows: { parameters: ['u32', 'function', 'isize'], result: 'i32' },
    GetClassNameW: { parameters: ['pointer', 'buffer', 'i32'], result: 'i32' },
    PostMessageW: { parameters: ['pointer', 'u32', 'usize', 'isize'], result: 'i32' },
  });
  let posted = 0;
  const name = new Uint16Array(64);
  const cb = new Deno.UnsafeCallback({ parameters: ['pointer', 'isize'], result: 'i32' }, hwnd => {
    const n = u.symbols.GetClassNameW(hwnd, name, name.length);
    if (n === 6 && String.fromCharCode(...name.subarray(0, 6)) === '#32770' && u.symbols.PostMessageW(hwnd, WM_CLOSE, 0n, 0n)) posted++;
    return 1;
  });
  try {
    u.symbols.EnumThreadWindows(thread, cb.pointer, 0n);
  } finally {
    cb.close();
    if (!w) u.close();
  }
  return posted;
}

// the worker: one dialog, then its answer
if (parentPort && workerData && workerData.pick) {
  const flag = workerData.flag ? new Int32Array(workerData.flag) : null;
  try {
    const r = showDialog(workerData.pick, {
      onOwner: o => parentPort.postMessage({ type: 'owner', ...o }),
      canceled: () => !!flag && Atomics.load(flag, 0) !== 0,
    });
    parentPort.postMessage(r.canceled ? { type: 'canceled' } : { type: 'done', paths: r.paths });
  } catch (e) {
    parentPort.postMessage({ type: 'error', error: String((e && e.message) || e) });
  }
}
