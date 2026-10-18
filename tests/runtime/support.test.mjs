// Browsers (CLAUDE.md "Browsers"): src/core/support.js, the required set main.js checks before anything of Sumika is
// made (missingFeatures on fake windows, the 116-byte probe read back, on the real V8 and under flags that take its
// features away, describeMissing, the unsupported stub), and the page bundle itself: src/main.js bundled with
// build.mjs's options and run in a vm context whose fetch, storages, IndexedDB, caches, Worker, BroadcastChannel, Web
// Locks, listeners and element creation are tripwires. A browser that lacks a required feature gets the stub, one warn,
// and nothing else (the page stays as it was); data-phone="off" on a phone is the phone's offApi and never reads
// WebAssembly; a browser with everything gets exactly the full window.sumika; with data-hub the window's first
// listeners are the HubClient's pagehide and pageshow (capture), made before the Site's (the back/forward cache).
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PROBE, FEATURES, missingFeatures, describeMissing, unsupportedApi } from '../../src/core/support.js';
import { offApi } from '../../src/core/phone.js';
import { page } from './bundle_page.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUPPORT = path.join(root, 'src', 'core', 'support.js');

/** A window with every required feature: Node's WebAssembly and BigInt64Array, a stand-in createImageBitmap. */
const full = (extra = {}) => ({ WebAssembly, BigInt64Array, createImageBitmap: () => Promise.resolve(null), ...extra });

// ---------------------------------------------------------------- missingFeatures on fake windows

test('missingFeatures: everything present -> []; each id alone; all missing -> wasm (the two after it skipped) and the rest, in order', () => {
  assert.deepEqual(FEATURES, ['wasm', 'wasm-features', 'wasm-compile', 'BigInt64Array', 'createImageBitmap']);
  assert.deepEqual(missingFeatures(full()), []);
  assert.deepEqual(missingFeatures(full({ WebAssembly: undefined })), ['wasm'], 'no WebAssembly: the probe is not tried');
  assert.deepEqual(missingFeatures(full({ WebAssembly: { validate: () => true } })), ['wasm'], 'no Module');
  assert.deepEqual(missingFeatures(full({ WebAssembly: () => {} })), ['wasm'], 'not an object');
  let compiled = 0;
  const wasm = (validate, Module) => ({ validate, Module: Module || function () { compiled++; } });
  assert.deepEqual(missingFeatures(full({ WebAssembly: wasm(() => false) })), ['wasm-features']);
  assert.equal(compiled, 0, 'a probe that does not validate is not compiled');
  assert.deepEqual(missingFeatures(full({ WebAssembly: wasm(() => 1) })), ['wasm-features'], 'only true validates');
  assert.deepEqual(missingFeatures(full({ WebAssembly: wasm(() => { throw new Error('x'); }) })), ['wasm-features']);
  assert.deepEqual(missingFeatures(full({ WebAssembly: wasm(() => true, function () { throw new Error('CSP'); }) })), ['wasm-compile']);
  const seen = [];
  assert.deepEqual(missingFeatures(full({ WebAssembly: wasm(b => { seen.push(b); return true; }) })), []);
  assert.equal(compiled, 1, 'compiled once');
  assert.deepEqual(seen, [PROBE], 'the probe is what is validated');
  assert.deepEqual(missingFeatures(full({ BigInt64Array: undefined })), ['BigInt64Array']);
  assert.deepEqual(missingFeatures(full({ createImageBitmap: undefined })), ['createImageBitmap']);
  assert.deepEqual(missingFeatures(full({ createImageBitmap: {} })), ['createImageBitmap'], 'not a function');
  assert.deepEqual(missingFeatures({}), ['wasm', 'BigInt64Array', 'createImageBitmap']);
  assert.deepEqual(missingFeatures(null), ['wasm', 'BigInt64Array', 'createImageBitmap'], 'no window at all');
  assert.deepEqual(missingFeatures(full({ WebAssembly: wasm(() => false), BigInt64Array: undefined, createImageBitmap: undefined })),
    ['wasm-features', 'BigInt64Array', 'createImageBitmap']);
});

test('missingFeatures: a throwing getter counts as missing and nothing throws; it reads the three globals and nothing else', () => {
  const throwing = name => { const w = full(); Object.defineProperty(w, name, { get() { throw new Error('denied'); } }); return w; };
  assert.deepEqual(missingFeatures(throwing('WebAssembly')), ['wasm']);
  assert.deepEqual(missingFeatures(throwing('BigInt64Array')), ['BigInt64Array']);
  assert.deepEqual(missingFeatures(throwing('createImageBitmap')), ['createImageBitmap']);
  const badWasm = { get validate() { throw new Error('x'); }, Module: function () {} };
  assert.deepEqual(missingFeatures(full({ WebAssembly: badWasm })), ['wasm'], 'a throwing member of WebAssembly');
  const reads = [];
  const win = new Proxy(full(), { get(t, k) { reads.push(k); return t[k]; }, has(t, k) { reads.push(k); return k in t; } });
  assert.deepEqual(missingFeatures(win), []);
  assert.deepEqual([...new Set(reads)].sort(), ['BigInt64Array', 'WebAssembly', 'createImageBitmap']);
});

// ---------------------------------------------------------------- the probe on the real engine

/** missingFeatures in a child Node with V8 flags, on a window of that process's own globals. */
function childMissing(flags) {
  const code = `const m = await import(${JSON.stringify(pathToFileURL(SUPPORT).href)});
console.log(JSON.stringify(m.missingFeatures({ WebAssembly: globalThis.WebAssembly, BigInt64Array: globalThis.BigInt64Array, createImageBitmap() {} })));`;
  const r = spawnSync(process.execPath, [...flags, '--input-type=module', '-e', code], { encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').at(-1));
}

/**
 * The probe's code section read back: each body's instructions by name (only the opcodes the probe uses; anything else
 * throws). Section ids 10 = code; LEB128 sizes are single bytes here.
 */
function probeOps(bytes) {
  let i = 8;
  while (bytes[i] !== 0x0a) i += 2 + bytes[i + 1];
  const end = i + 2 + bytes[i + 1];
  i += 3;                                     // id, size, body count
  const NAMES = {
    0x06: 'try', 0x07: 'catch', 0x08: 'throw', 0x09: 'rethrow', 0x0b: 'end', 0x18: 'delegate', 0x19: 'catch_all',
    0x1a: 'drop', 0x20: 'local.get', 0x41: 'i32.const', 0x42: 'i64.const', 0x44: 'f64.const',
    0xc0: 'i32.extend8_s', 0xc1: 'i32.extend16_s', 0xc2: 'i64.extend8_s', 0xc3: 'i64.extend16_s', 0xc4: 'i64.extend32_s',
  };
  const FC = { 0x02: ['i32.trunc_sat_f64_s', 0], 0x0a: ['memory.copy', 2], 0x0b: ['memory.fill', 1] };
  const IMM = { 0x06: 1, 0x07: 1, 0x08: 1, 0x09: 1, 0x18: 1, 0x20: 1, 0x41: 1, 0x42: 1, 0x44: 8 };
  const bodies = [];
  while (i < end) {
    const stop = i + 1 + bytes[i];
    assert.equal(bytes[i + 1], 0, 'no locals');
    i += 2;
    const ops = [];
    while (i < stop) {
      const op = bytes[i++];
      if (op === 0xfc) { const [name, n] = FC[bytes[i++]]; ops.push(name); i += n; continue; }
      if (!(op in NAMES)) throw new Error(`opcode 0x${op.toString(16)} at ${i - 1}`);
      ops.push(NAMES[op]);
      i += IMM[op] || 0;
    }
    bodies.push(ops);
  }
  return bodies;
}

test('the probe holds every instruction family the engines use beyond the MVP (wasm-dis of the four engines)', () => {
  const [f0, f1] = probeOps(PROBE);
  // in every engine: try, catch <tag>, catch_all, delegate, rethrow, throw, i32.extend8_s / 16_s, a trunc_sat,
  // memory.copy / fill; YAYA also i64.extend16_s / 32_s. No SIMD, reference types, tail calls or multi-value
  for (const op of ['try', 'catch', 'catch_all', 'delegate', 'rethrow', 'throw', 'i32.extend8_s', 'i32.extend16_s', 'i64.extend32_s',
    'i32.trunc_sat_f64_s', 'memory.copy', 'memory.fill']) assert.ok(f0.includes(op), op);
  assert.deepEqual(f0, ['try', 'try', 'i32.const', 'i32.extend8_s', 'drop', 'i32.const', 'i32.extend16_s', 'drop', 'i64.const',
    'i64.extend32_s', 'drop', 'f64.const', 'i32.trunc_sat_f64_s', 'drop', 'i32.const', 'i32.const', 'i32.const', 'memory.copy',
    'i32.const', 'i32.const', 'i32.const', 'memory.fill', 'throw', 'delegate', 'catch', 'rethrow', 'catch_all', 'end', 'end']);
  assert.deepEqual(f1, ['local.get', 'end']);
});

test('the probe: 116 bytes (far below Chrome\'s 4 KB main-thread compile limit), valid and compiled here; taken away by V8 flags', () => {
  assert.equal(PROBE.length, 116);
  assert.ok(PROBE.length < 4096);
  assert.equal(WebAssembly.validate(PROBE), true);
  assert.ok(new WebAssembly.Module(PROBE) instanceof WebAssembly.Module);
  assert.deepEqual(childMissing([]), [], 'the same in a child process without flags');
  assert.deepEqual(childMissing(['--no-experimental-wasm-legacy-eh']), ['wasm-features'], 'legacy exception handling off: the engines could not run');
  assert.deepEqual(childMissing(['--jitless']), ['wasm'], 'jitless (as Lockdown Mode): no WebAssembly');
});

test('the probe in a realm that refuses wasm code generation (as a Content-Security-Policy without \'wasm-unsafe-eval\'): wasm-compile', () => {
  const ctx = vm.createContext({ PROBE: new Uint8Array(PROBE) }, { codeGeneration: { strings: true, wasm: false } });
  const W = vm.runInContext('WebAssembly', ctx);
  assert.equal(W.validate(PROBE), true, 'validate is never refused');
  assert.deepEqual(missingFeatures({ WebAssembly: W, BigInt64Array, createImageBitmap() {} }), ['wasm-compile']);
});

// ---------------------------------------------------------------- the words and the stub

test('describeMissing: words for the console, in the order given', () => {
  assert.equal(describeMissing(['wasm']), 'WebAssembly (turned off, as in Lockdown Mode, or too old)');
  assert.equal(describeMissing(['wasm-features']), 'WebAssembly exception handling (Chrome 95, Firefox 100, Safari 15.2)');
  assert.match(describeMissing(['wasm-compile']), /Content-Security-Policy without 'wasm-unsafe-eval'/);
  assert.equal(describeMissing(['BigInt64Array', 'createImageBitmap']),
    'BigInt64Array (Chrome 67, Firefox 68, Safari 15); createImageBitmap (Chrome 50, Firefox 42, Safari 15)');
  assert.equal(describeMissing([]), '');
  assert.equal(describeMissing(['other']), 'other');
});

test('unsupportedApi: frozen; the off stub\'s members plus supported false and the missing ids; phone as given; nothing throws', async () => {
  const api = unsupportedApi('1.0.0', null, ['wasm']);
  assert.ok(Object.isFrozen(api));
  assert.ok(Object.isFrozen(api.missing));
  assert.deepEqual(Object.keys(api).sort(), [...Object.keys(offApi('1.0.0')), 'missing', 'supported'].sort());
  assert.deepEqual([api.version, api.phone, api.site, api.runtime, api.supported, api.missing], ['1.0.0', null, null, null, false, ['wasm']]);
  assert.deepEqual([api.state, api.reason], ['off', 'unsupported'], 'off, and why');
  assert.equal(await api.start(), 'none');
  for (const k of ['callGhost', 'closeGhost', 'quit', 'changeGhost', 'changeShell', 'changeBalloon']) assert.equal(await api[k]('x'), false, k);
  assert.deepEqual([api.ghosts(), api.running(), api.shells(), api.balloons()], [[], [], [], { top: [], all: [] }]);
  assert.equal(unsupportedApi('1.0.0', 'tucked', []).phone, 'tucked');
  const ids = ['wasm-features', 'createImageBitmap'];
  const b = unsupportedApi('1.0.0', 'on', ids);
  ids.push('x');
  assert.deepEqual(b.missing, ['wasm-features', 'createImageBitmap'], 'a copy');
  assert.equal('supported' in offApi('1.0.0'), false, 'the off stub has no `supported`');
});

// ---------------------------------------------------------------- the page bundle in a vm context
// (tests/runtime/bundle_page.mjs: page(o) runs the bundle with tripwires; see there)

/** the members of the live window.sumika (main.js), `state` (core/choice.js) among them */
const LIVE = ['balloons', 'callGhost', 'changeBalloon', 'changeGhost', 'changeShell', 'closeGhost', 'ghosts', 'phone', 'quit', 'running',
  'runtime', 'shells', 'site', 'start', 'state', 'version'];

test('the bundle in a browser that lacks a required feature: the stub with the id, one warn naming it, and nothing else touched', async () => {
  for (const [o, id, word] of [[{ wasm: false }, 'wasm', /WebAssembly \(turned off/], [{ bitmap: false }, 'createImageBitmap', /createImageBitmap/],
    [{ bigint: false }, 'BigInt64Array', /BigInt64Array/], [{ wasm: false, bitmap: false }, null, /WebAssembly.*; createImageBitmap/]]) {
    const r = await page(o);
    const what = JSON.stringify(o);
    assert.deepEqual(r.hits, [], `${what}: no fetch, storage, lock, worker, channel, listener or element`);
    assert.equal(r.api.supported, false, what);
    if (id) assert.deepEqual([...r.api.missing], [id], what);
    else assert.deepEqual([...r.api.missing], ['wasm', 'createImageBitmap'], what);
    assert.equal(r.api.site, null);
    assert.equal(r.api.phone, null, 'a desktop: no phone');
    assert.ok(Object.isFrozen(r.api));
    assert.equal(r.warns.length, 1, `${what}: one warn`);
    assert.match(r.warns[0], /^\[sumika\] this browser cannot run Sumika: it lacks /);
    assert.match(r.warns[0], word);
    assert.deepEqual(r.errors, []);
    assert.equal(await r.api.start(), 'none', 'page code calling the stub never throws');
  }
});

test('the bundle on a phone with data-phone="off": the phone\'s offApi, no `supported`, WebAssembly never read; tucked without WebAssembly: the stub, no button', async () => {
  const off = await page({ wasm: false, search: '?sumika-phone', dataset: { phone: 'off' } });
  assert.deepEqual(Object.keys(off.api).sort(), Object.keys(offApi('x')).sort());
  assert.equal(off.api.phone, 'off');
  assert.equal('supported' in off.api, false);
  assert.equal(off.reads.WebAssembly, 0, 'the check never runs when Sumika is off');
  assert.deepEqual([off.hits, off.warns, off.errors], [[], [], []]);
  const tucked = await page({ wasm: false, search: '?sumika-phone', dataset: { phone: 'tucked' } });
  assert.equal(tucked.api.phone, 'tucked');
  assert.equal(tucked.api.supported, false);
  assert.deepEqual(tucked.hits, [], 'no launcher button, no listener');
  assert.equal(tucked.warns.length, 1);
});

test('the bundle in a browser with everything (data-autostart="0"): exactly the full window.sumika, its Site made, no warn', async () => {
  const r = await page({ dataset: { autostart: '0' } });
  assert.deepEqual(Object.keys(r.api).sort(), LIVE);
  assert.equal('supported' in r.api, false);
  assert.ok(r.api.site, 'the Site is made');
  assert.equal(r.api.phone, null);
  assert.equal(r.api.state, 'enabled', 'no data-default-state, no choice: the usual page');
  assert.equal(r.reads.WebAssembly, 1, 'the check ran once');
  assert.deepEqual([r.warns, r.errors], [[], []]);
  assert.ok(!r.hits.includes('fetch') && !r.hits.includes('Worker'), 'not started: nothing fetched');
});

// ---------------------------------------------------------------- data-hub (the storage hub)

const CDN = 'http://cdn.test/sumika/sumika.js';     // the runtime on another origin than the page (http://site.test)

test('data-hub on the unsupported path and the phone off path: still nothing touched (no frame, listener, channel or storage), no warn about it', async () => {
  for (const hub of ['', 'http://cdn.test/sumika/hub.html', 'garbage']) {
    const un = await page({ wasm: false, dataset: { hub }, src: CDN });
    assert.deepEqual(un.hits, [], `unsupported, data-hub="${hub}"`);
    assert.equal(un.warns.length, 1, 'only the unsupported warn: data-hub is never read');
    const off = await page({ search: '?sumika-phone', dataset: { phone: 'off', hub }, src: CDN });
    assert.deepEqual([off.hits, off.warns, off.errors], [[], [], []], `off, data-hub="${hub}"`);
    assert.equal(off.api.phone, 'off');
  }
});

test('data-hub with data-autostart="0": the full window.sumika; before start() no frame, no fetch, and not one member of the page origin\'s storages read', async () => {
  for (const dataset of [{ hub: '', autostart: '0' }, { hub: 'http://cdn.test/sumika/hub.html', autostart: '0' }]) {
    const r = await page({ dataset, src: CDN });
    assert.deepEqual(Object.keys(r.api).sort(), LIVE);
    assert.ok(r.api.site);
    assert.equal(r.api.state, null, 'the visitor\'s choice is the hub\'s: read at the first start');
    assert.deepEqual([r.warns, r.errors], [[], []]);
    const touched = r.hits.filter(h => /^(document\.createElement|fetch|Worker|BroadcastChannel|localStorage|sessionStorage|indexedDB|caches|navigator\.locks)/.test(h));
    assert.deepEqual(touched, [], JSON.stringify(dataset));
  }
  // without the attribute: the usual page, which reads its own localStorage (the language's prefs)
  const plain = await page({ dataset: { autostart: '0' }, src: CDN });
  assert.ok(plain.hits.some(h => h.startsWith('localStorage.')), 'the control: the Site\'s constructor reads the page\'s storage');
});

test('data-hub that is not usable as written (a relative URL, another scheme) or names the page\'s own origin: the usual page, one warn for a bad value', async () => {
  const bad = await page({ dataset: { hub: 'hub.html', autostart: '0' }, src: CDN });
  assert.equal(bad.warns.length, 1);
  assert.match(bad.warns[0], /data-hub must be empty or an absolute http\(s\) URL/);
  assert.ok(bad.hits.some(h => h.startsWith('localStorage.')), 'its own origin\'s storage, as without the attribute');
  const own = await page({ dataset: { hub: '', autostart: '0' } });     // sumika.js on the page's own origin
  assert.deepEqual(own.warns, []);
  assert.ok(own.hits.some(h => h.startsWith('localStorage.')), 'the hub on the page\'s origin is the page\'s storage');
});

test('data-hub: main.js makes the HubClient with the page\'s window before the Site, so its pagehide and pageshow listeners (capture) are the window\'s first, ahead of the Site\'s (the back/forward cache: CONTRACTS "Hub protocol"); without data-hub the window gets only the Site\'s', async () => {
  // [type, capture] of the window's listeners (the options come from the vm's realm)
  const added = r => r.listeners.map(([t, o]) => [t, !!(o && o.capture)]);
  const pageHooks = r => added(r).filter(([t]) => t === 'pagehide' || t === 'pageshow');
  // start() runs on (here it falls back: no frame can be made) until the Site's page hooks are on the window
  const started = async r => {
    for (let i = 0; i < 200 && pageHooks(r).every(([, capture]) => capture); i++) await new Promise(res => setTimeout(res, 10));
    return r;
  };
  const client = [['pagehide', true], ['pageshow', true]];
  for (const hub of ['', 'http://cdn.test/sumika/hub.html']) {
    const idle = await page({ dataset: { hub, autostart: '0' }, src: CDN });
    assert.deepEqual(added(idle), client, `made with the client, before start(): data-hub="${hub}"`);
    const r = await started(await page({ dataset: { hub }, src: CDN }));
    assert.deepEqual(added(r).slice(0, 2), client, `data-hub="${hub}"`);
    assert.deepEqual(pageHooks(r), [...client, ['pagehide', false], ['pageshow', false]], 'the Site\'s after');
  }
  assert.deepEqual((await page({ dataset: { autostart: '0' }, src: CDN })).listeners, [], 'without data-hub: none before start()');
  assert.deepEqual(pageHooks(await started(await page({ src: CDN }))), [['pagehide', false], ['pageshow', false]], 'and the Site\'s only');
});
