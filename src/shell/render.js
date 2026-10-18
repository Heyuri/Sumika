// Surface composition (SH §3.4–§3.7, §6.3): base construction, the layer list of a character's current state
// (pure binds with inserts, animation frames, base overrides) and its composition. Pure: images come from an
// `ImageSource` ({get(path) -> Img|null|undefined}), where undefined means "not loaded yet".
import { log } from '../core/log.js';
import { GrowCanvas, composeLayers, emptyImage, normalizeMethod, realRect } from './compositor.js';

/**
 * @typedef {Object} ImageSource
 * @property {(path:string) => (import('./compositor.js').Img|null|undefined)} get   prepared image (origin 0,0)
 */

const ELEMENT_KEEP = new Set(['reduce', 'interpolate', 'overlayfast', 'replace', 'asis']);

/**
 * How an element after the first one drawn draws in base(): base, add, bind, the non-compositing methods and unknown
 * names as overlay (SH §3.4) [disasm 2.9.10.3000 LoadSurfacePropertiesImpl 0x711801–0x711824: base, and any method
 * without the drawing bit 0x10000, become overlay 0x10002]. The blend-* methods are drawn as overlay too, a simplification.
 */
const elementMethod = m => (ELEMENT_KEEP.has(m) ? m : 'overlay');
/** an element's method as ssp.exe stores it, for telling a repeated line from a different one */
const storedMethod = m => (m.startsWith('blend-') ? m : elementMethod(m));

/** the base extent is the union of the element rectangles with the origin (SH §3.4) */
function extentRect(x0, y0, x1, y1) {
  const ax = Math.min(0, x0), ay = Math.min(0, y0);
  return { x: ax, y: ay, w: Math.max(x1, 0) - ax, h: Math.max(y1, 0) - ay };
}

/**
 * Pattern methods ssp.exe leaves out of a surface's fallback collision box (SH §6.9): CreateBoundingBoxSub skips a
 * pattern whose type has a bit of the mask, 0x1000000 for a surface with elements (base 0x1000000 and the 0x7xxxxxx
 * types: move, start, stop, insert, alternative-/parallelstart/-stop, import, noop, scaling), else 0x4000000, which
 * lets base through [disasm CreateBoundingBox 0x5b6051–0x5b6078, CreateBoundingBoxSub 0x5b5e98,
 * GetMethodTypeFromText 0x703c20].
 */
export const COLL_SKIP = new Set(['base', 'move', 'start', 'stop', 'insert', 'alternativestart', 'alternativestop',
  'parallelstart', 'parallelstop', 'import', 'noop', 'scaling']);
export const COLL_SKIP_IMAGELESS = new Set([...COLL_SKIP].filter(m => m !== 'base'));

const MAX = 0x7fffffff;

/**
 * JRect::MultiplyRectH / MultiplyRectV with 0.8 (SH §6.9): each axis shrinks to 80 % around its centre, every step
 * truncated toward zero [disasm 0x5784c0, 0x578510].
 * @param {{l:number, t:number, r:number, b:number}} box
 */
export function shrink80({ l, t, r, b }) {
  const m = (a, z) => {
    const c = Math.trunc((a + z) / 2), h = Math.trunc(Math.trunc((z - a) * 0.8) / 2);
    return [c - h, c + h];
  };
  const [l2, r2] = m(l, r), [t2, b2] = m(t, b);
  return { l: l2, t: t2, r: r2, b: b2 };
}

/** join box q, placed at (x, y), into acc per axis; an axis where q has no size is skipped [disasm 0x5bd3f0, 0x5b5da0] */
function joinReal(acc, q, x, y) {
  if (q.r - q.l) { acc.l = Math.min(acc.l, x + q.l); acc.r = Math.max(acc.r, x + q.r); }
  if (q.b - q.t) { acc.t = Math.min(acc.t, y + q.t); acc.b = Math.max(acc.b, y + q.b); }
}

export class SurfaceRenderer {
  /**
   * @param {import('./surfaces.js').Shell} shell
   * @param {ImageSource} images
   */
  constructor(shell, images, { baseCacheSize = 48 } = {}) {
    this.shell = shell;
    this.images = images;
    this._bases = new Map();      // id -> Img|null (LRU)
    this._baseMax = baseCacheSize;
    this._prefix = null;          // {key, img}
    this._lastPrefixKey = null;
    this._real = new Map();       // id -> element box (realBox)
    this._coll = new Map();       // id -> collision box (collisionBox); ssp.exe makes both once per shell load
    this._lists = new Map();      // id -> element list (elementList)
  }

  /**
   * ssp.exe's element list of a surface (SPAnimeBase +0x3d0, SH §3.4, §6.9), which base(), _sizeRect(), baseFiles()
   * and sspElements() all follow [disasm 2.9.10.3000]: its surfaceN.png at 0,0 first (LoadSurfaceOld 0x707a01, made
   * before surfaces*.txt is read), then every element line in the order read, blocks in load order, surface.append
   * ones included (Shell elementsRead), each appended at the end (AddSurfaceElement 0x5b99a0, append 0x5b9c4d; no
   * sort). A line whose file is not in the shell is skipped: ssp.exe adds no record for an image that does not load
   * (0x712052). An element0 line removes the surfaceN.png entry (0x5b9a22). A line repeating the number of an earlier
   * element is skipped when it matches the first such element in method, file and place (log.definedtwice 0x5b9b6d),
   * else appended too (0x5b9b83). Cached per id; built from new records, the shell's shared ones are never written.
   * @returns {{file:string, x:number, y:number, method:string, index:number}[]|null} null: no such surface; the
   *   surfaceN.png entry has index -1
   */
  elementList(id) {
    const hit = this._lists.get(id);
    if (hit) return hit;
    const s = this.shell.surface(id);
    if (!s) return null;
    const list = [];
    if (s.png) list.push({ file: s.png, x: 0, y: 0, method: 'overlay', index: -1 });
    for (const e of s.elementsRead) {
      const file = this.shell.resolveFile(e.file);
      if (!file) { log.once('shell:nofile:' + e.file, 'shell: missing element image', e.file); continue; }
      if (e.index === 0 && list.length && list[0].index === -1) list.shift();
      else {
        const prev = list.find(x => x.index === e.index);
        if (prev && prev.file === file && prev.x === e.x && prev.y === e.y && storedMethod(prev.method) === storedMethod(e.method)) continue;
      }
      list.push({ file, x: e.x, y: e.y, method: e.method, index: e.index });
    }
    this._lists.set(id, list);
    return list;
  }

  /** Image files needed to build surface id's base (its element list: element files and surfaceN.png). */
  baseFiles(id, depth = 0) {
    const s = this.shell.surface(id);
    if (!s) return [];
    const list = this.elementList(id);
    if (list.length) return list.map(x => x.file);
    // image-less (an empty element list): its size comes from its animation frames (_animRect)
    const out = new Set();
    if (depth <= 2) {
      for (const def of s.anims.values()) {
        if (def.isBind) continue;
        for (const p of def.patterns) {
          if (p.ids || p.method === 'move' || !(p.surface >= 0) || p.surface === s.id) continue;
          for (const f of this.baseFiles(p.surface, depth + 1)) out.add(f);
        }
      }
    }
    return [...out];
  }

  /**
   * The base image of a surface (also used for parts). null = no such surface / nothing to draw;
   * undefined = images still loading (their paths are pushed to `missing`).
   * @returns {import('./compositor.js').Img|null|undefined}
   */
  base(id, missing = null) {
    const hit = this._bases.get(id);
    if (hit !== undefined) {
      this._bases.delete(id);
      this._bases.set(id, hit);
      return hit;
    }
    const s = this.shell.surface(id);
    if (!s) return null;
    let img;
    if (s.elementsRead.length) {
      // the element list in its order (elementList); the first image drawn is a plain draw onto the empty canvas
      // whatever its method, asis too, the others keep theirs [disasm 2.9.10.3000 ElementRenderForDrawTask 0x5b9cc0:
      // one element is drawn with 0x10002, several into a cleared surface with 0x1000000, which ElementRender 0x5b9e00
      // turns into 0x10002 for the first one drawn (0x5b9ec5)]. sagiri_tama writes `element0,overlayfast,<face>`
      // after her head on 207 surfaces: the face paints onto the head; read first, it would draw nothing.
      const list = this.elementList(id);
      const parts = [];
      let wait = false;
      for (const x of list) {
        const im = this.images.get(x.file);
        if (im === undefined) { wait = true; if (missing) missing.push(x.file); }
        parts.push(im);
      }
      if (wait) return undefined;
      const c = new GrowCanvas();
      let first = true;
      list.forEach((x, i) => {
        const im = parts[i];
        if (!im) return;                     // a broken image is not drawn and is not the first one
        c.draw(im, x.x, x.y, first ? 'overlay' : elementMethod(x.method));
        first = false;
      });
      img = c.img.width ? c.img : emptyImage();
    } else if (s.png) {
      const im = this.images.get(s.png);
      if (im === undefined) { if (missing) missing.push(s.png); return undefined; }
      img = im || emptyImage();
    } else {
      img = emptyImage();   // text-only surface: empty base, animations draw everything (SH §3.4 rule 3)
    }
    this._bases.set(id, img);
    if (this._bases.size > this._baseMax) this._bases.delete(this._bases.keys().next().value);
    return img;
  }

  /**
   * Base rectangle of a surface in surface coordinates ({x,y,w,h}); null when not known yet. Image sizes that are
   * known before decoding (ImageSource.size, optional) give it without waiting for the pixels.
   */
  baseRect(id, depth = 0) {
    const s = this.shell.surface(id);
    if (s && !this.elementList(id).length) return this._animRect(s, depth);
    const b = this.base(id);
    if (b === undefined) return this._sizeRect(id);
    if (!b || !b.width) return { x: 0, y: 0, w: 0, h: 0 };
    return extentRect(b.ox, b.oy, b.ox + b.width, b.oy + b.height);
  }

  /**
   * An image-less surface (an empty element list: no PNG and no element whose file is there) reaches from the origin to the right and bottom edges of what its
   * animations draw (SH §3.4 rule 3, §6.1) [guess]. Tsubasa's playing music box 12 only cycles 13–15 at 0,0: with a
   * 0×0 base its window stood below the screen edge, where SSP keeps it where 11 stood [observed: the box vanished on
   * play]. Frames above or left of the origin (fireworks 930 rise 500 px) grow the canvas like overflowing overlays
   * and do not move the left/top edges, so left/top placements of these surfaces stay as with a 0×0 base.
   * null = a frame's size is not known yet.
   */
  _animRect(s, depth) {
    let x1 = 0, y1 = 0;
    for (const def of s.anims.values()) {
      if (def.isBind) continue;
      for (const p of def.patterns) {
        if (p.ids || p.method === 'move' || !(p.surface >= 0) || p.surface === s.id) continue;
        if (depth > 2) continue;                      // frames of frames of frames: ignore
        const r = this.baseRect(p.surface, depth + 1);
        if (r === null) return null;
        if (!r.w || !r.h) continue;
        x1 = Math.max(x1, p.x + r.x + r.w); y1 = Math.max(y1, p.y + r.y + r.h);
      }
    }
    return { x: 0, y: 0, w: x1, h: y1 };
  }

  /**
   * baseRect from image sizes alone: the element list (or surfaceN.png) with base()'s rules, so both give the same
   * rect; null when a size is unknown
   */
  _sizeRect(id) {
    if (typeof this.images.size !== 'function') return null;
    const s = this.shell.surface(id);
    if (!s) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const list = this.elementList(id);
    let first = true;
    for (const e of list) {
      const z = this.images.size(e.file);
      if (z === undefined) return null;
      if (!z) continue;                                  // broken: not drawn, as in base()
      const m = first ? 'overlay' : elementMethod(e.method);
      first = false;
      if (m === 'reduce' || !z.width || !z.height) continue;   // reduce never grows the canvas
      x0 = Math.min(x0, e.x); y0 = Math.min(y0, e.y); x1 = Math.max(x1, e.x + z.width); y1 = Math.max(y1, e.y + z.height);
    }
    return x1 > x0 ? extentRect(x0, y0, x1, y1) : { x: 0, y: 0, w: 0, h: 0 };
  }

  /** forget cached bases and prefixes (e.g. after images were evicted); the boxes stay, they hold no pixels */
  clear() { this._bases.clear(); this._prefix = null; this._lastPrefixKey = null; }

  /**
   * The files and places of a surface's element list (elementList), whatever their methods: what ssp.exe's InitFirst
   * joins into the element box (SH §6.9) [disasm 2.9.10.3000 InitFirst 0x5bfb2e–0x5bfb7e; it logs "Element=0" when
   * surfaceN.png and elements are both there, 0x5bfbb5].
   * @returns {{file:string, x:number, y:number}[]}
   */
  sspElements(id) {
    return (this.elementList(id) || []).map(e => ({ file: e.file, x: e.x, y: e.y }));
  }

  /**
   * A surface's element box (SPAnimeBase +0x590, SH §6.9) [disasm InitFirst 0x5bd475–0x5bd539]: the real rects
   * (realRect) of its element list joined per axis at each element's place, unscaled surface px; an untouched left /
   * top is 0, so a surface with nothing opaque is {0,0,0,0}. Missing or broken images are left out.
   * @returns {{l:number, t:number, r:number, b:number}|null|undefined} null: no such surface; undefined: an image is
   *   still loading (its path pushed to `missing`)
   */
  realBox(id, missing = null) {
    const hit = this._real.get(id);
    if (hit) return hit;
    if (!this.shell.surface(id)) return null;
    const c = { l: MAX, t: MAX, r: 0, b: 0 };
    let wait = false;
    for (const e of this.sspElements(id)) {
      const im = this.images.get(e.file);
      if (im === undefined) { wait = true; if (missing) missing.push(e.file); continue; }
      if (im) joinReal(c, realRect(im), e.x, e.y);
    }
    if (wait) return undefined;
    if (c.l === MAX) c.l = 0;
    if (c.t === MAX) c.t = 0;
    this._real.set(id, c);
    return c;
  }

  /**
   * ssp.exe's collision box of a surface (SPAnimeBase +0x5b0, made once at shell load; EV §3.2.1, SH §6.9)
   * [disasm CreateBoundingBox 0x5b5f80–0x5b6320]: the element box (realBox); when that is narrower or lower than 50 px,
   * instead that box (or nothing, when it is 0×0) joined with L2: each animation pattern's surface box at the
   * pattern's place, per axis, over every animation (bind groups on or off), leaving out COLL_SKIP's methods
   * (COLL_SKIP_IMAGELESS's for a surface with no element), L2's untouched left / top 0. Then shrink80. Unscaled
   * surface px, r / b exclusive as a JRect's; r <= l or b <= t is an empty box. Cached (clear() keeps it).
   * @returns {{l:number, t:number, r:number, b:number}|null|undefined} null: no such surface; undefined: images still
   *   loading (their paths pushed to `missing`)
   */
  collisionBox(id, missing = null) {
    const hit = this._coll.get(id);
    if (hit) return hit;
    const s = this.shell.surface(id);
    if (!s) return null;
    const c = this.realBox(id, missing);
    if (!c) return c;
    let box = c;
    if (c.r - c.l < 50 || c.b - c.t < 50) {
      const skip = this.sspElements(id).length ? COLL_SKIP : COLL_SKIP_IMAGELESS;
      const l2 = { l: MAX, t: MAX, r: 0, b: 0 };
      let wait = false;
      for (const def of s.anims.values()) {
        for (const p of def.patterns) {
          if (p.ids || skip.has(p.method) || !(p.surface >= 0)) continue;
          const q = this.realBox(p.surface, missing);
          if (q === undefined) wait = true;
          else if (q) joinReal(l2, q, p.x, p.y);
        }
      }
      if (wait) return undefined;
      if (l2.l === MAX) l2.l = 0;
      if (l2.t === MAX) l2.t = 0;
      const b = c.r - c.l || c.b - c.t ? c : { l: MAX, t: MAX, r: 0, b: 0 };
      box = { l: Math.min(b.l, l2.l), t: Math.min(b.t, l2.t), r: Math.max(b.r, l2.r), b: Math.max(b.b, l2.b) };
    }
    const out = shrink80(box);
    this._coll.set(id, out);
    return out;
  }

  /**
   * Every image a surface may need right away: its base, the frames of its non-bind animations and the parts of
   * the bind groups that are on (SH §6.6 prefetch).
   */
  prefetchFiles(surf, bindOn) {
    const ids = new Set([surf.id]);
    for (const def of surf.anims.values()) {
      if (def.isBind && !bindOn(def.id)) continue;
      for (const p of def.patterns) if (!p.ids && p.surface >= 0 && p.method !== 'move') ids.add(p.surface);
    }
    const out = new Set();
    for (const id of ids) for (const f of this.baseFiles(id)) out.add(f);
    return [...out];
  }

  /**
   * Layer list for a character state (SH §6.3), back to front.
   * @param {import('./surfaces.js').SurfaceDef} surf
   * @param {{bindOn:(id:number)=>boolean, anim: import('./animator.js').Animator}} st
   * @returns {{layers: {img, x, y, method, alpha, key, dyn}[], missing: string[]}}
   */
  layers(surf, st) {
    const { bindOn, anim } = st;
    const missing = [];
    const layers = [];
    const part = id => this.base(id, missing);
    const anims = surf.anims;
    const bindAnim = id => { const d = anims.get(id); return d && d.isBind && bindOn(id) ? d : null; };
    const offOf = id => anim.offset(id) || { x: 0, y: 0 };

    // groups reached through an insert inside an enabled group are drawn only at the insertion point
    const reserved = new Set();
    const collect = (h, stack) => {
      for (const p of anims.get(h).patterns) {
        if (p.method !== 'insert') continue;
        const t = p.ids[0];
        if (bindAnim(t) && !stack.has(t) && !reserved.has(t)) {
          reserved.add(t);
          stack.add(t);
          collect(t, stack);
          stack.delete(t);
        }
      }
    };
    for (const id of surf.drawOrder) {
      const d = anims.get(id);
      if (d.isPureBind && bindOn(id)) collect(id, new Set([id]));
    }

    const ovr = anim.baseOverride();
    const baseId = ovr !== null ? ovr : surf.id;
    const baseImg = part(baseId);
    let baseLayer = { img: baseImg || emptyImage(), x: 0, y: 0, method: 'overlay', alpha: 255, key: 'B' + baseId, dyn: ovr !== null };

    const drawn = new Set();
    const pushFrame = (id, f) => {
      if (f.surface < 0) return;
      const im = part(f.surface);
      if (!im) return;
      const o = offOf(id);
      layers.push({ img: im, x: f.x + o.x, y: f.y + o.y, method: f.method, alpha: f.alpha === undefined ? 255 : f.alpha, key: '', dyn: true });
    };
    const emitBind = (id, stack) => {
      let first = true;
      const o = offOf(id);
      for (const p of anims.get(id).patterns) {
        if (p.method === 'insert') {
          const t = p.ids[0];
          const td = bindAnim(t);
          if (td && !stack.has(t) && !drawn.has(t)) {
            drawn.add(t);
            if (td.isPureBind) { stack.add(t); emitBind(t, stack); stack.delete(t); } else {
              const f = anim.frame(t);
              if (f) pushFrame(t, f);
            }
          }
          continue;
        }
        if (p.ids || p.method === 'move') continue;   // control methods are invalid in bind groups
        if (!(p.surface >= 0)) continue;
        if (p.method === 'base' && first) {
          const b = part(p.surface);
          baseLayer = { img: b || emptyImage(), x: 0, y: 0, method: 'overlay', alpha: 255, key: 'B' + p.surface, dyn: baseLayer.dyn };
          first = false;
          continue;
        }
        first = false;
        const im = part(p.surface);
        if (!im) continue;
        const m = normalizeMethod(p.method);
        const x = p.x + o.x, y = p.y + o.y;
        const alpha = p.alpha === undefined ? 255 : p.alpha;
        layers.push({ img: im, x, y, method: m, alpha, key: `${p.surface}@${x},${y}${m[0]}${alpha}`, dyn: false });
      }
    };
    const emitAnim = id => {
      const d = anims.get(id);
      if (d.isPureBind) {
        if (bindOn(id) && !reserved.has(id)) { drawn.add(id); emitBind(id, new Set([id])); }
        return;
      }
      if (reserved.has(id) || drawn.has(id)) return;
      const f = anim.frame(id);
      if (f) pushFrame(id, f);
    };

    const back = [];
    for (const id of surf.drawOrder) if (anims.get(id).background) { const n = layers.length; emitAnim(id); back.push(...layers.splice(n)); }
    for (const id of surf.drawOrder) if (!anims.get(id).background) emitAnim(id);
    return { layers: [...back, baseLayer, ...layers], missing, drawn };
  }

  /**
   * Compose the character's current state.
   * @returns {{image: import('./compositor.js').Img|null, missing: string[]}} image null while images load
   */
  compose(surf, st) {
    const { layers, missing } = this.layers(surf, st);
    if (missing.length) return { image: null, missing: [...new Set(missing)] };
    // static prefix (base + binds below the first animated layer) is cached once it is stable for two frames
    let n = 0;
    while (n < layers.length && !layers[n].dyn) n++;
    if (n < 2) return { image: composeLayers(layers), missing };
    let key = surf.id + '|';
    for (let i = 0; i < n; i++) key += layers[i].key + ';';
    if (this._prefix && this._prefix.key === key) {
      if (n === layers.length) return { image: this._prefix.img, missing };
      return { image: composeLayers(layers.slice(n), { prefix: this._prefix.img }), missing };
    }
    if (this._lastPrefixKey === key) {
      const img = composeLayers(layers.slice(0, n));
      this._prefix = { key, img };
      if (n === layers.length) return { image: img, missing };
      return { image: composeLayers(layers.slice(n), { prefix: img }), missing };
    }
    this._lastPrefixKey = key;
    return { image: composeLayers(layers), missing };
  }
}
