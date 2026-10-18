// %-variable expansion before a script plays: ssp.exe's TranslateParam / TranslateParamReal (properties.md §2).
import test from 'node:test';
import assert from 'node:assert/strict';
import { expandScript, EXPAND_NAMES, WORD_NAMES } from '../../src/sakura/expand.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('error');
const S = s => s.replace(/¥/g, '\\');

/** A resolver over a table: property names under 'property:NAME', null for anything else; records every call. */
function table(values) {
  const asked = [];
  const resolve = (name, arg) => {
    asked.push(name === 'property' ? ['property', arg] : [name]);
    const key = name === 'property' ? 'property:' + arg : name;
    return key in values ? values[key] : null;
  };
  return { resolve, asked };
}

test('%property[NAME]: the value goes in raw (a \\ in it is script); a failed one is removed', () => {
  const t = table({ 'property:p': S('a¥nb'), 'property:e': '' });
  assert.equal(expandScript(S('x%property[p]y'), t.resolve), S('xa¥nby'));
  assert.equal(expandScript('x%property[bad]y', t.resolve), 'xy');
  assert.equal(expandScript('x%property[e]y', t.resolve), 'xy');
  assert.deepEqual(t.asked, [['property', 'p'], ['property', 'bad'], ['property', 'e']]);
});

test('%property[] and an unclosed %property[x stay as written; NAME ends at the first ]', () => {
  const t = table({ 'property:ghostlist(a': 'V' });
  assert.equal(expandScript('a%property[]b', t.resolve), 'a%property[]b');
  assert.equal(expandScript('a%property[x', t.resolve), 'a%property[x');
  assert.equal(expandScript('a%propertyx', t.resolve), 'a%propertyx');
  assert.equal(expandScript('%property[ghostlist(a]b).name]', t.resolve), 'Vb).name]');
  assert.deepEqual(t.asked, [['property', 'ghostlist(a']]);
});

test('nothing inside a tag bracket is expanded; \\% never is; text between tags is', () => {
  const t = table({ username: 'Hana', 'property:a': 'A' });
  const r = s => expandScript(S(s), t.resolve);
  assert.equal(r('¥q[%username,X]'), S('¥q[%username,X]'));
  assert.equal(r('¥![embed,E,"%property[a]"]'), S('¥![embed,E,"%property[a]"]'));
  assert.equal(r('¥![open,inputbox,I,,%username]'), S('¥![open,inputbox,I,,%username]'));
  assert.equal(r('¥_a[ID]%username¥_a ¥__q[ID]%property[a]¥__q'), S('¥_a[ID]Hana¥_a ¥__q[ID]A¥__q'));
  assert.equal(r('¥%username ¥¥%username'), S('¥%username ¥¥Hana'), '\\% is a tag letter; \\\\ is not');
  // the bracket ends at the first ] without a \ before it; quotes are not honoured
  assert.equal(r('¥![raise,E,a¥]%username]%username'), S('¥![raise,E,a¥]%username]Hana'));
  assert.equal(r('¥![raise,E,"a]%username"]'), S('¥![raise,E,"a]Hana"]'));
  assert.equal(r('¥s10%username'), S('¥s10Hana'), 'a tag without a bracket skips its letter only');
});

test('names are case-sensitive and longest first; unknown or valueless names stay as written', () => {
  const t = table({ selfname: 'S', selfname2: 'T', 'property:a': 'A' });
  assert.equal(expandScript('%Property[a] %selfname2 %selfname %month %x 100%', t.resolve), '%Property[a] T S %month %x 100%');
  assert.ok(EXPAND_NAMES.includes('property') && !EXPAND_NAMES.includes('*'), '%* is the tokenizer\'s');
  assert.equal(expandScript('%*', t.resolve), '%*');
});

test('the word variables: %dms and %m + one of cehlpstz? are asked by name; a %m that ends the text is asked as m', () => {
  const t = table({ dms: 'D', ms: 'S', 'm?': 'Q', me: 'E', m: 'M' });
  assert.equal(expandScript('%dms %ms %m? %me投げ %mx %M? %m', t.resolve), 'D S Q E投げ %mx %M? M');
  assert.deepEqual(t.asked, [['dms'], ['ms'], ['m?'], ['me'], ['m']], '%month and %minute come first: no %mo, %mi');
  assert.deepEqual([...WORD_NAMES].sort(), ['dms', 'm', 'm?', 'mc', 'me', 'mh', 'ml', 'mp', 'ms', 'mt', 'mz']);
  const u = table({ month: '10', minute: '5' });
  assert.equal(expandScript('%month %minute %m b', u.resolve), '10 5 %m b', 'a %m with text after it is text');
  assert.deepEqual(u.asked, [['month'], ['minute']]);
  const v = table({});
  assert.equal(expandScript('%m', v.resolve), '%m', 'no word: as written');
  assert.deepEqual(v.asked, [['m']]);
});

test('%username, %selfname, %selfname2, %keroname, %last…name double their backslashes; %property does not', () => {
  const t = table({ username: S('a¥b'), selfname: S('c¥'), selfname2: S('¥d'), keroname: S('e¥¥f'), 'property:p': S('g¥h'),
    lastghostname: S('i¥'), screenwidth: S('j¥') });
  assert.equal(expandScript('%username|%selfname|%selfname2|%keroname|%property[p]|%lastghostname|%screenwidth', t.resolve),
    S('a¥¥b|c¥¥|¥¥d|e¥¥¥¥f|g¥h|i¥¥|j¥'));
});

test('a value is scanned again from its 2nd character, then whole passes repeat while the text changes (at most 5)', () => {
  // a value holding %username is expanded in the same pass [disasm 0x6372F4]: one pass is enough
  let t = table({ 'property:p': '<%username>', username: 'Hana' });
  assert.equal(expandScript('%property[p]', t.resolve), '<Hana>');
  assert.deepEqual(t.asked, [['property', 'p'], ['username']]);
  assert.equal(expandScript('%property[p]', t.resolve, { maxPasses: 1 }), '<Hana>', 'the scan goes inside the value');
  // a value starting with a variable: that one waits for the next pass
  t = table({ 'property:p': '%username', username: 'Hana' });
  assert.equal(expandScript('%property[p]', t.resolve), 'Hana');
  assert.deepEqual(t.asked, [['property', 'p'], ['username']]);
  assert.equal(expandScript('%property[p]', t.resolve, { maxPasses: 1 }), '%username', 'its 1st character is not looked at');
  // two names that turn into each other: five passes, then it stops
  t = table({ username: '%selfname', selfname: '%username' });
  assert.equal(expandScript('%username', t.resolve), '%selfname');
  assert.equal(t.asked.length, 5);
  assert.equal(expandScript('%username', t.resolve, { maxPasses: 2 }), '%username');
});

test('after a removal the scan goes on one character late (ssp.exe 0x637024): a \\ there loses its bracket skip', () => {
  const t = table({ username: 'Hana' });
  assert.equal(expandScript(S('%property[x]¥%username'), t.resolve), S('¥Hana'));
  // the character right after a removed variable is looked at only by the next pass
  assert.equal(expandScript('%property[x]%username', t.resolve), 'Hana');
});

test('a value that grows the script for ever stops expanding (ssp.exe would not) [decision]', () => {
  const t = table({ username: 'x%username' });
  const out = expandScript('%username', t.resolve);
  assert.ok(out.length > 1000 && out.length < 200000);
  assert.ok(t.asked.length <= 10000);
});

test('a thenable resolver gives a Promise of the same text; no thenable: a string', async () => {
  const values = { username: 'Hana', 'property:a': 'A', 'property:b': null };
  const sync = table(values);
  const s = S('¥0%username %property[a]%property[b]! ¥q[%username,x]%month');
  const plain = expandScript(s, sync.resolve);
  assert.equal(typeof plain, 'string');
  const asyncAsked = [];
  const p = expandScript(s, (name, arg) => {
    asyncAsked.push(name);
    const v = sync.resolve(name, arg);
    return name === 'username' ? Promise.resolve(v) : v;
  });
  assert.ok(p instanceof Promise);
  assert.equal(await p, plain);
  assert.equal(plain, S('¥0Hana A! ¥q[%username,x]%month'));
  // a resolver that throws or rejects gives no value
  assert.equal(await expandScript('%username|%property[a]', name => (name === 'username' ? Promise.reject(new Error('x')) : null)),
    '%username|');
  assert.equal(expandScript('%property[a]b', () => { throw new Error('x'); }), 'b');
  assert.equal(expandScript('no variables', () => assert.fail('not asked')), 'no variables');
});
