// Freeze the clock for engine tests: FAKE_NOW=2026-10-06T02:01:00 (local time) node --import ./tests/fake_time.mjs ...
const spec = process.env.FAKE_NOW;
if (spec) {
  const RealDate = Date;
  const start = new RealDate(spec).getTime();
  const t0 = RealDate.now();
  const now = () => start + (RealDate.now() - t0);
  globalThis.Date = class extends RealDate {
    constructor(...a) { if (a.length === 0) super(now()); else super(...a); }
    static now() { return now(); }
  };
}
