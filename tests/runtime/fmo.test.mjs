// src/core/fmo.js: the FMO text a Satori ghost reads (EV §2.7.8): SSP's lines and key order, self first, the others in
// slot order by their ids, Sumika's paths, values cleaned, empty ones left out.
import test from 'node:test';
import assert from 'node:assert/strict';
import { fmoText, FMO_PATH } from '../../src/core/fmo.js';

const X = { id: 'x', name: 'Ghost X', sakuraName: 'Xs', keroName: 'Xk', surfaces: [0, 10], shell: 'master' };
const Y = { id: 'y', name: 'Ghost Y', sakuraName: 'Ys', keroName: '', surfaces: [3, -1], shell: 'master' };
const Z = { id: 'katari', name: 'カタリベカタリ', sakuraName: 'カタリ', keroName: '謎の装置', surfaces: [5, 15] };

const lines = t => t.split('\r\n');
const id = n => `ssp_fmo_header_00000000_${n}`;

test('one ghost: SSP\'s lines `<id>.<key>\\x01<value>\\r\\n` in its key order, without the window handles', () => {
  assert.equal(FMO_PATH, '/ssp/');
  const t = fmoText(X);
  assert.ok(t.endsWith('\r\n'));
  assert.deepEqual(lines(t).slice(0, -1), [
    `${id('00000000')}.path\x01/ssp/`,
    `${id('00000000')}.name\x01Xs`,
    `${id('00000000')}.keroname\x01Xk`,
    `${id('00000000')}.sakura.surface\x010`,
    `${id('00000000')}.kero.surface\x0110`,
    `${id('00000000')}.ghostpath\x01/`,
    `${id('00000000')}.fullname\x01Ghost X`,
    `${id('00000000')}.modulestate\x01shiori:running`,
  ]);
  assert.doesNotMatch(t, /hwnd/);
});

test('the others after self, numbered 1, 2 … so their ids sort in slot order; ghostpath /ssp/ghost/<id>/', () => {
  const others = [Y, Z, ...Array.from({ length: 14 }, (_, i) => ({ ...Y, id: `g${i}`, sakuraName: `G${i}` }))];
  const t = fmoText(X, others);
  const ids = [...new Set(lines(t).filter(Boolean).map(l => l.slice(0, l.indexOf('.'))))];
  assert.equal(ids.length, 17);
  assert.deepEqual(ids, [...ids].sort(), 'text order = slot order (Satori keeps its entries in a map by id)');
  assert.deepEqual(ids.slice(0, 3), [id('00000000'), id('00000001'), id('00000002')]);
  assert.equal(ids[16], id('00000010'), 'hex, fixed width');
  assert.ok(t.includes(`${id('00000001')}.ghostpath\x01/ssp/ghost/y/\r\n`));
  assert.ok(t.includes(`${id('00000002')}.ghostpath\x01/ssp/ghost/katari/\r\n`));
  assert.ok(t.includes(`${id('00000002')}.name\x01カタリ\r\n${id('00000002')}.keroname\x01謎の装置\r\n`));
  assert.ok(t.includes(`${id('00000002')}.fullname\x01カタリベカタリ\r\n`));
  assert.equal(lines(t).filter(l => l.endsWith('.ghostpath\x01/')).length, 1, 'only self has `/`');
});

test('values: CR, LF and \\x01 become a space; an empty value leaves its line out; -1 for no surface', () => {
  const odd = { id: 'o', name: 'a\r\nb', sakuraName: 'c\x01d', keroName: '', surfaces: [-1, 'x'] };
  const t = fmoText(odd, [{ id: 'p', name: '', sakuraName: 'P' }]);
  assert.ok(t.includes(`${id('00000000')}.fullname\x01a  b\r\n`));
  assert.ok(t.includes(`${id('00000000')}.name\x01c d\r\n`));
  assert.ok(!t.includes(`${id('00000000')}.keroname`), 'no kero name: no line (Satori drops it anyway)');
  assert.ok(t.includes(`${id('00000000')}.sakura.surface\x01-1\r\n${id('00000000')}.kero.surface\x01-1\r\n`));
  assert.ok(!t.includes(`${id('00000001')}.fullname`));
  assert.ok(t.includes(`${id('00000001')}.kero.surface\x01-1\r\n`), 'no surfaces at all: -1');
  for (const l of lines(t).filter(Boolean)) assert.equal(l.split('\x01').length, 2, l);
  assert.equal(fmoText(null, [Y]).includes(id('00000000')), false, 'no self: the others keep their numbers');
});
