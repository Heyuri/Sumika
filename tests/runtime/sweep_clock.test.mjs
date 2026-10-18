// The ghost sweep's clock (tools/sweep/clock.mjs, docs/research/ghost-sweep.md "The clock"): --clock's values, and a
// process whose Date and performance.now follow the sweep's clock, so two sweep runs see the same time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_START, localMs, localText, parseClock, fixProcessClock } from '../../tools/sweep/clock.mjs';

test('--clock: fixed by default (2026-10-07 20:00:00 local), another local start, or real', () => {
  const start = new Date(2026, 9, 7, 20, 0, 0).getTime();
  assert.equal(DEFAULT_START, '2026-10-07T20:00:00');
  for (const v of [undefined, '', 'fixed', 'FIXED']) {
    assert.deepEqual(parseClock(v), { fixed: true, start, label: 'fixed 2026-10-07T20:00:00' });
  }
  // real: the page side keeps the fixed start (the earlier sweep's clocks)
  assert.deepEqual(parseClock('real'), { fixed: false, start, label: 'real' });
  assert.deepEqual(parseClock('2026-10-07T19:55'), { fixed: true, start: new Date(2026, 9, 7, 19, 55, 0).getTime(),
    label: 'fixed 2026-10-07T19:55:00' });
  assert.equal(parseClock('2027-01-01').start, new Date(2027, 0, 1).getTime());
  assert.equal(parseClock('2026-10-07 23:59:30').label, 'fixed 2026-10-07T23:59:30');
  for (const bad of ['now', '2026-02-30', '2026-10-07T24:00', '2026-13-01', '07/10/2026', '2026-10-07T20']) {
    assert.throws(() => parseClock(bad), /--clock/, bad);
  }
  assert.equal(localMs('2026-02-29'), null);
  assert.equal(localText(start), '2026-10-07T20:00:00');
});

test('fixProcessClock: Date and performance.now follow the clock, in whole ms; statics, instanceof, restore', () => {
  const RealDate = Date;
  const realPerf = performance.now;
  const clock = { t: new RealDate(2026, 9, 7, 20, 0, 0).getTime(), now() { return this.t; } };
  const restore = fixProcessClock(clock);
  try {
    assert.equal(Date.now(), clock.t);
    assert.equal(new Date().getTime(), clock.t);
    assert.equal(Date(), new RealDate(clock.t).toString());
    assert.equal(new Date().getHours(), 20);
    assert.equal(performance.now(), 1000);
    // the clock stands still until it is advanced, then everything moves with it
    clock.t += 60000.5;
    assert.equal(Date.now(), clock.t - 0.5);
    assert.equal(new Date().getMinutes(), 1);
    assert.equal(performance.now(), 61000.5);
    // a date with arguments is the same date as before; the statics and instanceof stay
    assert.equal(new Date(2000, 0, 2).getTime(), new RealDate(2000, 0, 2).getTime());
    assert.equal(new Date(0).toISOString(), '1970-01-01T00:00:00.000Z');
    assert.equal(Date.UTC(2026, 9, 7), RealDate.UTC(2026, 9, 7));
    assert.equal(Date.parse('2026-10-07T00:00:00Z'), RealDate.parse('2026-10-07T00:00:00Z'));
    assert.ok(new Date() instanceof RealDate);
    assert.ok(new RealDate() instanceof Date);
    assert.ok(Number.isNaN(new Date(undefined).getTime()));
    class Sub extends Date {}
    assert.equal(new Sub().getTime(), Date.now());
    assert.ok(new Sub() instanceof Sub);
  } finally {
    restore();
  }
  assert.equal(globalThis.Date, RealDate);
  assert.equal(performance.now, realPerf);
  assert.ok(Math.abs(Date.now() - new RealDate().getTime()) < 1000);
  assert.ok(Object.prototype.hasOwnProperty.call(performance, 'now') === false);
});
