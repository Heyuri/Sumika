// CSS-like procedural balloon for ghosts without a balloon (BA §9): SSPデフォルト+ metrics, drawn on canvases.
// Only used in a browser; the metrics alone are enough for layout in Node.
import { makeCanvas } from './images.js';

/** descript.txt of the fallback (same text metrics as SSPデフォルト+ and LightBlue: line limit 287). */
export const FALLBACK_DESCRIPT = [
  ['name', 'Sumika default'], ['type', 'balloon'],
  ['validrect.left', '23'], ['validrect.top', '14'], ['validrect.right', '-23'], ['validrect.bottom', '-12'],
  ['wordwrappoint.x', '-25'],
  ['font.height', '12'],
  ['font.color.r', '84'], ['font.color.g', '32'], ['font.color.b', '27'],
  ['font.shadowcolor.r', '195'], ['font.shadowcolor.g', '195'], ['font.shadowcolor.b', '239'],
  ['anchor.font.color.r', '77'], ['anchor.font.color.g', '82'], ['anchor.font.color.b', '194'],
  ['anchor.pen.color.r', '0'], ['anchor.pen.color.g', '0'], ['anchor.pen.color.b', '255'],
  ['cursor.blendmethod', 'notmaskpen'], ['cursor.style', 'square'],
  ['cursor.brush.color.r', '150'], ['cursor.brush.color.g', '100'], ['cursor.brush.color.b', '100'],
  ['cursor.pen.color.r', '84'], ['cursor.pen.color.g', '32'], ['cursor.pen.color.b', '27'],
  ['cursor.font.color.r', '0'], ['cursor.font.color.g', '0'], ['cursor.font.color.b', '0'],
  ['arrow0.x', '-20'], ['arrow0.y', '8'], ['arrow1.x', '-20'], ['arrow1.y', '-18'],
  ['communicatebox.x', '8'], ['communicatebox.y', '18'], ['communicatebox.width', '301'], ['communicatebox.height', '18'],
];

/** name -> [w, h, tail centre row or -1] */
export const FALLBACK_IMAGES = {
  balloons0: [335, 169, 66], balloons1: [335, 169, 66], balloons2: [335, 384, 281], balloons3: [335, 384, 281],
  balloonk0: [335, 96, 50], balloonk1: [335, 96, 50], balloonk2: [335, 169, 66], balloonk3: [335, 169, 66],
  balloonc0: [317, 42, -1], balloonc1: [317, 42, -1], balloonc2: [317, 42, -1], balloonc3: [317, 42, -1],
};

// balloon artwork, not UI text (UI §2.10): English in both UI languages, like SSP's own default balloon
// (balloon/ssp/balloonc1.png reads "Communicate"); the box's accessible names come from core/i18n.js
const BOX_CAPTIONS = ['Script', 'Communicate', 'Teach', 'Input'];

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Draw one fallback image; name is a FALLBACK_IMAGES key. Returns a canvas or null without a DOM. */
export function drawFallback(name) {
  const spec = FALLBACK_IMAGES[name];
  if (!spec) return null;
  const [w, h, tail] = spec;
  const c = makeCanvas(w, h);
  if (!c) return null;
  const ctx = c.getContext('2d');
  const box = tail < 0;
  const n = +name.replace(/\D/g, '');
  const right = !box && n % 2 === 1; // odd images sit right of the character: tail on the left
  const x0 = box ? 0.5 : 9.5, bw = box ? w - 1 : w - 19;
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, 'rgb(214,231,255)');
  g.addColorStop(1, 'rgb(239,247,255)');
  ctx.fillStyle = g;
  ctx.strokeStyle = 'rgb(49,74,132)';
  ctx.lineWidth = 1;
  roundRect(ctx, x0, 0.5, bw, h - 1, box ? 8 : 12);
  ctx.fill();
  ctx.stroke();
  if (!box) {
    const ty = tail + 0.5;
    ctx.beginPath();
    if (right) { ctx.moveTo(9.5, ty - 4.5); ctx.lineTo(0.5, ty); ctx.lineTo(9.5, ty + 4.5); }
    else { ctx.moveTo(w - 9.5, ty - 4.5); ctx.lineTo(w - 0.5, ty); ctx.lineTo(w - 9.5, ty + 4.5); }
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(right ? 9 : w - 11, ty - 4, 2, 8); // hide the body border under the tail
  } else {
    ctx.fillStyle = 'rgb(49,74,132)';
    ctx.font = '10px sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(BOX_CAPTIONS[n] || '', 10, 4);
  }
  return c;
}

/** Scroll arrow (0 = up, 1 = down) or the \![*] marker dot, 8×8. */
export function drawFallbackPart(kind) {
  const c = makeCanvas(8, 8);
  if (!c) return null;
  const ctx = c.getContext('2d');
  ctx.fillStyle = kind === 'marker' ? 'rgb(84,110,190)' : 'rgb(108,140,255)';
  ctx.beginPath();
  if (kind === 'marker') ctx.arc(4, 4, 3.5, 0, Math.PI * 2);
  else if (kind === 'arrow0') { ctx.moveTo(4, 1); ctx.lineTo(8, 7); ctx.lineTo(0, 7); }
  else { ctx.moveTo(0, 1); ctx.lineTo(8, 1); ctx.lineTo(4, 7); }
  ctx.fill();
  return c;
}
