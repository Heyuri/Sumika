// Fast-forward replay on real scripts: snapshot a corpus script half-way, replay it into fresh mocks, and check that
// the display matches the original run at the saved point and at the end (SS §7, SUM C5).
import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, loadCorpus, displayLog } from './mocks.mjs';
import { needs } from '../needs.mjs';

const real = needs('tests/corpus');
const corpus = real.skip ? [] : loadCorpus();
const STRIDE = 8;

async function toEnd(m) {
  for (let i = 0; i < 1000; i++) {
    await m.clock.runAll();
    if (m.player.run && m.player.run.state === 'clickwait') m.balloons.emit('click', { button: 0 });
    else break;
  }
}

const texts = m => [...m.balloons.views].filter(([, v]) => v.text).map(([s, v]) => [s, v.text]).sort((a, b) => a[0] - b[0]);

test('replay matches the original run on sampled corpus scripts', { ...real, timeout: 600000 }, async () => {
  let n = 0, states = {};
  const t0 = performance.now();
  for (let i = 0; i < corpus.length; i += STRIDE) {
    const { script, request } = corpus[i];
    // 1. how long does the whole script take?
    const full = setup();
    full.player.play(script, { event: request });
    await toEnd(full);
    const T = full.clock.now();
    // 2. stop half-way
    const a = setup();
    a.player.play(script, { event: request });
    await a.clock.advance(Math.floor(T / 2));
    const rs = a.player.runState();
    if (!rs) continue;
    states[rs.state] = (states[rs.state] || 0) + 1;
    // 3. replay
    const b = setup();
    b.player.replay(JSON.parse(JSON.stringify(rs)));
    if (rs.state === 'clickwait') await b.clock.advance(0);
    assert.deepEqual(displayLog(b.rec.log), displayLog(a.rec.log), `display of ${request} at ${Math.floor(T / 2)} ms`);
    // 4. both end with the same balloons
    await toEnd(a);
    await toEnd(b);
    assert.deepEqual(texts(b), texts(a), `final text of ${request}`);
    assert.equal(b.player.choosing, a.player.choosing);
    n++;
  }
  console.log(`[replay] ${n} scripts checked in ${(performance.now() - t0).toFixed(0)} ms, saved states ${JSON.stringify(states)}`);
  assert.ok(n > 500);
});
