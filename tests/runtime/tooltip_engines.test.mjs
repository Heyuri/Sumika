// Tooltips through the real engines (UI §4.8): the event loop's tipSource hooks against Tsubasa on the Satori build and
// emily4 on the YAYA build (engine adapters in-process, no worker), with the References SSP sends. The texts
// ssp.exe shows: Tsubasa's dress-up icon "Monochrome Winter Outfit (Mini) + Tights", emily4's "■なんか話して■" /
// "みんなでおしゃべりします。" on two lines.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SatoriEngine } from '../../src/worker/engines/satori.js';
import { YayaEngine } from '../../src/worker/engines/yaya.js';
import { saoriBridge } from '../../src/worker/saori/index.js';
import { yayaFilePlan } from '../../src/core/engine-files.js';
import { GhostFiles } from '../../src/core/loader.js';
import { buildRequest, parseResponse } from '../../src/core/shiori.js';
import { EventLoop } from '../../src/core/events.js';
import { StateStore, memoryStorage } from '../../src/core/state.js';
import { loadEngineFactory } from '../load_engine.mjs';
import { FakeClock, FakePlayer, FakeStage, FakeBalloons, FakeDialogs, settle } from './fakes.mjs';
import { needs } from '../needs.mjs';

globalThis.self = globalThis.self || { postMessage() {} };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SATORI_JS = path.join(root, 'site', 'sumika', 'engines', 'satori.js');
const YAYA_JS = path.join(root, 'site', 'sumika', 'engines', 'yaya.js');
const TSUBASA = path.join(root, 'site', 'ghost', 'tsubasa');
const EMILY = path.join(root, 'site', 'ghost', 'emily4');

class NodeSatori extends SatoriEngine { async factory() { return loadEngineFactory('satori'); } }
class NodeYaya extends YayaEngine { async factory() { return loadEngineFactory('yaya'); } }

/** ShioriClient look-alike around an in-process engine. */
class InProcessShiori {
  constructor(engine) {
    this.engine = engine;
    this.base = { Charset: 'UTF-8', Sender: 'SSP', SenderType: 'internal', SecurityLevel: 'local' };
    this.log = [];
  }
  async request(r) {
    const res = parseResponse(this.engine.request(buildRequest(r, this.base)));
    this.log.push({ method: r.method || 'GET', id: r.id, refs: (r.refs || []).map(String), status: res.status, value: res.value });
    return res;
  }
  async unload() { return this.engine.unload(); }
  async persist() { return []; }
}

function walk(dir, rel = '', out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), rel + e.name + '/', out);
    else out.push([rel + e.name, fs.statSync(path.join(dir, e.name)).size]);
  }
  return out;
}
const bytesOf = p => { const b = fs.readFileSync(p); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); };

async function bootLoop(shiori, ghost) {
  const clock = new FakeClock();
  const player = new FakePlayer();
  const loop = new EventLoop({
    shiori, player, stage: new FakeStage(), balloons: new FakeBalloons(), dialogs: new FakeDialogs(), ghost, clock,
    state: new StateStore(ghost.id, { storage: memoryStorage(), clock }), env: { win: null, doc: null },
    ghostDescript: new Map([['name', ghost.name], ['sakura.name', ghost.sakuraName]]), site: { ghosts: [ghost], balloons: [] },
  });
  await loop.boot({ resume: false, firstBoot: true });
  if (player.busy) player.finish();
  await settle();
  shiori.log.length = 0;
  return { loop, player };
}

test('Tsubasa (Satori): dress-up icon, main-menu icon and two-line tips, her \\p[99] panel; choice and anchor hover / enter events answer 204', { ...needs('site/sumika/engines/satori.js', 'site/ghost/tsubasa'), timeout: 120000 }, async () => {
  const dir = path.join(TSUBASA, 'ghost', 'master');
  const files = walk(dir).filter(([p]) => /\.(txt|dic|sat|ini|csv|aym)$/i.test(p) && !/^(satori_save|updates)/i.test(path.basename(p)))
    .map(([p]) => ({ path: p, data: bytesOf(path.join(dir, p)) }));
  const e = new NodeSatori({ engineUrl: SATORI_JS, ghostDir: '/ghost/master/', log: () => {}, saori: saoriBridge });
  await e.boot();
  e.init(files, {}, { resume: false });
  const shiori = new InProcessShiori(e);
  const ghost = { id: 'tsubasa', name: 'Hayama-san Next Door', sakuraName: 'Tsubasa', keroName: '', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
  const { loop, player } = await bootLoop(shiori, ghost);
  const tip = (id, label = '', refs = [], kind = 'choice') => loop.balloons.tipSource({ scope: 0, kind, id, refs, label });
  // \__q[ID]\_b[icon,inline]\__q: R0 is empty, R1 the raw ID
  assert.equal(await tip('冬服白黒ミニタイツ着せ替えメニュー'), 'Monochrome Winter Outfit (Mini) + Tights');
  assert.equal(await tip('何か話して'), 'Random talk');
  // Satori's own \q form: the ID carries \x01label\x01N (she splits it herself)
  assert.equal(await tip('何か話して\x01Say Something\x011', 'Say Something'), 'Random talk');
  assert.equal(await tip('音楽ファイル名調整'), 'Automatically shortens file names to fit\nTurn this OFF if the display is slow');
  assert.equal(await tip('On再生リスト削除', '', ['3']), 'Delete song');
  assert.equal(await tip('no such id'), null);
  assert.equal(await tip('http://example.com/', 'example', [], 'anchor'), null, 'an anchor: OnAnchorHover, no text');
  const panel = await loop.stage.tipSource({ scope: 99, collision: 'Mmenu', x: 10, y: 20, fresh: true, device: 'mouse' });
  assert.equal(panel, 'Show menu');
  assert.equal(await loop.stage.tipSource({ scope: 0, collision: 'Head', x: 10, y: 20, fresh: true }), null);
  const hover = shiori.log.filter(r => /^On(Choice|Anchor|Mouse)Hover$/.test(r.id));
  assert.ok(hover.length >= 9 && hover.every(r => r.status === 204), 'OnChoiceHover / OnAnchorHover / OnMouseHover: 204');
  assert.deepEqual(hover.filter(r => r.id === 'OnAnchorHover').map(r => r.refs), [['example', 'http://example.com/']]);
  assert.deepEqual(shiori.log.filter(r => r.id === 'balloon_tooltip')[0].refs, ['', '冬服白黒ミニタイツ着せ替えメニュー']);
  assert.deepEqual(shiori.log.find(r => r.id === 'tooltip').refs, ['10', '20', '0', '99', 'Mmenu', '0']);
  // OnChoiceEnter / OnAnchorEnter on entering and leaving: 204, nothing plays
  const before = player.plays.length;
  loop.balloons.emit('select', { scope: 0, index: 0, prev: -1, cause: 'move', info: { kind: 'choice', id: '何か話して\x01Say Something\x011', refs: [], label: 'Say Something' } });
  loop.balloons.emit('select', { scope: 0, index: 1, prev: 0, cause: 'move', info: { kind: 'anchor', id: 'http://example.com/', refs: [], label: 'example' } });
  loop.balloons.emit('select', { scope: 0, index: -1, prev: 1, cause: 'move', info: null });
  await settle();
  assert.deepEqual(shiori.log.filter(r => /Enter$/.test(r.id)).map(r => `${r.method} ${r.id} ${r.status}`),
    ['GET OnChoiceEnter 204', 'NOTIFY OnChoiceEnter 204', 'GET OnAnchorEnter 204', 'GET OnChoiceEnter 204']);
  assert.equal(player.plays.length, before);
});

test('emily4 (YAYA): her menu items\' two-line tips with R0 = the padded label, URL and word anchors', { ...needs('site/ghost/emily4'), timeout: 120000 }, async () => {
  assert.ok(fs.existsSync(YAYA_JS), 'site/sumika/engines/yaya.js is missing: run python engines/yaya/build.py');
  assert.ok(fs.existsSync(path.join(EMILY, 'ghost', 'master')), 'site/ghost/emily4 is missing');
  const plan = yayaFilePlan(new GhostFiles('mem:/', walk(EMILY)));
  const files = plan.bytes.map(p => ({ path: p, data: bytesOf(path.join(EMILY, p)) }));
  const e = new NodeYaya({
    engineUrl: YAYA_JS, log: () => {}, saori: saoriBridge,
    opts: { module: 'yaya', ghostId: 'emily4', placeholders: plan.placeholders, site: { ghosts: [], balloons: [] }, lang: 'ja-JP' },
  });
  await e.boot();
  assert.equal(e.init(files, {}, { resume: false, bootEpochMs: Date.now() }), true);
  const shiori = new InProcessShiori(e);
  const ghost = { id: 'emily4', name: 'Emily/Phase4.5', sakuraName: 'Emily', keroName: 'Teddy', engine: 'yaya', module: 'yaya', defaultShell: 'master', shells: [{ id: 'master', name: 'master' }] };
  const { loop } = await bootLoop(shiori, ghost);
  // her main menu as she draws it (\q[label,ID]): the label as given, padding included
  const menu = await shiori.request({ method: 'GET', id: 'OnChoiceSelect', refs: ['MAINMENU'] });
  const items = [...String(menu.value || '').matchAll(/\\q\[([^\]]*)\]/g)].map(m => {
    const a = m[1].split(',');
    return { label: a.slice(0, -1).join(','), id: a[a.length - 1] };
  });
  const ai = items.find(i => i.id === 'AITALK');
  assert.ok(ai && /^なんか話して\s+$/.test(ai.label), 'her menu pads the label: ' + JSON.stringify(ai));
  const tip = (id, label, refs = [], kind = 'choice') => loop.balloons.tipSource({ scope: 0, kind, id, refs, label });
  assert.equal(await tip('AITALK', ai.label), '■なんか話して■\nみんなでおしゃべりします。', 'the tip ssp.exe shows');
  assert.equal(await tip('AITALK', ''), '■■\nみんなでおしゃべりします。', 'R0 must be the label');
  assert.equal(await tip('http://example.com/', 'link', [], 'anchor'), 'URLをブラウザで開く : http://example.com/');
  assert.equal(await tip('OnAnchorWordExec', 'word', ['x'], 'anchor'), '解説：x');
  assert.deepEqual(shiori.log.filter(r => /Hover$/.test(r.id)).map(r => `${r.id} ${r.status}`),
    ['OnChoiceHover 204', 'OnChoiceHover 204', 'OnAnchorHover 204', 'OnAnchorHover 204']);
  assert.equal(await loop.stage.tipSource({ scope: 0, collision: 'Head', x: 10, y: 20, fresh: true }), null, 'no shell tips in her template');
  loop.balloons.emit('select', { scope: 0, index: 0, prev: -1, cause: 'move', info: { kind: 'choice', id: 'AITALK', refs: [], label: ai.label } });
  loop.balloons.emit('select', { scope: 0, index: 1, prev: 0, cause: 'move', info: { kind: 'anchor', id: 'OnAnchorWordExec', refs: ['x'], label: 'word' } });
  loop.balloons.emit('select', { scope: 0, index: -1, prev: 1, cause: 'move', info: null });
  await settle();
  assert.deepEqual(shiori.log.filter(r => /Enter$/.test(r.id)).map(r => `${r.method} ${r.id} ${r.status}`),
    ['GET OnChoiceEnter 204', 'NOTIFY OnChoiceEnter 204', 'GET OnAnchorEnter 204', 'GET OnChoiceEnter 204']);
});
