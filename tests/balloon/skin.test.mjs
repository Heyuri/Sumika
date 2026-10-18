import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixture } from './setup.mjs';
import { ROOT } from './node_helpers.mjs';
import { BalloonSkin, balloonFamilies, siteBalloonId } from '../../src/balloon/skin.js';
import { resolveCoord, resolveEdge, skinGeometry, skinFont, mergeCfg } from '../../src/balloon/geometry.js';
import { needs } from '../needs.mjs';

const real = needs('site/ghost/tsubasa');

test('LightBlue: descript and per-image files', real, async () => {
  const { skin } = await fixture();
  assert.equal(skin.name, 'LightBlue');
  assert.equal(skin.isFallback, false);
  const names = [...skin.images.keys()].sort();
  assert.deepEqual(names, ['balloonc0', 'balloonc1', 'balloonc2', 'balloonc3', 'balloonk0', 'balloonk1', 'balloonk2', 'balloonk3',
    'balloonk4', 'balloonk5', 'balloons0', 'balloons1', 'balloons2', 'balloons3']);
  assert.deepEqual([...skin.parts.keys()].sort(), ['arrow0', 'arrow1', 'sstp']);
  // balloons0s.txt merged over descript.txt
  const s0 = skin.images.get('balloons0');
  assert.equal(s0.cfg.get('origin.x'), '23');
  assert.equal(s0.cfg.get('windowposition.x'), '0');
  assert.equal(s0.cfg.get('font.height'), '12');
});

test('LightBlue: derived geometry (BA §10.3)', real, async () => {
  const { skin } = await fixture();
  const rows = [['balloonk0', 340, 96, 84, 80], ['balloons0', 340, 170, 158, 154], ['balloonk2', 340, 170, 158, 154],
    ['balloons2', 340, 384, 372, 368], ['balloonk4', 340, 384, 372, 368]];
  for (const [name, w, h, vrBottom, arrow1y] of rows) {
    const g = skin.images.get(name).geo;
    assert.equal(g.width, w, name);
    assert.equal(g.height, h, name);
    assert.equal(g.originX, 23);
    assert.equal(g.originY, 13);
    assert.equal(g.lineLimit, 287, name);
    assert.deepEqual(g.validRect, { left: 0, top: 0, right: 340, bottom: vrBottom });
    assert.deepEqual(g.arrow0, { x: 314, y: 8 });
    assert.deepEqual(g.arrow1, { x: 314, y: arrow1y });
    assert.deepEqual(g.clickwait, g.arrow1);
    assert.deepEqual(g.windowPosition, { x: 0, y: 0, limit: true });
  }
  assert.deepEqual(skin.images.get('balloonc3').geo.box, { x: 10, y: 18, width: 301, height: 18 });
  assert.equal(skin.images.get('balloonc3').w, 322);
});

test('LightBlue: default font and cursor styles', real, async () => {
  const { skin } = await fixture();
  const f = skin.font;
  assert.equal(f.height, 12);
  assert.deepEqual(f.color, [84, 32, 27]);
  assert.deepEqual(f.shadow, [195, 195, 239]);
  assert.equal(f.shadowStyle, 'offset');
  assert.deepEqual(f.anchorColor, [77, 82, 194]);
  assert.deepEqual(f.cursor, { style: 'square', method: 'notmaskpen', brush: [150, 100, 100], pen: [84, 32, 27], font: [0, 0, 0] });
  assert.equal(f.cursorNS.style, 'none');
  assert.equal(f.anchor.style, 'underline');
  assert.deepEqual(f.anchor.pen, [0, 0, 255]);
  assert.match(f.name, /MS Gothic/);
});

test('image choice by scope, \\b id and side, with fallbacks (BA §1.2)', real, async () => {
  const { skin } = await fixture();
  const n = (s, id, side) => (skin.balloon(s, id, side) || {}).name || null;
  assert.equal(n(0, 0, 'left'), 'balloons0');
  assert.equal(n(0, 0, 'right'), 'balloons1');
  assert.equal(n(0, 2, 'left'), 'balloons2');
  assert.equal(n(0, 2, 'right'), 'balloons3');
  assert.equal(n(0, 1, 'left'), 'balloons0', 'odd ids map to their pair');
  assert.equal(n(0, 3, 'right'), 'balloons3');
  assert.equal(n(0, 4, 'left'), null, '\\0\\b[4] does not exist (caller keeps its id)');
  assert.equal(n(1, 4, 'left'), 'balloonk4');
  assert.equal(n(1, 2, 'right'), 'balloonk3');
  assert.equal(n(5, 2, 'left'), 'balloonk2', 'no balloonp5def*: falls back to k');
  assert.equal(n(23, 4, 'right'), 'balloonk5');
  assert.equal(n(0, -1, 'left'), null);
  assert.deepEqual(balloonFamilies(7), ['balloonp7def', 'balloonk', 'balloons']);
  assert.equal(skin.marker(0).name, 'sstp', 'no marker*.png: the \\![*] marker is sstp.png');
  assert.equal(skin.arrow(1, 3).name, 'arrow1');
  assert.equal(skin.clickwait(0), null);
  assert.equal(skin.box(3).name, 'balloonc3');
  assert.equal(skin.box(1).name, 'balloonc1');
});

test('descript coordinate rules', () => {
  assert.equal(resolveCoord('-30', 340), 310);
  assert.equal(resolveCoord('--5', 340), -5);
  assert.equal(resolveCoord('12', 340), 12);
  assert.equal(resolveCoord(undefined, 340, 7), 7);
  assert.equal(resolveEdge('0', 340), 340);
  assert.equal(resolveEdge('-12', 384), 372);
  // SSPデフォルト+ style: validrect only, no origin
  const cfg = new Map([['validrect.left', '23'], ['validrect.top', '14'], ['validrect.right', '-23'], ['validrect.bottom', '-12'],
    ['wordwrappoint.x', '-25']]);
  const g = skinGeometry(cfg, 335, 169);
  assert.equal(g.originX, 23);
  assert.equal(g.originY, 14);
  assert.equal(g.lineLimit, 287);
  // per-image files cannot override whole-balloon keys
  const m = mergeCfg(new Map([['use_self_alpha', '0'], ['origin.x', '1']]), new Map([['use_self_alpha', '1'], ['origin.x', '2'], ['name', 'x']]));
  assert.equal(m.get('use_self_alpha'), '0');
  assert.equal(m.get('origin.x'), '2');
  assert.equal(m.has('name'), false);
  const f = skinFont(new Map([['font.shadowcolor.r', 'none']]));
  assert.equal(f.shadow, null);
});

test('fallback skin has SSPデフォルト+ metrics', () => {
  const s = BalloonSkin.fallback();
  assert.equal(s.isFallback, true);
  const g = s.balloon(0, 0, 'left').geo;
  assert.equal(g.width, 335);
  assert.equal(g.originX, 23);
  assert.equal(g.originY, 14);
  assert.equal(g.lineLimit, 287);
  assert.equal(s.balloon(0, 2, 'right').h, 384);
  assert.equal(s.balloon(1, 0, 'left').h, 96);
  assert.equal(s.balloon(7, 2, 'left').name, 'balloonk2');
  assert.equal(s.box(3).w, 317);
  assert.equal(s.marker(0).w, 8);
  assert.equal(s.font.height, 12);
});

test('missing descript.txt gives the fallback skin', async () => {
  const s = await BalloonSkin.load({ has: () => false }, { decode: false });
  assert.equal(s.isFallback, true);
});

test('forGhost: the balloon bundled with the ghost (index entry), else the built-in one', real, async () => {
  const { ghost } = await fixture();
  const entry = JSON.parse(fs.readFileSync(path.join(ROOT, 'site/sumika/index/ghosts.json'), 'utf8')).ghosts.find(g => g.id === 'tsubasa');
  const s = await BalloonSkin.forGhost({ ghost: entry, ghostFiles: ghost, decode: false });
  assert.equal(s.name, 'LightBlue');
  const f = await BalloonSkin.forGhost({ ghost: { balloon: 'nope' }, ghostFiles: ghost, decode: false });
  assert.equal(f.isFallback, true);
});

test('forGhost: a ghost without a balloon gets the site default balloon (ghosts.json defaultBalloon)', real, async () => {
  const { ghost } = await fixture();
  const balloonFiles = async id => { assert.equal(id, 'sumika'); return ghost.sub('LightBlue'); };   // any balloon folder
  const site = { defaultBalloon: 'sumika', balloon: id => (id === 'sumika' ? { id } : null), balloonFiles };
  const s = await BalloonSkin.forGhost({ ghost: { balloon: null, bundledBalloons: [] }, ghostFiles: ghost, site, decode: false });
  assert.equal(s.isFallback, false);
  const f = await BalloonSkin.forGhost({ ghost: { balloon: null }, ghostFiles: ghost, site: { ...site, defaultBalloon: null }, decode: false });
  assert.equal(f.isFallback, true);
});

test('forGhost: a ghost naming a shared balloon by its descript name gets that balloon, not the site default (BA §1.6)', real, async () => {
  const { ghost } = await fixture();
  const asked = [];
  const balloons = [{ id: 'sumika', name: 'Sumika' }, { id: 'ssp', name: 'SSPデフォルト+' }];
  const site = { defaultBalloon: 'sumika', balloons, balloon: id => balloons.find(b => b.id === id) || null,
    balloonFiles: async id => { asked.push(id); return ghost.sub('LightBlue'); } };
  const s = await BalloonSkin.forGhost({ ghost: { balloon: 'SSPデフォルト+', bundledBalloons: [] }, ghostFiles: ghost, site, decode: false });
  assert.equal(s.isFallback, false);
  assert.deepEqual(asked, ['ssp']);
  assert.equal(siteBalloonId(site, 'ssp'), 'ssp');
  assert.equal(siteBalloonId(site, 'nope'), null);
  assert.equal(siteBalloonId(null, 'ssp'), null);
});
