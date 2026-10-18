// src/core/ghostset.js: the set of ghosts on screen — stored set, site closed, call targets, the targets of a
// ghost's talk (COMMUNICATE) and of \![raiseother], cross-ghost References, set diffs, tab marker v2. Pure: no DOM, no
// runtime.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_GHOSTS, LEAD_ID, chooseSet, siteClosed, resolveCallTarget, otherGhostRef, afterBootRefs, otherClosedRefs,
  otherChangedRefs, otherTalkRefs, diffSets, markerGhosts, markerCarry, markerRecord, markerQuit,
  ALL_GHOSTS, sspNameEqual, communicateTargets, raiseTargets, isLastInstall,
} from '../../src/core/ghostset.js';
import {
  GhostLock, memoryStorage, runtimePrefs, sessionMarker, stateKey, storedClosed, SESSION_KEY,
} from '../../src/core/state.js';
import { buildRequest } from '../../src/core/shiori.js';

// site order x, y, yaya, z, w; y's sakura name is Japanese (the corpus calls by sakura name: \![call,ghost,なと])
const GHOSTS = [
  { id: 'x', name: 'Ghost X', sakuraName: 'Ex', engine: 'satori' },
  { id: 'y', name: 'Ghost Y', sakuraName: 'なと', engine: 'satori' },
  { id: 'yaya', name: 'Yaya Test', sakuraName: 'Yayako', engine: 'yaya' },
  { id: 'z', name: 'Ghost Z', sakuraName: 'Zed', engine: 'satori' },
  { id: 'w', name: 'Ghost W', sakuraName: 'Dub', engine: 'satori' },
];
const INDEX = { ghosts: GHOSTS, ghost: id => GHOSTS.find(g => g.id === id) || null };
const supported = g => g.engine !== 'yaya';
const ids = list => list.map(g => (g ? g.id : g));
const entry = id => INDEX.ghost(id);

/** A seeded random (LCG), so the random picks are the same on every run. */
function seeded(seed = 1) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}

const sessionStore = () => {
  const m = new Map();
  return { get: k => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, String(v)), remove: k => m.delete(k), m };
};

test('constants: no cap on ghosts at once, as SSP; the lead lock is sumika/lead, apart from every ghost lock', () => {
  assert.equal(MAX_GHOSTS, Infinity);
  assert.equal(LEAD_ID, '/lead');
  const lead = new GhostLock(LEAD_ID, { locks: null, Channel: null });
  assert.equal(lead.name, 'sumika/lead');
  assert.notEqual(lead.name, new GhostLock('lead', { locks: null, Channel: null }).name);
});

test('chooseSet: the stored set in order, minus lost and unrunnable ghosts, without duplicates, capped', () => {
  const o = { supported };
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghost: 'y', ghosts: ['y', 'x'] } })), ['y', 'x'], 'set order kept');
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghosts: ['gone', 'x', 'yaya', 'z'] } })), ['x', 'z'], 'unknown and unsupported dropped');
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghosts: ['x', 'x', 'z', 'x', 7, null, ''] } })), ['x', 'z'], 'duplicates and junk dropped');
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghosts: ['x', 'y', 'z'] }, max: 2 })), ['x', 'y']);
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghosts: ['x', 'y', 'z', 'w'] } })), ['x', 'y', 'z', 'w'], 'no cap by default');
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghosts: ['x', 'y', 'z', 'w'] }, max: 3 })), ['x', 'y', 'z'], 'a site cap');
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghosts: ['x', 'y', 'z'] }, max: 0 })), ['x', 'y', 'z'], 'a bad max is the default');
  assert.deepEqual(ids(chooseSet(INDEX, { stored: { ghosts: ['yaya', 'x'] } })), ['yaya', 'x'], 'every engine counts by default');
  assert.deepEqual(ids(chooseSet({ ghosts: GHOSTS }, { stored: { ghosts: ['z', 'x'] } })), ['z', 'x'], 'an index without ghost()');
  assert.deepEqual(ids(chooseSet(INDEX, { ...o, stored: { ghosts: ['x', 'yaya', 'y', 'z'] }, max: 2 })), ['x', 'y'],
    'the cap counts the ghosts kept, not the ids stored');
});

test('chooseSet: no stored set, or nothing left of it -> [fallback()] (chooseGhost); a null fallback -> []', () => {
  const fallback = () => entry('z');
  for (const stored of [{}, { ghost: 'x' }, { ghosts: 'x' }, null, undefined, { ghosts: [] }]) {
    assert.deepEqual(ids(chooseSet(INDEX, { stored, supported, fallback })), ['z'], JSON.stringify(stored));
  }
  assert.deepEqual(ids(chooseSet(INDEX, { stored: { ghosts: ['gone', 'yaya'] }, supported, fallback })), ['z'], 'all dropped');
  assert.deepEqual(chooseSet(INDEX, { stored: { ghosts: ['gone'] }, supported, fallback: () => null }), []);
  assert.deepEqual(chooseSet(INDEX, { stored: {} }), [], 'the default fallback gives nothing');
  assert.deepEqual(chooseSet(INDEX), []);
});

test('chooseSet: a stored ghost other than ghosts[0] (code that knows one ghost changed it) takes slot 0', () => {
  assert.deepEqual(ids(chooseSet(INDEX, { stored: { ghost: 'z', ghosts: ['x', 'y'], rev: 4 }, supported })), ['z', 'y']);
  assert.deepEqual(ids(chooseSet(INDEX, { stored: { ghost: 'y', ghosts: ['x', 'y'] }, supported })), ['y'], 'x changed to y, already there');
  assert.deepEqual(ids(chooseSet(INDEX, { stored: { ghost: 'x', ghosts: ['x', 'y'] }, supported })), ['x', 'y'], 'the Site\'s own writes agree');
});

test('chooseSet reads the set the runtime prefs keep through patch writes (ghosts, rev)', () => {
  const ls = memoryStorage();
  runtimePrefs.set({ ghost: 'x', ghosts: ['x', 'y'], rev: 1 }, ls);
  runtimePrefs.set({ lang: 'ja' }, ls);                    // Language ▸ writes only its key
  assert.deepEqual(runtimePrefs.get(ls), { ghost: 'x', ghosts: ['x', 'y'], rev: 1, lang: 'ja' });
  assert.deepEqual(ids(chooseSet(INDEX, { stored: runtimePrefs.get(ls), supported })), ['x', 'y']);
  runtimePrefs.set({ ghost: 'x', ghosts: ['x'], rev: 2 }, ls);   // y closed
  assert.deepEqual(runtimePrefs.get(ls), { ghost: 'x', ghosts: ['x'], rev: 2, lang: 'ja' });
  assert.deepEqual(ids(chooseSet(INDEX, { stored: runtimePrefs.get(ls), supported })), ['x']);
});

test('siteClosed: only when every ghost of the stored set is closed (read with storedClosed)', () => {
  const ls = memoryStorage();
  const closedOf = id => storedClosed(id, ls);
  assert.equal(siteClosed([], () => true), false, 'no set: not closed');
  assert.equal(siteClosed(null, () => true), false);
  ls.setItem(stateKey('x'), JSON.stringify({ v: 1, closed: true }));
  ls.setItem(stateKey('y'), JSON.stringify({ v: 1, closed: false }));
  assert.equal(siteClosed(['x'], closedOf), true, 'one ghost alone: the same rule');
  assert.equal(siteClosed(['x', 'y'], closedOf), false, 'mixed');
  assert.equal(siteClosed(['x', 'z'], closedOf), false, 'a ghost never stored is not closed');
  ls.setItem(stateKey('y'), JSON.stringify({ v: 1, closed: true }));
  assert.equal(siteClosed(['x', 'y'], closedOf), true, 'all');
});

test('resolveCallTarget random: never the caller, a ghost on screen or one that cannot run; none left -> null', () => {
  const random = seeded(7);
  const seen = new Set();
  for (let i = 0; i < 60; i++) {
    const g = resolveCallTarget(GHOSTS, 'x', 'random', { onScreen: new Set(['x', 'y']), supported, random });
    assert.ok(g && ['z', 'w'].includes(g.id), g && g.id);
    seen.add(g.id);
  }
  assert.deepEqual([...seen].sort(), ['w', 'z'], 'both free ghosts come up');
  for (const r of [0, 0.999999]) {
    assert.ok(['z', 'w'].includes(resolveCallTarget(GHOSTS, 'x', 'Random', { onScreen: ['x', 'y'], supported, random: () => r }).id));
  }
  for (let i = 0; i < 20; i++) {
    assert.notEqual(resolveCallTarget(GHOSTS, 'x', 'random', { supported, random }).id, 'x', 'the caller even when onScreen leaves it out');
  }
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'random', { onScreen: new Set(['x', 'y', 'z', 'w']), supported, random }), null);
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'random', { onScreen: new Set(['x', 'y', 'z', 'w']), random: () => 0 }).id, 'yaya',
    'every engine counts by default');
});

test('resolveCallTarget sequential: the first ghost after the caller that is free, wrapping', () => {
  const o = { supported };
  assert.equal(resolveCallTarget(GHOSTS, 'y', 'sequential', { ...o, onScreen: new Set(['x', 'y']) }).id, 'z', 'yaya skipped');
  assert.equal(resolveCallTarget(GHOSTS, 'w', 'sequential', { ...o, onScreen: new Set(['w', 'x']) }).id, 'y', 'wraps past the end');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'SEQUENTIAL', { ...o, onScreen: new Set(['x']) }).id, 'y');
  assert.equal(resolveCallTarget(GHOSTS, null, 'sequential', { ...o, onScreen: new Set(['x']) }).id, 'y', 'no caller: from the top');
  assert.equal(resolveCallTarget(GHOSTS, 'z', 'sequential', { ...o, onScreen: new Set(['x', 'y', 'z', 'w']) }), null);
});

test('resolveCallTarget by name: descript name, sakura name, folder id, then any case; SSP asks the caller\'s names first', () => {
  const o = { supported, onScreen: new Set(['x']) };
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'なと', o).id, 'y', 'a sakura name (the corpus\'s \\![call,ghost,なと])');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'Ghost Z', o).id, 'z');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'w', o).id, 'w');
  assert.equal(resolveCallTarget(GHOSTS, 'x', ' ghost w ', o).id, 'w', 'trimmed, any case');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'W', o).id, 'w');
  // precedence: Beta is p's sakura name and q's descript name; Gamma is q's sakura name and r's folder id
  const list = [
    { id: 'p', name: 'Alpha', sakuraName: 'Beta' },
    { id: 'q', name: 'Beta', sakuraName: 'Gamma' },
    { id: 'Gamma', name: 'Delta', sakuraName: 'Eps' },
  ];
  assert.equal(resolveCallTarget(list, 'c', 'Beta').id, 'q', 'descript name before sakura name');
  assert.equal(resolveCallTarget(list, 'c', 'Gamma').id, 'q', 'sakura name before folder id');
  assert.equal(resolveCallTarget(list, 'c', 'delta').id, 'Gamma', 'descript name in any case');
  assert.equal(resolveCallTarget(list, 'c', 'gamma').id, 'Gamma', 'folder id in any case (sakura names only as written)');
  // [disasm GetGhostIDFromTag] the caller's own descript name, any descript name, the caller's own sakura name, any
  // sakura name: a name the caller shares points at the caller (ignored)
  const twins = [{ id: 't1', name: 'Twin', sakuraName: 'A' }, { id: 't2', name: 'Twin', sakuraName: 'B' }];
  assert.equal(resolveCallTarget(twins, 't2', 'Twin'), null, 'own descript name first');
  assert.equal(resolveCallTarget(twins, 'other', 'Twin').id, 't1');
  const shared = [{ id: 's1', name: 'One', sakuraName: 'S' }, { id: 's2', name: 'Two', sakuraName: 'S' }];
  assert.equal(resolveCallTarget(shared, 's2', 'S'), null, 'own sakura name before the others\'');
  const mixed = [{ id: 'm1', name: 'Mo', sakuraName: 'K' }, { id: 'm2', name: 'N', sakuraName: 'Mo' }];
  assert.equal(resolveCallTarget(mixed, 'm2', 'Mo').id, 'm1', 'any descript name before the caller\'s sakura name');
});

test('resolveCallTarget ignores the caller, ghosts on screen, unknown names, lastinstall*, missing engines', () => {
  const o = { supported, onScreen: new Set(['x', 'y']) };
  for (const t of ['Ghost X', 'Ex', 'x', 'X']) assert.equal(resolveCallTarget(GHOSTS, 'x', t, o), null, `self: ${t}`);
  for (const t of ['Ghost Y', 'なと', 'y']) assert.equal(resolveCallTarget(GHOSTS, 'x', t, o), null, `on screen: ${t}`);
  for (const t of ['nobody', '', '   ', null, undefined, 'lastinstalled', 'LastInstall', 'lastinstalledghost']) {
    assert.equal(resolveCallTarget(GHOSTS, 'x', t, o), null, `ignored: ${t}`);
  }
  for (const t of ['Yaya Test', 'Yayako', 'yaya']) assert.equal(resolveCallTarget(GHOSTS, 'x', t, o), null, `needs YAYA: ${t}`);
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'Yayako', { onScreen: new Set(['x']) }).id, 'yaya', 'every engine counts by default');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'z', { onScreen: new Set(['x', 'z']) }), null);
  assert.equal(resolveCallTarget([], 'x', 'random'), null);
  assert.equal(resolveCallTarget(null, 'x', 'z'), null);
});

test('resolveCallTarget byId: a folder id exactly; on screen, the caller or unrunnable -> null', () => {
  const o = { byId: true, supported, onScreen: new Set(['x', 'y']) };
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'z', o).id, 'z');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'y', o), null, 'on screen');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'x', o), null, 'self');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'yaya', o), null, 'needs YAYA');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'Z', o), null, 'ids are exact');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'Ghost Z', o), null, 'no names');
  assert.equal(resolveCallTarget(GHOSTS, 'x', 'random', o), null, 'no keywords');
});

// ---------------------------------------------------------------- ghost-to-ghost talk and raised events (EV §2.7.7, §2.7.9)

test('sspNameEqual: SSP\'s wcsicmp_printchar — spaces (up to U+0020, U+3000) skipped anywhere, SSP\'s case table, no width or kana folding', () => {
  assert.equal(sspNameEqual('Emily / Phase4.5', 'emily/phase4.5'), true);
  assert.equal(sspNameEqual('琥珀 あかね', '琥珀あかね'), true, 'roommate\'s sakura name');
  assert.equal(sspNameEqual('琥珀　あかね', '琥珀あかね'), true, 'U+3000');
  assert.equal(sspNameEqual(' \tTsu\r\nbasa\x01', 'TSUBASA'), true, 'every control character too');
  assert.equal(sspNameEqual('ＴＳＵＢＡＳＡ', 'ｔｓｕｂａｓａ'), true, 'full-width letters fold among themselves');
  assert.equal(sspNameEqual('ΣΟΦΙΑ', 'σοφια'), true, 'Greek');
  assert.equal(sspNameEqual('ａ', 'a'), false, 'no width folding');
  assert.equal(sspNameEqual('あ', 'ア'), false, 'no kana folding');
  assert.equal(sspNameEqual('À', 'à'), false, 'SSP\'s table leaves À–Þ');
  assert.equal(sspNameEqual('a‌b', 'ab'), false, 'U+200C (SSP\'s duplicate-name mark) is not skipped');
  assert.equal(sspNameEqual('Tsubasa', 'Tsubasa2'), false);
  assert.equal(sspNameEqual('Tsu basa', 'Tsubasa'), true);
  assert.equal(sspNameEqual(' ', ''), true, 'nothing but skipped characters');
  assert.equal(sspNameEqual(null, ''), true);
});

test('communicateTargets: by the sakura name in effect only, the first match per \\x01 token, duplicates kept; ALL only as the whole value', () => {
  assert.equal(ALL_GHOSTS, '__SYSTEM_ALL_GHOST__');
  const peers = [
    { id: 'y', name: 'Ghost Y', sakuraName: 'なと', keroName: 'ごはん' },
    { id: 'z', name: 'Ghost Z', sakuraName: 'Zed', keroName: 'Kay' },
    { id: 'a', name: 'Zed', sakuraName: '琥珀 あかね', keroName: '' },
    { id: 'b', name: 'Ghost B', sakuraName: 'zed', keroName: '' },
  ];
  assert.deepEqual(communicateTargets(peers, 'なと'), ['y']);
  assert.deepEqual(communicateTargets(peers, 'ZED'), ['z'], 'the first match in any case; b never');
  assert.deepEqual(communicateTargets(peers, '琥珀あかね'), ['a'], 'spaces skipped');
  for (const t of ['Ghost Y', 'ごはん', 'Kay', 'y', 'Ghost B']) {
    assert.deepEqual(communicateTargets(peers, t), [], `never a descript name, kero name or id: ${t}`);
  }
  assert.deepEqual(communicateTargets(peers, 'Zed\x01なと\x01nobody\x01\x01zed'), ['z', 'y', 'z'],
    'token order; unknown and empty tokens vanish; a name twice: that ghost twice');
  assert.deepEqual(communicateTargets(peers, '__system_all_ghost__'), ['y', 'z', 'a', 'b'], 'ALL in any case: every peer, in order');
  assert.deepEqual(communicateTargets(peers, `なと\x01${ALL_GHOSTS}`), ['y'], 'inside a list ALL is just an unknown name');
  assert.deepEqual(communicateTargets(peers, ` ${ALL_GHOSTS}`), [], 'the whole value, nothing skipped');
  for (const t of ['', null, undefined, '\x01\x01']) assert.deepEqual(communicateTargets(peers, t), [], String(t));
  assert.deepEqual(communicateTargets([], ALL_GHOSTS), []);
  assert.deepEqual(communicateTargets(null, 'なと'), []);
  assert.deepEqual(communicateTargets([null, { sakuraName: 'なと' }, { id: '', sakuraName: 'なと' }], 'なと'), [], 'peers without an id');
});

test('raiseTargets: random, lastinstall, ALL with the raiser, then per token a descript name before a sakura name; never the kero name', () => {
  const cands = [
    { id: 'x', name: 'Ghost X', sakuraName: 'Ex', keroName: 'Kx' },          // the raiser (the caller skips it)
    { id: 'p', name: 'Alpha', sakuraName: 'Beta', keroName: 'Ka' },
    { id: 'q', name: 'Beta', sakuraName: 'Gamma', keroName: '' },
    { id: 'r', name: 'Delta', sakuraName: 'Gam ma', keroName: '' },
    { id: 's', name: 'Eps', sakuraName: 'gamma', keroName: '' },
  ];
  assert.deepEqual(raiseTargets(cands, 'Beta'), ['q'], 'a descript name anywhere before an earlier sakura name');
  assert.deepEqual(raiseTargets(cands, 'alpha'), ['p'], 'descript names in any case');
  assert.deepEqual(raiseTargets(cands, 'Gamma'), ['q'], 'a sakura name; the first of equals');
  assert.deepEqual(raiseTargets(cands, 'GAM MA'), ['r'], 'an exact (case-folded) sakura name before an earlier one with spaces skipped');
  assert.deepEqual(raiseTargets(cands, 'gam　ma'), ['q'], 'no exact one: the first with spaces skipped');
  assert.deepEqual(raiseTargets(cands, 'Ex'), ['x'], 'the raiser is a candidate');
  for (const t of ['Ka', 'Kx', 'p', 'nobody', '', '\x01']) assert.deepEqual(raiseTargets(cands, t), [], `none: ${t}`);
  assert.deepEqual(raiseTargets(cands, 'Ghost X\x01Delta\x01\x01nobody\x01delta'), ['x', 'r', 'r'], 'token order, duplicates kept');
  assert.deepEqual(raiseTargets(cands, '__System_All_Ghost__'), ['x', 'p', 'q', 'r', 's'], 'ALL: every candidate, the raiser included');
  assert.deepEqual(raiseTargets(cands, `Beta\x01${ALL_GHOSTS}`), ['q'], 'ALL inside a list: an unknown name');
  assert.deepEqual(raiseTargets(cands, 'random', { random: () => 0 }), ['x'], 'random: the raiser possible');
  assert.deepEqual(raiseTargets(cands, 'RANDOM', { random: () => 0.5 }), ['q']);
  assert.deepEqual(raiseTargets(cands, 'random', { random: () => 0.999999 }), ['s']);
  assert.deepEqual(raiseTargets([], 'random', { random: () => 0 }), []);
  assert.deepEqual(raiseTargets([...cands, { id: 'li', name: 'lastinstall', sakuraName: 'lastinstalled' }], 'lastinstall'), [],
    'lastinstall…: nothing is installed in a browser, even a ghost of that name');
  assert.deepEqual(raiseTargets(cands, 'LastInstalledGhost'), []);
  assert.deepEqual(raiseTargets(null, ALL_GHOSTS), []);
  for (const t of ['lastinstall', 'LASTINSTALLx', 'lastinstall.ghost']) assert.equal(isLastInstall(t), true, t);
  for (const t of ['last install', 'xlastinstall', 'lastinstal', '', null]) assert.equal(isLastInstall(t), false, String(t));
});

test('otherghostname References: <sakura name>\\x01<surface 0>\\x01<surface 1>, -1 for no surface', () => {
  assert.equal(otherGhostRef({ sakuraName: 'Tsubasa', surfaces: [0, 10] }), 'Tsubasa\x010\x0110');
  assert.equal(otherGhostRef({ sakuraName: 'ハヤト', surfaces: [5] }), 'ハヤト\x015\x01-1');
  assert.equal(otherGhostRef({ sakuraName: 'A', surfaces: [-1, null] }), 'A\x01-1\x01-1');
  assert.equal(otherGhostRef({ sakuraName: 'A', surfaces: ['3', 'x'] }), 'A\x013\x01-1');
  assert.equal(otherGhostRef({ sakuraName: 'A', surfaces: [2.5, NaN] }), 'A\x01-1\x01-1');
  assert.equal(otherGhostRef({}), '\x01-1\x01-1');
  assert.equal(otherGhostRef(), '\x01-1\x01-1');
});

test('after-boot and closed References: 8 slots, R3-R6 not sent, R7 the shell', () => {
  const info = { sakuraName: 'Hayato', script: '\\0Hi.\\e', name: 'ハヤト', shell: 'master', path: '/ghost/hayato/' };
  const want = ['Hayato', '\\0Hi.\\e', 'ハヤト', undefined, undefined, undefined, undefined, 'master'];
  for (const f of [afterBootRefs, otherClosedRefs]) {
    const r = f(info);
    assert.equal(r.length, 8, f.name);
    assert.deepEqual(r, want, f.name);
  }
  assert.deepEqual(afterBootRefs({ sakuraName: 'A', name: 'B', shell: 'm' }), ['A', '', 'B', undefined, undefined, undefined, undefined, 'm'],
    'nothing played: R1 empty, still sent');
  // the request leaves R3-R6 out and keeps R7 (shiori.js buildRequest skips undefined)
  const text = buildRequest({ id: 'OnGhostCallComplete', refs: afterBootRefs(info) }, {});
  assert.deepEqual(text.match(/^Reference\d+/gm), ['Reference0', 'Reference1', 'Reference2', 'Reference7']);
});

test('OnOtherGhostChanged References: 16 slots, R6-R13 not sent, R14/R15 the shells', () => {
  const a = { sakuraName: 'Ex', name: 'Ghost X', script: '\\0Bye.\\e', shell: 'master' };
  const b = { sakuraName: 'Dub', name: 'Ghost W', script: '\\0Hello.\\e', shell: 'winter' };
  const r = otherChangedRefs(a, b);
  assert.equal(r.length, 16);
  assert.deepEqual(r.slice(0, 6), ['Ex', 'Dub', '\\0Bye.\\e', '\\0Hello.\\e', 'Ghost X', 'Ghost W']);
  assert.deepEqual(r.slice(6, 14), Array(8).fill(undefined));
  assert.deepEqual(r.slice(14), ['master', 'winter']);
  const text = buildRequest({ id: 'OnOtherGhostChanged', refs: r }, {});
  assert.deepEqual(text.match(/^Reference\d+/gm), ['Reference0', 'Reference1', 'Reference2', 'Reference3', 'Reference4', 'Reference5',
    'Reference14', 'Reference15']);
});

test('OnOtherGhostTalk References: talker name and sakura name, flags, event, script, the refs joined by \\x01', () => {
  const talker = { name: 'Hayama-san Next Door', sakuraName: 'Tsubasa' };
  const run = { event: 'OnMouseDoubleClick', script: '\\0Hm?\\e', refs: [0, 0, 0, null, 'Head', undefined] };
  assert.deepEqual(otherTalkRefs(talker, run, ''),
    ['Hayama-san Next Door', 'Tsubasa', '', 'OnMouseDoubleClick', '\\0Hm?\\e', '0\x010\x010\x01\x01Head\x01']);
  assert.equal(otherTalkRefs(talker, run, 'break')[2], 'break');
  assert.equal(otherTalkRefs(talker, run, ['break', '', 'communicate'])[2], 'break,communicate', 'a comma list');
  assert.deepEqual(otherTalkRefs(talker, { event: 'OnBoot', script: 's' }), ['Hayama-san Next Door', 'Tsubasa', '', 'OnBoot', 's', '']);
  assert.equal(otherTalkRefs().length, 6);
});

test('diffSets: ghosts gone, added, and replaced in place (same place, another ghost)', () => {
  assert.deepEqual(diffSets(['x', 'y'], ['x', 'y']), { gone: [], added: [], replaced: [] });
  assert.deepEqual(diffSets(['x'], ['x', 'z']), { gone: [], added: ['z'], replaced: [] }, 'a call');
  assert.deepEqual(diffSets(['x', 'y'], ['y']), { gone: ['x'], added: [], replaced: [] }, 'a close: y moves up, not a change');
  assert.deepEqual(diffSets(['x', 'y'], ['w', 'y']), { gone: [], added: [], replaced: [['x', 'w']] }, 'a change in slot 0');
  assert.deepEqual(diffSets(['x', 'y', 'z'], ['x', 'w', 'z']), { gone: [], added: [], replaced: [['y', 'w']] });
  assert.deepEqual(diffSets(['x', 'y'], ['y', 'z']), { gone: ['x'], added: ['z'], replaced: [] }, 'a close and a call');
  assert.deepEqual(diffSets(['x', 'y'], ['w']), { gone: ['y'], added: [], replaced: [['x', 'w']] });
  assert.deepEqual(diffSets(['x', 'y'], []), { gone: ['x', 'y'], added: [], replaced: [] }, 'quit / sync');
  assert.deepEqual(diffSets(null, ['x']), { gone: [], added: ['x'], replaced: [] });
});

test('marker readers: a v1 marker {ghost, pending, change} reads as ghosts [ghost] and carry {ghost: change}', () => {
  const change = { sakuraName: 'Ex', name: 'Ghost X', path: '/ghost/x/', script: '\\0Bye.\\e' };
  const v1 = { booted: true, ghost: 'y', sessionEpochMs: 5, pending: true, change };
  assert.deepEqual(markerGhosts(v1), ['y']);
  assert.deepEqual(markerCarry(v1), { y: { kind: 'change', change } });
  assert.deepEqual(markerCarry({ ...v1, change: undefined }), { y: { kind: 'change', change: null } }, 'a change from nobody known');
  assert.deepEqual(markerCarry({ booted: true, ghost: 'y', sessionEpochMs: 5 }), {});
  assert.deepEqual(markerCarry({ booted: true, ghost: 'y', pending: 'yes' }), {}, 'only pending: true');
  for (const bad of [null, undefined, 'x', []]) { assert.deepEqual(markerGhosts(bad), []); assert.deepEqual(markerCarry(bad), {}); }
  // v2: ghosts and carry win over the mirror
  const call = { sakuraName: 'Ex', name: 'Ghost X', path: '/ghost/x/', script: '' };
  const v2 = {
    booted: true, ghost: 'x', sessionEpochMs: 5, ghosts: ['x', 'y', 'x'],
    carry: {
      y: { kind: 'call', call, caller: 'x' },
      z: { kind: 'after', of: 'call', caller: 'x' },
      w: { kind: 'after', of: 'change', prev: { sakuraName: 'Ex', name: 'Ghost X', shell: 'master', script: '' } },
      bad1: { kind: 'call' }, bad2: { kind: 'after', of: 'boot' }, bad3: 'change', bad4: { kind: 'other' },
    },
  };
  assert.deepEqual(markerGhosts(v2), ['x', 'y']);
  assert.deepEqual(Object.keys(markerCarry(v2)), ['y', 'z', 'w'], 'malformed entries dropped');
  assert.equal(markerCarry(v2).y, v2.carry.y, 'entries pass through as written');
  assert.deepEqual(markerCarry({ ...v2, pending: true, change }), markerCarry(v2), 'carry wins over the v1 mirror');
});

test('markerRecord: one ghost gives the single-ghost runtime\'s v1 fields plus ghosts; two keep ghost = ghosts[0]', () => {
  // no carry: exactly the old {booted, ghost, sessionEpochMs}, in that order, plus ghosts
  assert.equal(JSON.stringify(markerRecord({ ghosts: ['x'], sessionEpochMs: 5 })),
    JSON.stringify({ booted: true, ghost: 'x', sessionEpochMs: 5, ghosts: ['x'] }));
  // a change carried for the one ghost: the old {…, pending: true, change} first
  const change = { sakuraName: 'Ex', name: 'Ghost X', path: '/ghost/x/', script: '\\0Bye.\\e' };
  const one = markerRecord({ ghosts: ['w'], sessionEpochMs: 5, carry: { w: { kind: 'change', change } } });
  assert.deepEqual(one, { booted: true, ghost: 'w', sessionEpochMs: 5, pending: true, change, ghosts: ['w'], carry: { w: { kind: 'change', change } } });
  assert.deepEqual(Object.keys(one).slice(0, 5), ['booted', 'ghost', 'sessionEpochMs', 'pending', 'change']);
  assert.equal(markerRecord({ ghosts: ['w'], sessionEpochMs: 5, carry: { w: { kind: 'change', change: null } } }).change, null);
  assert.equal(markerRecord({ ghosts: ['w'], sessionEpochMs: 5, carry: { w: { kind: 'after', of: 'change', prev: {} } } }).pending, undefined,
    'pending only for a change');
  // two ghosts
  const call = { sakuraName: 'Ex', name: 'Ghost X', path: '/ghost/x/', script: '' };
  const two = markerRecord({
    ghosts: ['x', 'y'], sessionEpochMs: 9,
    carry: { y: { kind: 'call', call, caller: 'x' }, z: { kind: 'after', of: 'call', caller: 'x' }, x: { kind: 'bogus' } },
  });
  assert.deepEqual(two, { booted: true, ghost: 'x', sessionEpochMs: 9, ghosts: ['x', 'y'], carry: { y: { kind: 'call', call, caller: 'x' } } },
    'carries outside the set and malformed ones dropped; a call carry is no v1 pending');
  assert.equal(markerRecord({ ghosts: ['x', 'y'], sessionEpochMs: 9, carry: { y: { kind: 'change', change } } }).pending, undefined,
    'pending only for ghosts[0]');
});

test('the marker round trip: markerRecord -> sessionMarker.write / read (v2 fields pass through) -> the readers', () => {
  const ss = sessionStore();
  const call = { sakuraName: 'Ex', name: 'Ghost X', path: '/ghost/x/', script: '\\0Come.\\e' };
  sessionMarker.write(markerRecord({ ghosts: ['x', 'y'], sessionEpochMs: 77, carry: { y: { kind: 'call', call, caller: 'x' } } }), ss);
  const m = sessionMarker.read(ss);
  assert.equal(m.ghost, 'x');
  assert.equal(m.sessionEpochMs, 77);
  assert.deepEqual(markerGhosts(m), ['x', 'y']);
  assert.deepEqual(markerCarry(m), { y: { kind: 'call', call, caller: 'x' } });
  // one ghost: what the single-ghost runtime wrote before
  sessionMarker.write(markerRecord({ ghosts: ['x'], sessionEpochMs: 77 }), ss);
  assert.deepEqual(JSON.parse(ss.m.get(SESSION_KEY)), { booted: true, ghost: 'x', sessionEpochMs: 77, ghosts: ['x'], v: 2 });
  // an empty set is no marker
  sessionMarker.write(markerRecord({ ghosts: [], sessionEpochMs: 77 }), ss);
  assert.equal(sessionMarker.read(ss), null);
});

test('markerRecord quit: a Quit saying goodbye is written as quit: true (left out otherwise) and read back by markerQuit', () => {
  const ss = sessionStore();
  const one = markerRecord({ ghosts: ['x', 'y'], sessionEpochMs: 5, quit: true });
  assert.equal(one.quit, true);
  assert.equal(JSON.stringify(markerRecord({ ghosts: ['x'], sessionEpochMs: 5, quit: false })),
    JSON.stringify({ booted: true, ghost: 'x', sessionEpochMs: 5, ghosts: ['x'] }), 'no quit: no quit field');
  sessionMarker.write(one, ss);
  assert.equal(markerQuit(sessionMarker.read(ss)), true);
  assert.deepEqual(markerGhosts(sessionMarker.read(ss)), ['x', 'y']);
  for (const m of [null, undefined, 'x', [], { booted: true, ghost: 'x' }, { booted: true, ghost: 'x', quit: 'yes' }, { quit: 1 }]) {
    assert.equal(markerQuit(m), false);
  }
});
