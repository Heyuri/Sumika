// Whether Sumika runs on a page (src/core/choice.js; [decision] On, Off and Site default only): data-default-state
// read as data-phone is (values, case, one warn), the visitor's record `sumika:choice` read through the schema hook (none,
// On, Off, garbage, a newer page's record read for what fits, blocked storage) and written as the control page writes it
// (kept fields, Site default removes it, a newer record never written, a refusing storage), and startState's whole
// precedence table: the visitor's choice over the site's default, On as "enabled" whatever the default, data-phone=
// "tucked" kept on a phone under On. main.js's order before it (phone off, then the browser check) is
// default_state.test.mjs's, on the bundle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CHOICE_KEY, CHOICES, DEFAULT_STATES, defaultState, parseChoice, readChoice, saveChoice, startState } from '../../src/core/choice.js';
import { SCHEMA } from '../../src/core/schema.js';
import { memoryStorage } from '../../src/core/state.js';
import { isLocalKey } from '../../src/core/hubproto.js';

test('the key and values: a sumika: localStorage key (the hub carries it), On and Off; data-default-state enabled, tucked, off', () => {
  assert.equal(CHOICE_KEY, 'sumika:choice');
  assert.ok(isLocalKey(CHOICE_KEY), 'one of the keys the storage hub mirrors');
  assert.deepEqual(CHOICES, ['on', 'off']);
  assert.deepEqual(DEFAULT_STATES, ['enabled', 'tucked', 'off']);
  assert.equal(SCHEMA.choice, 1);
});

test('defaultState: absent, empty or unknown -> enabled (an unknown value warns once); the three values in any case, trimmed', () => {
  const run = d => { const warns = []; return [defaultState(d, m => warns.push(m)), warns.length, warns[0]]; };
  assert.deepEqual(run({}).slice(0, 2), ['enabled', 0], 'absent');
  assert.deepEqual(run(undefined).slice(0, 2), ['enabled', 0]);
  assert.deepEqual(run(null).slice(0, 2), ['enabled', 0]);
  assert.deepEqual(run({ defaultState: '' }).slice(0, 2), ['enabled', 0], 'bare');
  assert.deepEqual(run({ defaultState: '  ' }).slice(0, 2), ['enabled', 0]);
  for (const v of ['enabled', 'tucked', 'off']) assert.deepEqual(run({ defaultState: v }).slice(0, 2), [v, 0], v);
  assert.deepEqual(run({ defaultState: ' TUCKED ' }).slice(0, 2), ['tucked', 0], 'any case, trimmed');
  assert.deepEqual(run({ defaultState: 'Off' }).slice(0, 2), ['off', 0]);
  const [v, n, msg] = run({ defaultState: 'hidden' });
  assert.deepEqual([v, n], ['enabled', 1], 'an unknown value: enabled, one warn');
  assert.match(msg, /data-default-state="hidden" is not enabled, tucked or off/);
  assert.deepEqual(run({ defaultState: 'on' }).slice(0, 2), ['enabled', 1], '"on" is the visitor\'s word, not the site\'s');
});

test('parseChoice / readChoice: none, On, Off; no JSON, no object or no choice in it -> none; a newer record read for what fits; blocked storage', () => {
  assert.deepEqual(parseChoice(null), { choice: null, newer: false, rec: null });
  for (const c of ['on', 'off']) {
    const r = parseChoice(JSON.stringify({ choice: c, v: 1 }));
    assert.deepEqual([r.choice, r.newer], [c, false], c);
  }
  assert.equal(parseChoice(JSON.stringify({ choice: 'off' })).choice, 'off', 'unmarked: version 1');
  for (const bad of ['{', '"off"', '[]', '1', JSON.stringify({ choice: 'maybe', v: 1 }), JSON.stringify({ v: 1 })]) {
    assert.equal(parseChoice(bad).choice, null, bad);
  }
  const newer = parseChoice(JSON.stringify({ choice: 'off', v: 2, why: 'later' }));
  assert.deepEqual([newer.choice, newer.newer], ['off', true], 'a newer page\'s record: read for what fits');
  assert.deepEqual(parseChoice(JSON.stringify({ choice: { level: 3 }, v: 2 })).choice, null, 'a choice it cannot read: none');

  const s = memoryStorage();
  assert.deepEqual(readChoice(s), { choice: null, newer: false, blocked: false });
  s.setItem(CHOICE_KEY, JSON.stringify({ choice: 'on', v: 1 }));
  assert.deepEqual(readChoice(s), { choice: 'on', newer: false, blocked: false });
  assert.deepEqual(readChoice(null), { choice: null, newer: false, blocked: true }, 'no storage at all');
  const refusing = { getItem() { throw new DOMException('denied', 'SecurityError'); } };
  assert.deepEqual(readChoice(refusing), { choice: null, newer: false, blocked: true }, 'storage that throws: the site\'s default');
  // a read writes nothing
  const writes = [];
  const watched = { getItem: k => s.getItem(k), setItem: (k) => writes.push(k), removeItem: k => writes.push(k) };
  readChoice(watched);
  assert.deepEqual(writes, []);
});

test('saveChoice: On and Off stored with their version, fields a later writer added kept; Site default removes the record; a newer record is never written or cleared; a refusing storage fails', () => {
  const s = memoryStorage();
  assert.equal(saveChoice(s, 'off'), 'saved');
  assert.deepEqual(JSON.parse(s.getItem(CHOICE_KEY)), { choice: 'off', v: SCHEMA.choice });
  s.setItem(CHOICE_KEY, JSON.stringify({ choice: 'off', v: 1, at: 123 }));
  assert.equal(saveChoice(s, 'on'), 'saved');
  assert.deepEqual(JSON.parse(s.getItem(CHOICE_KEY)), { choice: 'on', v: 1, at: 123 }, 'an additive field kept');
  assert.equal(saveChoice(s, null), 'saved');
  assert.equal(s.getItem(CHOICE_KEY), null, 'Site default: no record');
  assert.equal(saveChoice(s, null), 'saved', 'already none');
  s.setItem(CHOICE_KEY, '{garbage');
  assert.equal(saveChoice(s, 'on'), 'saved', 'a record that does not read is replaced');
  assert.equal(readChoice(s).choice, 'on');

  const newer = JSON.stringify({ choice: 'off', v: 2, more: true });
  s.setItem(CHOICE_KEY, newer);
  assert.equal(saveChoice(s, 'on'), 'newer');
  assert.equal(saveChoice(s, null), 'newer');
  assert.equal(s.getItem(CHOICE_KEY), newer, 'never written or cleared');

  const full = { getItem: () => null, setItem() { throw new DOMException('full', 'QuotaExceededError'); }, removeItem() {} };
  assert.equal(saveChoice(full, 'off'), 'failed');
  const blocked = { getItem() { throw new DOMException('denied', 'SecurityError'); } };
  assert.equal(saveChoice(blocked, 'on'), 'failed');
  assert.throws(() => saveChoice(s, 'maybe'), TypeError);
  assert.throws(() => saveChoice(s, 'site'), TypeError, 'Site default is null, not a stored word');
});

test('startState: the whole table (the visitor\'s choice, else data-default-state; data-phone="tucked" on a phone kept unless off)', () => {
  const E = { state: 'enabled' }, T = { state: 'tucked' }, O = { state: 'off' };
  // [choice, siteDefault, phoneMode] -> state, reason
  const rows = [];
  for (const phoneMode of [null, 'on', 'tucked']) {
    const ph = phoneMode === 'tucked';
    for (const [def, none] of [['enabled', ph ? T : E], ['tucked', T], ['off', O], ['garbage', ph ? T : E]]) {
      rows.push([null, def, phoneMode, none.state, 'site']);
      rows.push(['on', def, phoneMode, ph ? 'tucked' : 'enabled', 'visitor']);
      rows.push(['off', def, phoneMode, 'off', 'visitor']);
    }
  }
  assert.equal(rows.length, 36);
  for (const [choice, def, phoneMode, state, reason] of rows) {
    assert.deepEqual(startState(choice, def, phoneMode), { state, reason }, JSON.stringify([choice, def, phoneMode]));
  }
  // spot checks in words
  assert.deepEqual(startState(null, 'enabled'), { state: 'enabled', reason: 'site' }, 'no attribute, no choice: the ghost as usual');
  assert.deepEqual(startState('on', 'off'), { state: 'enabled', reason: 'visitor' }, 'On beats the site\'s off');
  assert.deepEqual(startState('on', 'tucked'), { state: 'enabled', reason: 'visitor' }, 'On beats the site\'s tucked');
  assert.deepEqual(startState('off', 'enabled'), { state: 'off', reason: 'visitor' }, 'Off beats everything');
  assert.deepEqual(startState('on', 'enabled', 'tucked'), { state: 'tucked', reason: 'visitor' }, 'a phone\'s tucked kept under On');
  assert.deepEqual(startState(null, 'off', 'tucked'), { state: 'off', reason: 'site' }, 'the site\'s off beats its phone layout');
});
