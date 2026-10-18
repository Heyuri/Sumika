// \![execute,http-*] (src/core/http.js, shiori-events.md §4.15): SSP's options, parameters, charsets, file names and
// events; one ghost's requests over a fake fetch (every event path, which status succeeds and which error page is
// saved as ssp.exe's RealRead decides, R6 once the headers came, the privacy flags, sync and async, the duplicate
// check, cancel, a ghost that went); the EventLoop and the script player around them; bonsyou's counter through the
// real YAYA engine, and there too bonsyou's and emily4's mouse gestures (EV §4.5.1) and bonsyou's gong, whose
// OnSoundStop asks for the gong counter (EV §4.17). Nothing here goes on the network: every fetch is a fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  httpCommand, parseHttpOptions, cleanupFilename, urlFileName, httpEventNames, encodeText, percentEncode,
  isPercentEncoded, makeParam, buildHttpRequest, nofileText, headerText, safelisted, httpStatus, HttpRequests,
} from '../../src/core/http.js';
import { EventLoop } from '../../src/core/events.js';
import { PageSaori } from '../../src/core/page-saori.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { setLogLevel } from '../../src/core/log.js';
import { ScriptPlayer } from '../../src/sakura/player.js';
import { ManualClock } from '../../src/sakura/clock.js';
import { YayaEngine } from '../../src/worker/engines/yaya.js';
import { SatoriEngine } from '../../src/worker/engines/satori.js';
import { EmscriptenShiori } from '../../src/worker/engines/emscripten.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { yayaFilePlan, yayaSite } from '../../src/core/engine-files.js';
import { GhostFiles } from '../../src/core/loader.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakeShiori, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

setLogLevel('silent');
const enc = new TextEncoder();
const dec = new TextDecoder();
const hex = u8 => [...u8].map(b => b.toString(16).padStart(2, '0')).join(' ');
const str = u8 => (u8 ? String.fromCharCode(...u8) : null);

const COUNT_URL = 'http://ms.shillest.net/resource/bonsyou_count.txt';
const BONSYOU_TAG = [COUNT_URL, '--async=OnCountCompleteMenu', '--file=bonsyou_now.txt'];
const CLAP_URL = 'http://clap.webclap.com/clap.php?id=wahogewahowaho';

// ---------------------------------------------------------------- the tag

test('the tag: htt / rss / ica / web by the first 3 letters, the kind and method by substring (TextToMethod order)', () => {
  assert.deepEqual(httpCommand('http-get'), { kind: 'http', method: 'get' });
  assert.deepEqual(httpCommand('HTTP-POST'), { kind: 'http', method: 'post' });
  assert.deepEqual(httpCommand('http-delete'), { kind: 'http', method: 'delete' });
  assert.deepEqual(httpCommand('http-options'), { kind: 'http', method: 'options' });
  assert.deepEqual(httpCommand('httpx'), { kind: 'http', method: 'get' }, 'no method in it: get');
  assert.deepEqual(httpCommand('http-get-post'), { kind: 'http', method: 'post' }, 'post is tested first');
  assert.deepEqual(httpCommand('rss-get'), { kind: 'rss', method: 'get' });
  assert.deepEqual(httpCommand('ical-post'), { kind: 'ical', method: 'post' });
  assert.deepEqual(httpCommand('websocket'), { kind: 'websocket', method: 'get' });
  assert.deepEqual(httpCommand('http-rss'), { kind: 'rss', method: 'get' });
  assert.equal(httpCommand('install'), null);
  assert.equal(httpCommand('resetwindowpos'), null);
});

test('options: the URL first or --url=, prefixes in any case, empty values ignored (not --nofile= or --streaming=), unknown tokens are parameters', () => {
  let o = parseHttpOptions(BONSYOU_TAG);
  assert.equal(o.url, COUNT_URL);
  assert.equal(o.id, 'OnCountCompleteMenu');
  assert.equal(o.async, true);
  assert.equal(o.file, 'bonsyou_now.txt');
  assert.equal(o.timeoutS, 10, 'the default: 10 s per wait');
  assert.deepEqual(o.params, []);

  o = parseHttpOptions(['--URL=http://a/b', '--ASYNC=x', '--event=y', '--file=', '--timeout=50']);
  assert.equal(o.url, 'http://a/b', '--url= when the first token is an option');
  assert.equal(o.id, 'y', 'a repeat overrides; --event= is an alias');
  assert.equal(o.file, '', 'an empty value is ignored');
  assert.equal(o.timeoutS, 50);
  assert.equal(parseHttpOptions(['u', '--timeout=999']).timeoutS, 300, 'at most 300 s');
  assert.equal(parseHttpOptions(['u', '--timeout=0']).timeoutS, 10, '0 keeps the default');

  o = parseHttpOptions(['http://a/x.cgi', 'p=SSP 伺か', '--async', '--param=a=1', '--param=b=2', '--body=z']);
  assert.deepEqual(o.params, ['p=SSP 伺か', '--async', 'a=1', 'b=2', '--body=z'], 'the legacy form, a bare --async, --body: parameters');
  assert.equal(o.async, false, 'a bare --async is no option: the request is synchronous');

  o = parseHttpOptions(['u', '--async=a', '--sync=b']);
  assert.deepEqual([o.id, o.async], ['b', false], '--sync= after --async=');
  // ParseParameters stores an empty argument before others as the placeholder " " (0x6242e2), so ParseOptions' walk,
  // which stops at the first empty string (0x66526c), takes it as one more parameter and goes on [disasm]
  o = parseHttpOptions(['u', '--param=a=1', '', '--async=late']);
  assert.deepEqual([o.params, o.async, o.id], [['a=1', ' '], true, 'late'], 'an empty middle argument is the parameter " "');
  o = parseHttpOptions(['u', '--param=a=1', '']);
  assert.deepEqual(o.params, ['a=1'], 'an empty last argument ends the multi-string');
  assert.equal(parseHttpOptions(['', '--param=a=1']).url, ' ', 'an empty URL before others is the placeholder too');
  o = parseHttpOptions(['u', '--header=X-A: 1', '--header=X-B: 2', '--nofile', '--param-charset=Shift_JIS']);
  assert.deepEqual(o.headers, ['X-A: 1', 'X-B: 2'], '--header= adds up');
  assert.equal(o.nofile, 'UTF-8');
  assert.equal(o.paramCharset, 'Shift_JIS');
  assert.equal(parseHttpOptions(['u', '--nofile=EUC-JP']).nofile, 'EUC-JP');
  assert.equal(parseHttpOptions(['u', '--streaming']).streaming, '');

  // ParseOptions switches these on before its empty-value check (0x664ef8, 0x6651ff, 0x664e1b)
  assert.equal(parseHttpOptions(['u', '--nofile=', '--async=OnX']).nofile, 'UTF-8', '--nofile= (an empty %(charset)): no file, R3 in UTF-8');
  assert.equal(parseHttpOptions(['u', '--nofile=EUC-JP', '--nofile=']).nofile, 'EUC-JP', 'a charset given before stays');
  assert.equal(parseHttpOptions(['u', '--nofile=EUC-JP', '--nofile']).nofile, 'EUC-JP');
  assert.equal(parseHttpOptions(['u', '--nofileShift_JIS']).nofile, 'Shift_JIS', 'what follows a bare --nofile is a charset too');
  assert.equal(parseHttpOptions(['u', '--streaming=']).streaming, '', '--streaming=: on, no decoder named');
  assert.equal(parseHttpOptions(['u', '--streaming=sse', '--streaming=']).streaming, 'sse');
  o = parseHttpOptions(['u', '--expand=', '--async=', '--sync=', '--timeout=', '--param=', '--header=']);
  assert.deepEqual([o.params, o.headers, o.id, o.async, o.timeoutS], [[], [], '', false, 10], 'the others ignore an empty value');
});

test('file names: CleanupFilenameW\'s characters and DOS devices; without --file the URL\'s last segment', () => {
  assert.equal(cleanupFilename('a/b.txt'), 'a_b.txt', 'no subfolders');
  assert.equal(cleanupFilename('..\\x:y*?"<>|,;.txt'), '.._x_y________.txt');
  assert.equal(cleanupFilename('a\u20a9b\uff65c\u200bd\ufeffe\uff66f'), 'a_b_c_d_e_f');
  assert.equal(cleanupFilename('con.txt'), '_on.txt');
  assert.equal(cleanupFilename('LPT1'), '_PT1');
  assert.equal(cleanupFilename('1_今日の天気.png'), '1_今日の天気.png');
  assert.equal(urlFileName('http://ms.shillest.net/resource/bonsyou_count.cgi'), 'bonsyou_count.cgi');
  assert.equal(urlFileName(CLAP_URL), 'clap.php', 'the query is cut');
  assert.equal(urlFileName('http://a/b/c.html#top?x'), 'c.html');
  assert.equal(urlFileName('http://host/'), 'index.html');
  assert.equal(urlFileName('http://host'), 'host');
  assert.equal(urlFileName('data:text/plain,hi'), 'index.html');
});

test('event names: an ID starting with On (case-sensitive) is the event; other IDs go to OnExecuteHTTP*', () => {
  assert.deepEqual(httpEventNames('OnCountComplete'), { complete: 'OnCountComplete', failure: 'OnCountCompleteFailure', progress: 'OnCountCompleteProgress' });
  for (const id of ['webclap', 'onX', '']) {
    assert.deepEqual(httpEventNames(id), { complete: 'OnExecuteHTTPComplete', failure: 'OnExecuteHTTPFailure', progress: 'OnExecuteHTTPProgress' });
  }
});

// ---------------------------------------------------------------- parameters and charsets

test('charsets: UTF-8; CP932 as Windows writes it (JIS / NEC row 13 first, IBM before NEC-selected, best fit); EUC-JP', () => {
  assert.equal(hex(encodeText('テスト')), 'e3 83 86 e3 82 b9 e3 83 88');
  assert.equal(hex(encodeText('テスト', 'Shift_JIS')), '83 65 83 58 83 67');
  assert.equal(hex(encodeText('ｱ', 'sjis')), 'b1');
  assert.equal(hex(encodeText('≒', 'Shift_JIS')), '81 e0', 'JIS X 0208 before NEC row 13 (0x8790)');
  assert.equal(hex(encodeText('Ⅰ', 'Shift_JIS')), '87 54', 'NEC row 13 before the IBM copy');
  assert.equal(hex(encodeText('ⅰ', 'Shift_JIS')), 'fa 40', 'the IBM extension before the NEC-selected copy (0xEEEF)');
  assert.equal(hex(encodeText('¬', 'Shift_JIS')), '81 ca');
  assert.equal(hex(encodeText('café', 'Shift_JIS')), '63 61 66 65', 'best fit');
  assert.equal(hex(encodeText('a😀', 'Shift_JIS')), '61 3f 3f', 'a surrogate pair: ??');
  assert.equal(hex(encodeText('あ', 'EUC-JP')), 'a4 a2');
  assert.equal(hex(encodeText('あ', 'no-such-charset')), 'e3 81 82', 'an unknown name: UTF-8');
});

test('percent-encoding: form mode (body) and URL mode (query), kept bytes, IsPercentEncoded', () => {
  assert.equal(percentEncode(enc.encode('a b*~/=-._')), 'a+b*%7E%2F%3D-._');
  assert.equal(percentEncode(enc.encode('a b~?#/='), { form: false }), 'a%20b%7E%3F%23/=');
  assert.equal(percentEncode(enc.encode('a&b=c/d'), { keep: '&/=' }), 'a&b=c/d');
  assert.equal(isPercentEncoded(enc.encode('%E3%81%82;+'), '&/=+', true), true);
  assert.equal(isPercentEncoded(enc.encode('a b'), '&/=+', true), false);
  assert.equal(isPercentEncoded(enc.encode('a=b'), '&/+', true), false, 'a name may not hold =');
  assert.equal(isPercentEncoded(enc.encode('a=b'), '&/=+', true), true);
});

test('MakeParam: name=value pairs, the CRLF fallback that keeps & / =, multipart parts', () => {
  const items = list => list.map(s => enc.encode(s));
  assert.equal(str(makeParam(items(['message_body=テスト']))), 'message_body=%E3%83%86%E3%82%B9%E3%83%88');
  assert.equal(str(makeParam(items(['a=1', 'b=x y']))), 'a=1&b=x+y');
  assert.equal(str(makeParam(items(['q=%E3%81%82']))), 'q=%E3%81%82', 'already encoded: kept');
  assert.equal(str(makeParam(items(['message_name="A"&message_body="B"']))), 'message_name=%22A%22&message_body=%22B%22',
    'two = in one item: the whole string, & / = kept');
  assert.equal(str(makeParam(items(['abc']))), 'abc');
  assert.equal(str(makeParam(items(['a', 'b c']))), 'a%0D%0Ab+c', 'items without =: CRLF-joined');
  assert.equal(str(makeParam(items(['p=SSP 伺か']), { form: false })), 'p=SSP%20%E4%BC%BA%E3%81%8B', 'URL mode for a query');
  assert.equal(str(makeParam(items(['n"x=v1', 'b=v2']), { multipart: true, boundary: 'B' })),
    '--B\r\nContent-Disposition: form-data; name="n\\"x"\r\n\r\nv1\r\n--B\r\nContent-Disposition: form-data; name="b"\r\n\r\nv2\r\n--B--\r\n');
  assert.equal(makeParam(items(['ab']), { multipart: true, boundary: 'B' }).length, 0, 'multipart has no fallback');
});

test('the request: query for GET (a second ? after a query), bodies by content type, headers, CORS-simple or not', () => {
  const req = (args, method = 'get', x) => buildHttpRequest(parseHttpOptions(args), method, x);
  let r = req(BONSYOU_TAG);
  assert.deepEqual([r.method, r.url, r.body, r.headers, r.simple], ['GET', COUNT_URL, null, [['Accept-Language', '*']], true]);
  assert.equal(req(['http://a/x.cgi', 'p=SSP 伺か']).url, 'http://a/x.cgi?p=SSP%20%E4%BC%BA%E3%81%8B');
  assert.equal(req(['http://a/x?y=1', '--param=z=2']).url, 'http://a/x?y=1?z=2');
  assert.equal(req(['ws://a/b']).url, 'http://a/b');

  // Katari's clap: Shift_JIS, quotes inside the value
  r = req(['http://hello.pv.land.to/clap/clap.cgi', '--param-charset=Shift_JIS', '--param=hitokoto="テスト/カタリ"', '--async=WebClap'], 'post');
  assert.equal(str(r.body), 'hitokoto=%22%83e%83X%83g%2F%83J%83%5E%83%8A%22');
  assert.deepEqual(r.headers, [['Accept-Language', '*'], ['Content-Type', 'application/x-www-form-urlencoded']]);
  assert.equal(r.simple, true);
  r = req(['http://a/', '--content-type=application/x-www-form-urlencoded; charset=UTF-8', '--param=a=b'], 'put');
  assert.equal(r.headers[1][1], 'application/x-www-form-urlencoded', 'a given charset is dropped');
  assert.equal(r.simple, false, 'PUT is never simple');

  r = req(['http://a/', '--content-type=multipart/form-data', '--param=a=1'], 'post', { random: () => 0 });
  assert.equal(r.headers[1][1], 'multipart/form-data; boundary=----SSPFormBoundary0000000000000000');
  assert.match(str(r.body), /^------SSPFormBoundary0{16}\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n/);
  r = req(['http://a/', '--content-type=text/plain', '--param=line 1', '--param=line 2'], 'post');
  assert.equal(str(r.body), 'line 1\r\nline 2');
  assert.equal(r.simple, true);
  r = req(['http://a/', '--content-type=application/json', '--param={"a":1}', '--param=x'], 'post');
  assert.equal(str(r.body), '{"a":1}\x01x', 'any other type: the parameters as stored, byte 1 between them');
  assert.equal(r.simple, false);
  r = req(['http://a/'], 'post');
  assert.deepEqual([r.body.length, r.headers], [0, [['Accept-Language', '*']]], 'no parameters: an empty body, no Content-Type');

  r = req(['http://a/', '--accept-language=ja-JP', '--accept=text/plain', '--authorization=Basic abc',
    '--header=Host: evil', '--header=Cookie: x=1', '--header=X-One: 1', '--header=  more', '--header=Accept: */*',
    '--header=no colon', '--header=Bad Name: x', '--cookie=k=v']);
  assert.deepEqual(r.headers, [
    ['Accept-Language', 'ja-JP, ja;q=0.9, en;q=0.2, *;q=0.1'], ['Accept', '*/*'], ['Authorization', 'Basic abc'], ['X-One', '1 more'],
  ], 'Host and Cookie never; a continued line; a known name replaced; --cookie not sent');
  assert.equal(r.simple, false);
  assert.equal(safelisted('Accept-Language', '*'), true);
  assert.equal(safelisted('Content-Type', 'application/json'), false);
});

test('--nofile\'s R3 and R6: line breaks as byte 1, the body in its charset; headers as Name: value + byte 1', () => {
  assert.equal(nofileText(enc.encode('a\r\nb\nc\rd')), 'a\x01b\x01c\x01d');
  assert.equal(nofileText(Uint8Array.of(0x83, 0x65, 0x83, 0x58), 'Shift_JIS'), 'テス');
  assert.equal(nofileText(null), '');
  assert.equal(headerText(new Headers({ 'Content-Type': 'text/plain', 'X-A': '1' })), 'content-type: text/plain\x01x-a: 1\x01');
});

// ---------------------------------------------------------------- one ghost's requests over a fake fetch

/** fetch double: answer(url, init) -> a Response (or a promise of one); an abort rejects as the browser does */
function fakeFetch(answer) {
  const calls = [];
  const f = (url, init = {}) => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => {
      if (init.signal) init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      Promise.resolve().then(() => (typeof answer === 'function' ? answer(url, init) : answer)).then(resolve, reject);
    });
  };
  f.calls = calls;
  return f;
}
const never = () => new Promise(() => {});
const corsRefused = () => Promise.reject(new TypeError('Failed to fetch'));
const ok = (text, init = {}) => new Response(text, { status: 200, headers: { 'Content-Type': 'text/plain' }, ...init });

function rig({ fetch = fakeFetch(() => ok('12345')), ghostDir = '/ssp/ghost/bonsyou/ghost/master/', requests = new Set(),
  writeFail = false, files = {} } = {}) {
  const clock = new FakeClock();
  const events = [];
  const writes = [];
  const state = { live: true, locked: false };
  const host = {
    canSend: () => state.live, live: () => state.live, locked: () => state.locked, ghostDir: () => ghostDir,
    writeFile: async (rel, bytes) => {
      if (writeFail) throw new Error('disk full');
      writes.push({ rel, text: dec.decode(bytes) });
      return ghostDir + rel;
    },
    readFile: async rel => (files[rel] ? enc.encode(files[rel]) : null),
    event: async (id, refs) => { events.push({ id, refs }); },
  };
  return { http: new HttpRequests({ host, fetch, clock, requests }), clock, events, writes, state, fetch };
}

test('bonsyou\'s counter: an async GET with --file, the privacy flags, the file before OnCountCompleteMenu', async () => {
  const t = rig();
  assert.equal(t.http.execute('http-get', BONSYOU_TAG), undefined, '--async: the script goes on');
  await settle();
  assert.equal(t.fetch.calls.length, 1);
  const { url, init } = t.fetch.calls[0];
  assert.equal(url, COUNT_URL);
  assert.equal(init.method, 'GET');
  assert.equal(init.mode, 'cors', 'the body is needed');
  assert.equal(init.credentials, 'omit', 'no cookies, no HTTP auth of the visitor');
  assert.equal(init.referrerPolicy, 'no-referrer', 'the visitor\'s page URL never reaches the ghost author');
  assert.equal(init.cache, 'no-store', 'asked again every time, as SSP; nothing kept, so no ETag or date goes back to recognise a visitor');
  assert.equal(init.redirect, 'follow');
  assert.equal(init.keepalive, true, 'a page left meanwhile still sends it');
  assert.equal(init.body, undefined);
  assert.deepEqual(init.headers, [['Accept-Language', '*']]);
  assert.deepEqual(t.writes, [{ rel: 'var/bonsyou_now.txt', text: '12345' }]);
  assert.deepEqual(t.events, [{ id: 'OnCountCompleteMenu', refs: ['get', 'OnCountCompleteMenu', COUNT_URL,
    '/ssp/ghost/bonsyou/ghost/master/var/bonsyou_now.txt', '200', '', 'content-type: text/plain\x01'] }]);
});

test('every failure path: 404, a CORS refusal or dead host, a write that fails, no fetch at all', async () => {
  let t = rig({ fetch: fakeFetch(() => new Response('gone', { status: 404 })) });
  t.http.execute('http-get', BONSYOU_TAG);
  await settle();
  assert.deepEqual(t.writes, [], 'nothing saved: an error page without a Content-Length is not read');
  assert.equal(t.events[0].id, 'OnCountCompleteMenuFailure');
  assert.deepEqual(t.events[0].refs.slice(0, 5), ['get', 'OnCountCompleteMenu', COUNT_URL,
    '/ssp/ghost/bonsyou/ghost/master/var/bonsyou_now.txt', '404'], 'R3: the path it would have written');

  t = rig({ fetch: fakeFetch(corsRefused) });
  t.http.execute('http-get', [COUNT_URL, '--async=webclap']);
  await settle();
  assert.deepEqual(t.events.map(e => [e.id, e.refs[1], e.refs[3], e.refs[4], e.refs[5], e.refs[6]]),
    [['OnExecuteHTTPFailure', 'webclap', '/ssp/ghost/bonsyou/ghost/master/var/bonsyou_count.txt', 'error', '', '']],
    'CORS, mixed content and dead hosts all look alike: SSP\'s `error`');

  t = rig({ writeFail: true });
  t.http.execute('http-get', BONSYOU_TAG);
  await settle();
  assert.deepEqual([t.events[0].id, t.events[0].refs[4]], ['OnCountCompleteMenuFailure', 'fileio']);

  t = rig({ fetch: null });
  t.http.execute('http-get', BONSYOU_TAG);
  await settle();
  assert.deepEqual([t.events[0].id, t.events[0].refs[4]], ['OnCountCompleteMenuFailure', 'error'], 'no network: a failure');
});

test('which status succeeds (RealRead): 200, 202, 203 read the body; 204 to HEAD or OPTIONS, 201 to PUT, 304 with a file read nothing', () => {
  const s = (status, method = 'get', x) => { const v = httpStatus(status, method, x); return [v.ok, v.read, v.reason]; };
  for (const st of [200, 202, 203]) assert.deepEqual(s(st), [true, true, '200'], String(st));
  assert.deepEqual(s(204, 'head'), [true, false, '200']);
  assert.deepEqual(s(204, 'options'), [true, false, '200']);
  for (const m of ['get', 'post', 'put', 'delete', 'patch']) assert.deepEqual(s(204, m), [false, true, '204'], `204 to ${m}`);
  assert.deepEqual(s(201, 'put'), [true, false, '200']);
  assert.deepEqual(s(201, 'post'), [false, false, '404'], 'SPHttp::Redirect without a Location');
  assert.deepEqual(s(201, 'post', { location: '/new/1' }), [false, false, '201'], 'with one SSP would follow it [guess]');
  assert.deepEqual(s(304, 'get', { file: true }), [true, false, '200'], 'the old file stays');
  assert.deepEqual(s(304, 'get', { file: false }), [false, true, '304'], '--nofile has no file to keep');
  for (const st of [300, 301, 302, 303, 307, 308]) assert.deepEqual(s(st), [false, false, '404'], `${st} without a Location`);
  assert.deepEqual(s(300, 'get', { location: 'http://a/b' }), [false, false, '300'], 'fetch follows no 300');
  for (const st of [205, 206, 226, 401, 404, 500]) assert.deepEqual(s(st), [false, true, String(st)], String(st));
});

test('a success is SSP\'s: 202 and 203 save; 204, 205 or 206 to a GET fail with the status and save nothing; HEAD\'s 204 and PUT\'s 201 succeed, no file', async () => {
  const run = async (method, status, headers = {}) => {
    const empty = [204, 205, 304].includes(status);
    const t = rig({ fetch: fakeFetch(() => new Response(empty ? null : 'x', { status, headers })) });
    t.http.execute(`http-${method}`, ['http://a.example/x.txt', '--file=x.txt', '--async=OnX']);
    await settle();
    return [t.writes.map(w => w.rel), t.events.map(e => [e.id, e.refs[4]])];
  };
  assert.deepEqual(await run('get', 202), [['var/x.txt'], [['OnX', '200']]]);
  assert.deepEqual(await run('get', 203), [['var/x.txt'], [['OnX', '200']]]);
  assert.deepEqual(await run('get', 204), [[], [['OnXFailure', '204']]], 'no empty var/x.txt, no Complete');
  assert.deepEqual(await run('get', 205), [[], [['OnXFailure', '205']]]);
  assert.deepEqual(await run('get', 206), [[], [['OnXFailure', '206']]]);
  assert.deepEqual(await run('head', 204), [[], [['OnX', '200']]]);
  assert.deepEqual(await run('options', 204), [[], [['OnX', '200']]]);
  assert.deepEqual(await run('put', 201), [[], [['OnX', '200']]], 'returned before the body is read');
  assert.deepEqual(await run('post', 201), [[], [['OnXFailure', '404']]], 'bee-style --file: SPHttp::Redirect, no Location');
  assert.deepEqual(await run('post', 201, { Location: '/n/1' }), [[], [['OnXFailure', '201']]], 'not followed here [guess]');
  assert.deepEqual(await run('get', 304), [[], [['OnX', '200']]], 'the old file stays');
});

test('an error page (Content-Length above 0): a threaded request saves it, or puts it in R3, before the Failure; a synchronous one drops it', async () => {
  const page = '<html>404</html>';
  const answer = (status = 404, length = page.length) => () => new Response(page, {
    status, headers: { 'Content-Type': 'text/html', 'Content-Length': String(length) },
  });
  const R6 = 'content-length: 16\x01content-type: text/html\x01';
  let t = rig({ fetch: fakeFetch(answer()) });
  t.http.execute('http-get', BONSYOU_TAG);
  await settle();
  assert.deepEqual(t.writes, [{ rel: 'var/bonsyou_now.txt', text: page }], 'the last count is replaced by the error page');
  assert.deepEqual(t.events.map(e => [e.id, e.refs[3], e.refs[4], e.refs[6]]),
    [['OnCountCompleteMenuFailure', '/ssp/ghost/bonsyou/ghost/master/var/bonsyou_now.txt', '404', R6]]);

  t = rig({ fetch: fakeFetch(answer()) });
  t.http.execute('http-get', [COUNT_URL, '--async=OnX', '--nofile']);
  await settle();
  assert.deepEqual([t.writes, t.events.map(e => [e.id, e.refs[3], e.refs[4]])], [[], [['OnXFailure', page, '404']]], '--nofile: R3 the page');

  t = rig({ fetch: fakeFetch(answer(500)) });
  await t.http.execute('http-get', [COUNT_URL, '--file=x.txt']);
  await t.http.execute('http-get', [COUNT_URL, '--nofile']);
  assert.deepEqual(t.writes, [], 'synchronous: drained and dropped');
  assert.deepEqual(t.events.map(e => [e.id, e.refs[3], e.refs[4], e.refs[6]]), [
    ['OnExecuteHTTPFailure', '/ssp/ghost/bonsyou/ghost/master/var/x.txt', '500', R6], ['OnExecuteHTTPFailure', '', '500', R6],
  ], 'R3 empty with --nofile');

  t = rig({ fetch: fakeFetch(answer(404, 0)) });
  t.http.execute('http-get', BONSYOU_TAG);
  await settle();
  assert.deepEqual([t.writes, t.events.map(e => e.refs[4])], [[], ['404']], 'Content-Length: 0 is not read');
});

test('R6 once the headers came: in the Progress events and in a Failure after them (a stall, a cancel); a body cut short leaves R3 empty', async () => {
  const stalled = () => {
    let push, answer;
    const f = fakeFetch((url, init) => {
      init.signal.addEventListener('abort', () => push.error(new DOMException('aborted', 'AbortError')));
      return new Promise(r => { answer = r; });
    });
    f.answer = () => answer(new Response(new ReadableStream({ start(c) { push = c; } }), { status: 200, headers: { 'X-A': '1' } }));
    f.push = text => push.enqueue(enc.encode(text));
    return f;
  };
  let fetch = stalled();
  let t = rig({ fetch });
  t.http.execute('http-get', [COUNT_URL, '--async=OnX', '--progress-notify', '--nofile', '--timeout=4']);
  await t.clock.advance(1000);
  fetch.answer();
  await settle();
  fetch.push('part');
  await t.clock.advance(1000);
  await t.clock.advance(4000);                       // then nothing more: the stall timer runs out
  const progress = t.events.filter(e => e.id === 'OnXProgress');
  assert.equal(progress[0].refs[6], '', 'waiting for the answer: no headers yet');
  assert.ok(progress.some(e => e.refs[3] === 'part' && e.refs[6] === 'x-a: 1\x01'), 'after it: the headers');
  assert.deepEqual(t.events.filter(e => e.id === 'OnXFailure').map(e => e.refs.slice(3)), [['', 'timeout', '', 'x-a: 1\x01']],
    'R3: what came is dropped; R6: the headers');

  fetch = stalled();
  t = rig({ fetch });
  t.http.execute('http-get', [COUNT_URL, '--async=OnX', '--nodescript']);
  await settle();
  fetch.answer();
  await settle();
  fetch.push('12');
  await settle();
  t.http.cancel('http', [COUNT_URL]);
  await settle();
  assert.deepEqual(t.events.map(e => [e.id, e.refs[3], e.refs[4], e.refs[6]]),
    [['OnXFailure', '/ssp/ghost/bonsyou/ghost/master/var/bonsyou_count.txt', 'artificial', 'x-a: 1\x01']]);
  assert.deepEqual(t.writes, [], 'no file from a body cut short');
});

test('the stall timer: OnNetworkHeavy at half of it for a threaded request, then `timeout`; --timeout and --nodescript', async () => {
  let t = rig({ fetch: fakeFetch(never) });
  t.http.execute('http-get', [COUNT_URL, '--async=OnX']);
  await t.clock.advance(4999);
  assert.deepEqual(t.events, []);
  await t.clock.advance(1);
  assert.deepEqual(t.events, [{ id: 'OnNetworkHeavy', refs: ['10', '5'] }]);
  await t.clock.advance(5000);
  assert.deepEqual(t.events.map(e => e.id), ['OnNetworkHeavy', 'OnXFailure']);
  assert.equal(t.events[1].refs[4], 'timeout');

  t = rig({ fetch: fakeFetch(never) });
  t.http.execute('http-get', [COUNT_URL, '--async=OnX', '--timeout=3', '--nodescript']);
  await t.clock.advance(3000);
  assert.deepEqual(t.events.map(e => [e.id, e.refs[4]]), [['OnXFailure', 'timeout']], 'no OnNetworkHeavy with --nodescript');

  t = rig({ fetch: fakeFetch(never) });
  const p = t.http.execute('http-get', [COUNT_URL, '--timeout=2']);
  await t.clock.advance(2000);
  await p;
  assert.deepEqual(t.events.map(e => [e.id, e.refs[4]]), [['OnExecuteHTTPFailure', 'timeout']], 'synchronous: no OnNetworkHeavy');
});

test('the timer is per wait for data: each chunk resets it; --progress-notify sends Progress while waiting', async () => {
  let push;
  const body = new ReadableStream({ start(c) { push = c; } });
  const t = rig({ fetch: fakeFetch(() => new Response(body, { status: 200 })) });
  t.http.execute('http-get', [COUNT_URL, '--async=OnX', '--progress-notify', '--nofile']);
  await t.clock.advance(1000);
  for (let i = 0; i < 3; i++) {
    push.enqueue(enc.encode(`part${i}\n`));
    await t.clock.advance(8000);
  }
  push.close();
  await settle();
  const done = t.events.filter(e => e.id === 'OnX' || e.id === 'OnXFailure');
  assert.deepEqual(done.map(e => [e.id, e.refs[3], e.refs[4]]), [['OnX', 'part0\x01part1\x01part2\x01', '200']],
    '24 s in all, never 10 s without data');
  const progress = t.events.filter(e => e.id === 'OnXProgress');
  assert.ok(progress.length >= 3, 'Progress events');
  assert.deepEqual(progress[0].refs.slice(0, 5), ['get', 'OnX', COUNT_URL, '', '200']);
});

test('without --async: the promise holds the script until the event went; R1 empty; OnExecuteHTTPComplete', async () => {
  const t = rig();
  const p = t.http.execute('http-get', [COUNT_URL]);
  assert.equal(typeof p.then, 'function');
  await p;
  assert.deepEqual(t.events.map(e => [e.id, e.refs[1], e.refs[4]]), [['OnExecuteHTTPComplete', '', '200']]);
  assert.deepEqual(t.writes, [{ rel: 'var/bonsyou_count.txt', text: '12345' }], 'the URL\'s last segment');
});

test('a web clap (DSLGS\'s): a simple POST that saves nothing goes no-cors, and the opaque answer is SSP\'s 200', async () => {
  const t = rig({ fetch: fakeFetch(() => ({ type: 'opaque', status: 0, headers: new Headers() })) });
  t.http.execute('http-post', [CLAP_URL, '--param=message_body="テスト"', '--async=webclap']);
  await settle();
  const { init } = t.fetch.calls[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.mode, 'no-cors');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.cache, 'no-store');
  assert.equal(str(init.body), 'message_body=%22%E3%83%86%E3%82%B9%E3%83%88%22');
  assert.deepEqual(init.headers, [['Accept-Language', '*'], ['Content-Type', 'application/x-www-form-urlencoded']]);
  assert.deepEqual(t.writes, [], 'an opaque answer has no body to save');
  assert.deepEqual(t.events.map(e => [e.id, e.refs[0], e.refs[1], e.refs[2], e.refs[4], e.refs[5], e.refs[6]]),
    [['OnExecuteHTTPComplete', 'post', 'webclap', CLAP_URL, '200', '', '']]);

  // one that saves its answer (bee's --file), or wants a header or a non-simple type: cors
  const t2 = rig();
  t2.http.execute('http-post', ['http://a/p.php', '--param=m=x', '--file=tmp(3).txt', '--async=dummy']);
  t2.http.execute('http-post', ['http://b/p.php', '--param=m=x', '--header=X-A: 1', '--async=dummy']);
  await settle();
  assert.deepEqual(t2.fetch.calls.map(c => c.init.mode), ['cors', 'cors']);
  assert.deepEqual(t2.writes, [{ rel: 'var/tmp(3).txt', text: '12345' }, { rel: 'var/p.php', text: '12345' }], 'a cors answer is saved as SSP saves it');
});

test('the same URL in flight (any case, any ghost of the page): the later request fails at once with `downloading`', async () => {
  const requests = new Set();
  const a = rig({ fetch: fakeFetch(never), requests });
  const b = rig({ fetch: fakeFetch(never), requests });
  a.http.execute('http-get', [COUNT_URL, '--async=OnA']);
  const p = a.http.execute('http-get', [COUNT_URL.toUpperCase().replace('HTTP', 'http'), '--async=OnA2', '--file=x.txt']);
  assert.equal(typeof p.then, 'function', 'the failure is raised inside the tag');
  await p;
  assert.deepEqual(a.events.map(e => [e.id, e.refs[3], e.refs[4], e.refs[5], e.refs[6]]),
    [['OnA2Failure', '/ssp/ghost/bonsyou/ghost/master/var/x.txt', 'downloading', '', '']]);
  await b.http.execute('http-get', [COUNT_URL]);
  assert.deepEqual(b.events.map(e => [e.id, e.refs[4]]), [['OnExecuteHTTPFailure', 'downloading']], 'another ghost\'s too [disasm]');
  assert.equal(a.fetch.calls.length + b.fetch.calls.length, 1);
  assert.deepEqual(a.events.filter(e => e.id === 'OnA2Failure').length, 1, 'each ghost hears only its own');
});

test('\\![cancel,http,URL]: the threaded request fails with `artificial`; a synchronous one cannot be reached', async () => {
  const t = rig({ fetch: fakeFetch(never) });
  t.http.execute('http-get', [COUNT_URL, '--async=OnX']);
  await settle();
  assert.equal(t.http.cancel('http', [COUNT_URL.toUpperCase().replace('HTTP://', 'http://')]), true);
  await settle();
  assert.deepEqual(t.events.map(e => [e.id, e.refs[4]]), [['OnXFailure', 'artificial']]);
  const s = rig({ fetch: fakeFetch(never) });
  const p = s.http.execute('http-get', [COUNT_URL]);
  s.http.cancel('http', [COUNT_URL]);
  await settle();
  assert.deepEqual(s.events, [], 'not in the in-flight list');
  await s.clock.advance(10000);
  await p;
  assert.deepEqual(s.events.map(e => e.refs[4]), ['timeout']);
  assert.equal(t.http.cancel('install', [COUNT_URL]), false);
});

test('a ghost that went or is locked: no request while frozen or closed; no file or event after; locked: the file only', async () => {
  let t = rig();
  t.state.live = false;
  assert.equal(t.http.execute('http-get', BONSYOU_TAG), undefined);
  await settle();
  assert.equal(t.fetch.calls.length, 0, 'nothing is sent while frozen or closed');

  let release;
  t = rig({ fetch: fakeFetch(() => new Promise(r => { release = r; })) });
  t.http.execute('http-get', BONSYOU_TAG);
  await settle();
  t.http.invalidate();                     // closed / left / taken over meanwhile
  release(ok('1'));
  await settle();
  assert.deepEqual([t.writes, t.events], [[], []], 'the request went on, unheard (scratch/http/ssp-disasm.md §8)');

  t = rig();
  t.state.locked = true;
  t.http.execute('http-get', BONSYOU_TAG);
  await settle();
  assert.equal(t.writes.length, 1, 'the download still lands');
  assert.deepEqual(t.events, [], 'minimized / passive / induction / \\t: the event is dropped');
});

test('what is not sent: not HTTP (false), no URL argument, a URL that does not parse without --file, --streaming, file:', async () => {
  const t = rig();
  assert.equal(t.http.execute('rss-get', [COUNT_URL]), false);
  assert.equal(t.http.execute('websocket', ['ws://a/']), false);
  assert.equal(t.http.execute('http-get', []), undefined);
  assert.equal(t.http.execute('http-get', ['not a url', '--async=OnX']), undefined, 'dropped silently');
  assert.equal(t.http.execute('http-get', ['relative/path.txt', '--async=OnX']), undefined, 'never the site\'s own URLs');
  await t.http.execute('http-get', ['not a url', '--file=x.txt']);
  await t.http.execute('http-get', [COUNT_URL, '--streaming', '--async=OnS']);
  await t.http.execute('http-get', ['file:///C:/x.txt']);
  await t.http.execute('http-get', [COUNT_URL, '--streaming=']);
  await settle();
  assert.equal(t.fetch.calls.length, 0);
  assert.deepEqual(t.events.map(e => [e.id, e.refs[4]]), [['OnExecuteHTTPFailure', 'error'], ['OnSFailure', 'paramerror'],
    ['OnExecuteHTTPFailure', 'error'], ['OnExecuteHTTPFailure', 'paramerror']], '--streaming= is streaming too');
});

test('--nofile= with an empty charset (a YAYA %(charset) left empty) keeps the body in R3 as UTF-8; no file', async () => {
  const t = rig({ fetch: fakeFetch(() => ok('テスト\r\n2')) });
  t.http.execute('http-get', [COUNT_URL, '--nofile=', '--async=OnX']);
  await settle();
  assert.deepEqual(t.writes, []);
  assert.deepEqual(t.events.map(e => [e.id, e.refs[3], e.refs[4]]), [['OnX', 'テスト\x012', '200']]);
});

test('--param-input-file: the ghost\'s file as the body, never a personal file; --nofile keeps the body in R3', async () => {
  const t = rig({ files: { 'post.txt': 'a=1&b=2', 'yaya_variable.cfg': 'secret' } });
  t.http.execute('http-post', ['http://a/p', '--param-input-file=post.txt', '--param=x=y', '--async=OnP', '--nofile']);
  t.http.execute('http-post', ['http://b/p', '--param-input-file=yaya_variable.cfg', '--param=x=y', '--async=OnQ', '--nofile']);
  await settle();
  assert.deepEqual(t.fetch.calls.map(c => [c.url, str(c.init.body)]).sort(), [['http://a/p', 'a=1&b=2'], ['http://b/p', 'x=y']], 'a save file is not posted');
  assert.deepEqual(t.events.map(e => [e.id, e.refs[3]]).sort(), [['OnP', '12345'], ['OnQ', '12345']]);
  assert.deepEqual(t.writes, [], '--nofile: no file');

  // the engine resolves the path (EmscriptenShiori.masterPath): spellings of a save file are refused as the file is
  const eng = new EmscriptenShiori({ engineUrl: 'x', ghostDir: '/ghost/master/' });
  const read = [];
  const r = rig();
  r.http.host.readFile = async rel => { read.push(rel); return eng.masterPath(rel) ? enc.encode(`SECRET ${eng.masterPath(rel)}`) : null; };
  const spellings = ['yaya_variable.cfg/', 'yaya_variable.cfg/.', './satori_savedata.txt/', 'x/../aya5_variable.cfg//',
    'dic\\..\\yaya_variable.cfg', '../ghost/master/yaya_variable.cfg'];
  for (const p of spellings) await r.http.execute('http-post', ['http://c/p', `--param-input-file=${p}`, '--param=a=b']);
  await r.http.execute('http-post', ['http://c/p', '--param-input-file=var\\..\\post.txt', '--param=a=b']);
  assert.deepEqual(read, ['post.txt'], 'nothing personal is even read; a path is passed on as resolved');
  assert.deepEqual(r.fetch.calls.map(c => str(c.init.body)), [...spellings.map(() => 'a=b'), 'SECRET /ghost/master/post.txt']);
});

// ---------------------------------------------------------------- the event loop and the player

const GHOST = { id: 'bonsyou', name: '梵鐘/MMOBPG', sakuraName: '梵鐘', keroName: 'なし', shells: [{ id: 'master', name: 'Master' }] };

/** FakeShiori with the client's file messages (ShioriClient.writeFile / ghostDir) */
class FileShiori extends FakeShiori {
  constructor(handler) { super(handler); this.ghostDir = '/ghost/master/'; this.files = new Map(); }
  async writeFile(rel, data) {
    this.files.set(rel, dec.decode(data));
    this.log.push({ method: 'WRITE', id: rel, refs: [], headers: {} });
    return this.ghostDir + rel;
  }
}

function loop({ handler = () => null, fetch } = {}) {
  const clock = new FakeClock();
  const shiori = new FileShiori(handler);
  const player = new FakePlayer();
  const l = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: GHOST,
    state: new StateStore('bonsyou', { storage: memoryStorage(), clock }), clock, env: { win: null, doc: null },
    ghostDescript: new Map([['name', GHOST.name]]), site: { ghosts: [GHOST], balloons: [] }, ...(fetch !== undefined ? { fetch } : {}),
  });
  return { loop: l, shiori, player, clock };
}

test('the event loop: the file is written before the GET, whose reply plays (SenderType internal); closed: nothing sent', async () => {
  const fetch = fakeFetch(() => ok('108'));
  const t = loop({ fetch, handler: r => (r.id === 'OnCountCompleteMenu' ? '\\0count\\e' : null) });
  await t.loop.boot({ resume: false });
  t.shiori.log.length = 0;
  t.loop.httpExecute('http-get', BONSYOU_TAG);
  await settle();
  const ids = t.shiori.log.map(r => `${r.method} ${r.id}`);
  const w = ids.indexOf('WRITE var/bonsyou_now.txt');
  const g = ids.indexOf('GET OnCountCompleteMenu');
  assert.ok(w >= 0 && g > w, `the file first, then the event: ${ids.join(', ')}`);
  assert.equal(t.shiori.files.get('var/bonsyou_now.txt'), '108');
  const ev = t.shiori.find('OnCountCompleteMenu')[0];
  assert.deepEqual(ev.refs, ['get', 'OnCountCompleteMenu', COUNT_URL, '/ghost/master/var/bonsyou_now.txt', '200', '', 'content-type: text/plain\x01']);
  assert.equal(ev.headers.SenderType, 'internal');
  assert.equal(t.player.last.script, '\\0count\\e', 'its reply plays');

  await t.loop.close(0);
  assert.equal(t.loop.closed, true);
  t.loop.httpExecute('http-get', [COUNT_URL, '--async=OnLate']);
  await settle();
  assert.equal(fetch.calls.length, 1, 'a closed ghost sends nothing');
});

test('the event loop: minimized or passive the download lands but no event; frozen (a takeover) nothing is sent', async () => {
  const fetch = fakeFetch(() => ok('7'));
  const t = loop({ fetch });
  await t.loop.boot({ resume: false });
  t.loop.minimized = { reason: 'user', scopes: [0] };
  t.loop.httpExecute('http-get', BONSYOU_TAG);
  await settle();
  assert.equal(t.shiori.files.get('var/bonsyou_now.txt'), '7');
  assert.deepEqual(t.shiori.find('OnCountCompleteMenu'), []);
  t.loop.minimized = null;
  t.loop.ghostLife.passive = true;
  t.loop.httpExecute('http-get', [COUNT_URL, '--async=OnP']);
  await settle();
  assert.deepEqual(t.shiori.find('OnP'), []);
  t.loop.ghostLife.passive = false;
  await t.loop.suspend();
  t.loop.httpExecute('http-get', [COUNT_URL, '--async=OnF']);
  await settle();
  assert.equal(fetch.calls.length, 2, 'a frozen loop sends nothing');
});

test('two ghosts on one page: each hears only its own requests; one closing leaves the other\'s request alone', async () => {
  let release;
  const fa = fakeFetch(() => new Promise(r => { release = r; }));
  const fb = fakeFetch(() => ok('b'));
  const a = loop({ fetch: fa });
  const b = loop({ fetch: fb });
  await a.loop.boot({ resume: false });
  await b.loop.boot({ resume: false });
  a.loop.httpExecute('http-get', ['http://a.example/a.txt', '--async=OnA']);
  b.loop.httpExecute('http-get', ['http://b.example/b.txt', '--async=OnB']);
  await settle();
  await b.loop.close(0);
  release(ok('a'));
  await settle();
  assert.deepEqual(a.shiori.find('OnA').map(r => r.refs[4]), ['200']);
  assert.deepEqual(a.shiori.find('OnB'), []);
  assert.deepEqual(b.shiori.find('OnB').map(r => r.refs[4]), ['200']);
  assert.deepEqual(b.shiori.find('OnA'), []);
  assert.deepEqual([[...a.shiori.files.keys()], [...b.shiori.files.keys()]], [['var/a.txt'], ['var/b.txt']]);
});

test('the event loop: no window, no fetch given: nothing goes on the network, the ghost hears `error`', async () => {
  const t = loop({ handler: () => null });
  await t.loop.boot({ resume: false });
  await t.loop.httpExecute('http-post', [CLAP_URL, '--param=a=b']);
  assert.deepEqual(t.shiori.find('OnExecuteHTTPFailure').map(r => r.refs[4]), ['error']);
});

test('the player: a synchronous request holds the script at the tag; --async does not; rss is reported; cancel reaches the host', async () => {
  const clock = new ManualClock(0);
  const calls = [];
  let release;
  const host = {
    httpExecute: (sub, args) => {
      calls.push(['execute', sub, args]);
      return args.some(a => /^--async=/.test(a)) ? undefined : sub.includes('rss') ? false : new Promise(r => { release = r; });
    },
    httpCancel: (sub, args) => { calls.push(['cancel', sub, args]); },
    unknownTag: raw => calls.push(['unknown', raw]),
  };
  const written = [];
  const view = { write: t => written.push(t), clear() {}, resetKind() {}, setFont() {}, visible: true };
  const balloons = { get: () => view, hideAll() {}, on: () => () => {} };
  const player = new ScriptPlayer({ stage: null, balloons, host, clock, speedMs: 0 });
  player.play('a\\![execute,http-get,http://x/y,--async=OnX]b\\![execute,http-get,http://x/z]c\\![cancel,http,http://x/y]' +
    '\\![execute,http-rss,http://x/r]\\![execute,rss-get,http://x/s]d');
  await clock.advance(100);
  assert.equal(written.join(''), 'ab', 'held at the synchronous tag');
  assert.equal(player.busy, true);
  release();
  await clock.advance(100);
  assert.equal(written.join(''), 'abcd');
  assert.deepEqual(calls, [
    ['execute', 'http-get', ['http://x/y', '--async=OnX']], ['execute', 'http-get', ['http://x/z']],
    ['cancel', 'http', ['http://x/y']], ['execute', 'http-rss', ['http://x/r']],
    ['unknown', '\\![execute,http-rss,http://x/r]'], ['unknown', '\\![execute,rss-get,http://x/s]'],
  ], 'the host declines what is not HTTP; rss-get never reaches it');
  // a replay after a page change never sends it again (a side effect, SS §7)
  calls.length = 0;
  player.replay({ src: 'a\\![execute,http-get,http://x/z]b', ip: 2, sub: 0, state: 'running' });
  await clock.advance(100);
  assert.deepEqual(calls, []);
});

// ---------------------------------------------------------------- web claps with quotes in the middle of an argument

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ROOMMATE = path.join(ROOT, 'site', 'ghost', 'roommate', 'ghost', 'master');
const SATORI_JS = path.join(ROOT, 'site', 'sumika', 'engines', 'satori.js');
const RAQIA_URL = 'http://clap.webclap.com/clap.php?id=raqia_09';
const opaque = () => ({ type: 'opaque', status: 0, headers: new Headers() });

/** A script through the real player, its \![execute,http-*] handed to `http` (HttpRequests) as the EventLoop does. */
async function playWithHttp(script, http) {
  const clock = new ManualClock(0);
  const written = [];
  const unknown = [];
  const view = { write: t => written.push(t), clear() {}, resetKind() {}, setFont() {}, visible: true };
  const balloons = { get: () => view, hideAll() {}, on: () => () => {} };
  const host = { httpExecute: (sub, args) => http.execute(sub, args), unknownTag: raw => unknown.push(raw) };
  const player = new ScriptPlayer({ stage: null, balloons, host, clock, speedMs: 0 });
  player.play(script);
  await clock.advance(100);
  await settle();
  return { text: written.join(''), unknown, busy: player.busy };
}

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

test('roommate\'s web clap on the real Satori engine: one tag, the quotes dropped, SSP\'s 110-byte body (EV §4.15, SS §3.4)', { ...needs('site/ghost/roommate'), timeout: 60000 }, async () => {
  assert.ok(fs.existsSync(SATORI_JS), 'site/sumika/engines/satori.js is missing: run python engines/satori/build.py');
  assert.ok(fs.existsSync(path.join(ROOMMATE, 'dic_Menu.txt')), 'site/ghost/roommate is missing');
  const files = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/');
      else if (/\.(txt|dic|sat|ini|csv|aym)$/i.test(e.name) && !/^(satori_save|updates)/i.test(e.name)) {
        const b = fs.readFileSync(p);
        files.push({ path: rel + e.name, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
      }
    }
  })(ROOMMATE, '');
  const engine = new NodeSatori({ engineUrl: SATORI_JS, ghostDir: '/ghost/master/', log: () => {}, saori: saoriBridge });
  await engine.boot();
  engine.init(files, {}, { resume: false });
  const base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
  const ask = (id, refs) => parseResponse(engine.request(buildRequest({ method: 'GET', id, refs }, base))).value || '';

  // the menu's ご意見 (dic_Menu.txt:845) sets 拍手送信元 and opens the input box; OnUserInput runs
  // 拍手送信内容を教えてもらった (dic_Menu.txt:852), whose tag holds `"[（拍手送信元）]（拍手送信内容）"`
  assert.match(ask('OnChoiceSelect', ['ご意見']), /\\!\[open,inputbox,拍手送信内容,,--limit=970\]/);
  const script = ask('OnUserInput', ['拍手送信内容', 'こんにちは']);
  assert.ok(script.includes('--param=message_body="[琥珀 あかね]こんにちは",--async=webclap]'), script);

  const t = rig({ fetch: fakeFetch(opaque), ghostDir: '/ghost/master/' });
  const played = await playWithHttp(script, t.http);
  assert.equal(played.text, '', 'nothing of the tag shows in the balloon');
  assert.deepEqual(played.unknown, []);
  assert.equal(played.busy, false, '--async=webclap: the script goes on to its \\e');
  assert.equal(t.fetch.calls.length, 1);
  const { url, init } = t.fetch.calls[0];
  assert.equal(url, RAQIA_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.mode, 'no-cors');
  const body = str(init.body);
  assert.equal(body, 'message_body=%5B%E7%90%A5%E7%8F%80+%E3%81%82%E3%81%8B%E3%81%AD%5D%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF',
    'what ssp.exe posts: no %22 (the quotes are gone), the whole [sender]text');
  assert.equal(init.body.length, 110);
  assert.deepEqual(t.events.map(e => [e.id, e.refs[0], e.refs[1], e.refs[2], e.refs[4]]),
    [['OnExecuteHTTPComplete', 'post', 'webclap', RAQIA_URL, '200']], 'R1 webclap: roommate\'s own handler (dic_Menu.txt:860)');

  // a user's ',' and ']' stay inside the quotes: still one parameter
  const t2 = rig({ fetch: fakeFetch(opaque), ghostDir: '/ghost/master/' });
  ask('OnChoiceSelect', ['ご意見']);
  const p2 = await playWithHttp(ask('OnUserInput', ['拍手送信内容', 'バグ報告: 選択肢が, 二つ出る]']), t2.http);
  assert.equal(p2.text, '');
  assert.match(str(t2.fetch.calls[0].init.body), /^message_body=%5B%E7%90%A5%E7%8F%80\+%E3%81%82%E3%81%8B%E3%81%AD%5D.*%2C\+%E4%BA%8C%E3%81%A4%E5%87%BA%E3%82%8B%5D$/);

  // one '"' of the user's reopens the quote up to the end of the script: SSP drops the tag ("Unclosed '['") and \e
  const t3 = rig({ fetch: fakeFetch(opaque), ghostDir: '/ghost/master/' });
  ask('OnChoiceSelect', ['ご意見']);
  const p3 = await playWithHttp(ask('OnUserInput', ['拍手送信内容', 'one " quote']), t3.http);
  assert.deepEqual([p3.text, t3.fetch.calls.length, t3.events.length], ['', 0, 0], 'no request, nothing shown');
});

test('yomi_to_syu\'s web clap (dic_Menu.txt:846, syu_s/dic_Menu.txt:393): the same template, SSP\'s body; Marmot\'s commas and b-d\'s two quote pairs', async () => {
  const B = '\\';
  const tag = (param, id = 'webclap') => `${B}![execute,http-post,${RAQIA_URL},--param=${param},--async=${id}]${B}e`;
  const run = async script => {
    const t = rig({ fetch: fakeFetch(opaque), ghostDir: '/ghost/master/' });
    const p = await playWithHttp(script, t.http);
    assert.equal(p.text, '', script);
    return str(t.fetch.calls[0].init.body);
  };
  assert.equal(await run(tag('message_body="[ヨミと柊子]こんにちは"')),
    'message_body=%5B%E3%83%A8%E3%83%9F%E3%81%A8%E6%9F%8A%E5%AD%90%5D%E3%81%93%E3%82%93%E3%81%AB%E3%81%A1%E3%81%AF');
  // MarmotUndergroundAndNico (chika/dic12_RadioProtector.txt:240): commas inside the quotes stay in the value
  assert.equal(await run(tag('message_name="N"&message_body="コーナー,,,x"', 'OnWebCrapResponseFinish')),
    'message_name=N&message_body=%E3%82%B3%E3%83%BC%E3%83%8A%E3%83%BC%2C%2C%2Cx', 'two = in one item: & / = kept');
  // b-d (dic04_Menu.txt:78): a second quote pair in one argument; the quotes go, so no %22 is posted
  assert.equal(await run(tag('message_name="【ダウンから】"&message_body="hi"', 'OnWebCrapResponseFinish')),
    'message_name=%E3%80%90%E3%83%80%E3%82%A6%E3%83%B3%E3%81%8B%E3%82%89%E3%80%91&message_body=hi');
});

// ---------------------------------------------------------------- bonsyou on the real YAYA engine

const BONSYOU = path.join(ROOT, 'site', 'ghost', 'bonsyou');
const YAYA_JS = path.join(ROOT, 'site', 'sumika', 'engines', 'yaya.js');

class NodeYaya extends YayaEngine {
  async factory() { return loadEngineFactory('yaya'); }
}

/** The worker around an in-process engine: requests, and the 'write' message (ShioriClient.writeFile) */
class YayaShiori {
  constructor(engine) {
    this.engine = engine;
    this.ghostDir = engine.ghostDir;
    this.stored = {};
    this.log = [];
    this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
    this.engine.changedFiles();
  }
  keep() { Object.assign(this.stored, this.engine.changedFiles()); }
  async request(r) {
    const res = parseResponse(this.engine.request(buildRequest(r, this.base)));
    this.keep();
    this.log.push({ id: r.id, method: r.method || 'GET', refs: r.refs || [], value: res.value });
    return res;
  }
  async writeFile(rel, data) { const p = this.engine.writeMasterFile(rel, data); this.keep(); return p; }
  async readFile(rel) { const b = this.engine.readMasterFile(rel); return b ? new Uint8Array(b) : null; }
  async unload() { return this.engine.unload(); }
}

test('bonsyou\'s menu counter on the real YAYA engine: the download lands in var/, OnCountCompleteMenu FOPENs it', { ...needs('site/ghost/bonsyou'), timeout: 60000 }, async () => {
  assert.ok(fs.existsSync(YAYA_JS), 'site/sumika/engines/yaya.js is missing: run python engines/yaya/build.py');
  assert.ok(fs.existsSync(path.join(BONSYOU, 'ghost', 'master', 'yaya_all.txt')), 'site/ghost/bonsyou is missing');
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push([rel + e.name, fs.statSync(path.join(d, e.name)).size]);
    }
  })(BONSYOU, '');
  const plan = yayaFilePlan(new GhostFiles('mem:/bonsyou/', list));
  const files = plan.bytes.map(p => {
    const b = fs.readFileSync(path.join(BONSYOU, p));
    return { path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  });
  const engine = new NodeYaya({
    engineUrl: YAYA_JS, log: () => {}, saori: saoriBridge,
    opts: { module: 'yaya', ghostId: 'bonsyou', placeholders: plan.placeholders, site: yayaSite({ ghosts: [GHOST], balloons: [] }), lang: 'ja-JP' },
  });
  await engine.boot();
  assert.equal(engine.init(files, {}, { resume: false, bootEpochMs: Date.now() }), true);
  const shiori = new YayaShiori(engine);
  const fetch = fakeFetch(() => new Response('31415', { status: 200 }));
  const clock = new FakeClock();
  const player = new FakePlayer();
  const l = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: GHOST,
    state: new StateStore('bonsyou', { storage: memoryStorage(), clock }), clock, env: { win: null, doc: null }, fetch,
    ghostDescript: new Map([['name', GHOST.name]]), site: { ghosts: [GHOST], balloons: [] },
  });
  await l.boot({ resume: false, firstBoot: true });

  // the menu item's own reply holds the tag (OnMenu_DispCount); the player hands it to the host as the real one would
  const menu = await shiori.request({ method: 'GET', id: 'OnMenu_DispCount', refs: [] });
  const m = /\\!\[execute,([^,\]]+),([^\]]*)\]/.exec(menu.value || '');
  assert.ok(m, `OnMenu_DispCount asks for the counter: ${menu.value}`);
  l.httpExecute(m[1], m[2].split(','));
  for (let i = 0; i < 40 && !(player.last && /31415/.test(player.last.script)); i++) await settle();
  assert.equal(fetch.calls[0].url, COUNT_URL);
  assert.equal(fetch.calls[0].init.credentials, 'omit');
  assert.equal(dec.decode(new Uint8Array(engine.readMasterFile('var/bonsyou_now.txt'))), '31415', 'in the engine\'s ghost/master/var/');
  const ev = shiori.log.find(r => r.id === 'OnCountCompleteMenu');
  assert.ok(ev, 'OnCountCompleteMenu was sent');
  assert.deepEqual(ev.refs, ['get', 'OnCountCompleteMenu', COUNT_URL, '/ssp/ghost/bonsyou/ghost/master/var/bonsyou_now.txt', '200', '', 'content-type: text/plain;charset=UTF-8\x01']);
  assert.match(ev.value || '', /31415/, 'the ghost read the count from the file');
  assert.match(player.last.script, /31415/, 'and its reply plays');
  assert.ok(shiori.stored['ghost/master/var/bonsyou_now.txt'], 'stored per visitor like any file the ghost writes');
  assert.equal(engine.readMasterFile('../../readme.txt'), null, '--param-input-file stays inside ghost/master');
  assert.ok(engine.readMasterFile('var\\..\\yaya.txt'), 'a path inside it, Windows separators');
  assert.throws(() => engine.writeMasterFile('var/../..', new Uint8Array(1)), /not a file of the ghost/);
  await l.close(0);
});

// ---------------------------------------------------------------- mouse gestures on the real YAYA engine (EV §4.5.1)

const EMILY4 = path.join(ROOT, 'site', 'ghost', 'emily4');
const EMILY4_GHOST = {
  id: 'emily4', name: 'Emily/Phase4.5', sakuraName: 'Emily', keroName: 'Teddy', defaultShell: 'master',
  shells: [{ id: 'master', name: 'Phase4.5[新]' }],
};

/**
 * A site ghost on the real YAYA engine (module yaya) behind an EventLoop with fake views, booted. `Audio`: a sound
 * player (PageSaori over the ghost's files with that element class) whose host is the loop; `fetch`: the loop's.
 */
async function yayaLoop(dir, ghost, { Audio = null, fetch } = {}) {
  assert.ok(fs.existsSync(YAYA_JS), 'site/sumika/engines/yaya.js is missing: run python engines/yaya/build.py');
  assert.ok(fs.existsSync(path.join(dir, 'ghost', 'master')), `${dir} is missing`);
  const list = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else list.push([rel + e.name, fs.statSync(path.join(d, e.name)).size]);
    }
  })(dir, '');
  const plan = yayaFilePlan(new GhostFiles(`mem:/${ghost.id}/`, list));
  const files = plan.bytes.map(p => {
    const b = fs.readFileSync(path.join(dir, p));
    return { path: p, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
  });
  const engine = new NodeYaya({
    engineUrl: YAYA_JS, log: () => {}, saori: saoriBridge,
    opts: { module: 'yaya', ghostId: ghost.id, placeholders: plan.placeholders, site: yayaSite({ ghosts: [ghost], balloons: [] }), lang: 'ja-JP' },
  });
  await engine.boot();
  assert.equal(engine.init(files, {}, { resume: false, bootEpochMs: Date.now() }), true);
  const shiori = new YayaShiori(engine);
  const clock = new FakeClock();
  const player = new FakePlayer();
  const stage = new FakeStage();
  const audio = Audio ? new PageSaori({ files: new GhostFiles(`mem:/${ghost.id}/`, list), Audio, win: null }) : null;
  const loop = new EventLoop({
    shiori, player, stage, balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost,
    state: new StateStore(ghost.id, { storage: memoryStorage(), clock }), clock, env: { win: null, doc: null },
    ghostDescript: new Map([['name', ghost.name]]), site: { ghosts: [ghost], balloons: [] },
    ...(audio ? { audio } : {}), ...(fetch !== undefined ? { fetch } : {}),
  });
  if (audio) audio.host = loop;
  await loop.boot({ resume: false });
  return { engine, shiori, player, stage, loop, audio };
}

/**
 * What the views emit for a right drag (src/shell/mouse.js): OnMouseDown(1), the gestures, OnMouseUp(1) without a click,
 * 'end'; press point (9, 5) on `c0`, the point now (5, 5). The OnMouseGesture requests sent, once all have answered.
 */
async function rightDrag(t, names, c0 = '') {
  const n = t.shiori.log.length;
  const m = (type, extra) => t.stage.emit('mouse', {
    type, scope: 0, x: 9, y: 5, button: 1, wheel: 0, collision: c0, device: 'mouse', ...extra,
  });
  const deg = { left: 180.4, right: 0, end: 0 };
  m('down');
  for (const name of names) {
    m('gesture', { name, deg: deg[name], dir: -1, run: 1, wx: 5, wy: 5, wx0: 9, wy0: 5, collision: '', collision0: c0 });
  }
  m('up', { click: false });
  m('gesture', { name: 'end', deg: 0, dir: -1, run: 1, wx: 5, wy: 5, wx0: 9, wy0: 5, collision: '', collision0: c0 });
  const sent = () => t.shiori.log.slice(n).filter(r => r.id === 'OnMouseGesture');
  for (let i = 0; i < 80 && (sent().length < names.length + 1 || !t.shiori.log.slice(n).some(r => r.id === 'OnMouseUp')); i++) await settle();
  for (let i = 0; i < 10; i++) await settle();      // the last reply's OnTranslate and play
  return sent();
}

test('bonsyou rings on a right drag left then right (its OnMouseGesture), and only once until OnSoundStop', { ...needs('site/ghost/bonsyou'), timeout: 60000 }, async () => {
  const t = await yayaLoop(BONSYOU, GHOST);
  let sent = await rightDrag(t, ['left', 'right']);
  // its own comment: "r0 0/1  r1 Mouse  r2 MouseHit  r3 Start   r4 StartHit   r5 direction"
  assert.deepEqual(sent.map(r => r.refs), [
    [0, '5\x015', '', '9\x015', '', 'left', 180], [0, '5\x015', '', '9\x015', '', 'right', 0],
    [0, '5\x015', '', '9\x015', '', 'end', 0],
  ]);
  assert.deepEqual(sent.slice(0, 2).map(r => r.value || ''), ['', ''], 'left and right only collect');
  assert.match(sent[2].value || '', /\\!\[sound,play,bonsyou\.wav\]/, 'end: DoGong');
  assert.match(t.player.last.script, /bonsyou\.wav/, 'the gong plays');
  assert.equal(t.shiori.log.filter(r => r.id === 'OnMouseClick').length, 0);
  sent = await rightDrag(t, ['left', 'right']);
  assert.match(sent[2].value || '', /連続では鳴らせません/, 'GongLock: only its OnSoundStop clears it');
  await t.loop.close(0);
});

test('bonsyou\'s gong on the real YAYA engine: OnSoundStop [bonsyou.wav, end] clears GongLock and fetches the count; OnCountComplete reads it (EV §4.17)', { ...needs('site/ghost/bonsyou'), timeout: 60000 }, async () => {
  class FakeAudio {
    constructor(src) { this.src = src; this.paused = true; this.currentTime = 0; FakeAudio.all.push(this); }
    play() { this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  FakeAudio.all = [];
  const fetch = fakeFetch(() => ok('108'));
  const t = await yayaLoop(BONSYOU, GHOST, { Audio: FakeAudio, fetch });
  const gong = async () => (await t.shiori.request({ method: 'GET', id: 'OnMenu_Gong', refs: [] })).value || '';
  let v = await gong();                                // 鳴らしてみる
  const tag = /\\!\[sound,(play),([^\]]+)\]/.exec(v);
  assert.ok(tag, `DoGong plays the gong: ${v}`);
  t.loop.sound(tag[1], tag[2].split(','));            // as the player hands \![sound,play,…] to its host
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.match(a.src, /ghost\/master\/bonsyou\.wav$/);
  assert.equal(a.paused, false);
  assert.match(await gong(), /連続では鳴らせません/, 'locked while it rings');

  a.onended();                                         // about 23 s later
  for (let i = 0; i < 40 && !t.shiori.log.some(r => r.id === 'OnSoundStop'); i++) await settle();
  const stop = t.shiori.log.find(r => r.id === 'OnSoundStop');
  assert.deepEqual([stop.method, stop.refs], ['GET', ['bonsyou.wav', 'end']]);
  const http = /\\!\[execute,([^,\]]+),([^\]]*)\]/.exec(stop.value || '');
  assert.ok(http, `its OnSoundStop asks for the counter: ${stop.value}`);
  assert.deepEqual([http[1], http[2].split(',')],
    ['http-get', ['http://ms.shillest.net/resource/bonsyou_count.cgi', '--async=OnCountComplete', '--file=bonsyou.txt']]);
  t.loop.httpExecute(http[1], http[2].split(','));
  for (let i = 0; i < 40 && !(t.player.last && /煩悩/.test(t.player.last.script)); i++) await settle();
  assert.equal(fetch.calls[0].url, 'http://ms.shillest.net/resource/bonsyou_count.cgi');
  const done = t.shiori.log.find(r => r.id === 'OnCountComplete');
  assert.ok(done, 'OnCountComplete was sent');
  assert.match(done.value || '', /108/, 'it read var/bonsyou.txt');
  assert.match(t.player.last.script, /108[^]*の煩悩が消えてゆきました/, 'and its reply plays');
  assert.match(await gong(), /\\!\[sound,play,bonsyou\.wav\]/, 'GongLock cleared: it rings again');
  await t.loop.close(0);
});

test('emily4 flips her skirt on a right drag left across it (OnMouseGestureCall0Skirt_left); end answers nothing', { ...needs('site/ghost/emily4'), timeout: 60000 }, async () => {
  const t = await yayaLoop(EMILY4, EMILY4_GHOST);
  const sent = await rightDrag(t, ['left'], 'Skirt');
  assert.deepEqual(sent.map(r => [r.refs[0], r.refs[4], r.refs[5]]), [[0, 'Skirt', 'left'], [0, 'Skirt', 'end']]);
  assert.match(sent[0].value || '', /\\s\[80\]/, 'MouseGestureSkirt(80): R0 + R4 + the names so far');
  assert.equal(sent[1].value || '', '', 'end erases her arrays');
  assert.equal(t.player.last.meta.event, 'OnMouseGesture');
  await t.loop.close(0);
});
