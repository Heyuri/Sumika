// Shared fixture: Tsubasa's ghost folder, her LightBlue skin and a headless Balloons.
import { DiskFiles, TSUBASA } from './node_helpers.mjs';
import { BalloonSkin } from '../../src/balloon/skin.js';
import { Balloons } from '../../src/balloon/manager.js';
import { scanImagePaths } from '../../src/balloon/images.js';
import { play, tokenize } from './script.mjs';
import { setLogLevel } from '../../src/core/log.js';

setLogLevel('error');

let cached = null;

/** Ghost files + LightBlue skin, loaded once per test file. */
export async function fixture() {
  if (cached) return cached;
  const ghost = new DiskFiles(TSUBASA);
  const skin = await BalloonSkin.load(ghost.sub('LightBlue'), { decode: false });
  cached = { ghost, skin };
  return cached;
}

/**
 * A fresh headless Balloons over Tsubasa's files, plus a run(script) helper that lays a script out.
 * Layout as in SSP: word wrap on (BA §3.5) unless opts.options says otherwise.
 */
export async function makeBalloons(opts = {}) {
  const { ghost, skin } = await fixture();
  const stage = opts.stage || null;
  const options = { wordWrap: true, ...(opts.options || {}) };
  const b = new Balloons({ skin, ghostFiles: ghost, root: null, stage, ghostDescript: new Map(), options });
  b.images.decode = false;
  async function run(script, o = {}) {
    await b.images.prefetch(scanImagePaths(script));
    return play(b, script, o);
  }
  return { balloons: b, run, skin, ghost, tokenize };
}

/** Elements of a scope's layout, with balloon-space coordinates added (bx, by). */
export function laid(b, scope = 0) {
  const e = b.get(scope).engine, g = e.geo;
  return e.elements.map(el => ({ ...el, bx: el.t === 'p' ? el.x : g.originX + el.x, by: el.t === 'p' ? el.y : g.originY + el.y + el.dy }));
}
