// Canvases a ghost draws on (CLAUDE.md "Browsers"): WebKit caps the canvas memory of a page (on iOS about a quarter of
// the device's RAM, every canvas counted until it is collected) [verify]. Over the cap getContext('2d') answers null,
// and a canvas resized after it got its context gets no backing store: no exception, it draws nothing, reads back
// zeros. A ghost with a canvas found unable to draw is ended like a failed start (Runtime._canvasLost): no half-drawn
// ghost, no invisible shape that still takes taps. Found: getContext null, or a canvas's first backing store read back
// empty (backingLost, once per canvas). Not found (a known limit, ssp-ui.md §9.11 S5): a backing store refused at a
// later resize (a surface of another size, a balloon growing, Shell / Balloon scaling, a device-pixel-ratio change);
// that character or balloon then draws nothing while it still takes taps. With every canvas granted (the usual case)
// nothing here changes a pixel.

/** The error a decoder throws when its canvas got no 2D context (isCanvasLost tells it apart). */
export function canvasLostError(what = 'canvas') {
  return Object.assign(new Error(`${what}: no 2D context (the browser's canvas memory?)`), { name: 'CanvasLost' });
}

/** @returns {boolean} e is canvasLostError's */
export function isCanvasLost(e) {
  return !!e && e.name === 'CanvasLost';
}

/**
 * Whether a freshly sized canvas got no backing store: one opaque pixel drawn at its top left is read back (alpha 0 =
 * none) and cleared again, the context's state restored. Call it only on a canvas just sized (so cleared), and once per
 * canvas: Chromium warns ("Multiple readback operations using getImageData…") at a canvas's second getImageData
 * [measured in Chromium: one read, no warning; two reads, the warning] and moves that canvas from
 * the GPU to software rendering [infer: Chromium's readback fallback, not measured]. A canvas of no size, a context
 * without getImageData, or a read that throws counts as granted (false).
 * @param {CanvasRenderingContext2D|OffscreenCanvasRenderingContext2D|null} ctx
 * @returns {boolean}
 */
export function backingLost(ctx) {
  if (!ctx || typeof ctx.getImageData !== 'function') return false;
  const c = ctx.canvas;
  if (!c || !(c.width > 0) || !(c.height > 0)) return false;
  let saved = false;
  try {
    ctx.save();
    saved = true;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, 1, 1);
    const a = ctx.getImageData(0, 0, 1, 1).data[3];
    ctx.clearRect(0, 0, 1, 1);
    return a === 0;
  } catch (e) {
    return false;
  } finally {
    if (saved) { try { ctx.restore(); } catch (e) { /* ignore */ } }
  }
}

/**
 * Give a temporary canvas's memory back at once (WebKit counts it against the cap until it is collected): size 0×0.
 * For decode canvases after their pixels were read; never for a canvas something still draws from.
 * @param {HTMLCanvasElement|OffscreenCanvas|null} c
 */
export function releaseCanvas(c) {
  if (!c) return;
  try {
    c.width = 0;
    c.height = 0;
  } catch (e) { /* ignore */ }
}
