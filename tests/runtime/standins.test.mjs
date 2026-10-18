// SAORI stand-ins (src/worker/saori/standins.js) through the bridge the engine calls: request and response text.
import test from 'node:test';
import assert from 'node:assert/strict';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { sjisByteLength, standIns, pathFromDll } from '../../src/worker/saori/standins.js';

const notes = [];
saoriBridge.notifyPage = (name, cmd, args) => notes.push([name, cmd, args]);
saoriBridge.log = () => {};

const exec = (h, ...args) => saoriBridge.request(h,
  `EXECUTE SAORI/1.0\r\nCharset: UTF-8\r\nSender: SATORI\r\nSecurityLevel: Local\r\n${args.map((a, i) => `Argument${i}: ${a}\r\n`).join('')}\r\n`);
const header = (res, name) => { const m = new RegExp(`\\r\\n${name}: ([^\\r]*)\\r\\n`).exec(res); return m ? m[1] : null; };
const load = name => saoriBridge.load(`/ghost/master/saori/${name}`, '/ghost/master/saori/');

test('every declared SAORI loads and answers GET Version with Charset: UTF-8', () => {
  for (const dll of ['dsaudio.dll', 'gomi.dll', 'empty.dll', 'fill_desktop.dll', 'httpc.dll', 'yaya.dll', 'DSAudio.DLL']) {
    const h = load(dll);
    assert.ok(h > 0, dll);
    const res = saoriBridge.request(h, 'GET Version SAORI/1.0\r\nCharset: UTF-8\r\nSender: SATORI\r\n\r\n');
    assert.match(res, /^SAORI\/1\.0 200 OK\r\n/);
    assert.match(res, /\r\nCharset: UTF-8\r\n/);
    saoriBridge.unload(h);
  }
  assert.equal(load('unknown.dll'), 0);
});

test('gomi: -n reports an empty bin (Result 0, Value0 0); emptying is a no-op', () => {
  const h = load('gomi.dll');
  const r = exec(h, '-n');
  assert.match(r, /^SAORI\/1\.0 200 OK/);
  assert.equal(header(r, 'Result'), '0');
  assert.equal(header(r, 'Value0'), '0');
  const e = exec(h, '-asfq');
  assert.match(e, /^SAORI\/1\.0 200 OK/);
  assert.equal(header(e, 'Value0'), null);
});

test('empty.dll answers like gomi.dll: -n is 0, -ef / -sf do nothing', () => {
  const h = load('empty.dll');
  assert.equal(header(exec(h, '-n'), 'Result'), '0');
  for (const opt of ['-ef', '-sf']) {
    const r = exec(h, opt);
    assert.match(r, /^SAORI\/1\.0 200 OK/);
    assert.equal(header(r, 'Value0'), null);
  }
});

test('httpc: empty result (weather fails gracefully); no arguments -> 0', () => {
  const h = load('httpc.dll');
  const r = exec(h, 'erase_tag', 'http://weather.livedoor.com/area/forecast/130010', '今日の天気 - ', '天気概況');
  assert.match(r, /^SAORI\/1\.0 200 OK/);
  assert.equal(header(r, 'Result'), '');
  assert.equal(header(r, 'Value0'), null);
  assert.equal(header(exec(h), 'Result'), '0');
});

test('fill_desktop: 200 and a page flash; no arguments clears it', () => {
  const h = load('fill_desktop.dll');
  notes.length = 0;
  assert.match(exec(h, '255', '255', '240'), /^SAORI\/1\.0 200 OK/);
  assert.match(exec(h), /^SAORI\/1\.0 200 OK/);
  assert.deepEqual(notes, [['fill_desktop.dll', 'fill', ['255', '255', '240']], ['fill_desktop.dll', 'clear', []]]);
});

test('dsaudio: every command is 200 without Value headers; volume query returns the current value; unload stops', () => {
  const h = load('dsaudio.dll');
  notes.length = 0;
  for (const cmd of [['load', 'C:\\music\\a.mp3'], ['play'], ['pause'], ['stop'], ['loop', 'enable'], ['hwnd', '1000\x011001'], ['something']]) {
    const r = exec(h, ...cmd);
    assert.match(r, /^SAORI\/1\.0 200 OK/, cmd[0]);
    assert.doesNotMatch(r, /Value\d/, cmd[0]);
    // only load reports success; anything else called outside nop (volume, hwnd) would show up in her balloon
    assert.equal(header(r, 'Result'), cmd[0] === 'load' ? '1' : '', cmd[0]);
  }
  // ＊ボリュームアップ calls （dsaudio,volume,（音楽ボリューム）） inline: setting it must return nothing
  assert.equal(header(exec(h, 'volume', '3000'), 'Result'), '');
  assert.equal(header(exec(h, 'volume', ''), 'Result'), '3000');
  assert.equal(header(exec(h, 'volume'), 'Result'), '3000');
  assert.equal(header(exec(h, 'volume', '99999'), 'Result'), '');
  assert.equal(header(exec(h, 'volume'), 'Result'), '10000');
  const cmds = notes.map(n => n[1]);
  assert.deepEqual(cmds, ['load', 'play', 'pause', 'stop', 'loop', 'something', 'volume', 'volume']);
  assert.deepEqual(notes[0][2], ['C:\\music\\a.mp3']);
  // a comma in the file name reaches the SAORI as two arguments (Satori's argument split): one path again
  notes.length = 0;
  assert.equal(header(exec(h, 'load', 'C:\\sumika\\drop\\0acc8cbd\\Hello', ' World.mp3'), 'Result'), '1');
  assert.deepEqual(notes, [['dsaudio.dll', 'load', ['C:\\sumika\\drop\\0acc8cbd\\Hello, World.mp3']]]);
  notes.length = 0;
  saoriBridge.unload(h);
  assert.deepEqual(notes, [['dsaudio.dll', 'unload', []]]);
});

test('aya (yaya.dll): GETSTRBYTES = Shift_JIS byte length; other functions 204', () => {
  const h = load('yaya.dll');
  assert.equal(header(exec(h, 'GETSTRBYTES', 'aSong Titlea'), 'Result'), '12');
  assert.equal(header(exec(h, 'getstrbytes', 'aあｱ漢a'), 'Result'), String(1 + 2 + 1 + 2 + 1));
  assert.match(exec(h, 'STRLEN', 'x'), /^SAORI\/1\.0 204/);
  assert.equal(sjisByteLength(''), 0);
  assert.equal(sjisByteLength('～ｶﾞ'), 4);
});

// ---- stand-ins from the ghost sweep (docs/research/ghost-sweep.md)

test('aya5 Read.*: another ghost\'s save data is "notfound" (or the given text), Value0 -1; GETSTRBYTES as yaya', () => {
  const h = load('aya5.dll');
  const r = exec(h, 'Read.SaveData', 'bukimi', '辞書フォルダ');
  assert.equal(header(r, 'Result'), 'notfound');
  assert.equal(header(r, 'Value0'), '-1');
  assert.equal(header(exec(h, 'Read.SaveData', 'bukimi', 'x', 'なし'), 'Result'), 'なし');
  assert.equal(header(exec(h, 'Read.Shell', 'pakuchiku'), 'Result'), 'notfound');
  assert.equal(header(exec(h, 'GETSTRBYTES', 'aあ'), 'Result'), '3');
});

test('mciaudior / mciaudio: load (relative to the DLL folder), play, loop, stop reach the music box; Result always empty', () => {
  assert.equal(pathFromDll('/ghost/master/saori/', 'gounod_avemaria.mid'), 'ghost/master/saori/gounod_avemaria.mid');
  assert.equal(pathFromDll('/ghost/master/saori/', String.raw`..\sound\hymn109.mid`), 'ghost/master/sound/hymn109.mid');
  assert.equal(pathFromDll('/ghost/master/', 'xeno.mp3'), 'ghost/master/xeno.mp3');
  const drop = String.raw`C:\sumika\drop\0a1b2c3d\a.mp3`;
  assert.equal(pathFromDll('/ghost/master/saori/', drop), drop);
  assert.equal(pathFromDll('/ghost/master/saori/', '"music.mp3"'), 'ghost/master/saori/music.mp3');
  notes.length = 0;
  const h = load('mciaudior.dll');
  for (const args of [['load', 'a', ' b.mp3'], ['play'], ['loop'], ['stop'], ['load', String.raw`..\sound\x.mid`]]) {
    const r = exec(h, ...args);
    assert.match(r, /^SAORI\/1\.0 200 OK/);
    assert.equal(header(r, 'Result'), '', args[0]);
  }
  // load: the ghost-root path, then the file as the ghost gave it (OnMAAPlayFinish / OnMAAPlayLoop Reference0)
  assert.deepEqual(notes.map(([n, c, a]) => [n, c, ...a]), [
    ['mciaudior.dll', 'load', 'ghost/master/saori/a, b.mp3', 'a, b.mp3'],
    ['mciaudior.dll', 'loop', 'disable'], ['mciaudior.dll', 'play'],
    ['mciaudior.dll', 'loop', 'enable'], ['mciaudior.dll', 'play'],
    ['mciaudior.dll', 'stop'],
    ['mciaudior.dll', 'load', 'ghost/master/sound/x.mid', String.raw`..\sound\x.mid`],
  ]);
  saoriBridge.unload(h);
  assert.deepEqual(notes.at(-1), ['mciaudior.dll', 'unload', []], 'the music stops with the DLL');
  assert.ok(load('mciaudio.dll') > 0 && load('MCIAUDIOR.DLL') > 0);
  // um.nar's mciaudior２-６ (copies of the DLL, each its own player) would share the one music box: no stand-in
  assert.equal(load('mciaudior2.dll'), 0);
  assert.equal(standIns['mciaudior2.dll'], undefined);
});

test('time_check how_many_days: days from today, negative in the past; full-width digits', () => {
  const now = new Date(2026, 9, 8, 21, 30).getTime();
  const t = new standIns['time_check.dll']({ now: () => now });
  assert.deepEqual(t.execute(['how_many_days', '2026', '10', '8']), { result: '0' });
  assert.deepEqual(t.execute(['how_many_days', '２０２５', '１０', '８']), { result: '-365' });
  assert.deepEqual(t.execute(['how_many_days', '2026', '10', '18']), { result: '10' });
  assert.deepEqual(t.execute(['how_many_days', '', '', '']), { result: '0' }, 'no date yet (a first meeting): 0 days');
  assert.deepEqual(t.execute(['other']), { result: '' });
  assert.ok(load('time_check.dll') > 0);
});

test('saori_cpuid: OS from the user agent, processors and memory from the navigator, the rest 0', () => {
  const c = new standIns['saori_cpuid.dll']({ navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', hardwareConcurrency: 8, deviceMemory: 8 } });
  const v = k => c.execute([k]).result;
  assert.deepEqual([v('os.name'), v('os.version'), v('cpu.num'), v('mem.phyt'), v('cpu.clock'), v('os.build'), v('mem.os')],
    ['Windows', '10.0', '8', '8192', '0', '0', '0']);
  // as the DLL answers: 1st-innerport shows "（cpuid,platform）" in its balloon ("ssp.exe" under SSP)
  assert.deepEqual([v('platform'), v('cpu.mmx'), v('cpu.sse'), v('cpu.sse2'), v('cpu.tdn'), v('nosuchkey'), v('')],
    ['ssp.exe', 'Ready', 'Ready', 'Ready', 'Not Ready', 'Param Error', '']);
  const m = new standIns['saori_cpuid.dll']({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } });
  assert.deepEqual([m.execute(['os.name']).result, m.execute(['os.version']).result, m.execute(['mem.phyt']).result, m.execute(['cpu.num']).result],
    ['Mac OS X', '10.15', '0', '1']);
});

test('sysio: a dropped file exists and is a file, never a folder; other paths are absent; maho names a file type', () => {
  const s = load('sysio.dll');
  const drop = String.raw`C:\sumika\drop\0a1b2c3d\song.mp3`;
  const r = (...a) => header(exec(s, ...a), 'Result');
  // souzou_syoka: isexist <= 0 = gone; cmn: isfile != 1 = missing; Flugor / cmn: readdir != -1 = a folder
  assert.deepEqual([r('isexist', drop), r('isfile', drop), r('isdir', drop), r('readdir', drop)], ['1', '1', '0', '-1']);
  assert.deepEqual([r('isexist', String.raw`C:\music\a.mp3`), r('isfile', String.raw`C:\music\a.mp3`), r('readdir', String.raw`C:\music`)],
    ['0', '0', '-1']);
  assert.equal(r('isfile', drop.replace(/\\/g, '/').toUpperCase()), '1', 'any separator and case');
  const m = load('maho.dll');
  // an .smf is a Standard MIDI File (`MThd`, what the DLL reads); what it says for an .rmi is not known
  for (const [p, t] of [[String.raw`C:\sumika\drop\0a1b2c3d\a.MP3`, 'mp3'], ['x.mid', 'midi'], ['x.SMF', 'midi'], ['x.rmi', 'unknown'], ['x.ogg', 'ogg_vorbis'], ['x.jpg', 'jpeg'], ['x.wav', 'wav'], ['x', 'unknown']]) {
    assert.equal(header(exec(m, p), 'Result'), t, p);
  }
});
