// Win32 ROP2 raster operations named by cursor/anchor blendmethods (BA §3.8, SUM C13). Pure.
// Each mode is a per-channel function of P (the brush colour) and D (the pixel already drawn). SSP 2.9 draws only the
// pen of a cursor whose blendmethod is a ROP, so the painter applies them only on request (Painter.ropFill).

export const ROP2 = {
  black: () => 0,
  notmergepen: (p, d) => ~(p | d) & 255,
  masknotpen: (p, d) => ~p & d & 255,
  notcopypen: p => ~p & 255,
  maskpennot: (p, d) => p & ~d & 255,
  not: (p, d) => ~d & 255,
  xorpen: (p, d) => (p ^ d) & 255,
  notmaskpen: (p, d) => ~(p & d) & 255,
  maskpen: (p, d) => p & d,
  notxorpen: (p, d) => ~(p ^ d) & 255,
  nop: (p, d) => d,
  mergenotpen: (p, d) => (~p | d) & 255,
  copypen: p => p,
  mergepennot: (p, d) => (p | ~d) & 255,
  mergepen: (p, d) => (p | d) & 255,
  white: () => 255,
};

/** Normalise a mode name ('R2_NOTMASKPEN', 'notmaskpen' ...); unknown names give null. */
export function ropMode(name) {
  const s = String(name || '').trim().toLowerCase().replace(/^r2_/, '');
  return Object.prototype.hasOwnProperty.call(ROP2, s) ? s : null;
}

/**
 * A cursor/anchor blendmethod (descript `*.blendmethod`, \f[*method,...]): 'none' for plain painting (copypen, the
 * brush as it is, is the same thing), otherwise the ROP2 mode name; unknown names give null (BA §2.3, §3.8).
 */
export function blendMethod(name) {
  const s = String(name ?? '').trim().toLowerCase();
  if (s === 'none') return 'none';
  const m = ropMode(s);
  return m === 'copypen' ? 'none' : m;
}

const tableCache = new Map();

/** Three 256-entry lookup tables (R, G, B) for a mode and brush colour. */
export function ropTables(mode, brush) {
  const key = mode + ':' + brush.join(',');
  let t = tableCache.get(key);
  if (!t) {
    const f = ROP2[mode] || ROP2.nop;
    t = [0, 1, 2].map(c => {
      const a = new Uint8Array(256);
      for (let d = 0; d < 256; d++) a[d] = f(brush[c], d);
      return a;
    });
    if (tableCache.size > 64) tableCache.clear();
    tableCache.set(key, t);
  }
  return t;
}

/** Apply a ROP to RGBA pixels in place (alpha untouched, so transparent pixels stay transparent). */
export function applyRop(data, mode, brush) {
  const [tr, tg, tb] = ropTables(mode, brush);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = tr[data[i]];
    data[i + 1] = tg[data[i + 1]];
    data[i + 2] = tb[data[i + 2]];
  }
  return data;
}
