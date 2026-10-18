// Tsubasa's music box on the real Satori build (TS §3.4): a dropped .mp3 reaches her as OnFileDrop2 with a pseudo-path,
// she offers Play / Loop / Playlist, and "Play Normally" calls dsaudio load ... play with that same path, which the page
// side plays from the DropStore. No worker: the engine adapter is driven directly, as in satori_integration.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SatoriEngine } from '../../src/worker/engines/satori.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { PageSaori } from '../../src/core/page-saori.js';
import { DropStore } from '../../src/core/drops.js';
import { setLogLevel } from '../../src/core/log.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, FakeWindow, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GHOST_DIR = path.join(root, 'site', 'ghost', 'tsubasa', 'ghost', 'master');
const ENGINE_JS = path.join(root, 'site', 'sumika', 'engines', 'satori.js');
const real = needs('site/sumika/engines/satori.js', 'site/ghost/tsubasa');
const GHOST = { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };

class NodeSatori extends SatoriEngine {
  async factory() { return loadEngineFactory('satori'); }
}

function engineFiles() {
  const out = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, rel + e.name + '/');
      else if (/\.(txt|dic|sat|ini|csv|aym)$/i.test(e.name) && !/^(satori_save|updates)/i.test(e.name)) {
        const b = fs.readFileSync(p);
        out.push({ path: rel + e.name, data: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) });
      }
    }
  })(GHOST_DIR, '');
  return out;
}

class InProcessShiori {
  constructor(engine) { this.engine = engine; this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' }; this.log = []; }
  async request(r) {
    const res = parseResponse(this.engine.request(buildRequest(r, this.base)));
    this.log.push({ method: r.method || 'GET', id: r.id, refs: r.refs || [], status: res.status, value: res.value });
    return res;
  }
  async unload() { return this.engine.unload(); }
  async persist() { this.engine.save(); return this.engine.changedFiles(); }
}

class FakeAudio {
  constructor(src) { this.src = src; this.paused = true; this.loop = false; this.volume = 1; this.currentTime = 0; FakeAudio.all.push(this); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  removeAttribute() { this.src = ''; }
}
FakeAudio.all = [];

test('Tsubasa: a dropped .mp3 -> OnFileDrop2 -> her play choices -> dsaudio load/play with the same path -> playback', { ...real, timeout: 120000 }, async () => {
  setLogLevel('silent');
  const drops = new DropStore({ URL: { createObjectURL: () => 'blob:song', revokeObjectURL() {} } });
  const page = new PageSaori({ files: { resolve: () => null, url: p => p }, Audio: FakeAudio, win: new FakeWindow(), drops });
  const notes = [];
  saoriBridge.notifyPage = (name, cmd, args) => { notes.push([name, cmd, args]); page.handle({ name, cmd, args }); };
  saoriBridge.log = () => {};
  const engine = new NodeSatori({ engineUrl: ENGINE_JS, ghostDir: '/ghost/master/', log: () => {}, saori: saoriBridge });
  await engine.boot();
  engine.init(engineFiles(), {}, { resume: false });
  const shiori = new InProcessShiori(engine);
  const clock = new FakeClock();
  const player = new FakePlayer();
  const stage = new FakeStage();
  const loop = new EventLoop({
    shiori, player, stage, balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost: GHOST, clock,
    state: new StateStore('tsubasa', { storage: memoryStorage(), clock }), env: { win: null, doc: null }, audio: page, drops,
    ghostDescript: new Map([['name', 'Hayama-san Next Door'], ['sakura.name', 'Tsubasa']]), site: { ghosts: [GHOST], balloons: [] },
  });
  page.host = loop;
  await loop.boot({ resume: false });
  if (player.busy) player.finish();
  await settle();

  // a comma: Satori splits （dsaudio,load,（path）） there; the stand-in joins the path again
  const song = new File([new Uint8Array(16)], 'Song A, live.mp3', { type: 'audio/mpeg', lastModified: 1700000000000 });
  stage.emit('drop', { scope: 1, files: [song], x: 10, y: 10 });
  await settle();
  const req = shiori.log.find(r => r.id === 'OnFileDrop2');
  assert.equal(req.status, 200, 'she answers OnFileDrop2');
  const p = req.refs[0];
  assert.match(p, /^C:\\sumika\\drop\\[0-9a-f]{8}\\Song A, live\.mp3$/);
  const offer = player.last.script;
  assert.match(offer, /"Song A， live"/, 'the display name: last path segment, no extension, her full-width comma');
  for (const id of ['通常再生ドロップ', 'ループ再生ドロップ', 'リスト登録']) assert.ok(offer.includes(`\\__q[${id}]`), id);
  player.finish({ hasChoices: true });
  await settle();

  notes.length = 0;
  player.emit('link', { kind: 'choice', id: '通常再生ドロップ', label: '', refs: [], scope: 0 });
  await settle();
  const sel = shiori.log.filter(r => /^OnChoiceSelect/.test(r.id)).map(r => `${r.id}:${r.status}`);
  assert.deepEqual(sel, ['OnChoiceSelectEx:204', 'OnChoiceSelect:200']);
  const ds = notes.filter(n => n[0] === 'dsaudio.dll').map(([, c, a]) => [c, ...a]);
  assert.deepEqual(ds[0], ['load', p], 'load gets the path from R0');
  assert.deepEqual(ds.find(n => n[0] === 'loop'), ['loop', 'disable']);
  assert.deepEqual(ds.at(-1), ['play']);
  assert.doesNotMatch(player.last.script, /（dsaudio/, 'SAORI calls do not leak');

  // the page plays the dropped file
  await settle();
  const a = FakeAudio.all.at(-1);
  assert.ok(a, 'an audio element was created');
  assert.equal(a.src, 'blob:song');
  assert.equal(a.paused, false);
  assert.deepEqual(page.musicState(), { path: p, currentTime: 0, loop: false, volume: page.music.volume, playing: true });
  loop.destroy();
  page.destroy();
  engine.unload();
});
