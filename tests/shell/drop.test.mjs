// Files dragged onto a character (EV §4.14 OnFileDrop2): CharacterView takes only drags that carry files over an
// opaque pixel (everything else keeps the browser's and the host page's handling) and the stage emits 'drop'.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FsFiles, GHOST, nodeDecode } from './helpers.mjs';
import { needs } from '../needs.mjs';
import { carriesFiles, droppedFiles } from '../../src/shell/character.js';

class El {
  constructor(tag) { this.tagName = tag.toUpperCase(); this.style = {}; this.dataset = {}; this.children = []; this.listeners = {}; this.parentNode = null; }
  appendChild(c) { this.children.push(c); c.parentNode = this; return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
  removeEventListener(t, f) { this.listeners[t] = (this.listeners[t] || []).filter(x => x !== f); }
  attachShadow() { const r = new El('#shadow'); r.getElementById = id => r.children.find(c => c.id === id) || null; this.shadowRoot = r; return r; }
  getContext() { return { putImageData() {} }; }
  setPointerCapture() {}
  releasePointerCapture() {}
  fire(type, e) {
    const ev = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; }, ...e };
    for (const f of this.listeners[type] || []) f(ev);
    return ev;
  }
}

function installDom() {
  globalThis.document = {
    createElement: t => new El(t), body: new El('body'), documentElement: { clientWidth: 1280, clientHeight: 720 },
    hidden: false, addEventListener() {}, removeEventListener() {},
  };
  globalThis.window = { innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  globalThis.ImageData = class { constructor(data, w, h) { this.data = data; this.width = w; this.height = h; } };
}

const file = name => new File([new Uint8Array(3)], name, { lastModified: 1 });
const item = (dir = false) => ({ kind: 'file', webkitGetAsEntry: () => ({ isDirectory: dir }) });
/** DataTransfer look-alike; during dragover the files are hidden (only types). */
const dt = (types, files = [], items = null) => ({ types, files, items: items || files.map(() => item()), dropEffect: 'none' });

test('helpers: drags that carry files; folders left out of a drop', () => {
  assert.equal(carriesFiles(dt(['Files'])), true);
  assert.equal(carriesFiles(dt(['text/plain', 'text/uri-list'])), false);
  assert.equal(carriesFiles({ types: { contains: t => t === 'Files' } }), true, 'DOMStringList');
  assert.equal(carriesFiles(null), false);
  const a = file('a.mp3'), b = file('Music');
  assert.deepEqual(droppedFiles(dt(['Files'], [a, b], [item(), item(true)])), [a]);
  assert.deepEqual(droppedFiles(dt(['Files'], [a, b], [])), [a, b], 'no items: every File');
  assert.deepEqual(droppedFiles(null), []);
});

test('DOM: file drags over an opaque pixel are taken and emitted as a stage "drop"; others pass through', needs('site/ghost/tsubasa'), async () => {
  installDom();
  const { Stage } = await import('../../src/shell/stage.js');
  const frames = [];
  const clock = { now: () => 0, requestFrame: f => frames.push(f), setTimeout: () => 0, clearTimeout: () => {} };
  const stage = await Stage.create({ files: new FsFiles(GHOST), decode: nodeDecode, clock, random: () => 0.99 });
  for (let i = 0; i < 30; i++) {
    for (const f of frames.splice(0)) f(0);
    await new Promise(r => setImmediate(r));
  }
  const cv = stage.char(0).element.children[0];
  const drops = [];
  stage.on('drop', e => drops.push(e));
  const at = (x, y, dataTransfer) => ({ clientX: 1060 + x, clientY: 340 + y, dataTransfer });   // as in dom.test.mjs

  // nobody receives drops yet (engine loading without the runtime's hold, closed): the browser keeps them
  assert.equal(stage.acceptsDrops, false);
  assert.ok(!cv.fire('dragover', at(100, 30, dt(['Files']))).prevented);
  const early = cv.fire('drop', at(100, 30, dt(['Files'], [file('a.mp3')])));
  assert.ok(!early.prevented && !early.stopped);
  assert.equal(drops.length, 0);
  stage.acceptsDrops = true;

  const over = cv.fire('dragover', at(100, 30, dt(['Files'])));
  assert.ok(over.prevented, 'files over her head: accepted');
  assert.equal(over.dataTransfer.dropEffect, 'copy');
  assert.ok(!over.stopped, 'the page still sees its dragover');
  assert.ok(cv.fire('dragenter', at(100, 30, dt(['Files']))).prevented);
  assert.ok(!cv.fire('dragover', at(1, 1, dt(['Files']))).prevented, 'transparent pixel: not ours');
  assert.ok(!cv.fire('dragover', at(100, 30, dt(['text/plain']))).prevented, 'text and links: not ours');

  const a = file('Song A.mp3');
  const d = cv.fire('drop', at(100, 30, dt(['Files'], [a, file('Folder')], [item(), item(true)])));
  assert.ok(d.prevented && d.stopped, 'the browser does not open the file, the page does not get it');
  assert.equal(drops.length, 1);
  assert.deepEqual(drops[0], { scope: 0, files: [a], x: 100, y: 30 });

  const text = cv.fire('drop', at(100, 30, dt(['text/plain'])));
  assert.ok(!text.prevented && !text.stopped);
  const miss = cv.fire('drop', at(1, 1, dt(['Files'], [a])));
  assert.ok(!miss.prevented && !miss.stopped);
  const folders = cv.fire('drop', at(100, 30, dt(['Files'], [file('Folder')], [item(true)])));
  assert.ok(folders.prevented, 'still ours, but nothing to report');
  assert.equal(drops.length, 1);

  // the surface changed under an accepted drag (now transparent there): still ours, or the browser opens the file
  assert.ok(cv.fire('dragover', at(100, 30, dt(['Files']))).prevented);
  const moved = cv.fire('drop', at(1, 1, dt(['Files'], [a])));
  assert.ok(moved.prevented && moved.stopped);
  assert.equal(drops.length, 2);
  assert.deepEqual(drops[1], { scope: 0, files: [a], x: 1, y: 1 });
  // ... but not after the drag left her
  cv.fire('dragover', at(100, 30, dt(['Files'])));
  cv.fire('dragleave', at(100, 30, dt(['Files'])));
  assert.ok(!cv.fire('drop', at(1, 1, dt(['Files'], [a]))).prevented);
  assert.equal(drops.length, 2);
  stage.destroy();
});
