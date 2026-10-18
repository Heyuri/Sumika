// ssp.exe's property names over a fake world (src/core/properties.js, docs/research/properties.md §5, §6).
import test from 'node:test';
import assert from 'node:assert/strict';
import { getProperty, setProperty, parseCharIndex, pickFromList } from '../../src/core/properties.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('error');

const SUNDAY = new Date(2026, 9, 11, 9, 5, 7, 250).getTime();       // local time: Sunday 2026-10-11 09:05:07.250

function liveGhost(name, o = {}) {
  const calls = [];
  const live = {
    calls,
    username: () => Promise.resolve(o.username ?? null),
    ext: key => Promise.resolve(o.ext && key in o.ext ? o.ext[key] : null),
    setExt: (key, value) => { calls.push(['setExt', key, value]); return Promise.resolve(true); },
    status: () => 'talking,balloon(0=0)',
    selfname2: () => name + '2',
    scopeCount: () => 2,
    scope: n => (n >= 0 && n < 2 ? { name: n ? 'Teddy' : name, surface: n ? 10 : 5, defaultSurface: n ? 10 : 0,
      balloonDefault: n ? 2 : 0, x: 100 + n, y: 500, rect: [50, 300, 150.4, 500], scaling: [100, 133.333] } : null),
    shells: () => [
      { id: 'master', name: 'Master', path: `/ghost/${o.id}/shell/master/`, sakuraName: '', keroName: '', hidden: false },
      { id: 'x', name: 'Other.Shell', path: `/ghost/${o.id}/shell/x/`, sakuraName: 'S', keroName: 'K', hidden: true },
    ],
    currentShell: () => 'master',
    balloon: () => BALLOONS[1],
    balloonScope: n => ({ num: n * 2, rect: [10, 20, 350, 190], validWidth: 287, validWidthInitial: 317, validHeight: 158,
      validHeightInitial: 145, lines: 11, linesInitial: 10, basePos: { x: 23, y: 13 }, charWidth: 6, vertical: 0 }),
    setSurface: (n, v) => { calls.push(['setSurface', n, v]); return true; },
    setBalloon: (n, v) => { calls.push(['setBalloon', n, v]); return true; },
  };
  return live;
}

const BALLOONS = [
  { id: 'sumika', name: 'sumika', path: '/balloon/sumika/' },
  { id: 'emily4', name: 'Balloon for Emily/P4', path: '/ghost/emily4/emily4/', craftman: 'Emily Team' },
];

function world() {
  const emily = { id: 'emily4', name: 'Emily/Phase4.5', sakuraName: 'Emily', keroName: 'Teddy', path: '/ghost/emily4/',
    craftman: 'Emily Development Team', homeurl: 'https://example.invalid/emily/', thumbnails: ['/ghost/emily4/thumbnail.png'],
    times: { lastboot: SUNDAY }, live: liveGhost('Emily', { id: 'emily4', username: 'Visitor', ext: { k: 'v', e: '' } }) };
  const katari = { id: 'katari', name: 'カタリベカタリ', sakuraName: 'カタリ', keroName: '謎の装置', path: '/ghost/katari/', live: null };
  const tsubasa = { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', path: '/ghost/tsubasa/',
    live: liveGhost('Tsubasa', { id: 'tsubasa', username: 'Tsubasa\'s friend' }) };
  return {
    emily, katari, tsubasa,
    now: () => SUNDAY, locale: () => 'ja-JP', idleSec: () => 12.7, sessionSec: () => 3600.2, cursor: () => null,
    viewport: () => ({ w: 1280, h: 720, dpr: 1.5, depth: 24 }), dark: () => true, online: () => true,
    baseware: { name: 'SSP', version: 'SSP/2.9.08 (sumika-1.0.0; Web)', platform: 'ssp.exe' },
    self: () => emily,
    ghosts: () => [emily, katari, tsubasa],
    active: () => [emily, tsubasa],
    balloons: () => BALLOONS,
  };
}

const get = (name, w = world()) => getProperty(w, name);

test('scope forms: scope(N), scopeN, index(N), indexN, char(N), charN, sakura / kero prefixes (ParseCharIndex)', () => {
  for (const s of ['scope(0)', 'scope0', 'index(0)', 'index0', 'char(0)', 'char0', 'sakura', 'SAKURA', 'scope( 0)']) {
    assert.equal(get(`currentghost.${s}.surface.num`), '5', s);
  }
  for (const s of ['scope(1)', 'scope1', 'kero', 'Kero', 'keroXY']) assert.equal(get(`currentghost.${s}.surface.num`), '10', s);
  assert.deepEqual(parseCharIndex('scope(2).bind.menu'), { scope: 2, rest: 'bind.menu' });
  assert.equal(parseCharIndex('Scope(0).x'), null, 'swscanf words are lower case only');
  assert.equal(parseCharIndex('scope0'), null, 'no property after it');
  assert.equal(get('currentghost.scope(2).surface.num'), null, 'no such scope');
  assert.equal(get('currentghost.balloon.scope0.validwidth'), '287');
  assert.equal(get('currentghost.balloon.scope(0).validwidth'), '287');
  assert.equal(get('currentghost.balloon.sakura.lines'), '11');
});

test('ghostlist(X): by ID, by path (absolute or relative, \\ or /, any case), by name, then by sakura name', () => {
  for (const x of ['emily4', 'EMILY4', '/ghost/emily4/', '/ghost/emily4', 'ghost/emily4', '\\ghost\\Emily4\\', 'Emily/Phase4.5',
    'emily/phase4.5', 'Emily']) {
    assert.equal(get(`ghostlist(${x}).sakuraname`), 'Emily', x);
  }
  assert.equal(get('ghostlist(Emily/Phase4.5).path'), '/ghost/emily4/', 'a dot inside the parentheses');
  assert.equal(get('ghostlist(カタリ).name'), 'カタリベカタリ');
  assert.equal(get('activeghostlist(Tsubasa).name'), 'Hayama-san Next Door');
  assert.equal(get('ghostlist(nobody).name'), null);
  assert.equal(get('ghostlist(emily4)'), null, 'nothing after it');
  assert.equal(get('currentghost.shelllist(S).name'), null, 'no sakura name for other lists');
  const items = [{ id: 'a', name: 'x(1)' }, { id: 'b', name: 'B' }];
  assert.deepEqual(pickFromList(items, '(x(1)).name'), { item: items[0], index: 0, rest: 'name' });
  assert.deepEqual(pickFromList(items, '.index(1).name'), { item: items[1], index: 1, rest: 'name' });
  assert.equal(pickFromList(items, '.index1.name'), null, 'indexN needs a ( somewhere after it');
});

test('activeghostlist: count, index(N) in set order with the caller, current = the caller; out of range fails', () => {
  assert.equal(get('activeghostlist.count'), '2');
  assert.equal(get('ActiveGhostList.Count'), '2');
  assert.equal(get('activeghostlist.index(0).name'), 'Emily/Phase4.5');
  assert.equal(get('activeghostlist.index(1).name'), 'Hayama-san Next Door');
  assert.equal(get('activeghostlist.index(2).name'), null);
  assert.equal(get('activeghostlist.index(-1).name'), null);
  assert.equal(get('ghostlist.count'), '3');
  assert.equal(get('ghostlist.index(1).sakuraname'), 'カタリ');
  assert.equal(get('ghostlist.index2.scope(0).surface.num'), '5', '"indexN" with a ( later in the name');
  assert.equal(get('ghostlist.current.name'), 'Emily/Phase4.5');
  assert.equal(get('activeghostlist.current.keroname'), 'Teddy');
  assert.equal(get('activeghostlist.index(1).index'), '2', 'index: the position in the installed list');
});

test('the running ghost: username asks its engine (another ghost\'s too); a ghost not up fails', async () => {
  const p = get('currentghost.username');
  assert.ok(p instanceof Promise);
  assert.equal(await p, 'Visitor');
  assert.equal(await get('activeghostlist(tsubasa).username'), 'Tsubasa\'s friend');
  assert.equal(get('ghostlist(katari).username'), null);
  assert.equal(get('ghostlist(katari).scope(0).surface.num'), null);
  assert.equal(get('ghostlist(tsubasa).scope(0).name'), 'Tsubasa');
  assert.equal(get('currentghost.status'), 'talking,balloon(0=0)');
  assert.equal(get('currentghost.selfname2'), 'Emily2');
  assert.equal(get('currentghost.scope.count'), '2');
  assert.equal(get('currentghost.kinokoname'), null);
  assert.equal(await get('currentghost.ext.k'), 'v');
  assert.equal(await get('currentghost.ext.e'), null, 'an empty value fails');
  assert.equal(await get('currentghost.ext.none'), null);
});

test('scope, shell and balloon names', () => {
  assert.equal(get('currentghost.scope(0).name'), 'Emily');
  assert.equal(get('currentghost.scope(1).seriko.defaultsurface'), '10');
  assert.equal(get('currentghost.scope(1).balloon.defaultsurface'), '2');
  assert.equal(get('currentghost.sakura.bind.menu'), 'auto');
  assert.equal(get('currentghost.scope(1).x'), '101');
  assert.equal(get('currentghost.scope(0).rect'), '50,300,150,500');
  assert.equal(get('currentghost.scope(0).scaling'), '100,133.33');
  assert.equal(get('currentghost.scope(0).currentmonitor.dpi'), '144');
  assert.equal(get('currentghost.shelllist.count'), '2');
  assert.equal(get('currentghost.shelllist.current.name'), 'Master');
  assert.equal(get('currentghost.shelllist.current.path'), '/ghost/emily4/shell/master/');
  assert.equal(get('currentghost.shelllist.index(1).menu'), 'hidden');
  assert.equal(get('currentghost.shelllist(Master).notinstalled'), 'false');
  assert.equal(get('currentghost.shelllist(x).sakuraname'), 'S');
  assert.equal(get('currentghost.shelllist(Other.Shell).name'), null, 'a shell name with a dot cannot be addressed');
  assert.equal(get('currentghost.balloon.name'), 'Balloon for Emily/P4');
  assert.equal(get('currentghost.balloon.path'), '/ghost/emily4/emily4/');
  assert.equal(get('currentghost.balloon.index'), '1');
  assert.equal(get('currentghost.balloon.scope1.num'), '2');
  assert.equal(get('currentghost.balloon.scope0.basepos'), '23,13');
  assert.equal(get('currentghost.balloon.scope0.validheight.initial'), '145');
  assert.equal(get('currentghost.balloon.scope0.char_width'), '6');
  assert.equal(get('currentghost.balloon.scope0.vertical'), '0');
  assert.equal(get('currentghost.balloon.scope0.rect'), '10,20,350,190');
  assert.equal(get('currentghost.balloon.scope0.y'), '20');
  assert.equal(get('currentghost.balloon.scope(1).defaultsurface'), '2');
  assert.equal(get('currentghost.balloon.scope(2).lines'), null, 'a scope the ghost does not have');
  assert.equal(get('balloonlist.count'), '2');
  assert.equal(get('balloonlist(sumika).path'), '/balloon/sumika/');
  assert.equal(get('balloonlist.index(1).craftman'), 'Emily Team');
});

test('generic item names: craftman = craftmanw, homeurl = updateurl, thumbnail, times', () => {
  assert.equal(get('currentghost.craftmanw'), 'Emily Development Team');
  assert.equal(get('currentghost.updateurl'), 'https://example.invalid/emily/');
  assert.equal(get('ghostlist(katari).homeurl'), '');
  assert.equal(get('ghostlist(katari).craftmanurl'), '');
  assert.equal(get('currentghost.thumbnail'), '/ghost/emily4/thumbnail.png');
  assert.equal(get('ghostlist(katari).thumbnail'), null);
  assert.equal(get('ghostlist(katari).icon'), null);
  assert.equal(get('currentghost.lastboot_time'), '2026,10,11,9,5,7');
  assert.equal(get('currentghost.install_time'), '0,0,0,0,0,0');
  assert.equal(get('currentghost.update_result'), '');
});

test('not in ssp.exe 2.9.9 (UKADOC lists them): currentghost.balloon.count, scope(N).surface.x, shiori.*', () => {
  assert.equal(get('currentghost.balloon.count'), null);
  assert.equal(get('currentghost.scope(0).surface.x'), null);
  assert.equal(get('shiori.a'), null);
  assert.equal(get('currentghost.shiori.a'), null);
  assert.equal(get('ghostlistx.count'), null);
  assert.equal(get(' ghostlist.count'), null, 'never trimmed');
});

test('system.* and baseware.* in a browser', () => {
  const d = new Date(SUNDAY);
  assert.equal(d.getDay(), 0);
  assert.equal(get('system.dayofweek'), '日曜日');
  const en = { ...world(), locale: () => 'en-US' };
  assert.equal(get('system.dayofweek', en), 'Sunday');
  assert.deepEqual(['year', 'month', 'day', 'hour', 'minute', 'second', 'millisecond'].map(k => get('system.' + k)),
    ['2026', '10', '11', '9', '5', '7', '250']);
  assert.equal(get('SYSTEM.Year'), '2026', 'names in any case');
  assert.equal(get('system.os.type'), 'Web');
  assert.equal(get('system.os.name'), 'Web');
  assert.equal(get('system.os.arch'), 'unknown');
  assert.equal(get('system.os.version'), '');
  assert.equal(get('system.os.locale'), 'ja-JP');
  assert.equal(get('system.os.locale.language'), 'ja');
  assert.equal(get('system.os.locale.country'), 'JP');
  const y = d.getFullYear(), std = Math.max(new Date(y, 0, 1).getTimezoneOffset(), new Date(y, 6, 1).getTimezoneOffset());
  assert.equal(get('system.os.timezone.offset'), String(std));
  assert.equal(get('system.os.dst'), d.getTimezoneOffset() < std ? '1' : '0');
  assert.equal(get('system.os.unixtime'), String(Math.floor(SUNDAY / 1000)));
  assert.equal(get('system.os.uptime'), '3600');
  assert.equal(get('system.os.idletime'), '12');
  assert.equal(get('system.power.battery.percent'), '-1');
  assert.equal(get('system.power.percent'), '-1');
  assert.equal(get('system.power.source'), 'unknown');
  assert.equal(get('system.power.flag'), '');
  assert.equal(get('system.cpu.load'), null);
  assert.equal(get('system.memory.phyt'), null);
  assert.equal(get('system.disk.count'), '0');
  assert.equal(get('system.network.status'), 'online');
  assert.equal(get('system.network.ipaddress'), null);
  assert.equal(get('system.monitor.count'), '1');
  assert.equal(get('system.monitor.index(0).work'), '0,0,1280,720');
  assert.equal(get('system.monitor.index(0).bpp'), '24');
  assert.equal(get('system.monitor.index(1).work'), null);
  assert.equal(get('system.theme.os.mode'), 'dark');
  assert.equal(get('system.dnd.mode'), 'normal');
  assert.equal(get('system.cursor.pos'), '0,0', 'no pointer seen yet');
  assert.equal(get('system.cursor.pos', { ...world(), cursor: () => ({ x: 10.4, y: 20 }) }), '10,20');
  assert.equal(get('system.platform'), 'ssp.exe');
  assert.equal(get('baseware.name'), 'SSP');
  assert.equal(get('baseware.version'), 'SSP/2.9.08 (sumika-1.0.0; Web)');
  assert.equal(get('baseware.windowmode'), 'normal');
  assert.deepEqual(['headlinelist.count', 'pluginlist.count', 'rateofuselist.count', 'history.ghost.count',
    'developer.log.script.count'].map(n => get(n)), ['0', '0', '0', '0', '0']);
  assert.equal(get('history.ghost.index(0).name'), null);
  assert.equal(get('system.year', {}), null, 'a world without the member: fails');
  assert.equal(get('currentghost.name', {}), null);
});

test('\\![set,property]: surface and balloon of a scope, ext.KEY; writes through ghostlist(X) act on the caller', async () => {
  const w = world(), me = w.emily.live, other = w.tsubasa.live;
  assert.equal(setProperty(w, 'currentghost.scope(0).surface.num', '5'), true);
  assert.equal(setProperty(w, 'ghostlist.current.balloon.scope1.num', ' -1x'), true);
  assert.equal(setProperty(w, 'ghostlist(tsubasa).scope(0).surface.num', '7'), true);
  assert.equal(setProperty(w, 'activeghostlist(Tsubasa).sakura.surface.num', '8'), true);
  assert.deepEqual(me.calls, [['setSurface', 0, '5'], ['setBalloon', 1, -1], ['setSurface', 0, '7'], ['setSurface', 0, '8']]);
  assert.deepEqual(other.calls, [], 'never the other ghost');
  assert.equal(await setProperty(w, 'activeghostlist(tsubasa).ext.k', 'v'), true);
  assert.deepEqual(me.calls.at(-1), ['setExt', 'k', 'v']);
  for (const n of ['activeghostlist.current.scope(0).surface.num', 'system.year', 'baseware.name', 'currentghost.name',
    'balloonlist(sumika).name', 'ghostlist(nobody).scope(0).surface.num', 'currentghost.balloon.scope(5).num']) {
    assert.equal(setProperty(w, n, '1'), false, n);
  }
  // names ssp.exe can set that Sumika does not set yet: false (logged once)
  for (const n of ['currentghost.scope(0).bind.menu', 'currentghost.mousecursor.text', 'currentghost.seriko.zorder',
    'currentghost.shelllist(Master).menu', 'currentghost.balloon.scope(0).defaultsurface']) {
    assert.equal(setProperty(w, n, 'hidden'), false, n);
  }
  assert.equal(me.calls.length, 5);
});
