// Prepare upload's order (admin/server/upload.mjs uploadList, CLAUDE.md "What gets published", the publishing flow's
// step 7) with the control page: everything else first (the hashed control and hub scripts among it), then the
// fixed-name pages that name them, sumika/index.html (the control page) before sumika/hub.html, then sumika/sumika.js,
// and sumika/index/ghosts.json last; the control script is no optional file, its map is.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uploadList, LAST } from '../../admin/server/upload.mjs';

test('the upload order: everything else, then sumika/index.html, sumika/hub.html, sumika/sumika.js and sumika/index/ghosts.json last', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-upload-'));
  try {
    const put = rel => { const f = path.join(dir, ...rel.split('/')); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, rel); };
    for (const rel of ['404.html', 'sumika/index/ghosts.json', 'sumika/sumika.js', 'sumika/hub.html', 'sumika/index.html', 'sumika/build.json',
      'sumika/engines/control.0123456789.js', 'sumika/engines/control.0123456789.js.map', 'sumika/engines/hub.9876543210.js',
      'sumika/index/ghost.a.0123456789.json', 'ghost/a/descript.txt', 'dev/elsewhere.html']) put(rel);
    assert.deepEqual(LAST, ['sumika/index.html', 'sumika/hub.html', 'sumika/sumika.js', 'sumika/index/ghosts.json']);
    const list = uploadList(dir);
    const paths = list.map(f => f.path);
    assert.deepEqual(paths.slice(-4), [...LAST]);
    assert.ok(paths.indexOf('sumika/engines/control.0123456789.js') < paths.indexOf('sumika/index.html'), 'the script before the page naming it');
    assert.ok(!paths.some(p => p.startsWith('dev/')));
    const of = p => list.find(f => f.path === p);
    assert.equal(of('sumika/engines/control.0123456789.js').optional, undefined, 'the control script is needed');
    assert.equal(of('sumika/engines/control.0123456789.js.map').optional, 'map');
    assert.equal(of('sumika/index.html').optional, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
