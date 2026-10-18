// Sweep over every script Tsubasa's real satori.dll produced (≈7.3k VALUE lines): the tokenizer must cover every
// character, and the player must run each script to its end against the mocks without a single failing tag.
import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenize } from '../../src/sakura/tokenizer.js';
import { setup, loadCorpus } from './mocks.mjs';
import { needs } from '../needs.mjs';

const real = needs('tests/corpus');
const corpus = real.skip ? [] : loadCorpus();

test('tokenizer: every corpus script, full coverage', real, () => {
  let ms = 0, tokens = 0, chars = 0, maxMs = 0, maxLen = 0;
  const counts = new Map();
  let unknown = 0, unterminated = 0;
  for (const { script, request } of corpus) {
    const t0 = performance.now();
    const toks = tokenize(script);
    const dt = performance.now() - t0;
    ms += dt;
    if (script.length > maxLen) { maxLen = script.length; maxMs = dt; }
    tokens += toks.length;
    chars += script.length;
    let at = 0, text = '';
    for (const t of toks) {
      assert.equal(t.pos, at, `gap before token at ${at} in ${request}`);
      assert.ok(t.end > t.pos);
      if (t.raw != null) assert.equal(t.raw, script.slice(t.pos, t.end));
      if (t.type === 'text') text += script.slice(t.pos, t.end);
      if (t.type === 'unknown') unknown++;
      if (t.unterminated) unterminated++;
      if (t.type === 'tag') counts.set(t.name, (counts.get(t.name) || 0) + 1);
      at = t.end;
    }
    assert.equal(at, script.length, `tokens cover ${request}`);
  }
  // the spec inventory (SS §1.2) for a few anchors
  assert.equal(counts.get('_b'), 262313);
  assert.equal(counts.get('__q'), 23294);
  assert.equal(counts.get('e'), 7334);
  assert.equal(counts.get('C'), 601);
  assert.equal(unknown, 0);
  console.log(`[corpus] ${corpus.length} scripts, ${(chars / 1e6).toFixed(1)}M chars, ${tokens} tokens: ` +
    `tokenize total ${ms.toFixed(0)} ms; largest (${maxLen} chars) ${maxMs.toFixed(1)} ms; unterminated ${unterminated}`);
});

test('player: every corpus script runs to its end', { ...real, timeout: 600000 }, async () => {
  const failures = [];
  const warn = console.warn;
  console.warn = (...a) => { if (String(a[1] ?? '').includes('failed')) failures.push(a.join(' ')); };
  const reasons = new Map();
  const ignored = new Set();
  const t0 = performance.now();
  try {
    for (const { script, request } of corpus) {
      const m = setup({ speedMs: 0 });
      let r = null;
      m.player.play(script, { event: request }).then(x => { r = x; });
      for (let i = 0; i < 1000 && !r; i++) {
        await m.clock.runAll();
        if (m.player.run && m.player.run.state === 'clickwait') m.balloons.emit('click', { scope: 0, button: 0 });
        else if (!r) break;
      }
      if (!r) r = { reason: 'stuck' };
      reasons.set(r.reason, (reasons.get(r.reason) || 0) + 1);
      if (r.reason === 'stuck') failures.push('stuck: ' + request);
      for (const h of m.rec.host) if (h[0] === 'unknownTag') ignored.add(h[1].slice(0, 30));
    }
  } finally {
    console.warn = warn;
  }
  console.log(`[corpus] player sweep ${(performance.now() - t0).toFixed(0)} ms, results ${JSON.stringify([...reasons])}; ` +
    `ignored kinds: ${[...ignored].join(' | ')}`);
  assert.deepEqual(failures, []);
  assert.equal((reasons.get('end') || 0) + (reasons.get('quit') || 0), corpus.length);
});
