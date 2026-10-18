// src/core/runtime.js: file drops before an event loop can take them (engine loading, a frozen tab) are held and
// handed over once the ghost has booted (EV §4.14), so they neither vanish nor make the browser open the file; a drop
// on a frozen tab's ghost takes her over (a drag from the desktop does not focus the window).
import test from 'node:test';
import assert from 'node:assert/strict';
import { Runtime, HELD_DROP_MS } from '../../src/core/runtime.js';
import { Emitter } from '../../src/core/emitter.js';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('silent');

class FakeStage extends Emitter {
  constructor() { super(); this.acceptsDrops = false; this.destroyed = false; }
  destroy() { this.destroyed = true; }
}
const info = { scope: 1, files: [new File([new Uint8Array(2)], 'a.mp3')], x: 1, y: 2 };
const make = (R = Runtime) => new R({ base: 'http://s/', runtimeUrl: 'http://s/sumika/sumika.js' });

test('a drop while the engine loads is held, then handed to the booted event loop; stale ones are not', () => {
  const rt = make();
  const stage = new FakeStage();
  const loop = { booted: false };
  rt.parts = { stage, loop };
  const got = [];
  stage.on('drop', i => { if (loop.booted) got.push(i); });     // the event loop's own listener
  rt._holdDrops(stage);
  assert.equal(stage.acceptsDrops, true, 'characters take the drag');
  stage.emit('drop', info);
  assert.equal(got.length, 0);
  loop.booted = true;
  rt._deliverHeldDrop(stage);
  assert.deepEqual(got, [info]);
  stage.emit('drop', info);                                      // booted: the loop takes it, nothing is held
  assert.equal(rt._heldDrop, null);
  assert.equal(got.length, 2);
  loop.booted = false;
  stage.emit('drop', info);
  rt._heldDrop.at -= HELD_DROP_MS + 1;
  loop.booted = true;
  rt._deliverHeldDrop(stage);
  assert.equal(got.length, 2, 'too old to deliver');
});

test('a frozen tab (another tab has the ghost): a drop takes the ghost over and is delivered after the boot', async () => {
  const calls = [];
  class T extends Runtime {
    async _ghostCommon() { return { files: {}, ghostDescript: new Map(), shellId: 'master' }; }
    async _createStage() { return new FakeStage(); }
    async start() { calls.push('start'); }                       // the takeover's boot
  }
  const rt = make(T);
  rt.state = { readOnly: false, data: {}, reload() { calls.push('reload'); } };
  rt.lock = { requestTakeover() { calls.push('request'); }, async acquire() { calls.push('acquire'); return true; } };
  await rt._startFrozen();
  const frozen = rt.frozen;
  assert.equal(frozen.acceptsDrops, true);
  assert.deepEqual(calls, [], 'no document here: nothing else asks for the ghost');
  frozen.emit('drop', info);
  await new Promise(r => setImmediate(r));
  assert.deepEqual(calls, ['request', 'acquire', 'reload', 'start']);
  assert.ok(frozen.destroyed, 'the frozen stage made way');
  const booted = new FakeStage();
  const got = [];
  booted.on('drop', i => got.push(i));
  rt._deliverHeldDrop(booted);
  assert.deepEqual(got, [info]);
});
