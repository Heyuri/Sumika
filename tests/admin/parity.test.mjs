// Parity of the admin core with tools/index_site.py and tools/add_ghost.py, the fast subset (the full run: npm run
// parity, admin/parity.mjs): each scenario runs the Python tool and the JS port (admin/cli.mjs) on the same input, each
// into its own scratch site, and compares the two sites file by file (every byte; a pack by its name and gunzipped
// content: Node's zlib deflates otherwise), the exit statuses, and what each printed (site paths and gzip sizes
// aside). Inputs: the fixture ghosts, an SSP-like layout with a balloon SSP moved, synthetic archives (CP932 names, a
// profile/ folder, saves, a DLL, a Kawari save an archive ships), refusals of each kind, --keep and --skip, a replace
// and a removal. Runs Python (`python -I -B`; PYTHON names another interpreter): no Python is a failure.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parityIndex, parityAdd, parityRemove, makeSite, py, js, compareTrees, slug } from '../../admin/parity.mjs';
import { crc32 } from '../../tools/sweep/zip.mjs';
import { makeZip } from './zipmake.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURES = path.join(ROOT, 'tests', 'fixtures', 'ghost');
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-parity-'));
after(() => fs.rmSync(work, { recursive: true, force: true }));
const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const same = r => assert.ok(r.ok, `${r.name}:\n${(r.problems || []).join('\n')}`);
const fixtureSite = dir => makeSite(dir, Object.fromEntries(fs.readdirSync(FIXTURES).map(g => [g, path.join(FIXTURES, g)])));
const base = makeSite(path.join(work, 'base'), {});

test('index: the fixture ghosts give the same names and bytes from both tools, and each keeps the other\'s files', async () => {
  const site = fixtureSite(path.join(work, 'fixtures'));
  const r = await parityIndex('index', site, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  assert.ok(r.files >= 15 && r.packs === 5, JSON.stringify(r));
  // each tool on the other's output: nothing written (a pack of the same content is kept, whichever zlib wrote it)
  const [a, b] = r.sites;
  const stamp = d => fs.readdirSync(path.join(d, 'sumika', 'index')).map(n => [n, fs.statSync(path.join(d, 'sumika', 'index', n)).mtimeMs]);
  const before = [stamp(a), stamp(b)];
  await new Promise(res => setTimeout(res, 20));
  assert.equal((await js(['index', a])).status, 0);
  assert.equal(py([path.join(ROOT, 'tools', 'index_site.py'), b]).status, 0);
  assert.deepEqual([stamp(a), stamp(b)], before);
});

test('index: ghosts.json lists the ghosts in ssp.exe\'s Change ghost ▸ order from both tools; a bundled balloon\'s folder id still goes to the first ghost by id', async () => {
  // 23 ghosts by folder and descript name, in ssp.exe's menu order (from a screenshot)
  const shot = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'ssp-ghost-order.json'), 'utf8')).ghosts;
  const site = makeSite(path.join(work, 'order'), {});
  const ghost = (id, name) => put(path.join(site, 'ghost', id, 'ghost', 'master', 'descript.txt'), `charset,UTF-8\r\nname,${name}\r\n`);
  for (const g of shot) ghost(g.id, g.name);
  // aaa sorts last by name, zzz first: both bundle a balloon in folder `shared`, which aaa's wins (id order)
  ghost('aaa', '龍');
  ghost('zzz', '0 first');
  for (const id of ['aaa', 'zzz']) put(path.join(site, 'ghost', id, 'shared', 'descript.txt'), `charset,UTF-8\r\ntype,balloon\r\nname,${id}'s\r\n`);
  // ghosts.json `versions` names the thumbnails in the order the ghosts are listed
  const png = fs.readFileSync(path.join(FIXTURES, 'testghost', 'shell', 'master', 'surface0.png'));
  for (const id of ['aaa', 'pit', 'zzz']) put(path.join(site, 'ghost', id, 'thumbnail.png'), png);
  const r = await parityIndex('order', site, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  for (const s of r.sites) {
    const idx = JSON.parse(fs.readFileSync(path.join(s, 'sumika', 'index', 'ghosts.json'), 'utf8'));
    assert.deepEqual(idx.ghosts.map(g => g.id), ['zzz', ...shot.map(g => g.id), 'aaa'], s);
    assert.deepEqual(idx.balloons.filter(b => b.id === 'shared').map(b => [b.ghost, b.name]), [['aaa', "aaa's"]], s);
    assert.deepEqual(Object.keys(idx.manifests.ghost), Object.keys(idx.manifests.ghost).sort(), 'the manifests by id');
    assert.deepEqual(Object.keys(idx.versions), ['zzz', 'pit', 'aaa'].map(id => `ghost/${id}/thumbnail.png`));
  }
  // printed alike by both (the parity above); once more from the JS tool, which writes nothing new
  assert.match((await js(['index', r.sites[1]])).stdout, /^ {2}zzz\/shared: not listed for other ghosts, the folder id is taken$/m);
});

test('add from folders: an archive comparison that refuses, --keep and --skip, Kawari\'s save header, a replace', async () => {
  const yaya = path.join(FIXTURES, 'yayatest');
  const dau = path.join(yaya, 'updates2.dau');
  let r = await parityAdd('refused', { src: yaya, archive: dau, base }, work);
  same(r);
  assert.equal(r.status.join(), '1,1');
  assert.equal(r.refusal.length, 8);
  r = await parityAdd('keep-skip', { src: yaya, archive: dau, base,
    keep: ['readme.txt', 'ghost/master/descript.txt', 'GHOST\\master\\dic\\base.dic', 'ghost/master/dic/events.dic', 'shell/master/descript.txt'],
    skip: ['ghost/master/data/shipped.txt', 'ghost\\master\\dic\\memo.dic', '/shell/master/surface0.png'] }, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  assert.equal(fs.existsSync(path.join(r.sites[1], 'ghost', 'yayatest', 'shell', 'master', 'surface0.png')), false);

  const kawari = path.join(work, 'src', 'kawaritest');
  fs.cpSync(path.join(FIXTURES, 'kawaritest'), kawari, { recursive: true });
  put(path.join(kawari, 'ghost', 'master', 'save.txt'), '#\r\n# Kawari saved file\r\n#\r\nname : x\r\n');
  r = await parityAdd('kawari-save', { src: kawari, base }, work);
  same(r);
  assert.deepEqual(r.refusal, ['ghost/master/save.txt']);
  r = await parityAdd('kawari-skip', { src: kawari, base, skip: ['ghost/master/save.txt'] }, work);
  same(r);
  assert.equal(r.status.join(), '0,0');

  r = await parityAdd('testghost-twice', { src: path.join(FIXTURES, 'testghost'), base, times: 2 }, work);
  same(r);
});

test('add from an SSP layout: the balloon SSP moved is copied in; a re-copy that would lose a bundled balloon is refused', async () => {
  const ssp = path.join(work, 'ssp');
  const g = path.join(ssp, 'ghost', 'G1');
  fs.cpSync(path.join(FIXTURES, 'testghost'), g, { recursive: true });
  put(path.join(g, 'install.txt'), 'type,ghost\r\ndirectory,G1\r\nballoon.directory,bal\r\nrefreshundeletemask,dic01_test.txt:nothing.txt\r\n');
  put(path.join(g, 'ghost', 'master', 'satori_savedata.txt'), 'a save');
  put(path.join(g, 'ghost', 'master', 'profile', 'ghost.dat'), 'a profile');
  put(path.join(g, 'Thumbs.db'), 'x');
  put(path.join(g, 'ghost', 'master', 'var', 'bonsyou_now.txt'), 'PERSONAL_PATHS');
  put(path.join(g, 'empty', '.keep'), '');
  fs.rmSync(path.join(g, 'empty', '.keep'));
  const b = path.join(ssp, 'balloon', 'bal');
  put(path.join(b, 'descript.txt'), 'charset,UTF-8\r\ntype,balloon\r\nname,Bal\r\n');
  put(path.join(b, 'balloons0.png'), fs.readFileSync(path.join(FIXTURES, 'testghost', 'shell', 'master', 'surface0.png')));
  put(path.join(b, 'thumbnail.png'), fs.readFileSync(path.join(FIXTURES, 'testghost', 'shell', 'master', 'surface0.png')));
  let r = await parityAdd('ssp-layout', { src: g, base, times: 2 }, work);
  same(r);
  assert.ok(fs.existsSync(path.join(r.sites[0], 'ghost', 'G1', 'bal', 'balloons0.png')));
  assert.ok(fs.existsSync(path.join(r.sites[1], 'ghost', 'G1', 'empty')), 'an empty folder too');

  // the site copy holds a bundled balloon the source lacks: both refuse, nothing changes
  const site = path.join(work, 'lose-base');
  fs.cpSync(r.sites[0], site, { recursive: true });
  fs.renameSync(path.join(site, 'ghost', 'G1', 'bal'), path.join(site, 'ghost', 'G1', 'other'));
  r = await parityAdd('lose', { src: g, base: site }, work);
  same(r);
  assert.equal(r.status.join(), '1,1');
  assert.deepEqual(compareTrees(r.sites[1], site).diffs.filter(d => !d.path.startsWith('sumika')), []);
});

test('add from archives: CP932 names, folders, personal files and DLLs', async () => {
  const nar = put(path.join(work, 'arc', 'g.nar'), makeZip([
    { name: 'pre/install.txt', data: 'type,ghost\r\ndirectory,Arc\r\nrefreshundeletemask,savedata.txt\r\n' },
    { name: 'pre/ghost/master/descript.txt', data: 'charset,UTF-8\r\nname,Arc\r\nshiori,satori.dll\r\n' },
    { name: 'pre/ghost/master/dic.txt', data: '*OnBoot\r\n:hi\r\n' },
    { name: 'pre/ghost/master/satori_savedata.txt', data: 'a save' },
    { name: 'pre/ghost/master/satori.dll', data: 'MZ' },
    { name: 'pre/ghost/master/profile/', method: 0 },
    { name: 'pre/ghost/master/profile/x.txt', data: 'profile' },
    { name: Buffer.from([0x70, 0x72, 0x65, 0x2f, 0x95, 0x5c, 0x2f, 0x83, 0x5c, 0x2e, 0x74, 0x78, 0x74]), data: 'CP932 folder and file' },
    { name: 'pre/shell/master/descript.txt', data: 'name,master\r\n' },
    { name: 'pre/shell/master/surface0.png', data: fs.readFileSync(path.join(FIXTURES, 'testghost', 'shell', 'master', 'surface0.png')), method: 0 },
    { name: 'pre/empty/', method: 0 },
    { name: 'pre/logs/x.log', data: 'log' },
    { name: 'stray.txt', data: 'outside the ghost root' },
  ]));
  let r = await parityAdd('archive', { src: nar, id: 'arc', base }, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  assert.equal(r.prefix, 'pre/');
  assert.ok(fs.existsSync(path.join(r.sites[1], 'ghost', 'arc', 'logs')), 'the folder of a left-out log');
});

test('a Kawari ghost from its archive: its save-header files kept and recorded alike (sumika/kawari-shipped.json byte for byte); from a folder, compared with that archive or not, refused; a replace, a removal and a changed file', async () => {
  const members = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else members.push({ name: rel + e.name, data: fs.readFileSync(path.join(d, e.name)) });
    }
  })(path.join(FIXTURES, 'kawaritest'), '');
  const head = '#\r\n# Kawari saved file\r\n#\r\n';
  const saves = { 'ghost/master/default.txt': `${head}counter : 0\r\n`, 'ghost/master/sub/Learn.TXT': `${head}words : a\r\n` };
  for (const [name, data] of Object.entries(saves)) members.push({ name, data });
  // ghost/master/セーブ.txt in CP932, without the UTF-8 flag
  members.push({ name: Buffer.concat([Buffer.from('ghost/master/'), Buffer.from([0x83, 0x5a, 0x81, 0x5b, 0x83, 0x75]), Buffer.from('.txt')]),
    data: `${head}x : y\r\n` });
  saves['ghost/master/セーブ.txt'] = `${head}x : y\r\n`;
  const kar = put(path.join(work, 'arc', 'k.nar'), makeZip(members));
  const recordOf = s => path.join(s, 'sumika', 'kawari-shipped.json');
  const entries = Object.entries(saves).map(([p, d]) => [p, crc32(Buffer.from(d, 'utf8'))]);

  // from the archive (the Python side: its extraction with --from-archive), twice (a replace)
  let r = await parityAdd('archive-kawari', { src: kar, id: 'かわり', base, times: 2 }, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  const recorded = r.sites[1];
  assert.deepEqual(JSON.parse(fs.readFileSync(recordOf(recorded), 'utf8')), { format: 1, ghosts: { かわり: entries } });
  assert.match(fs.readFileSync(recordOf(recorded), 'utf8'), /^{\n "format": 1,\n "ghosts": {\n {2}"かわり": \[\n {3}\[\n {4}"ghost\/master\/default\.txt",/);
  for (const p of Object.keys(saves)) assert.ok(fs.existsSync(path.join(recorded, 'ghost', 'かわり', ...p.split('/'))), p);
  // a second one: ghosts by id
  r = await parityAdd('archive-kawari-second', { src: kar, id: 'b', base: recorded }, work);
  same(r);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(recordOf(r.sites[0]), 'utf8')).ghosts), ['b', 'かわり']);

  // from a folder (the same files): refused alike, plainly, with the developers' lines only where they fit
  const extracted = path.join(work, slug('archive-kawari'), 'extracted');
  r = await parityAdd('folder-kawari', { src: extracted, id: 'k2', base }, work);
  same(r);
  assert.equal(r.status.join(), '1,1');
  assert.deepEqual(r.refusal, Object.keys(saves).sort());
  assert.match(r.stderr, /^a Kawari ghost with such files is added only from its own \.nar or \.zip/m);
  assert.doesNotMatch(r.stderr, /KAWARI_SHIPPED_SAVES/);
  r = await parityAdd('folder-kawari-compared', { src: extracted, id: 'k2', archive: kar, base }, work);
  same(r);
  assert.equal(r.status.join(), '1,1');
  assert.match(r.stderr, /^k\.nar ships these as they are \(an author's default\): add the ghost from k\.nar itself, or list them in KAWARI_SHIPPED_SAVES/m);
  assert.match(r.stderr, /^ {4}\('ghost\/master\/default\.txt', 0x[0-9a-f]{8}\), {4}# k\.nar$/m, 'the KAWARI_SHIPPED_SAVES line');
  for (const s of r.sites) assert.equal(fs.existsSync(recordOf(s)), false, 'nothing recorded');
  const usage = py([path.join(ROOT, 'tools', 'add_ghost.py'), extracted, '--site', path.join(work, 'nosite'), '--from-archive']);
  assert.equal(usage.status, 2);
  assert.match(usage.stderr, /--from-archive needs --archive/);

  // a replace from a folder without such files: its entries go, and the empty record with them
  r = await parityAdd('replace-from-folder', { src: path.join(FIXTURES, 'kawaritest'), id: 'かわり', base: recorded }, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  for (const s of r.sites) assert.equal(fs.existsSync(recordOf(s)), false, s);

  // a recorded file changed in the site: both indexes refuse it, and only it
  const changed = path.join(work, 'changed');
  fs.cpSync(recorded, changed, { recursive: true });
  fs.appendFileSync(path.join(changed, 'ghost', 'かわり', 'ghost', 'master', 'default.txt'), 'name : someone\r\n');
  r = await parityIndex('index-changed', changed, work);
  same(r);
  assert.equal(r.status.join(), '1,1');
  assert.deepEqual(r.refusal, ['ghost/かわり/ghost/master/default.txt']);
  // the record names its ghost by id: the same files in a folder of another name (renamed or copied by hand) are
  // refused by both
  const moved = path.join(work, 'moved');
  fs.cpSync(recorded, moved, { recursive: true });
  fs.renameSync(path.join(moved, 'ghost', 'かわり'), path.join(moved, 'ghost', 'other'));
  r = await parityIndex('index-other-id', moved, work);
  same(r);
  assert.equal(r.status.join(), '1,1');
  assert.deepEqual(r.refusal, Object.keys(saves).map(p => `ghost/other/${p}`).sort());

  // a removal: the JS core drops its entries (the Python side: the folder and its entries deleted by hand)
  r = await parityRemove('remove-recorded', recorded, 'かわり', work);
  same(r);
  for (const s of r.sites) assert.equal(fs.existsSync(recordOf(s)), false, s);
});

test('the Kawari record: an editor\'s BOM is read alike (indexed alike, written again without it alike); one that does not read stops both tools\' adds and indexes alike, with the same words, nothing changed', async () => {
  const members = [];
  (function walk(d, rel) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(path.join(d, e.name), rel + e.name + '/');
      else members.push({ name: rel + e.name, data: fs.readFileSync(path.join(d, e.name)) });
    }
  })(path.join(FIXTURES, 'kawaritest'), '');
  const save = '#\r\n# Kawari saved file\r\n#\r\ncounter : 0\r\n';
  members.push({ name: 'ghost/master/default.txt', data: save });
  const kar = put(path.join(work, 'arc', 'rec.nar'), makeZip(members));
  const recordOf = s => path.join(s, 'sumika', 'kawari-shipped.json');
  let r = await parityAdd('rec-base', { src: kar, id: 'k', base }, work);
  same(r);
  const recorded = r.sites[1];

  // a BOM in front: both read it, index alike, and an add writes the record again alike, without it
  const bom = path.join(work, 'rec-bom');
  fs.cpSync(recorded, bom, { recursive: true });
  fs.writeFileSync(recordOf(bom), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), fs.readFileSync(recordOf(bom))]));
  r = await parityIndex('rec-bom-index', bom, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  r = await parityAdd('rec-bom-add', { src: kar, id: 'k2', base: bom }, work);
  same(r);
  assert.equal(r.status.join(), '0,0');
  const written = fs.readFileSync(recordOf(r.sites[0]));
  assert.equal(written[0], 0x7b, 'no BOM');
  assert.deepEqual(Object.keys(JSON.parse(written.toString('utf8')).ghosts), ['k', 'k2']);

  // one that does not read: the same refusal from both, before anything is copied or indexed (a lone surrogate in a
  // path reads as JSON in both, but neither could write it again: add_ghost.py copied, then failed on the write)
  for (const [i, text] of ['not json', '{"format": 1, "ghosts": {"k": [["ghost/master/default.txt", 1.0]]}}', '{"format": 2, "ghosts": {}}',
    '{"format": 1, "ghosts": {"k": [["ghost/master/default\\ud800.txt", 1]]}}'].entries()) {
    const broken = path.join(work, `rec-broken-${i}`);
    fs.cpSync(recorded, broken, { recursive: true });
    fs.writeFileSync(recordOf(broken), text);
    r = await parityIndex(`rec-broken-index-${i}`, broken, work);
    same(r);
    assert.equal(r.status.join(), '1,1');
    assert.match(r.stderr, /^stopped, nothing changed: sumika\/kawari-shipped\.json cannot be read: .*repair it, or delete it and add those Kawari ghosts again from their \.nar or \.zip$/s);
    for (const [name, src, id] of [['folder', path.join(FIXTURES, 'testghost'), 't'], ['archive', kar, 'k3']]) {
      r = await parityAdd(`rec-broken-add-${i}-${name}`, { src, id, base: broken }, work);
      same(r);
      assert.equal(r.status.join(), '1,1', name);
      for (const s of r.sites) assert.deepEqual(compareTrees(s, broken).diffs, [], `${name}: nothing changed`);
    }
  }
});

test('remove: the JS core\'s removal and index equal a deleted folder and index_site.py', async () => {
  const site = fixtureSite(path.join(work, 'rm-base'));
  assert.equal(py([path.join(ROOT, 'tools', 'index_site.py'), site]).status, 0);
  same(await parityRemove('remove', site, 'yayatest', work));
});
