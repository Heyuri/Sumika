// SSP's any-extension image lookup [disasm SPUtils::RemoveExtensionFromFileName 0x7892b0 (2.9.10),
// SPSurface::FindLoadableExtension 0x756b50 (2.9.10) / 0x77d3f0 (2.9.10.3000)]: an image written without its
// extension, or with any, is the first file of `<name>.*` whose extension is an image's. Used for shell element files
// (SPSurfaceManager::LoadInfo calls it [disasm 2.9.10.3000 0x778443]), dress-up thumbnails and banners. Pure.

// JLibGra's image extensions [disasm 2.9.10 table 0xb87910] (= tools/index_site.py THUMB_EXT): 'tif' and 'mdi' match
// as a prefix; 'exe' / 'dll' (icons in a program, code 12) never count
const IMAGE_EXT = new Set(['png', 'pnr', 'apng', 'apnr', 'dgp', 'dfp', 'ddp', 'dap', 'webp', 'gif', 'jpg', 'jpeg', 'jpe',
  'jfif', 'jfi', 'jif', 'pjpeg', 'pjp', 'bmp', 'dib', 'rle', 'btf', 'tf8', 'ico', 'cur', 'mag', 'pi', 'xbm', 'xpm', 'tga',
  'targa', 'vda', 'icb', 'vst', 'pbm', 'pgm', 'ppm', 'pam', 'pnm', 'pfm', 'pcx', 'qoi', 'psd', 'psp', 'pspimage', 'ora',
  'kra', 'krz', 'clip', 'lip', 'xcf']);
const IMAGE_EXT_PREFIX = ['tif', 'mdi'];

/**
 * JLibGra::IsLoadableExtension on an extension (no dot) [disasm 0x560710]: each UTF-16 unit cut to its low byte (a
 * full-width 'ｒ' reads 'r'), at most 15, up to a 0 byte, ASCII lower-cased.
 */
export function imageExt(ext) {
  let s = '';
  for (let i = 0; i < String(ext).length && i < 15; i++) {
    const c = String(ext).charCodeAt(i) & 0xff;
    if (!c) break;
    s += String.fromCharCode(c >= 0x41 && c <= 0x5a ? c + 32 : c);
  }
  return IMAGE_EXT.has(s) || IMAGE_EXT_PREFIX.some(p => s.startsWith(p));
}

/** Windows' order of the names FindFirstFile returns on NTFS: upper-cased [infer], as index_site.py sorts them. */
const ntfsOrder = (a, b) => {
  const A = a.toUpperCase(), B = b.toUpperCase();
  return A < B ? -1 : A > B ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/**
 * The extension FindLoadableExtension reads from a found name [disasm 0x756c0f]: 3 characters after a '.' 4 from the
 * end, else 2 after a '.' 3 from the end, else the last 4 (a name of 4 or more). null for a name too short.
 */
function foundExt(name) {
  const L = name.length, p = L - 3;
  if (p < 1) return null;
  if (name[p - 1] === '.') return name.slice(p);
  if (name[p] === '.') return name.slice(p + 1);
  return L >= 4 ? name.slice(p - 1) : name.slice(p);
}

const leaf = r => r.slice(r.lastIndexOf('/') + 1);

/**
 * The lookup over a folder's listing: the extension after the last '.' of the path's last segment goes; the first
 * entry of `<rest>.*` (any case) in NTFS order whose extension (foundExt) is an image's is it.
 * @param {string[]} names the entries of the path's folder, as paths with '/' (only their last segments are compared)
 * @param {string} path with '/'
 * @returns {string|null} the matching entry as given
 */
export function pickLoadable(names, path) {
  const base = leaf(String(path));
  const dot = base.lastIndexOf('.');
  const stem = (dot >= 0 ? base.slice(0, dot) : base).toLowerCase();
  if (!stem) return null;
  const hits = names
    .filter(r => { const n = leaf(r).toLowerCase(); return n === stem || n.startsWith(stem + '.'); })
    .sort((a, b) => ntfsOrder(leaf(a), leaf(b)));
  for (const r of hits) {
    const ext = foundExt(leaf(r));
    if (ext !== null && imageExt(ext)) return r;
  }
  return null;
}
