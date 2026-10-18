// Geometry while images load asynchronously (as they always do in a browser on first use): first-boot layout
// independent of decode order, \s + \![move] in the same instant, geometryReady(), sizes known up front.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Stage } from '../../src/shell/stage.js';
import { SurfaceRenderer } from '../../src/shell/render.js';
import { FsFiles, SizedFiles, GHOST, SHELL_DIR, FakeClock, delayedDecode, pngSize, tsubasaShell, fsImages } from './helpers.mjs';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');
const DESK = { w: 1280, h: 720 };

async function make({ files = new FsFiles(GHOST), delay = () => 5 } = {}) {
  const clock = new FakeClock(0);
  const events = [];
  const stage = await Stage.create({ files, dom: false, decode: delayedDecode(delay), clock, random: () => 0.99, desk: DESK });
  for (const t of ['surface', 'bind', 'move']) stage.on(t, e => events.push([t, e]));
  const idle = () => stage.images.pending.size === 0 && stage.images.queue.length === 0;
  const settle = async () => {
    for (let i = 0, calm = 0; i < 400 && calm < 3; i++) {
      stage.tick(clock.now());
      await new Promise(r => setTimeout(r, 2));
      calm = idle() ? calm + 1 : 0;
    }
  };
  return { stage, clock, events, settle };
}

/** the player's \![move,x,y,time,screen,<corner>,<corner>] target (sakura/commands.js moveTarget), inline */
function cornerMove(v, corner, dx = 0, dy = 0) {
  const [h, vv] = corner.split('.');
  const pick = (r, which, a, b) => (which === a ? 0 : which === b ? 1 : 0.5);
  const fx = pick(null, h, 'left', 'right'), fy = pick(null, vv, 'top', 'bottom');
  const r = v.rect, bp = v.basePoint;
  const anchor = { x: DESK.w * fx + dx, y: DESK.h * fy + dy };
  const cur = { x: r.x + r.width * fx, y: r.y + r.height * fy };
  v.moveTo(Math.round(bp.x + anchor.x - cur.x), Math.round(bp.y + anchor.y - cur.y));
}

test('first boot: \\1 waits for \\0\'s size even when its own tiny image decodes first', real, async () => {
  // big files decode last, as over a network: surface10.png (4x4) is ready long before surface0000.png
  const { stage, events, settle } = await make({ delay: b => (b.byteLength > 2000 ? 300 : 0) });
  const moves1 = [];
  stage.on('move', e => { if (e.scope === 1) moves1.push(stage.char(1).rect); });
  await settle();
  const surf = events.filter(e => e[0] === 'surface').map(e => e[1].scope);
  assert.deepEqual(surf, [1, 0], 'the race happened: scope 1 knew its size first');
  const s0 = stage.char(0), s1 = stage.char(1);
  assert.deepEqual(s0.rect, { x: 1060, y: 340, width: 220, height: 380 });
  assert.deepEqual(s1.rect, { x: 1056, y: 716, width: 4, height: 4 });      // flush against \0's left edge (UI §3.2)
  assert.ok(moves1.length && moves1.every(r => r.x === 1056), JSON.stringify(moves1));
  const st = stage.saveState();
  assert.ok(Math.abs(st.scopes[1].pos.rx - 1058 / 1280) < 1e-9, 'the persisted position is the laid-out one');
  // a new, still loading surface on \0 keeps its old geometry for the layout: nothing waits
  s0.setSurface(1);
  assert.equal(s0.geometryPending, true);
  stage.resetPositions();
  assert.deepEqual(s1.rect, { x: 1056, y: 716, width: 4, height: 4 });
});

test('\\s then \\![move] in the same instant: geometryPending, geometryReady, and a stale move is corrected', real, async () => {
  const { stage, settle } = await make({ delay: () => 15 });
  await settle();
  // Tsubasa: \p[10]\s[951]\![set,alignmentondesktop,free]\![move,0,0,1,screen,right.top,right.top]
  const v = stage.char(10);
  assert.equal(v.geometryPending, false);                 // default surface 10: \1 already decoded that image
  v.setSurface(951);
  assert.equal(v.geometryPending, true);
  assert.deepEqual([v.rect.width, v.rect.height], [4, 4]);  // still the previous surface's rect
  let ready = false;
  v.geometryReady().then(() => { ready = true; });
  v.setAlignment('free');
  cornerMove(v, 'right.top');
  await settle();
  assert.ok(ready);
  assert.deepEqual(v.rect, { x: 650, y: 0, width: 630, height: 350 });
  const p = stage.char(9);
  p.setSurface(950);
  p.setAlignment('free');
  cornerMove(p, 'left.top');
  await settle();
  assert.deepEqual(p.rect, { x: 0, y: 0, width: 630, height: 350 });
  // a caller that awaits geometryReady() gets exact results, also for moves the clamp could not guess
  const c = stage.char(18);
  c.setSurface(9420);
  c.setAlignment('free');
  await c.geometryReady();
  cornerMove(c, 'center.top', 0, 50);
  assert.equal(c.rect.y, 50);
  assert.equal(c.rect.x + c.rect.width / 2, 640);
  // geometryReady resolves for hidden views too (whenReady waits for a paint, which never comes)
  const h = stage.char(11);
  h.hide();
  h.setSurface(941);
  await h.geometryReady();
  assert.equal(h.geometryPending, false);
  assert.ok(h.rect.width > 4);
  // \s[-1] resolves a pending wait
  const k = stage.char(12);
  k.setSurface(940);
  const w = k.geometryReady();
  k.setSurface(-1);
  await w;
});

test('a move with the right size is not clamped; scaling keeps the geometry while a surface loads', real, async () => {
  const { stage, settle } = await make({ delay: () => 10 });
  await settle();
  const v = stage.char(0);
  v.setAlignment('free');
  v.setSurface(1);                                        // same body size as surface 0, not loaded yet
  assert.equal(v.geometryPending, true);
  v.moveTo(1200, 500);                                    // deliberately half off the desk
  v.setScaling(-100, 100);                                // \![set,scaling] mirrored, same instant
  assert.ok(v._geom, 'geometry kept');
  assert.equal(v.rect.width, 220);
  await settle();
  assert.deepEqual(v.basePoint, { x: 1200, y: 500 });
  assert.equal(v.rect.x + v.rect.width > 1280, true);
});

test('image sizes known up front (files.imageSize): geometry is synchronous, no wait at all', real, async () => {
  const { stage, settle } = await make({ files: new SizedFiles(GHOST), delay: () => 15 });
  const v = stage.char(10);
  assert.equal(v.geometryPending, false);
  v.setSurface(951);
  assert.equal(v.geometryPending, false);
  assert.deepEqual([v.rect.width, v.rect.height], [630, 350]);
  v.setAlignment('free');
  cornerMove(v, 'right.top');
  assert.deepEqual(v.rect, { x: 650, y: 0, width: 630, height: 350 });
  await settle();
  assert.deepEqual(v.rect, { x: 650, y: 0, width: 630, height: 350 });
  // first boot needs no waiting either
  assert.deepEqual(stage.char(1).rect, { x: 1056, y: 716, width: 4, height: 4 });
});

test('baseRect from sizes equals baseRect from decoded images (element surfaces included)', real, () => {
  const { shell } = tsubasaShell();
  const sizes = new Map();
  const size = p => {
    if (!sizes.has(p)) sizes.set(p, pngSize(path.join(SHELL_DIR, p)));
    return sizes.get(p);
  };
  const bySize = new SurfaceRenderer(shell, { get: () => undefined, size });
  const decoded = new SurfaceRenderer(shell, fsImages());
  const ids = shell.surfaceIds().filter(id => shell.surface(id).elements.length).slice(0, 40);
  ids.push(0, 10, 951, 9420);
  assert.ok(ids.length > 20);
  for (const id of ids) assert.deepEqual(bySize.baseRect(id), decoded.baseRect(id), 'surface ' + id);
  // an unknown size keeps it pending
  assert.equal(new SurfaceRenderer(shell, { get: () => undefined, size: () => undefined }).baseRect(0), null);
});

test('a surface drawn from surfaceN.png beside element1 settles to their union, sizes known up front or not', async () => {
  const { parseShell } = await import('../../src/shell/surfaces.js');
  const dim = { 'surface0.png': [100, 100], 'arm.png': [20, 20], 'surface10.png': [4, 4] };
  for (const sized of [true, false]) {
    const clock = new FakeClock(0);
    const shellFiles = {
      has: p => p in dim, resolve: p => (p in dim ? p : null), list: () => Object.keys(dim),
      ...(sized ? { imageSize: p => (dim[p] ? { width: dim[p][0], height: dim[p][1] } : undefined) } : {}),
      bytes: async () => new ArrayBuffer(8),
    };
    const decode = async (bytes, p) => {
      await new Promise(r => setTimeout(r, 3));
      const [w, h] = dim[p];
      const data = new Uint8Array(w * h * 4);
      data.fill(255, 4);                                   // pixel 0,0 is the colour key, the rest opaque white
      return { width: w, height: h, data };
    };
    const shell = parseShell({ descript: '', surfaces: [{ name: 'surfaces.txt', text: 'surface0\n{\nelement1,overlay,arm.png,110,0\n}\n' }], files: Object.keys(dim) });
    const stage = new Stage({ shell, shellFiles, shellId: 'master', dom: false, decode, clock, desk: DESK });
    const v = stage.char(0);
    for (let i = 0; i < 300 && !(v.rect && v.rect.width === 130 && stage.images.pending.size === 0); i++) {
      stage.tick(clock.now());
      await new Promise(r => setTimeout(r, 2));
    }
    assert.deepEqual([v.rect.width, v.rect.height], [130, 100], sized ? 'sizes known' : 'sizes from decoding');
  }
});
