// Browsers (CLAUDE.md "Browsers"): the check main.js runs before anything of Sumika is made. A browser too old (or with
// WebAssembly turned off) leaves the page as it was: no element, fetch, storage, lock, worker or listener, one console
// line, and window.sumika a frozen stub (unsupportedApi) so page code never throws.
// The baseline is Chrome / Edge / Android WebView 95 (Opera 81, Samsung Internet 17), Firefox 100, Safari 15.2 (macOS,
// iOS / iPadOS): the engines' WebAssembly exception handling (emsdk's legacy format) is the one feature without a
// fallback that sets it. Required = the no-fallback features a ghost needs to start or draw that some engine shipped
// after it could parse sumika.js (ES2020: Chrome 80, Firefox 74, Safari 13.1); older ones (Worker, Blob URLs,
// attachShadow, PointerEvent, TextDecoder('shift_jis'), fetch, URL, ImageData) come with the parse and are not checked.
// Not checkable up front, so not checked: a worker refused by worker-src, canvas memory (canvas.js: a lost canvas ends
// its ghost), IndexedDB (the memory fallback).
// Imported by main.js only; it imports phone.js for the stub's members.
import { offApi } from './phone.js';

/**
 * A 116-byte module with every instruction family the four engines' wasm uses beyond the MVP (wasm-dis of each engine:
 * legacy try / catch <tag> / catch_all / delegate / rethrow / throw, sign extension, trunc_sat,
 * memory.copy / fill), validated and compiled, never instantiated or called. Types 0 [] -> [] and 1 [i64] -> [i64] (an
 * i64 in a signature: MVP); memory min 1 page; tag 0 of type 0 (the exception section, id 13); exports e = f1, t = f0;
 * DataCount 0 (bulk memory's section, id 12); f0: try { try { i32.extend8_s; i32.extend16_s; i64.extend32_s (sign
 * extension); i32.trunc_sat_f64_s (non-trapping float-to-int); memory.copy; memory.fill (bulk memory); throw 0 }
 * delegate 0 } catch 0 { rethrow 0 } catch_all end (legacy exception handling: try 0x06, catch 0x07, throw 0x08,
 * rethrow 0x09, delegate 0x18, catch_all 0x19); f1: local.get 0. Every encoding here is one the engines themselves
 * use, so it validates wherever they would run. Far below Chrome's 4 KB limit for a synchronous compile on the main
 * thread.
 */
export const PROBE = new Uint8Array([
  0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,                             // magic, version 1
  0x01, 0x09, 0x02, 0x60, 0x00, 0x00, 0x60, 0x01, 0x7e, 0x01, 0x7e,           // types
  0x03, 0x03, 0x02, 0x00, 0x01,                                               // functions
  0x05, 0x03, 0x01, 0x00, 0x01,                                               // memory min 1
  0x0d, 0x03, 0x01, 0x00, 0x00,                                               // tag: attribute 0, type 0
  0x07, 0x09, 0x02, 0x01, 0x65, 0x00, 0x01, 0x01, 0x74, 0x00, 0x00,           // exports e, t
  0x0c, 0x01, 0x00,                                                           // datacount 0
  0x0a, 0x42, 0x02,                                                           // code: 2 bodies
  0x3b, 0x00,                                                                 // f0: 59 bytes, no locals
  0x06, 0x40,                                                                 //   try
  0x06, 0x40,                                                                 //     try
  0x41, 0x00, 0xc0, 0x1a,                                                     //       i32.extend8_s
  0x41, 0x00, 0xc1, 0x1a,                                                     //       i32.extend16_s
  0x42, 0x00, 0xc4, 0x1a,                                                     //       i64.extend32_s
  0x44, 0, 0, 0, 0, 0, 0, 0, 0, 0xfc, 0x02, 0x1a,                             //       i32.trunc_sat_f64_s
  0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0a, 0x00, 0x00,                 //       memory.copy
  0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0xfc, 0x0b, 0x00,                       //       memory.fill
  0x08, 0x00,                                                                 //       throw 0
  0x18, 0x00,                                                                 //     delegate 0
  0x07, 0x00,                                                                 //   catch 0
  0x09, 0x00,                                                                 //     rethrow 0
  0x19,                                                                       //   catch_all
  0x0b, 0x0b,                                                                 //   end, end
  0x04, 0x00, 0x20, 0x00, 0x0b,                                               // f1: local.get 0
]);

/** The ids missingFeatures can return, in its order. */
export const FEATURES = Object.freeze(['wasm', 'wasm-features', 'wasm-compile', 'BigInt64Array', 'createImageBitmap']);

/** A global of win; undefined when it is absent or its getter throws (counted as missing). */
function read(win, name) {
  try {
    return win ? win[name] : undefined;
  } catch (e) {
    return undefined;
  }
}

/**
 * What this browser lacks of the required set, in FEATURES order; [] when Sumika can run.
 *   wasm               WebAssembly with validate and Module (too old; Lockdown Mode, jitless or wasm-off settings);
 *                      when it is missing the next two are not tested
 *   wasm-features      WebAssembly.validate(PROBE) is not true: legacy exception handling and the rest (sets Chrome
 *                      95, Firefox 100, Safari 15.2); when it fails the compile is not tried
 *   wasm-compile       new WebAssembly.Module(PROBE) throws: a host Content-Security-Policy without 'wasm-unsafe-eval'
 *                      (the blob worker inherits it, so the engine would fail late, after about 1.4 MB of downloads)
 *                      [verify: whether WebKit applies a page's CSP to a blob worker]
 *   BigInt64Array      every engine start makes one (WASM_BIGINT; Safari 15)
 *   createImageBitmap  every shell image is decoded with it (Safari 15)
 * Reads the globals WebAssembly, BigInt64Array and createImageBitmap of win and compiles PROBE once (the module is
 * dropped): no element, storage, fetch or listener. Each test in its own try; a throwing getter counts as missing.
 * @param {object} win the page's window (or a stand-in)
 * @returns {string[]}
 */
export function missingFeatures(win) {
  const out = [];
  const W = read(win, 'WebAssembly');
  let wasm = false;
  try {
    wasm = !!W && typeof W === 'object' && typeof W.validate === 'function' && typeof W.Module === 'function';
  } catch (e) {
    wasm = false;
  }
  if (!wasm) out.push('wasm');
  else {
    let valid = false;
    try {
      valid = W.validate(PROBE) === true;
    } catch (e) {
      valid = false;
    }
    if (!valid) out.push('wasm-features');
    else {
      try {
        new W.Module(PROBE);
      } catch (e) {
        out.push('wasm-compile');
      }
    }
  }
  if (typeof read(win, 'BigInt64Array') !== 'function') out.push('BigInt64Array');
  if (typeof read(win, 'createImageBitmap') !== 'function') out.push('createImageBitmap');
  return out;
}

const WORDS = {
  wasm: 'WebAssembly (turned off, as in Lockdown Mode, or too old)',
  'wasm-features': 'WebAssembly exception handling (Chrome 95, Firefox 100, Safari 15.2)',
  'wasm-compile': 'WebAssembly compilation (refused: a Content-Security-Policy without \'wasm-unsafe-eval\'?)',
  BigInt64Array: 'BigInt64Array (Chrome 67, Firefox 68, Safari 15)',
  createImageBitmap: 'createImageBitmap (Chrome 50, Firefox 42, Safari 15)',
};

/**
 * The missing features in words for the console (log messages stay English).
 * @param {string[]} ids missingFeatures' result
 * @returns {string}
 */
export function describeMissing(ids) {
  return (ids || []).map(id => WORDS[id] || String(id)).join('; ');
}

/**
 * window.sumika in a browser that cannot run Sumika: the off stub's members (phone.js offApi: site and runtime null,
 * state 'off' with reason 'unsupported', start() -> 'none', lists empty, every change false), so page code never
 * throws, plus `supported: false` and the `missing` ids (frozen). Only this stub has `supported`; the live api and
 * offApi have none.
 * @param {string} version
 * @param {null|'on'|'tucked'} phone main.js's mode (null: no phone)
 * @param {string[]} missing
 */
export function unsupportedApi(version, phone, missing) {
  return Object.freeze({ ...offApi(version, { phone, reason: 'unsupported' }), supported: false, missing: Object.freeze([...missing]) });
}
