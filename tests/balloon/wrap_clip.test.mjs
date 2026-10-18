// The wrap point and the text clip at a balloon's right edge (BA §2.1, §3.9), on BloodTeaHOUSE ver.5's own balloon
// convulsions (site/ghost/bthver.5/convulsions: validrect.right -38, wordwrappoint.x -23, 200 px wide). ssp.exe caps the
// wrap point at validrect.right [disasm 2.9.10 CreateBackBuffer 0x5c9fd6–0x5c9ffd] and never clips text horizontally
// [disasm BTextOut 0x5ce528–0x5ce552]; SSP screenshots show the two lines below laid out that way, and a clip at the
// validrect would hide the last characters of every full line.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DiskFiles, ROOT } from './node_helpers.mjs';
import { play } from './script.mjs';
import { skinGeometry } from '../../src/balloon/geometry.js';
import { BalloonSkin } from '../../src/balloon/skin.js';
import { Balloons } from '../../src/balloon/manager.js';
import { Painter } from '../../src/balloon/paint.js';
import { setLogLevel } from '../../src/core/log.js';
import { needs } from '../needs.mjs';

setLogLevel('error');
const BTH = path.join(ROOT, 'site/ghost/bthver.5');
const convulsions = needs('site/ghost/bthver.5');

const CONVULSIONS = new Map([['origin.x', '17'], ['origin.y', '25'], ['validrect.left', '17'], ['validrect.top', '25'],
  ['validrect.right', '-38'], ['validrect.bottom', '-43'], ['wordwrappoint.x', '-23'], ['font.height', '12']]);

test('geometry: the wrap point is capped at validrect.right; one inside it is kept; a missing one is validrect.right', () => {
  const g = skinGeometry(CONVULSIONS, 200, 184);
  assert.deepEqual(g.validRect, { left: 17, top: 25, right: 162, bottom: 141 });
  assert.equal(g.originX, 17);
  assert.equal(g.lineLimit, 145, 'min(177, 162) - 17');
  const inside = skinGeometry(new Map([...CONVULSIONS, ['wordwrappoint.x', '-50']]), 200, 184);
  assert.equal(inside.lineLimit, 150 - 17, 'a wrap point left of validrect.right stays');
  const none = new Map(CONVULSIONS);
  none.delete('wordwrappoint.x');
  assert.equal(skinGeometry(none, 200, 184).lineLimit, 145);
});

/** convulsions as the site has it, and a run(script) that lays a script out in its scope */
async function bth() {
  const ghost = new DiskFiles(BTH);
  const skin = await BalloonSkin.load(ghost.sub('convulsions'), { decode: false });
  const b = new Balloons({ skin, ghostFiles: ghost, root: null, stage: null, ghostDescript: new Map(), options: { wordWrap: true } });
  b.images.decode = false;
  return { b, run: script => play(b, script, {}) };
}
/** each row's text, and the balloon-space x range of its glyphs */
function rows(b, scope) {
  const e = b.get(scope).engine, g = e.geo;
  const out = new Map();
  for (const el of e.elements) {
    if (el.t !== 'g') continue;
    const r = out.get(el.y) || { text: '', from: Infinity, to: 0 };
    r.text += el.ch;
    r.from = Math.min(r.from, g.originX + el.x);
    r.to = Math.max(r.to, g.originX + el.x + el.w);
    out.set(el.y, r);
  }
  return [...out.values()];
}

test('two BloodTeaHOUSE lines break as in SSP screenshots (13 characters; a hanging ？ makes 14)',
  convulsions, async () => {
    const { b, run } = await bth();
    await run('\\0\\s[115]水ないからいちご牛乳でいい？\\1\\s[302]え、まさか闇鍋食べる気なのかい？\\e');
    assert.equal(b.get(0).engine.geo.lineLimit, 145);
    assert.deepEqual(rows(b, 0), [{ text: '水ないからいちご牛乳でいい？', from: 17, to: 185 }], 'blood_01.txt:826');
    assert.deepEqual(rows(b, 1).map(r => r.text), ['え、まさか闇鍋食べる気なの', 'かい？'], 'blood_01.txt:791');
    assert.equal(rows(b, 1)[0].to, 173, 'の at 161-173, past validrect.right 162');
  });

/** a 2D context that records calls (with the clip in effect) and keeps no pixels */
function recorder() {
  const calls = [];
  const state = { globalCompositeOperation: 'source-over', font: '', fillStyle: '', strokeStyle: '' };
  const stack = [];
  let clip = null, path = [];
  const ctx = new Proxy(state, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 200, height: 184 };
      if (k === 'save') return () => stack.push({ ...state, clip });
      if (k === 'restore') return () => { const s = stack.pop(); clip = s.clip; delete s.clip; Object.assign(state, s); };
      if (k === 'beginPath') return () => { path = []; };
      if (k === 'rect') return (...a) => path.push(a);
      if (k === 'clip') return () => { clip = path[path.length - 1]; };
      if (k === 'measureText') return s => ({ width: [...s].length * 6 });
      return (...a) => calls.push([k, clip, ...a]);
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  return { ctx, calls };
}

test('paint: text is clipped to validRect\'s rows only, so the character past validrect.right is drawn whole',
  convulsions, async () => {
    const { b, run } = await bth();
    await run('\\0\\s[115]水ないからいちご牛乳でいい？\\e');
    const v = b.get(0);
    v.skin.sourceOf = () => null;
    const { ctx, calls } = recorder();
    new Painter(v).paint(ctx, true);
    const texts = calls.filter(c => c[0] === 'fillText');
    const last = texts.find(c => c[2] === '？');
    assert.ok(last, '？ is drawn');
    assert.ok(last[3] >= 173 && last[3] < 185, `in its cell 173-185 (centred there: ${last[3]})`);
    assert.deepEqual(last[1], [0, 25, 200, 116], 'clipped to the rows of validRect, the whole image wide');
    assert.ok(texts.every(c => c[1][0] === 0 && c[1][2] === 200), 'no glyph is clipped at validrect.left/right');
  });
