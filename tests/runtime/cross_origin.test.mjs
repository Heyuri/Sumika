// A page on another origin than the runtime's host (CORS: CLAUDE.md "Pages on other origins"): the site's thumbnails
// are site files for it (ui/thumbnail.js otherSite against the page's and the site's origins, setSiteBase), and the
// menu skin's probe asks for CORS only for an image of another origin, once more without it when that fails (ui/menu.js
// probeImage: the size alone, without the edge colour, on a host that sends no Access-Control-Allow-Origin).
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { otherSite, setSiteBase } from '../../src/ui/thumbnail.js';
import { probeImage } from '../../src/ui/menu.js';

const saved = { location: globalThis.location, Image: globalThis.Image, document: globalThis.document };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete globalThis[k]; else globalThis[k] = v; }
  setSiteBase(null);
});

test('otherSite: the page\'s origin and the site\'s (Site.base) are the site; any other origin is another site; no page: never', () => {
  const page = { href: 'https://a.example.com/blog/', origin: 'https://a.example.com' };
  setSiteBase(null);
  assert.equal(otherSite('https://a.example.com/ghost/x/thumbnail.png', page), false);
  assert.equal(otherSite('/ghost/x/thumbnail.png', page), false, 'relative');
  assert.equal(otherSite('https://sumika.example.com/ghost/x/thumbnail.png', page), true, 'no site base known: another site');
  setSiteBase('https://sumika.example.com/');
  assert.equal(otherSite('https://sumika.example.com/ghost/x/thumbnail.png?v=1', page), false, 'the runtime host\'s files are site files');
  assert.equal(otherSite('https://banner.example.org/b.png', page), true, 'a banner on the web stays another site');
  assert.equal(otherSite('http://sumika.example.com/x.png', page), true, 'another scheme is another origin');
  setSiteBase('not a url');
  assert.equal(otherSite('https://sumika.example.com/x.png', page), true);
  assert.equal(otherSite('https://x/y.png', null), false);
});

/** Image stand-in: loads unless `refuse(img)`; records crossOrigin at each src */
function fakeImages(refuse) {
  const made = [];
  globalThis.Image = class {
    constructor() { this.crossOrigin = null; made.push(this); }
    set src(u) {
      this._src = u;
      this.seen = this.crossOrigin;
      queueMicrotask(() => {
        if (refuse(this)) this.onerror && this.onerror();
        else { this.naturalWidth = 20; this.naturalHeight = 10; this.onload && this.onload(); }
      });
    }
    get src() { return this._src; }
  };
  return made;
}

test('probeImage: CORS asked only for another origin\'s image; refused (no ACAO): once more without, the size and no edge colour; same origin: no CORS asked', async () => {
  globalThis.location = { href: 'https://a.example.com/', origin: 'https://a.example.com' };
  const canvas = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData: () => ({ data: [1, 2, 3, 255] }) }) };
  const tainted = { width: 0, height: 0, getContext: () => ({ drawImage() {}, getImageData() { throw new Error('SecurityError'); } }) };
  // a host with CORS: loads with crossOrigin, the edge read
  let made = fakeImages(() => false);
  globalThis.document = { createElement: () => canvas };
  let r = await probeImage('https://sumika.example.com/ghost/x/shell/master/menu_background.png');
  assert.deepEqual(made.map(i => i.seen), ['anonymous']);
  assert.deepEqual(r, { url: 'https://sumika.example.com/ghost/x/shell/master/menu_background.png', width: 20, height: 10, edge: 'rgb(1,2,3)' });
  // a host without CORS: the CORS load fails, the plain one loads, its pixels cannot be read
  made = fakeImages(img => img.crossOrigin === 'anonymous');
  globalThis.document = { createElement: () => tainted };
  r = await probeImage('https://sumika.example.com/m.png', true);
  assert.deepEqual(made.map(i => i.seen), ['anonymous', null]);
  assert.deepEqual([r.width, r.height, r.edge], [20, 10, null]);
  // the same origin: no CORS asked, one load
  made = fakeImages(() => false);
  globalThis.document = { createElement: () => canvas };
  r = await probeImage('https://a.example.com/ghost/x/m.png');
  assert.deepEqual(made.map(i => i.seen), [null]);
  assert.equal(r.edge, 'rgb(1,2,3)');
  // a missing image: null, tried once more only when CORS was asked
  made = fakeImages(() => true);
  assert.equal(await probeImage('https://a.example.com/none.png'), null);
  assert.equal(made.length, 1);
  made = fakeImages(() => true);
  assert.equal(await probeImage('https://sumika.example.com/none.png'), null);
  assert.equal(made.length, 2);
});
