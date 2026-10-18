// Balloon descript.txt semantics (pure): coordinate rules, derived text geometry, default font and cursor styles.
// BA §1.4–§2. A "cfg" is a Map of lower-cased descript keys, already merged (descript.txt ⊕ <image>s.txt).
import { cfgColor } from './color.js';
import { blendMethod } from './rop.js';

/**
 * @typedef {import('./color.js').RGB} RGB
 * @typedef {{left:number, top:number, right:number, bottom:number}} Rect
 * @typedef {object} Geometry  everything the layout engine and painter need about one balloon image
 * @property {number} width
 * @property {number} height
 * @property {number} originX    text origin in balloon-image pixels (\_l[0,0])
 * @property {number} originY
 * @property {number} lineLimit  wrap point in text space (min(wordwrappoint.x, validRect.right) − origin.x)
 * @property {Rect} validRect    text area in balloon space: text rows outside top..bottom are clipped (its bottom is the
 *   scroll limit), inline images to the whole rect; text runs on past left and right (BA §3.9)
 * @property {{x:number,y:number}} arrow0
 * @property {{x:number,y:number}} arrow1
 * @property {{x:number,y:number}} clickwait
 * @property {{x:number|string, y:number, limit:boolean}} windowPosition
 * @property {{x:number,y:number,width:number,height:number}|null} box   communicatebox.* (input box images)
 *
 * @typedef {object} CursorStyle
 * @property {string} style    'square' | 'underline' | 'square+underline' | 'none'
 * @property {string} method   ROP2 mode name, or 'none' for plain painting (copypen is stored as 'none')
 * @property {RGB} brush
 * @property {RGB} pen
 * @property {RGB} font        text colour while highlighted (used with method 'none')
 *
 * @typedef {object} FontState
 * @property {string} name     CSS font-family list
 * @property {number} height   px
 * @property {RGB} color
 * @property {RGB|null} shadow
 * @property {string} shadowStyle 'offset' | 'outline'
 * @property {boolean} bold
 * @property {boolean} italic
 * @property {boolean} underline
 * @property {boolean} strike
 * @property {boolean} outline
 * @property {boolean} sub
 * @property {boolean} sup
 * @property {string} align    'left' | 'center' | 'right'
 * @property {string} valign   'top' | 'center' | 'bottom'
 * @property {RGB} anchorColor
 * @property {CursorStyle} cursor
 * @property {CursorStyle} cursorNS
 * @property {CursorStyle} anchor
 * @property {CursorStyle} anchorNS
 * @property {CursorStyle} anchorVisited
 */

/** Fonts tried for the default "ＭＳ ゴシック"; glyph advances are emulated, so any of them lays out the same. */
export const DEFAULT_FONT_FAMILY =
  '"MS Gothic","ＭＳ ゴシック","sumika-gothic","BIZ UDGothic","Osaka-Mono","IPAGothic","IPAゴシック",' +
  '"VL Gothic","Noto Sans Mono CJK JP","Noto Sans CJK JP",monospace';

/** Keys that only descript.txt may set (BA §1.4). */
export const WHOLE_BALLOON_KEYS = ['paint_transparent_region_black', 'use_self_alpha', 'use_input_alpha', 'overlay_outside_balloon'];
const IDENTITY_KEYS = ['name', 'type', 'craftman', 'craftmanw', 'craftmanurl', 'id', 'homeurl', 'readme', 'charset'];

/** Merge a per-image *s.txt over descript.txt (later wins, key by key). */
export function mergeCfg(descript, perImage) {
  if (!perImage || !perImage.size) return descript;
  const out = new Map(descript);
  for (const [k, v] of perImage) {
    if (WHOLE_BALLOON_KEYS.includes(k) || IDENTITY_KEYS.includes(k)) continue;
    out.set(k, v);
  }
  return out;
}

function int(v, def) {
  if (v === undefined || v === null) return def;
  const n = parseInt(String(v).trim(), 10);
  return Number.isFinite(n) ? n : def;
}

/** Coordinate with the UKADOC negative rule: negative counts from the right/bottom edge, '--N' is a literal −N. */
export function resolveCoord(v, size, def = 0) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const s = String(v).trim();
  if (s.startsWith('--')) return -int(s.slice(2), 0);
  const n = int(s, NaN);
  if (!Number.isFinite(n)) return def;
  return n < 0 ? size + n : n;
}

/** validrect.right/bottom: 0 and negative values count from the edge (BA §1.5 edge case). */
export function resolveEdge(v, size, def) {
  if (v === undefined || v === null || String(v).trim() === '') return def;
  const s = String(v).trim();
  if (s.startsWith('--')) return -int(s.slice(2), 0);
  const n = int(s, NaN);
  if (!Number.isFinite(n)) return def;
  return n <= 0 ? size + n : n;
}

/**
 * Derive the text geometry of a balloon image of size w×h from its merged cfg (BA §2.1, §2.4, §2.6).
 * @param {Map<string,string>} cfg
 * @returns {Geometry}
 */
export function skinGeometry(cfg, w, h) {
  const vr = {
    left: resolveCoord(cfg.get('validrect.left'), w, 14),
    top: resolveCoord(cfg.get('validrect.top'), h, 14),
    right: resolveEdge(cfg.get('validrect.right'), w, w - 14),
    bottom: resolveEdge(cfg.get('validrect.bottom'), h, h - 14),
  };
  const originX = resolveCoord(cfg.get('origin.x') ?? cfg.get('zeropoint.x'), w, vr.left);
  const originY = resolveCoord(cfg.get('origin.y') ?? cfg.get('zeropoint.y'), h, vr.top);
  // the wrap point never lies right of validrect.right: SSP's line limit is min(wordwrappoint.x, validrect.right) −
  // the origin [disasm 2.9.10 CreateBackBuffer 0x5c9fd6–0x5c9ffd] (BloodTeaHOUSE's convulsions: 177 vs 162)
  const wrapX = Math.min(resolveCoord(cfg.get('wordwrappoint.x'), w, vr.right), vr.right);
  const a0 = { x: resolveCoord(cfg.get('arrow0.x'), w, w - 10), y: resolveCoord(cfg.get('arrow0.y'), h, 10) };
  const a1 = { x: resolveCoord(cfg.get('arrow1.x'), w, w - 10), y: resolveCoord(cfg.get('arrow1.y'), h, h - 20) };
  const cw = { x: resolveCoord(cfg.get('clickwaitmarker.x'), w, a1.x), y: resolveCoord(cfg.get('clickwaitmarker.y'), h, a1.y) };
  const wpx = String(cfg.get('windowposition.x') ?? '0').trim().toLowerCase();
  const windowPosition = {
    x: wpx === 'center' || wpx === 'top' ? 'top' : wpx === 'bottom' ? 'bottom' : int(wpx, 0),
    y: int(cfg.get('windowposition.y'), 0),
    limit: String(cfg.get('windowposition.limit') ?? '1').trim() !== '0',
  };
  let box = null;
  if (cfg.has('communicatebox.x') || cfg.has('communicatebox.width')) {
    box = {
      x: int(cfg.get('communicatebox.x'), 8), y: int(cfg.get('communicatebox.y'), 18),
      width: int(cfg.get('communicatebox.width'), w - 16), height: int(cfg.get('communicatebox.height'), 18),
    };
  }
  return {
    width: w, height: h, originX, originY, lineLimit: wrapX - originX, validRect: vr,
    arrow0: a0, arrow1: a1, clickwait: cw, windowPosition, box,
  };
}

const bool = (v, def) => {
  if (v === undefined) return def;
  const s = String(v).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'on';
};

function cursorStyle(cfg, prefix, base) {
  const font = cfgColor(cfg, prefix + '.font.color', base.font) || base.font;
  return {
    style: (cfg.get(prefix + '.style') ?? base.style).trim().toLowerCase(),
    method: blendMethod(cfg.get(prefix + '.blendmethod')) || base.method,
    brush: cfgColor(cfg, prefix + '.brush.color', base.brush) || base.brush,
    pen: cfgColor(cfg, prefix + '.pen.color', null) || (cfg.has(prefix + '.font.color.r') ? font : base.pen),
    font,
  };
}

/**
 * Balloon default font state (what \f[default] restores), from the merged cfg (BA §2.2, §2.3).
 * @returns {FontState}
 */
export function skinFont(cfg) {
  const names = String(cfg.get('font.name') ?? cfg.get('font.face') ?? cfg.get('fontface') ?? '').trim();
  const black = [0, 0, 0];
  const color = cfgColor(cfg, 'font.color', black) || black;
  const shadowStyle = String(cfg.get('font.shadowstyle') ?? cfg.get('font.shadow.style') ?? 'offset').trim().toLowerCase();
  const cursor = cursorStyle(cfg, 'cursor', { style: 'square', method: 'none', brush: black, pen: black, font: black });
  const anchorColor = cfgColor(cfg, 'anchor.font.color', black) || black;
  const none = { style: 'none', method: 'none', brush: black, pen: black, font: color };
  return {
    name: names ? fontFamily(names) : DEFAULT_FONT_FAMILY,
    height: Math.max(1, int(cfg.get('font.height') ?? cfg.get('font.size') ?? cfg.get('fontsize'), 12)),
    color,
    shadow: cfgColor(cfg, 'font.shadowcolor', null),
    shadowStyle: shadowStyle === 'outline' ? 'outline' : 'offset',
    bold: bool(cfg.get('font.bold'), false),
    italic: bool(cfg.get('font.italic'), false),
    underline: bool(cfg.get('font.underline'), false),
    strike: bool(cfg.get('font.strike'), false),
    outline: bool(cfg.get('font.outline'), false),
    sub: false,
    sup: false,
    align: 'left',
    valign: 'top',
    anchorColor,
    cursor,
    cursorNS: cursorStyle(cfg, 'cursor.notselect', none),
    anchor: cursorStyle(cfg, 'anchor', { style: 'underline', method: 'none', brush: black, pen: anchorColor, font: anchorColor }),
    anchorNS: cursorStyle(cfg, 'anchor.notselect', { ...none, font: anchorColor }),
    anchorVisited: cursorStyle(cfg, 'anchor.visited', { ...none, font: anchorColor }),
  };
}

/** CSS font-family list from a comma-separated descript/\f[name] list, with the default stack appended. */
export function fontFamily(list) {
  const parts = String(list).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    .filter(s => !/\.(ttf|otf|ttc|woff2?)$/i.test(s));
  if (!parts.length) return DEFAULT_FONT_FAMILY;
  return parts.map(p => JSON.stringify(p)).join(',') + ',' + DEFAULT_FONT_FAMILY;
}
