// Balloon skins: descript.txt + per-image *s.txt, balloon images per scope/side/\b id with fallbacks, part images
// (arrows, marker, click-wait), input-box images. BA §1–§2, §9–§10.
import { parseDescript } from '../core/loader.js';
import { log } from '../core/log.js';
import { mergeCfg, skinGeometry, skinFont } from './geometry.js';
import { canDecode, decodeImage } from './images.js';
import { isCanvasLost } from '../core/canvas.js';
import { pngSize, opaqueRects, rectsToPath } from './bitmap.js';
import { FALLBACK_DESCRIPT, FALLBACK_IMAGES, drawFallback, drawFallbackPart } from './fallback.js';

/**
 * @typedef {import('./geometry.js').Geometry} Geometry
 * @typedef {import('./geometry.js').FontState} FontState
 * @typedef {object} SkinImage
 * @property {string} name      lower-case file stem ('balloons0', 'arrow1', 'sstp' ...)
 * @property {number} w
 * @property {number} h
 * @property {Map<string,string>} cfg   descript.txt merged with the image's *s.txt
 * @property {Geometry} geo
 * @property {FontState} font
 * @property {any} source       keyed bitmap (canvas) or null
 * @property {string|null} hit  CSS clip-path covering the opaque pixels
 * @property {(() => any)|null} draw  lazy painter (fallback skin)
 */

const IMAGE_RE = /^(balloon(?:s|k|c|p\d+def))(\d+)\.png$/i;
const PART_RE = /^(arrow(?:s|k|p\d+def)?[01]|marker(?:s|k|p\d+def)?|sstp|clickwait(?:s|k|p\d+def)?)\.png$/i;

/** Family prefixes for a scope, in fallback order (BA §1.2). */
export function balloonFamilies(scope) {
  if (scope === 0) return ['balloons'];
  if (scope === 1) return ['balloonk', 'balloons'];
  return [`balloonp${scope}def`, 'balloonk', 'balloons'];
}

function partSuffix(scope) {
  return scope === 0 ? 's' : scope === 1 ? 'k' : `p${scope}def`;
}

/**
 * A site balloon's folder id for `want`: its id, else its descript `name` (a ghost's `balloon,<name>` names the
 * balloon's name, not its folder: BA §1.6). null when the site (SiteIndex: balloon(id), balloons) has no such balloon.
 */
export function siteBalloonId(site, want) {
  if (!want || !site) return null;
  const e = (typeof site.balloon === 'function' && site.balloon(want))
    || (Array.isArray(site.balloons) ? site.balloons.find(b => b && b.name === want) : null);
  return e ? e.id || want : null;
}

export class BalloonSkin {
  /**
   * @param {{name:string, descript:Map<string,string>, images:Map<string,SkinImage>, parts:Map<string,SkinImage>,
   *          fallback?:boolean}} o
   */
  constructor(o) {
    this.name = o.name;
    this.descript = o.descript;
    /** @type {Map<string, SkinImage>} */
    this.images = o.images;
    /** @type {Map<string, SkinImage>} */
    this.parts = o.parts;
    this.isFallback = !!o.fallback;
    /** Balloon default font from descript.txt alone. */
    this.font = skinFont(o.descript);
    const sa = String(o.descript.get('use_self_alpha') ?? '0').trim().toLowerCase();
    this.selfAlpha = sa === '1' || sa === 'true';
  }

  /**
   * Load a balloon folder.
   * @param {object} files  GhostFiles of the balloon folder (e.g. ghostFiles.sub('LightBlue'))
   * @param {{decode?:boolean, onCanvasLost?:Function}} [o]  decode=false: sizes and metrics only (Node tests);
   *   onCanvasLost('balloon image'): an image's decode canvas got no 2D context (core/canvas.js): the
   *   image is left out as any unreadable one, and this is called once (the runtime ends the ghost)
   */
  static async load(files, o = {}) {
    const decode = o.decode ?? canDecode();
    let lost = false;
    const onLost = () => {
      if (lost) return;
      lost = true;
      if (typeof o.onCanvasLost === 'function') { try { o.onCanvasLost('balloon image'); } catch (e) { /* ignore */ } }
    };
    if (!files || !files.has('descript.txt')) {
      log.once('balloon:nodescript', 'balloon: descript.txt missing, using the built-in balloon');
      return BalloonSkin.fallback();
    }
    const descript = parseDescript(await files.text('descript.txt'));
    const selfAlpha = ['1', 'true'].includes(String(descript.get('use_self_alpha') ?? '').trim().toLowerCase());
    const paintBlack = String(descript.get('paint_transparent_region_black') ?? '1').trim() !== '0';
    const top = files.list('', { recursive: false });
    const images = new Map(), parts = new Map();
    const jobs = [];
    for (const path of top) {
      const m = IMAGE_RE.exec(path);
      const p = m ? null : PART_RE.exec(path);
      if (!m && !p) continue;
      const stem = path.slice(0, -4).toLowerCase();
      jobs.push((async () => {
        try {
          const bytes = await files.bytes(path);
          let size = pngSize(bytes);
          let cfg = descript;
          if (m) {
            const sTxt = path.slice(0, -4) + 's.txt';
            if (files.has(sTxt)) cfg = mergeCfg(descript, parseDescript(await files.text(sTxt)));
          }
          let source = null, hit = null;
          if (decode) {
            const pna = path.slice(0, -4) + '.pna';
            const mask = files.has(pna) ? await files.bytes(pna) : null;
            const mode = selfAlpha && size && size.alpha ? 'self' : 'key';
            const d = await decodeImage(bytes, { mode, mask, paintBlack, wantRects: !!m });
            source = d.source;
            size = { w: d.w, h: d.h };
            if (d.rects) hit = rectsToPath(d.rects);
          }
          if (!size) throw new Error('not a PNG');
          const img = { name: stem, w: size.w, h: size.h, cfg, geo: skinGeometry(cfg, size.w, size.h), font: skinFont(cfg), source, hit, draw: null };
          (m ? images : parts).set(stem, img);
        } catch (e) {
          if (isCanvasLost(e)) onLost();
          else log.once('balloon:skin:' + path, 'balloon: cannot load', path, String(e && e.message || e));
        }
      })());
    }
    await Promise.all(jobs);
    if (![...images.keys()].some(k => k.startsWith('balloons'))) {
      log.once('balloon:noimages', 'balloon: no balloons*.png, using the built-in balloon');
      return BalloonSkin.fallback();
    }
    return new BalloonSkin({ name: descript.get('name') || 'balloon', descript, images, parts });
  }

  /**
   * The balloon a ghost uses (BA §1.6, §9): its bundled balloon named by the index entry (ghosts.json `balloon`,
   * `bundledBalloons`), else a site balloon with that id or name, else the site's default balloon (ghosts.json
   * `defaultBalloon`), else the built-in one. Never throws. (The runtime's own choice: chooseBalloon in core/runtime.js.)
   * @param {{ghost?:object, ghostFiles?:object, site?:object, decode?:boolean}} o  site = SiteIndex
   */
  static async forGhost({ ghost, ghostFiles, site, decode } = {}) {
    try {
      const want = ghost && ghost.balloon;
      const bundled = (ghost && ghost.bundledBalloons) || [];
      const b = bundled.find(x => x.name === want || x.dir === want) || bundled[0];
      if (b && ghostFiles) return await BalloonSkin.load(ghostFiles.sub(b.dir), { decode });
      const id = siteBalloonId(site, want) || siteBalloonId(site, site && site.defaultBalloon);
      if (id) return await BalloonSkin.load(await site.balloonFiles(id), { decode });
    } catch (e) {
      log.once('balloon:forghost', 'balloon: cannot load the ghost balloon, using the built-in one', e);
    }
    return BalloonSkin.fallback();
  }

  /** Built-in balloon drawn on canvases (no files needed). */
  static fallback() {
    const descript = new Map(FALLBACK_DESCRIPT);
    const images = new Map();
    for (const [name, [w, h]] of Object.entries(FALLBACK_IMAGES)) {
      images.set(name, { name, w, h, cfg: descript, geo: skinGeometry(descript, w, h), font: skinFont(descript),
        source: null, hit: null, draw: () => drawFallback(name) });
    }
    const parts = new Map();
    for (const name of ['arrow0', 'arrow1', 'marker']) {
      parts.set(name, { name, w: 8, h: 8, cfg: descript, geo: skinGeometry(descript, 8, 8), font: skinFont(descript),
        source: null, hit: null, draw: () => drawFallbackPart(name) });
    }
    return new BalloonSkin({ name: 'Sumika default', descript, images, parts, fallback: true });
  }

  /**
   * The image for a scope's \b[id] on one side (BA §1.2): even = left of the character, odd = right.
   * Odd ids are normalised to their pair. Returns null when no family has it (caller keeps its current id).
   * @param {number} scope
   * @param {number} id
   * @param {'left'|'right'} side
   * @returns {SkinImage|null}
   */
  balloon(scope, id, side = 'left') {
    if (!(id >= 0)) return null;
    const base = id - (id % 2);
    const fams = balloonFamilies(scope);
    for (const idx of side === 'right' ? [base + 1, base] : [base, base + 1]) {
      for (const f of fams) {
        const img = this.images.get(f + idx);
        if (img) return img;
      }
    }
    return null;
  }

  /** Whether \b[id] exists for this scope. */
  hasKind(scope, id) {
    return this.balloon(scope, id, 'left') !== null;
  }

  /** Input-box image balloonc<n> (0 send, 1 communicate, 2 teach, 3 input), falling back to c3, then any. */
  box(n = 3) {
    return this.images.get('balloonc' + n) || this.images.get('balloonc3') ||
      [...this.images.values()].find(i => i.name.startsWith('balloonc')) || null;
  }

  _part(names) {
    for (const n of names) {
      const p = this.parts.get(n);
      if (p) return p;
    }
    return null;
  }

  /** \![*] marker: marker<side>, marker, then sstp (BA §1.1). */
  marker(scope) { return this._part(['marker' + partSuffix(scope), 'marker', 'sstp']); }

  /** Scroll arrow 0 (up) / 1 (down). */
  arrow(i, scope) { return this._part(['arrow' + partSuffix(scope) + i, 'arrow' + i]); }

  /** Click-wait marker image, or null (then the view blinks arrow1). */
  clickwait(scope) { return this._part(['clickwait' + partSuffix(scope), 'clickwait']); }

  /** Drawable bitmap of a skin image (draws fallback images on first use). */
  sourceOf(img) {
    if (!img) return null;
    if (!img.source && img.draw) {
      img.source = img.draw();
      img.draw = null;
      if (img.source && img.name.startsWith('balloon')) {
        try {
          const ctx = img.source.getContext('2d', { willReadFrequently: true });
          img.hit = rectsToPath(opaqueRects(ctx.getImageData(0, 0, img.w, img.h).data, img.w, img.h));
        } catch (e) { img.hit = null; }
      }
    }
    return img.source;
  }
}
