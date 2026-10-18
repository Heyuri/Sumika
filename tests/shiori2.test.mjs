// The SHIORI/2.x bridge (src/worker/engines/shiori2.js, kawari7-wasm.md §6): the handshake ssp.exe 2.9.10 makes, the
// 2.x request it sends for each of the page's SHIORI/3.0 calls (by the call's kind), what it never sends a 2.x SHIORI,
// and the page's reading of a 2.x reply (an EventLoop on fakes for its GetStringShiori reads). Pure: no engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { toShiori2, fromShiori2, readVersionReply, parseMessage, Shiori2Session, VERSION_REQUEST, VERSION_PROBE_30, NOTHING }
  from '../src/worker/engines/shiori2.js';
import { buildRequest, parseResponse } from '../src/core/shiori.js';
import { EventLoop } from '../src/core/events.js';
import { StateStore, memoryStorage } from '../src/core/state.js';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs } from './runtime/fakes.mjs';

const GHOST7 = { id: 'k7', name: 'K7', sakuraName: 'なな', keroName: '', engine: 'kawari7', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };

const CRLF = '\r\n';
const BASE = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
const page = (id, refs = [], o = {}) => buildRequest({ id, refs, ...o }, BASE);
const msg = (...lines) => lines.join(CRLF) + CRLF + CRLF;
/** a session after Kawari 7.5.0's handshake reply */
function kawari() {
  const s = new Shiori2Session();
  readVersionReply(msg('SHIORI/2.6 200 OK', 'Charset: Shift_JIS', 'Craftman: KawariDevelopmentTeam', 'ID: KAWARI.kdt.i18n',
    'Version: 7.5.0'), s);
  return s;
}
const one = (text, s = kawari(), meta = {}) => {
  const plan = toShiori2(text, s, meta);
  assert.equal(plan.length, 1, JSON.stringify(plan));
  return plan[0];
};

test('the handshake: GET Version SHIORI/2.6 in ASCII; the status line gives the version, a 2xx the ID and Craftman, Charset the charset', () => {
  assert.equal(VERSION_REQUEST, msg('GET Version SHIORI/2.6', 'Charset: UTF-8', 'Sender: SSP'), 'no SecurityLevel');
  assert.equal(VERSION_PROBE_30, msg('GET SHIORI/3.0', 'Charset: UTF-8', 'ID: version', 'SecurityLevel: local', 'Sender: SSP'));
  const s = kawari();
  assert.deepEqual({ ...s }, { version: 26, charset: 'Shift_JIS', name: 'KAWARI.kdt.i18n', craftman: 'KawariDevelopmentTeam' });
  const t = new Shiori2Session();
  assert.deepEqual(readVersionReply(msg('SHIORI/2.6 200 OK', 'Charset: Shift_JIS'), t), { version: 26, status: 200, probe30: false });
  assert.deepEqual(readVersionReply(msg('SHIORI/3.0 200 OK'), new Shiori2Session()), { version: 30, status: 200, probe30: true });
  assert.deepEqual(readVersionReply(msg('SHIORI/2.0 400 Bad Request'), new Shiori2Session()), { version: 20, status: 400, probe30: true });
  const u = new Shiori2Session();
  readVersionReply(msg('SHIORI/2.5 500 Internal Server Error', 'ID: x', 'Charset: UTF-8'), u);
  assert.deepEqual({ ...u }, { version: 25, charset: 'UTF-8', name: '', craftman: '' }, 'no ID from a non-2xx; Charset taken');
  assert.equal(readVersionReply('', new Shiori2Session()).status, 400);
});

test('an event: GET Sentence SHIORI/2.2 with Event, BaseEvent, Status and every Reference index (an absent one empty)', () => {
  const s = kawari();
  const r = one(page('OnTest', ['ソ表', undefined, 'c'], { headers: { BaseID: 'OnBase', Status: 'talking' } }), s);
  assert.equal(r.kind, 'event');
  assert.equal(r.text, msg('GET Sentence SHIORI/2.2', 'Charset: Shift_JIS', 'SecurityLevel: local', 'Sender: SSP',
    'Event: OnTest', 'BaseEvent: OnBase', 'Status: talking', 'Reference0: ソ表', 'Reference1: ', 'Reference2: c'));
  assert.equal(one(page('OnBoot'), s).text, msg('GET Sentence SHIORI/2.2', 'Charset: Shift_JIS', 'SecurityLevel: local',
    'Sender: SSP', 'Event: OnBoot'));
  // a NOTIFY event is sent the same way (no NOTIFY method below 3.0)
  const n = one(page('OnNotifySelfInfo', ['a'], { method: 'NOTIFY' }), s);
  assert.equal(n.kind, 'notify');
  assert.match(n.text, /^GET Sentence SHIORI\/2\.2\r\n[^]*Event: OnNotifySelfInfo\r\nReference0: a\r\n\r\n$/);
  // the charset the handshake named, in every request
  const utf = new Shiori2Session();
  readVersionReply(msg('SHIORI/2.6 200 OK', 'Charset: UTF-8'), utf);
  assert.match(one(page('OnBoot'), utf).text, /^GET Sentence SHIORI\/2\.2\r\nCharset: UTF-8\r\n/);
});

test('NOTIFY: basewareversion, capability, enable_log, enable_debug never sent; installed*name cut to 8; the two ghost-name notifications', () => {
  const s = kawari();
  for (const id of ['basewareversion', 'capability', 'enable_log', 'enable_debug']) {
    assert.deepEqual(toShiori2(page(id, ['x'], { method: 'NOTIFY' }), s), [], id);
  }
  const ten = Array.from({ length: 10 }, (_, i) => `g${i}`);
  for (const id of ['installedsakuraname', 'installedkeroname', 'installedghostname']) {
    const r = one(page(id, ten, { method: 'NOTIFY' }), s);
    assert.ok(r.text.includes('Reference7: g7\r\n') && !r.text.includes('Reference8'), id);
  }
  assert.ok(one(page('installedballoonname', ten, { method: 'NOTIFY' }), s).text.includes('Reference9: g9'), 'balloons not cut');
  assert.equal(one(page('ownerghostname', ['なな'], { method: 'NOTIFY' }), s).text,
    msg('NOTIFY OwnerGhostName SHIORI/2.3', 'Charset: Shift_JIS', 'Sender: SSP', 'Ghost: なな'));
  assert.equal(one(page('otherghostname', ['おと\x010\x0110', 'B\x013\x0111'], { method: 'NOTIFY' }), s).text,
    msg('NOTIFY OtherGhostName SHIORI/2.3', 'Charset: Shift_JIS', 'Sender: SSP', 'GhostEx: おと\x010\x0110', 'Ghost: おと',
      'GhostEx: B\x013\x0111', 'Ghost: B'));
  assert.equal(one(page('otherghostname', [], { method: 'NOTIFY' }), s).text,
    msg('NOTIFY OtherGhostName SHIORI/2.3', 'Charset: Shift_JIS', 'Sender: SSP'));
});

test('by kind: resource GET String 2.5, translate TRANSLATE 2.6 (none below 2.6), teach TEACH 2.4, the communicate box and another ghost', () => {
  const s = kawari();
  const res = one(page('sakura.recommendsites', [], {}), s, { kind: 'resource' });
  assert.equal(res.kind, 'string');
  assert.equal(res.text, msg('GET String SHIORI/2.5', 'Charset: Shift_JIS', 'SecurityLevel: local', 'SecurityOrigin: null',
    'Sender: SSP', 'ID: sakura.recommendsites'));
  const tr = one(page('OnTranslate', ['\\0abc\\e', '', 'OnBoot']), s, { kind: 'translate' });
  assert.equal(tr.text, msg('TRANSLATE Sentence SHIORI/2.6', 'Charset: Shift_JIS', 'SecurityLevel: local', 'SecurityOrigin: null',
    'Sender: SSP', 'Sentence: \\0abc\\e'));
  assert.match(one(page('OnTranslate', ['x', 'remote']), s, { kind: 'translate' }).text, /SecurityLevel: external/);
  const old = new Shiori2Session();
  readVersionReply(msg('SHIORI/2.5 200 OK'), old);
  assert.deepEqual(toShiori2(page('OnTranslate', ['x']), old, { kind: 'translate' }), [], 'none below 2.6');
  assert.equal(one(page('OnTeach', ['りんご', 'b', 'c']), s, { kind: 'teach' }).text,
    msg('TEACH SHIORI/2.4', 'Charset: Shift_JIS', 'SecurityLevel: local', 'Sender: SSP', 'Word: りんご', 'Reference0: b', 'Reference1: c'));
  assert.equal(one(page('OnCommunicate', ['user', 'こんにちは']), s, { kind: 'communicate-user' }).text,
    msg('GET Sentence SHIORI/2.0', 'Charset: Shift_JIS', 'SecurityLevel: local', 'Sender: User', 'Sentence: こんにちは'));
  const c = one(page('OnCommunicate', ['おと', 'やあ', undefined, 'r3'], { headers: { Age: '2', Surface: '0\x0110' } }), s,
    { kind: 'communicate', self: 'なな' });
  assert.equal(c.kind, 'sentence');
  assert.equal(c.text, msg('GET Sentence SHIORI/2.3', 'Charset: Shift_JIS', 'SecurityLevel: local', 'Sender: おと', 'Sentence: やあ',
    'To: なな', 'Age: 2', 'Surface: 0\x0110', 'Reference1: r3'), 'an absent Reference skipped, its index kept');
  assert.match(one(page('OnCommunicate', ['x', 'y']), s, { kind: 'communicate', self: 'me' }).text, /\r\nAge: 0\r\n/, 'Age always');
});

test('the reply: the 2.x status line kept, Charset UTF-8, the reply\'s headers, Value = the script for 200/311/312 only', () => {
  const r = fromShiori2(msg('SHIORI/2.6 200 OK', 'Age: 0', 'Charset: Shift_JIS', 'Reference0: ソ表', 'Sender: なな',
    'Sentence: 話しかけ\\e', 'To: おと'), 'event');
  assert.equal(r, msg('SHIORI/2.6 200 OK', 'Charset: UTF-8', 'Age: 0', 'Reference0: ソ表', 'Sender: なな', 'Sentence: 話しかけ\\e',
    'To: おと', 'Value: 話しかけ\\e'));
  const p = parseResponse(r);
  assert.equal(p.status, 200);
  assert.equal(p.protocol, 2.6);
  assert.equal(p.value, '話しかけ\\e');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 200 OK', 'String: http://x/', 'Sentence: s'), 'string')).value, 'http://x/',
    'GET String: String before Sentence');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 200 OK', 'Sentence: s'), 'string')).value, 's');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 200 OK', 'String: x'), 'event')).value, null, 'events read no String');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 311 Not Enough', 'Sentence: more'), 'teach')).value, 'more');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 400 Bad Request', 'Sentence: s'), 'event')).value, null);
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 204 No Content'), 'event')).status, 204);
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 200 OK', 'Value: v', 'Sentence: s'), 'event')).value, 'v', 'Value first');
  assert.equal(parseResponse(fromShiori2(null, 'event')).status, 500, 'no reply');
  assert.equal(parseResponse(fromShiori2('', 'event')).status, 500);
  assert.equal(parseResponse(NOTHING).status, 204);
  assert.equal(parseResponse(NOTHING).protocol, 2.6);
});

test('a word (kind word, %ms-style): GET Word SHIORI/2.0 with Charset, Sender and Type = the ID; the reply\'s Value, else Word', () => {
  const s = kawari();
  // SPShiori::GetWord's 2.x branch: no SecurityLevel, no Status, no References, the type with its backslash
  const w = one(page('\\ms', [], { headers: { Status: 'talking' } }), s, { kind: 'word' });
  assert.equal(w.kind, 'word');
  assert.equal(w.text, msg('GET Word SHIORI/2.0', 'Charset: Shift_JIS', 'Sender: SSP', 'Type: \\ms'));
  assert.equal(one(page('\\m?'), s, { kind: 'word' }).text, msg('GET Word SHIORI/2.0', 'Charset: Shift_JIS', 'Sender: SSP',
    'Type: \\m?'), '\\m? goes as it is (the page asks \\m next)');
  assert.equal(one(page('\\dms'), s, { kind: 'word' }).text, msg('GET Word SHIORI/2.0', 'Charset: Shift_JIS', 'Sender: SSP',
    'Type: \\dms'));
  const old = new Shiori2Session();
  readVersionReply(msg('SHIORI/2.0 200 OK', 'Charset: UTF-8'), old);
  assert.equal(one(page('\\me'), old, { kind: 'word' }).text, msg('GET Word SHIORI/2.0', 'Charset: UTF-8', 'Sender: SSP', 'Type: \\me'),
    'every 2.x version, in the charset the handshake named');
  // Kawari 7 answers `Word` (compatible.ms) with 200, or 204
  const r = fromShiori2(msg('SHIORI/2.6 200 OK', 'Charset: Shift_JIS', 'Word: 鈴木'), 'word');
  assert.equal(r, msg('SHIORI/2.6 200 OK', 'Charset: UTF-8', 'Word: 鈴木', 'Value: 鈴木'));
  assert.equal(parseResponse(r).value, '鈴木');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 200 OK', 'Value: v', 'Word: w'), 'word')).value, 'v', 'Value first');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 311 Not Enough', 'Word: w'), 'word')).value, 'w', '311 and 312 count');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 400 Bad Request', 'Word: w'), 'word')).value, null);
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 200 OK', 'Sentence: s'), 'word')).value, null, 'no Sentence for a word');
  assert.equal(parseResponse(fromShiori2(msg('SHIORI/2.6 204 No Content'), 'word')).status, 204);
});

test('GetStringShiori\'s 2.x branch for the tooltips and `.ext.`: GET String 2.5, ID, Status, every Reference; no SenderType', () => {
  const s = kawari();
  // the page's _getString (events.js): kind resource, SenderType internal; ssp.exe's 2.x form has no SenderType and
  // writes every index, an absent one empty [disasm 0x712C4B–0x712F1F]
  const head = ['GET String SHIORI/2.5', 'Charset: Shift_JIS', 'SecurityLevel: local', 'SecurityOrigin: null', 'Sender: SSP'];
  const get = (id, refs, status) => one(page(id, refs, { headers: { SenderType: 'internal', ...(status ? { Status: status } : {}) } }), s,
    { kind: 'resource' });
  const tip = get('balloon_tooltip', ['なんか話して', 'AITALK', undefined, 'r3'], 'talking,balloon(0=0)');
  assert.equal(tip.kind, 'string');
  assert.equal(tip.text, msg(...head, 'ID: balloon_tooltip', 'Status: talking,balloon(0=0)', 'Reference0: なんか話して',
    'Reference1: AITALK', 'Reference2: ', 'Reference3: r3'));
  assert.equal(get('tooltip', [5, 6, 0, 99, 'Mmenu', 0]).text, msg(...head, 'ID: tooltip', 'Reference0: 5', 'Reference1: 6',
    'Reference2: 0', 'Reference3: 99', 'Reference4: Mmenu', 'Reference5: 0'));
  assert.equal(get('property.get', ['k']).text, msg(...head, 'ID: property.get', 'Reference0: k'));
  assert.equal(get('property.set', ['k', 'v']).text, msg(...head, 'ID: property.set', 'Reference0: k', 'Reference1: v'));
});

test('the page reads a 2.x GET String as ssp.exe: 200, 311 and 312, Value / String / Sentence, decoded; never a COMMUNICATE', async () => {
  const s = kawari();
  let answer = () => msg('SHIORI/2.6 204 No Content');
  const sent = [];
  // ShioriClient + worker + Kawari7Engine.request, with the 2.x SHIORI scripted (BASE is the client's base headers)
  const shiori = {
    async request(r) {
      const plan = toShiori2(buildRequest(r, BASE), s, { kind: r.kind || '', self: r.self || '' });
      for (const p of plan) sent.push(p.text);
      return parseResponse(plan.length ? fromShiori2(answer(plan[0].text), plan[0].kind) : NOTHING);
    },
    async unload() { return []; },
    async persist() { return []; },
  };
  const clock = new FakeClock();
  const peers = { others: () => [], count: () => 2, busy: () => false, asked: [], match(to) { this.asked.push(to); return ['y']; } };
  const loop = new EventLoop({
    shiori, player: new FakePlayer(), stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(),
    ghost: GHOST7, clock, env: { win: null, doc: null }, state: new StateStore(GHOST7.id, { storage: memoryStorage(), clock }),
    ghostDescript: new Map([['name', GHOST7.name], ['sakura.name', GHOST7.sakuraName]]), site: { ghosts: [GHOST7], balloons: [] },
    peers,
  });
  await loop.boot({ resume: false });
  sent.length = 0;
  const strings = {
    balloon_tooltip: msg('SHIORI/2.6 311 Not Enough', 'String: tip \\&[amp] more\\nline', 'To: Ys'),
    tooltip: msg('SHIORI/2.6 312 Advice', 'Sentence: shell tip', 'To: Ys'),
    'property.get': msg('SHIORI/2.6 200 OK', 'String: \\&[lt]v\\&[gt]', 'To: Ys'),
    'property.set': msg('SHIORI/2.6 311 Not Enough', 'String: no'),
    homeurl: msg('SHIORI/2.6 203 Non-Authoritative', 'String: http://x/'),
  };
  answer = text => {
    const m = /\r\nID: ([^\r]*)\r\n/.exec(text);
    return /^GET String /.test(text) && m && strings[m[1]] ? strings[m[1]] : msg('SHIORI/2.6 204 No Content');
  };
  assert.equal(await loop.balloons.tipSource({ kind: 'choice', id: 'a', refs: [], label: 'A', scope: 0 }), 'tip & more\nline', '311');
  assert.equal(await loop.stage.tipSource({ scope: 0, collision: 'Head', x: 1, y: 2, fresh: false }), 'shell tip', '312, Sentence');
  assert.equal(await loop._property('currentghost.ext.k'), '<v>');
  assert.equal(await loop.setProperty('currentghost.ext.k', 'v'), false, 'property.set wants a 2xx [disasm 0x648D09]');
  assert.equal(await loop.resource('homeurl'), null, 'a 203 has no string');
  assert.deepEqual(sent.map(t => t.split(CRLF).find(l => /^(ID|Event): /.test(l)) + ' ' + t.split(CRLF)[0]), [
    'Event: OnChoiceHover GET Sentence SHIORI/2.2', 'ID: balloon_tooltip GET String SHIORI/2.5',
    'ID: tooltip GET String SHIORI/2.5', 'ID: property.get GET String SHIORI/2.5', 'ID: property.set GET String SHIORI/2.5',
    'ID: homeurl GET String SHIORI/2.5',
  ]);
  assert.equal(loop._comm, null, 'a `To` in a GET String reply names no target (no SendCommunicate)');
  assert.deepEqual(peers.asked, []);
  loop.destroy();
});

test('parseMessage: the first header of a name wins, any case; References by index; the value after the colon and its spaces', () => {
  const m = parseMessage(msg('GET Sentence SHIORI/2.2', 'event: a', 'Event: b', 'Reference3:  x', 'Odd'));
  assert.equal(m.start, 'GET Sentence SHIORI/2.2');
  assert.equal(m.get('EVENT'), 'a');
  assert.equal(m.refs[3], 'x');
  assert.equal(m.refs.length, 4);
  assert.equal(m.get('Odd'), null);
});
