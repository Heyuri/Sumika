// The part of the page the visitor sees, for keeping the runtime's text boxes above a phone's on-screen keyboard
// (UI §9.11, §6.4). The keyboard and pinch zoom shrink the visual viewport, not the layout viewport the boxes live in
// (position:absolute in the fixed 0×0 host, root.js; layers.js); visualViewport's offsetLeft / offsetTop are relative
// to that layout viewport, so they are the boxes' own coordinates (never pageTop). Only phone code calls this module
// (balloon/dialogs.js and ui/settings.js with their `phone` option): a desktop window never gets its listeners.
// Vertical only and nothing while zoomed [decision]: the keyboard takes height, never width, and visualViewport's
// events also fire on every pan of a pinch zoom, where a box pinned to the visible part could never be reached.

/**
 * The visible part of the layout viewport in layout-viewport CSS px, with the visual viewport's scale (pinch zoom);
 * without visualViewport (an old browser) the layout viewport itself, scale 1.
 * @param {Window|null} [win]
 * @returns {{x:number, y:number, width:number, height:number, scale:number}}
 */
export function visibleRect(win = typeof window !== 'undefined' ? window : null) {
  const vv = win && win.visualViewport;
  if (vv) return { x: vv.offsetLeft || 0, y: vv.offsetTop || 0, width: vv.width, height: vv.height, scale: vv.scale || 1 };
  const doc = (win && win.document) || (typeof document !== 'undefined' ? document : null);
  const de = doc && doc.documentElement;
  return {
    x: 0, y: 0, width: (de && de.clientWidth) || (win && win.innerWidth) || 0,
    height: (de && de.clientHeight) || (win && win.innerHeight) || 0, scale: 1,
  };
}

/** Pinch zoom (or a browser's own zoom into a field) is on: the boxes are left where they are. */
export const zoomed = vis => Math.abs(((vis && vis.scale) || 1) - 1) > 0.01;

/**
 * The vertical shift that brings a box {y, h} inside vis, `margin` px in: up when its bottom is below the visible part
 * (the keyboard), down when its top is above it; a box taller than the visible part shows its top. Pure.
 * @param {{y:number, h:number}} box
 * @param {{y:number, height:number}} vis visibleRect()
 * @returns {number} dy in layout px; 0 when it fits
 */
export function keepVisible(box, vis, margin = 8) {
  const top = vis.y + margin, bottom = vis.y + vis.height - margin;
  let dy = 0;
  if (box.y + box.h > bottom) dy = bottom - (box.y + box.h);
  if (box.y + dy < top) dy = top - box.y;
  return dy;
}

/**
 * fn(visibleRect(win)) after the visual viewport's resize or scroll (the keyboard, the browser's pan to a field) and
 * the window's resize (browsers whose keyboard resizes the layout viewport), at most once per frame.
 * @param {Window|null} win
 * @param {(vis: ReturnType<typeof visibleRect>) => void} fn
 * @returns {() => void} off: removes every listener; a frame already asked for does nothing
 */
export function watchVisible(win, fn) {
  if (!win || typeof win.addEventListener !== 'function') return () => {};
  const vv = win.visualViewport && typeof win.visualViewport.addEventListener === 'function' ? win.visualViewport : null;
  const frame = typeof win.requestAnimationFrame === 'function' ? f => win.requestAnimationFrame(f)
    : typeof requestAnimationFrame === 'function' ? f => requestAnimationFrame(f) : f => setTimeout(f, 16);
  let live = true, queued = false;
  const run = () => { queued = false; if (live) fn(visibleRect(win)); };
  const kick = () => { if (live && !queued) { queued = true; frame(run); } };
  if (vv) { vv.addEventListener('resize', kick); vv.addEventListener('scroll', kick); }
  win.addEventListener('resize', kick);
  return () => {
    if (!live) return;
    live = false;
    if (vv) { vv.removeEventListener('resize', kick); vv.removeEventListener('scroll', kick); }
    win.removeEventListener('resize', kick);
  };
}
