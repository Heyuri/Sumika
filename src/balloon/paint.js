// Canvas painter for one balloon: balloon bitmap, positioned \_b images, text and inline images, foreground images,
// scroll arrows, and the choice/anchor highlight. Layers and clipping follow BA §3.6/§8: background images and text are
// clipped to the balloon's own shape (source-atop), text also to validRect's rows and inline images to validRect;
// foreground images are not clipped. The view gives them (and the arrows) a canvas of their own above the content,
// because the content canvas carries the balloon's clip-path. Highlight (BA §3.8): blendmethod none paints the brush under the text and recolours it; with a ROP2
// blendmethod SSP 2.9 draws only the pen, so the brush is not drawn at all unless `ropFill` asks for UKADOC's raster
// operation, which is then computed exactly on the composited pixels (SUM C13).
import { css } from './color.js';
import { applyRop } from './rop.js';
import { drawFallbackPart } from './fallback.js';

/** CSS font shorthand of a font state. */
export function fontCss(f) {
  return `${f.italic ? 'italic ' : ''}${f.bold ? 'bold ' : ''}${f.height}px ${f.name}`;
}

/**
 * Composite RGBA pixels `top` over `base` in place (source-over, straight alpha as getImageData returns them).
 * @param {Uint8ClampedArray} base
 * @param {Uint8ClampedArray} top
 */
export function overPixels(base, top) {
  for (let i = 0; i < base.length; i += 4) {
    const ta = top[i + 3];
    if (!ta) continue;
    if (ta === 255) { base[i] = top[i]; base[i + 1] = top[i + 1]; base[i + 2] = top[i + 2]; base[i + 3] = 255; continue; }
    const t = ta / 255, b = base[i + 3] / 255 * (1 - t), a = t + b;
    for (let c = 0; c < 3; c++) base[i + c] = Math.round((top[i + c] * t + base[i + c] * b) / a);
    base[i + 3] = Math.round(a * 255);
  }
  return base;
}

const OUTLINE = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
let fallbackMarker;

/** Style used for a link in its current state (hovered or not, visited anchors). */
export function linkStyle(link, hovered) {
  const f = link.font;
  if (link.info.kind === 'anchor') return hovered ? f.anchor : link.visited ? f.anchorVisited : f.anchorNS;
  return hovered ? f.cursor : f.cursorNS;
}

export class Painter {
  /** @param {import('./model.js').BalloonModel} model */
  constructor(model) {
    this.m = model;
    this.version = -1;
    this.count = 0;
    this.scroll = -1;
    this.arrows = '';
    this.widths = new Map();
    this.lastFont = '';
    this.loading = 0; // images that could not be drawn yet
    this.split = false; // the last full paint put foreground images and arrows on their own canvas
    this.ropFill = false; // fill square cursors with the brush through their ROP2 blendmethod (UKADOC; not SSP 2.9)
  }

  /** Can the last paint be extended by drawing only the new elements? */
  canAppend() {
    const e = this.m.engine;
    if (e.version !== this.version || e.scrollY !== this.scroll || this.arrows !== this._arrowState()) return false;
    if (e.elements.length < this.count) return false;
    for (let i = this.count; i < e.elements.length; i++) if (e.elements[i].t === 'p') return false;
    if (this.hasFg && !this.split) return false; // on the content canvas they must stay above new text
    return true;
  }

  _arrowState() {
    const e = this.m.engine;
    return (e.scrollY > 0 ? 'u' : '') + (e.scrollY < e.maxScroll ? 'd' : '');
  }

  /**
   * Paint the balloon. Contexts are already scaled to CSS pixels of the balloon image.
   * @param {CanvasRenderingContext2D} ctx  content
   * @param {boolean} full
   * @param {CanvasRenderingContext2D|null} [fctx]  foreground images and arrows (stacked above ctx); null = on ctx
   */
  paint(ctx, full, fctx = null) {
    const m = this.m, e = m.engine, g = e.geo, img = m.img;
    ctx.imageSmoothingEnabled = false;
    ctx.textBaseline = 'top';
    this.lastFont = '';
    const from = full ? 0 : this.count;
    if (full) {
      this.loading = 0;
      this.hasFg = false;
      ctx.globalCompositeOperation = 'source-over';
      ctx.clearRect(0, 0, m.width, m.height);
      const bg = img ? m.skin.sourceOf(img) : null;
      if (bg) ctx.drawImage(bg, 0, 0);
      else { ctx.fillStyle = 'rgb(250,250,255)'; ctx.fillRect(0, 0, m.width, m.height); }
      ctx.globalCompositeOperation = 'source-atop';
      for (const el of e.elements) {
        if (el.t !== 'p') continue;
        if (el.fg) { this.hasFg = true; continue; }
        this._image(ctx, el, el.x, el.y - (el.fixed ? 0 : e.scrollY));
      }
      const hl = m.hoverLink >= 0 ? e.links[m.hoverLink] : null;
      if (hl) {
        const st = linkStyle(hl, true);
        if (st.method === 'none' && st.style.includes('square')) {
          ctx.fillStyle = css(st.brush);
          for (const r of e.linkRects(m.hoverLink)) ctx.fillRect(r.x, r.y, r.w, r.h);
        }
      }
    } else {
      ctx.globalCompositeOperation = 'source-atop';
    }
    // Text is clipped to validRect's rows only: SSP draws each run with ExtTextOut clipped to validrect widened to the
    // run and limited to the image [disasm 2.9.10 BTextOut 0x5ce528–0x5ce552], so the character that crosses the wrap
    // point shows whole past validrect.right. Inline images keep the whole validRect (SSP's handling not traced).
    ctx.save();
    const vr = g.validRect;
    ctx.beginPath();
    ctx.rect(0, vr.top, m.width, vr.bottom - vr.top);
    ctx.clip();
    const ox = g.originX, oy = g.originY - e.scrollY;
    const els = e.elements;
    for (let i = from; i < els.length; i++) {
      const el = els[i];
      if (el.t === 'p' || el.missing) continue;
      const y = oy + el.y + el.dy;
      if (y > vr.bottom || y + el.h < vr.top) continue;
      if (el.t === 'g') { this._glyph(ctx, el, ox + el.x, y); continue; }
      ctx.save();
      ctx.beginPath();
      ctx.rect(vr.left, vr.top, vr.right - vr.left, vr.bottom - vr.top);
      ctx.clip();
      this._image(ctx, el, ox + el.x, y);
      ctx.restore();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
    if (full) {
      const top = fctx || ctx;
      if (fctx) {
        fctx.globalCompositeOperation = 'source-over';
        fctx.imageSmoothingEnabled = false;
        fctx.clearRect(0, 0, m.width, m.height);
      }
      for (const el of els) if (el.t === 'p' && el.fg) this._image(top, el, el.x, el.y - (el.fixed ? 0 : e.scrollY));
      this._arrows(top);
      this.split = !!fctx;
    }
    this.version = e.version;
    this.count = els.length;
    this.scroll = e.scrollY;
    this.arrows = this._arrowState();
  }

  _arrows(ctx) {
    const m = this.m, e = m.engine, g = e.geo;
    for (const i of [0, 1]) {
      if (i === 0 ? e.scrollY <= 0 : e.scrollY >= e.maxScroll) continue;
      const part = m.skin.arrow(i, m.scope);
      const src = part ? m.skin.sourceOf(part) : drawFallbackPart('arrow' + i);
      if (src) ctx.drawImage(src, g['arrow' + i].x, g['arrow' + i].y);
    }
  }

  _source(el) {
    const m = this.m;
    if (el.img.key === 'part:marker') {
      const p = m.skin.marker(m.scope);
      if (p) return m.skin.sourceOf(p);
      if (fallbackMarker === undefined) fallbackMarker = drawFallbackPart('marker');
      return fallbackMarker;
    }
    return m.images ? m.images.source(el.img) : null;
  }

  _image(ctx, el, x, y) {
    const src = this._source(el);
    if (!src) { if (!el.missing) this.loading++; return; }
    const c = el.clip;
    if (c) ctx.drawImage(src, c[0], c[1], c[2] - c[0], c[3] - c[1], x, y, c[2] - c[0], c[3] - c[1]);
    else ctx.drawImage(src, x, y);
  }

  _width(ctx, fc, ch) {
    const k = fc + '\u0000' + ch;
    let w = this.widths.get(k);
    if (w === undefined) {
      w = ctx.measureText(ch).width;
      if (this.widths.size > 4000) this.widths.clear();
      this.widths.set(k, w);
    }
    return w;
  }

  _glyph(ctx, el, x, y) {
    const f = el.font, m = this.m;
    let color = f.color;
    if (el.link >= 0) {
      const link = m.engine.links[el.link];
      if (link.info.kind === 'anchor') color = link.visited ? link.font.anchorVisited.font : link.font.anchorColor;
      if (el.link === m.hoverLink) {
        const st = linkStyle(link, true);
        if (st.method === 'none' && st.style.includes('square')) color = st.font;
      }
    }
    const ch = el.ch;
    const blank = ch === ' ' || ch === '　';
    if (!blank) {
      const fc = fontCss(f);
      if (fc !== this.lastFont) { ctx.font = fc; this.lastFont = fc; }
      const mw = this._width(ctx, fc, ch);
      const dx = mw < el.w - 0.5 ? (el.w - mw) / 2 : 0;
      if (f.shadow) {
        ctx.fillStyle = css(f.shadow);
        for (const [sx, sy] of f.shadowStyle === 'outline' ? OUTLINE : [[1, 1]]) ctx.fillText(ch, x + dx + sx, y + sy, el.w);
      }
      if (f.outline) {
        ctx.strokeStyle = css(color);
        ctx.lineWidth = 1;
        ctx.strokeText(ch, x + dx, y, el.w);
      } else {
        ctx.fillStyle = css(color);
        ctx.fillText(ch, x + dx, y, el.w);
      }
    }
    if (f.strike || f.underline) {
      ctx.fillStyle = css(color);
      const t = Math.max(1, Math.round(f.height / 12));
      if (f.strike) ctx.fillRect(x, y + Math.round(f.height * 0.55), el.w, t);
      if (f.underline) ctx.fillRect(x, y + f.height - t, el.w, t);
    }
  }

  /**
   * Draw the choice/anchor highlight onto the overlay canvas (raw pixel coordinates = CSS px × dpr): the pen
   * rectangle and/or underline. The brush of blendmethod none is painted under the text by paint().
   * @param {CanvasRenderingContext2D} octx  overlay context, scaled like the main one
   * @param {CanvasRenderingContext2D} mctx  main context (source pixels for the ROP, with ropFill)
   * @param {CanvasRenderingContext2D|null} [fctx]  foreground canvas between main and overlay (composited first)
   */
  paintHover(octx, mctx, dpr, fctx = null) {
    const m = this.m, e = m.engine;
    octx.setTransform(1, 0, 0, 1, 0, 0);
    octx.clearRect(0, 0, octx.canvas.width, octx.canvas.height);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (!m.visible) return;
    for (let li = 0; li < e.links.length; li++) {
      const hovered = li === m.hoverLink;
      const st = linkStyle(e.links[li], hovered);
      if (!st || st.style === 'none') continue;
      const rects = e.linkRects(li);
      if (!rects.length) continue;
      const square = st.style.includes('square');
      for (const r of rects) {
        if (square && this.ropFill && st.method !== 'none') {
          const sx = Math.round(r.x * dpr), sy = Math.round(r.y * dpr);
          const sw = Math.round((r.x + r.w) * dpr) - sx, sh = Math.round((r.y + r.h) * dpr) - sy;
          if (sw > 0 && sh > 0) {
            try {
              const id = mctx.getImageData(sx, sy, sw, sh);
              if (fctx && this.split && (this.hasFg || this.arrows)) overPixels(id.data, fctx.getImageData(sx, sy, sw, sh).data);
              applyRop(id.data, st.method, st.brush);
              octx.putImageData(id, sx, sy);
            } catch (err) { /* tainted canvas: no highlight */ }
          }
        }
        octx.fillStyle = css(st.pen);
        if (square) {
          octx.fillRect(r.x, r.y, r.w, 1);
          octx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
          octx.fillRect(r.x, r.y, 1, r.h);
          octx.fillRect(r.x + r.w - 1, r.y, 1, r.h);
        }
        if (st.style.includes('underline')) octx.fillRect(r.x, r.y + r.h - 1, r.w, 1);
      }
    }
  }
}
