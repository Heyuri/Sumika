// Where a balloon goes next to its character (BA §4, UI §4.1) and where input boxes go (BA §5). Pure.
// Phones (ssp-ui.md §9.11, Sumika's own): the overhead fallback and the balloon fit (balloonFit).

/**
 * @typedef {{x:number, y:number, width:number, height:number}} Rect
 * @param {object} o
 * @param {Rect} o.char              the scope's character rect in viewport px (its base surface)
 * @param {{w:number,h:number}} o.size  balloon image size
 * @param {{x:number,y:number}} [o.offset]  shell balloon offset (+x toward the character, +y down)
 * @param {string} [o.align]         'none' | 'left' | 'right' | 'top' | 'bottom' ('center' = 'top')
 * @param {'left'|'right'|null} [o.prefer]  side the user chose with a right click
 * @param {{x:number|string, y:number, limit:boolean}} [o.windowPosition]  balloon descript windowposition.*
 * @param {{x:number,y:number}} [o.userOffset]
 * @param {{width:number,height:number}} o.viewport
 * @param {boolean} [o.overhead]     phones only (Balloons with `phone`): neither side fits → above her head
 * @returns {{x:number, y:number, side:'left'|'right'|'top'|'bottom'}}
 */
export function placeBalloon(o) {
  const S = o.char, B = o.size, vw = o.viewport.width, vh = o.viewport.height;
  const off = o.offset || { x: 0, y: 0 };
  const wp = o.windowPosition || { x: 0, y: 0, limit: true };
  let align = String(o.align || 'none').toLowerCase();
  if (align === 'center') align = 'top';
  const left = S.x - B.w + off.x, right = S.x + S.width - off.x;
  let side, over = false;
  if (wp.x === 'top' || wp.x === 'bottom') side = wp.x;
  else if (align === 'left' || align === 'right' || align === 'top' || align === 'bottom') side = align;
  else {
    // left unless the user chose the right (right click); the side changes only when the balloon would be cut off
    // and the other side has room, never because the character crossed the middle of the screen [observed]
    side = o.prefer || 'left';
    if (side === 'left' && left < 0 && right + B.w <= vw) side = 'right';
    else if (side === 'right' && right + B.w > vw && left >= 0) side = 'left';
    // a phone: room on neither side → centred above her head, the shell's offsets (tuned for beside) left out;
    // never below her (she stands on the bottom edge) [decision, ssp-ui.md §9.11]
    if (o.overhead && left < 0 && right + B.w > vw) { side = 'top'; over = true; }
  }
  let x, y;
  if (side === 'left') { x = left; y = S.y + off.y; }
  else if (side === 'right') { x = right; y = S.y + off.y; }
  else if (side === 'top' && over) { x = S.x + S.width / 2 - B.w / 2; y = S.y - B.h; }
  else if (side === 'top') { x = S.x + S.width / 2 - B.w / 2 + off.x; y = S.y - B.h + off.y; }
  else { x = S.x + S.width / 2 - B.w / 2 + off.x; y = S.y + S.height + off.y; }
  if (typeof wp.x === 'number') x += wp.x;
  y += wp.y || 0;
  if (o.userOffset) { x += o.userOffset.x || 0; y += o.userOffset.y || 0; }
  if (wp.limit !== false) {
    x = Math.max(0, Math.min(x, vw - B.w));
    y = Math.max(0, Math.min(y, vh - B.h));
  }
  return { x: Math.round(x), y: Math.round(y), side };
}

/** CSS px: Apple's smallest text size; LightBlue's 12-px font may go to 11 (ssp-ui.md §9.11) */
export const READABLE_PX = 11;

/**
 * The phone default of Balloon scaling (CSS px per image px) [decision, ssp-ui.md §9.11]: the widest balloon
 * (balloons*, balloonk*, balloonp*; not the input box) within the short side, its font never below READABLE_PX unless
 * the screen itself is narrower (text cut off by the edge cannot be read at all), never enlarged. 1 for a page
 * without a mobile viewport (phone.mobileView false: the browser already shrinks it) or a skin without images.
 * @param {{images?: Map<string,{w:number}>, font?: {height:number}}|null} skin  BalloonSkin
 * @param {{short:number, long:number, mobileView:boolean}|null} phone
 */
export function balloonFit(skin, phone) {
  let w = 0;
  for (const [name, img] of (skin && skin.images) || []) if (/^balloon[skp]\d/i.test(name)) w = Math.max(w, img.w);
  if (!(w > 0) || !phone || !phone.mobileView) return 1;
  const H = (skin.font && skin.font.height) || 12;
  return Math.min(1, phone.short / w, Math.max((phone.short - 16) / w, READABLE_PX / H));
}

/**
 * Input/communicate box position (BA §5, UI §6.1): an explicit position wins; otherwise below the scope's balloon,
 * left-aligned; otherwise centred above the character. Boxes already open are stacked under each other.
 * @param {object} o
 * @param {{w:number,h:number}} o.size
 * @param {{x:number,y:number}|null} [o.at]       SHIORI resource <box>.defaultleft/defaulttop
 * @param {Rect|null} [o.balloon]                 the scope's visible balloon
 * @param {Rect|null} [o.char]                    the scope's character
 * @param {number} [o.index]                      boxes already open
 * @param {{width:number,height:number}} o.viewport
 */
export function placeBox(o) {
  const B = o.size, vw = o.viewport.width, vh = o.viewport.height, gap = 4;
  const stack = (o.index || 0) * (B.h + gap);
  let x, y;
  if (o.at) { x = o.at.x; y = o.at.y + stack; }
  else if (o.balloon) { x = o.balloon.x; y = o.balloon.y + o.balloon.height + gap + stack; }
  else if (o.char) { x = o.char.x + o.char.width / 2 - B.w / 2; y = o.char.y - B.h - 8 - stack; }
  else { x = (vw - B.w) / 2; y = vh / 2 - B.h / 2 + stack; }
  if (!o.at && o.balloon && y + B.h > vh && o.char) y = o.char.y - B.h - 8 - stack;
  x = Math.max(0, Math.min(x, vw - B.w));
  y = Math.max(0, Math.min(y, vh - B.h));
  return { x: Math.round(x), y: Math.round(y) };
}
