// Character placement math (UI §3.1–3.3, §3.5, SUM C28) and the phone fit (UI §9.11). Pure.
// A character is placed by its base point ("anchor", viewport px). Its geometry `g` is in surface coordinates:
//   g.rect = base rectangle {x, y, w, h} (before animations and binds), g.bp = base point {x, y}, g.sx/g.sy = scale.
import { scopeName } from './surfaces.js';

export const ALIGNMENTS = ['bottom', 'top', 'left', 'right', 'free'];

/** Base point default: centre x, bottom y of the base rectangle; descript defaultx/defaulty and point.basepos win. */
export function basePoint(rect, { defaultX, defaultY, basepos } = {}) {
  const num = v => (v === undefined || v === null || v === '' ? NaN : Number(v));
  let x = basepos && Number.isFinite(basepos.x) ? basepos.x : num(defaultX);
  let y = basepos && Number.isFinite(basepos.y) ? basepos.y : num(defaultY);
  if (!Number.isFinite(x)) x = rect.x + rect.w / 2;
  if (!Number.isFinite(y)) y = rect.y + rect.h;
  return { x, y };
}

/**
 * alignmenttodesktop for a scope (UI §3.1): runtime override < shell per-scope < shell global < ghost per-scope
 * < ghost global < 'bottom'.
 * @param {Map<string,string>} shellDescript @param {Map<string,string>} [ghostDescript]
 */
export function resolveAlignment(scope, override, shellDescript, ghostDescript) {
  const ok = v => {
    v = (v || '').trim().toLowerCase();
    return ALIGNMENTS.includes(v) ? v : null;
  };
  if (ok(override)) return ok(override);
  const k = scopeName(scope) + '.seriko.alignmenttodesktop';
  for (const d of [shellDescript, ghostDescript]) {
    if (!d) continue;
    const v = ok(d.get(k)) || ok(d.get('seriko.alignmenttodesktop'));
    if (v) return v;
  }
  return 'bottom';
}

/** viewport rectangle of the base rect when the base point is at `a` */
export function rectAt(a, g) {
  return { x: a.x - (g.bp.x - g.rect.x) * g.sx, y: a.y - (g.bp.y - g.rect.y) * g.sy, width: g.rect.w * g.sx, height: g.rect.h * g.sy };
}

/** anchor that puts the base rectangle's top-left corner at (left, top) */
export function anchorForTopLeft(left, top, g) {
  return { x: left + (g.bp.x - g.rect.x) * g.sx, y: top + (g.bp.y - g.rect.y) * g.sy };
}

/** apply docking: bottom/top fix y, left/right fix x */
export function snap(a, g, align, desk) {
  const r = rectAt(a, g);
  let { x, y } = a;
  if (align === 'bottom') y += desk.h - (r.y + r.height);
  else if (align === 'top') y -= r.y;
  else if (align === 'left') x -= r.x;
  else if (align === 'right') x += desk.w - (r.x + r.width);
  return { x, y };
}

/** keep at least `margin` px of the base rectangle inside the desk (load / resize, UI §3.3) */
export function clampIntoView(a, g, desk, margin = 32) {
  const r = rectAt(a, g);
  let { x, y } = a;
  const mx = Math.min(margin, r.width), my = Math.min(margin, r.height);
  if (r.x + r.width < mx) x += mx - (r.x + r.width);
  if (r.x > desk.w - mx) x -= r.x - (desk.w - mx);
  if (r.y + r.height < my) y += my - (r.y + r.height);
  if (r.y > desk.h - my) y -= r.y - (desk.h - my);
  return { x, y };
}

/** shift so that the whole base rectangle is inside the desk (left/top edge wins when it is larger) */
export function clampInside(a, g, desk) {
  const r = rectAt(a, g);
  let dx = 0, dy = 0;
  if (r.x + r.width > desk.w) dx = desk.w - (r.x + r.width);
  if (r.x + dx < 0) dx = -r.x;
  if (r.y + r.height > desk.h) dy = desk.h - (r.y + r.height);
  if (r.y + dy < 0) dy = -r.y;
  return { x: a.x + dx, y: a.y + dy };
}

export function toRatio(a, desk) { return { rx: desk.w ? a.x / desk.w : 0, ry: desk.h ? a.y / desk.h : 0 }; }
export function fromRatio(p, desk) { return { x: (+p.rx || 0) * desk.w, y: (+p.ry || 0) * desk.h }; }

/**
 * A window that misses the desk comes back as ssp.exe's ClampToWorkRect brings it (seriko.automove on, its default;
 * UI §3.2) [disasm 0x41E540, JRect::IsIntersect 0x576650]; one that overlaps the desk by any amount stays where it is.
 * The rectangles are half-open, so a window touching an edge from outside misses the desk too. Then:
 * - x: the left edge only when the window lies wholly left of the desk, else the right edge (also when only y misses);
 * - y: the top edge only when it lies wholly above, else the bottom edge [infer: the relation comes from
 *   JRect::GetOutDirection with index -1, which always clamps x; for y Sumika takes relation 3 for every window].
 */
export function bringBack(a, g, desk) {
  const r = rectAt(a, g);
  if (r.x < desk.w && r.x + r.width > 0 && r.y < desk.h && r.y + r.height > 0) return { x: a.x, y: a.y };
  const left = r.x + r.width < 0 ? 0 : desk.w - r.width;
  const top = r.y + r.height < 0 ? 0 : desk.h - r.height;
  return { x: a.x + left - r.x, y: a.y + top - r.y };
}

/**
 * Default place of one character: where it stands when nothing is stored for it (a ghost's first boot, Reset shell
 * position, a \p[n] window shown for the first time), as ssp.exe 2.9.08f computes it (UI §3.2) [disasm
 * CCharWndCode::GetDefaultWndPosX/Y 0x41DA50/0x41DBD0, GetDefaultWndPosImpl 0x41D830]. It reads only this ghost's own
 * characters: no other ghost on screen moves it (UI §3.5), and no room is left for balloons.
 * - left: its defaultleft; else \0's right edge on the desk's right edge; else (\1, \p[n]) its right edge against
 *   `below.left`; with nothing below, the desk's middle;
 * - top: its defaulttop; else \0's base point on the desk's bottom; else its base point level with `below.baseY`; with
 *   nothing below, its bottom on the desk's bottom.
 * Then bringBack, then docking (alignment), in UpdateWndSize's order [disasm: ClampToWorkRect at 0x41E778, then
 * resolveSnapAxis with the alignment].
 * @param {{scope:number, g:object, align:string, defaultLeft?:number, defaultTop?:number}} it
 * @param {{left:number, baseY:number}|null} below  the nearest lower scope that has a window (Stage._standing): its
 *   defaultleft, else its window's left now; its defaulttop's base point, else its base point now
 * @param {{w:number,h:number}} desk
 * @returns {{x:number,y:number}} the anchor (base point)
 */
export function defaultPlace(it, below, desk) {
  const g = it.g;
  const w = g.rect.w * g.sx, h = g.rect.h * g.sy;
  const by = (g.bp.y - g.rect.y) * g.sy;
  let left, top;
  if (Number.isFinite(it.defaultLeft)) left = it.defaultLeft;
  else if (it.scope === 0) left = desk.w - w;
  else left = below ? below.left - w : desk.w / 2;
  if (Number.isFinite(it.defaultTop)) top = it.defaultTop;
  else if (it.scope === 0) top = desk.h - by;
  else top = below ? below.baseY - by : desk.h - h;
  return snap(bringBack(anchorForTopLeft(left, top, g), g, desk), g, it.align, desk);
}

/**
 * Phones only (ssp-ui §9.11, Sumika's own) [decision]: `margin` CSS px each side of \0 and \1 side by side across the
 * screen's short side; at most `tallLong` of the long side tall (room for a balloon above her head in portrait) and at
 * most the short side minus `bars` (whole in landscape under the browser's bars [verify]); `min`, the floor in CSS px
 * per image px (tap areas, thin lines), on the height only, so a wide pair still fits across.
 */
export const FIT = Object.freeze({ margin: 8, tallLong: 0.4, bars: 112, min: 0.4 });

/**
 * The phone default of Shell scaling: {scale (CSS px per image px), percent (SSP's device-px %)} or null (no fit).
 * Never enlarged; rounded down to a whole percentage (no snapping to SCALE_STEPS). Only the screen's sides enter, so
 * portrait and landscape loads fit alike; a page that is no mobile view (a ~980-px layout the browser already
 * shrinks to the screen) gets none.
 * @param {{w0:number, h0:number, w1?:number, h1?:number}|null} sizes base rects of the default surfaces of \0 and \1
 *   (image px); \1 missing or unsized counts 0
 * @param {{short:number, long:number, mobileView:boolean}|null} phone core/phone.js, CSS px
 * @param {number} dpr devicePixelRatio
 */
export function phoneFit(sizes, phone, dpr) {
  if (!sizes || !(sizes.w0 > 0) || !(sizes.h0 > 0) || !phone || !phone.mobileView) return null;
  const W = sizes.w0 + (sizes.w1 || 0), H = Math.max(sizes.h0, sizes.h1 || 0);
  const kW = (phone.short - 2 * FIT.margin) / W;                                   // across the portrait width
  const kH = Math.min(FIT.tallLong * phone.long, phone.short - FIT.bars) / H;      // above her head; whole in landscape
  const k = Math.min(1, kW, Math.max(FIT.min, kH));                                // the floor never beats the width
  if (k >= 1) return { scale: 1, percent: Math.round(dpr * 100) };
  const percent = Math.floor(k * dpr * 100 + 1e-9);
  return { scale: percent / (100 * dpr), percent };
}
