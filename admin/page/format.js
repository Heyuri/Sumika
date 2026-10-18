// Small formatting helpers of the admin page. Pure.

/** A folder's separator as its path writes it: '\' for Windows paths (drive letters, UNC), else '/'. */
export const sepOf = p => (/^[A-Za-z]:|\\/.test(String(p)) ? '\\' : '/');

/** A child path of a folder the program listed (its own form: 'C:\\', 'C:\\x', '/', '/x'). */
export function joinPath(dir, name) {
  const d = String(dir);
  const sep = sepOf(d);
  return d.endsWith(sep) || d.endsWith('/') ? d + name : d + sep + name;
}

/** The last segment of a path ('C:\\a\\b' → 'b'; a root stays as it is). */
export function baseName(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i < 0 || i === s.length - 1 ? String(p) : s.slice(i + 1);
}

/** The folder a path is in ('C:\\a\\b' → 'C:\\a', 'C:\\a' → 'C:\\', '/a' → '/'), or null for a root. */
export function parentOf(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  if (i < 0) return null;
  const head = s.slice(0, i);
  if (/^[A-Za-z]:$/.test(head)) return `${head}\\`;
  return head || (s.startsWith('/') ? '/' : null);
}

/** The ledger prune keeps beside a site folder (tools/prune.mjs ledgerPath: `<DIR>.published.json`). */
export const ledgerName = site => `${baseName(site)}.published.json`;

const UNITS = [['gigabyte', 1e9], ['megabyte', 1e6], ['kilobyte', 1e3]];

/** A size in bytes in the language's number format ("12.3 MB"; decimal units, as Explorer's MB rounding aside). */
export function formatBytes(n, lang = 'en') {
  const v = Number(n) || 0;
  const [unit, div] = UNITS.find(([, d]) => v >= d) || ['byte', 1];
  const x = v / div;
  const digits = unit === 'byte' || x >= 100 ? 0 : 1;
  try {
    return new Intl.NumberFormat(lang === 'ja' ? 'ja-JP' : 'en-US',
      { style: 'unit', unit, unitDisplay: unit === 'byte' ? 'long' : 'short', maximumFractionDigits: digits }).format(x);
  } catch (e) {
    const short = { gigabyte: 'GB', megabyte: 'MB', kilobyte: 'kB', byte: 'B' }[unit];
    return `${x.toFixed(digits)} ${short}`;
  }
}
