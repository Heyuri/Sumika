// The admin core's crash-safe folder moves (admin/core/staging.mjs; CLAUDE.md "The admin tool"): an add copies into
// SITE/.sumika-admin-work/ and renames the complete copy into ghost/<id>, a replace moves the old folder aside first,
// a removal moves ghost/<id> aside before deleting it; a refused rename (retried, then refused) undoes what was done;
// recoverWork settles what a cut-off job left; checkSite names it. Everything on scratch sites in the OS temp folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addGhost, removeGhost, checkSite, indexSite, recoverWork, workLeftovers, WORK_DIR, AdminRefusal } from '../../admin/core/api.mjs';
import { makeSite, scratchOnly, filesUnder } from '../../admin/server/drive.mjs';
import { uploadList } from '../../admin/server/upload.mjs';
import { checkProblems } from '../../admin/server/check.mjs';
import * as core from '../../admin/core/api.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'ghost', 'testghost');
const FAST = { retryMs: [1, 1] };

async function site(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sumika-admin-staging-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const s = makeSite(path.join(scratchOnly(d), 'site'));
  await indexSite(s);
  return s;
}

const put = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
};
const tree = dir => (fs.existsSync(dir) ? filesUnder(dir).map(([rel, abs]) => `${rel}=${fs.readFileSync(abs).toString('hex')}`).sort() : null);
const eperm = () => Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });

test('an add copies into the work folder, renames the complete copy into ghost/<id>, and leaves no work folder', async t => {
  const s = await site(t);
  const dst = path.join(s, 'ghost', 'testghost');
  const steps = [];
  let sawCopy = false;
  const r = await addGhost(FIXTURE, s, {
    onStep: (step, id) => steps.push(`${step} ${id}`),
    onProgress: p => {
      if (p.phase !== 'copy') return;
      sawCopy = true;
      // a closed window at this moment would leave no ghost folder: the copy is elsewhere
      assert.ok(!fs.existsSync(dst), 'no ghost/<id> while the copy runs');
      assert.equal(workLeftovers(s).length, 1);
      assert.match(workLeftovers(s)[0].name, /^new-[0-9a-f]{6}-testghost$/);
    },
  });
  assert.ok(sawCopy);
  assert.deepEqual(steps, ['copy testghost', 'swap testghost', 'placed testghost', 'index testghost']);
  assert.equal(r.path, dst);
  assert.deepEqual(tree(dst), tree(FIXTURE));
  assert.ok(!fs.existsSync(path.join(s, WORK_DIR)), 'the work folder is gone');
  assert.ok(r.index && r.index.ids.includes('testghost'));
});

test('an error during the copy leaves no ghost folder, deletes the staging copy, and a replace keeps the old ghost', async t => {
  const s = await site(t);
  const dst = path.join(s, 'ghost', 'testghost');
  // the copy's last step (progress is throttled: a phase's first and last step always come)
  const boom = o => addGhost(FIXTURE, s, { ...o, index: false, onProgress: p => { if (p.phase === 'copy' && p.total && p.done >= p.total) throw new Error('disk full'); } });
  await assert.rejects(boom({}), /disk full/);
  assert.ok(!fs.existsSync(dst), 'no ghost folder');
  assert.ok(!fs.existsSync(path.join(s, WORK_DIR)), 'the staging copy is gone');
  await addGhost(FIXTURE, s, { index: false });
  put(path.join(dst, 'ghost', 'master', 'mine.txt'), 'the old ghost\'s own file\n');
  const before = tree(dst);
  await assert.rejects(boom({ replace: true }), /disk full/);
  assert.deepEqual(tree(dst), before, 'the old ghost as it was');
  assert.ok(!fs.existsSync(path.join(s, WORK_DIR)));
});

test('a rename Windows keeps refusing: retried, then refused with the site as before (an add, a replace, a removal)', async t => {
  const s = await site(t);
  const dst = path.join(s, 'ghost', 'testghost');
  let calls = 0;
  const refuse = { ...FAST, rename: () => { calls++; throw eperm(); } };
  const e1 = await addGhost(FIXTURE, s, { index: false, io: refuse }).catch(e => e);
  assert.ok(e1 instanceof AdminRefusal && e1.code === 'work.rename', String(e1));
  assert.equal(e1.params.path, dst);
  assert.equal(e1.params.error, 'EPERM');
  assert.equal(calls, 3, 'tried once and twice again');
  assert.ok(!fs.existsSync(dst) && !fs.existsSync(path.join(s, WORK_DIR)));

  await addGhost(FIXTURE, s, { index: false });
  const before = tree(dst);
  // the old folder moves aside, the new one is refused: the old one goes back
  const second = { ...FAST, rename: (a, b) => { if (path.basename(a).startsWith('new-')) throw eperm(); fs.renameSync(a, b); } };
  const e2 = await addGhost(FIXTURE, s, { index: false, replace: true, io: second }).catch(e => e);
  assert.equal(e2.code, 'work.rename', String(e2));
  assert.deepEqual(tree(dst), before, 'the old ghost is back');
  assert.ok(!fs.existsSync(path.join(s, WORK_DIR)), 'no leftover');

  const e3 = await removeGhost(s, 'testghost', { io: refuse }).catch(e => e);
  assert.equal(e3.code, 'work.rename', String(e3));
  assert.deepEqual(tree(dst), before, 'nothing deleted');
});

test('a file another program holds open inside the ghost folder: Windows refuses the move, the removal deletes nothing', async t => {
  const s = await site(t);
  await addGhost(FIXTURE, s, { index: false });
  const dst = path.join(s, 'ghost', 'testghost');
  const fd = fs.openSync(path.join(dst, 'readme.txt'), 'r');
  let r;
  try {
    r = await removeGhost(s, 'testghost', { io: FAST }).catch(e => e);
  } finally {
    fs.closeSync(fd);
  }
  if (process.platform === 'win32') {
    // [measured: EPERM from Node's and Deno's node:fs alike, though Node opens with FILE_SHARE_DELETE]
    assert.equal(r.code, 'work.rename', String(r));
    assert.equal(r.params.error, 'EPERM');
    assert.deepEqual(tree(dst), tree(FIXTURE), 'nothing deleted');
    assert.ok(!fs.existsSync(path.join(s, WORK_DIR)));
  } else assert.ok(!fs.existsSync(dst), 'elsewhere an open file does not stop a rename');
});

test('a rename refused a few times then allowed (a scanner let go) just takes longer', async t => {
  const s = await site(t);
  let left = 2;
  const flaky = { ...FAST, rename: (a, b) => { if (left-- > 0) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' }); fs.renameSync(a, b); } };
  await addGhost(FIXTURE, s, { index: false, io: flaky });
  assert.deepEqual(tree(path.join(s, 'ghost', 'testghost')), tree(FIXTURE));
  const steps = [];
  left = 2;
  await removeGhost(s, 'testghost', { io: flaky, onStep: (step, id) => steps.push(`${step} ${id}`) });
  assert.deepEqual(steps, ['swap testghost', 'placed testghost', 'index testghost']);
  assert.ok(!fs.existsSync(path.join(s, 'ghost', 'testghost')) && !fs.existsSync(path.join(s, WORK_DIR)));
});

test('a replace whose undo fails too: the old folder is kept in the work folder, and recoverWork puts it back', async t => {
  const s = await site(t);
  const dst = path.join(s, 'ghost', 'testghost');
  await addGhost(FIXTURE, s, { index: false });
  const before = tree(dst);
  let n = 0;
  const stuck = { ...FAST, rename: (a, b) => { if (++n >= 2) throw eperm(); fs.renameSync(a, b); } };
  const e = await addGhost(FIXTURE, s, { index: false, replace: true, io: stuck }).catch(x => x);
  assert.equal(e.code, 'work.undo', String(e));
  assert.ok(!fs.existsSync(dst), 'ghost/<id> is missing for now');
  assert.match(path.basename(e.params.kept), /^old-[0-9a-f]{6}-testghost$/);
  assert.deepEqual(workLeftovers(s).map(w => w.kind), ['old'], 'the copy deleted, the old folder kept');
  const c = await checkSite(s);
  assert.equal(c.ok, false);
  assert.deepEqual(c.work.map(w => w.code), ['work.leftover']);
  assert.equal(c.work[0].path, `${WORK_DIR}/${path.basename(e.params.kept)}`);
  const r = await recoverWork(s);
  assert.deepEqual(r.entries.map(x => [x.kind, x.action]), [['old', 'restored']]);
  assert.equal(r.clean, true);
  assert.deepEqual(tree(dst), before, 'the old ghost is back in place');
});

test('recoverWork: a staging copy and a removed ghost are deleted, a replaced ghost goes back or goes, anything else goes too', async t => {
  const s = await site(t);
  const w = path.join(s, WORK_DIR);
  await addGhost(FIXTURE, s, { id: 'kept', index: false });
  // what four cut-off jobs left: a half copy, a removal, a replace cut before the new folder was in, one cut after
  put(path.join(w, 'new-aaaaaa-half', 'ghost', 'master', 'descript.txt'), 'name,half\r\n');
  put(path.join(w, 'del-bbbbbb-gone', 'ghost', 'master', 'descript.txt'), 'name,gone\r\n');
  put(path.join(w, 'old-cccccc-back', 'ghost', 'master', 'descript.txt'), 'name,back\r\n');
  put(path.join(w, 'old-dddddd-kept', 'ghost', 'master', 'descript.txt'), 'name,old kept\r\n');
  // names the core never makes: the work folder is the program's own scratch, so they go too (Check says they go at
  // the next change, and Prepare upload waits for that); a link as a link, what it points to stays
  put(path.join(w, 'notes.txt'), 'not the core\'s\n');
  put(path.join(w, 'odd', 'x.txt'), 'x\n');
  const outside = path.join(path.dirname(s), 'outside');
  put(path.join(outside, 'keep.txt'), 'not the site\'s\n');
  fs.symlinkSync(outside, path.join(w, 'linked'), 'junction');
  const r = await recoverWork(s);
  assert.deepEqual(r.entries.map(e => `${e.name} ${e.action}`), [
    'del-bbbbbb-gone deleted', 'linked deleted', 'new-aaaaaa-half deleted', 'notes.txt deleted', 'odd deleted',
    'old-cccccc-back restored', 'old-dddddd-kept deleted',
  ]);
  assert.equal(r.clean, true);
  assert.ok(!fs.existsSync(w));
  assert.equal(fs.readFileSync(path.join(outside, 'keep.txt'), 'utf8'), 'not the site\'s\n', 'the junction deleted as a link');
  assert.ok(!fs.existsSync(path.join(s, 'ghost', 'half')) && !fs.existsSync(path.join(s, 'ghost', 'gone')));
  assert.equal(fs.readFileSync(path.join(s, 'ghost', 'back', 'ghost', 'master', 'descript.txt'), 'utf8'), 'name,back\r\n');
  assert.deepEqual(tree(path.join(s, 'ghost', 'kept')), tree(FIXTURE), 'the ghost in place is the one kept');
  assert.deepEqual((await recoverWork(s)).entries, []);
});

test('a link or junction in the work folder\'s own place: one leftover, deleted as a link, what it points to never listed nor touched', async t => {
  const s = await site(t);
  const w = path.join(s, WORK_DIR);
  // someone's own folder, with names the core never makes and one it does: recoverWork deletes such names in the work
  // folder, so through the link it would have emptied this folder
  const mine = path.join(path.dirname(s), 'mine');
  put(path.join(mine, 'precious.txt'), 'not the site\'s\n');
  put(path.join(mine, 'new-aaaaaa-x', 'ghost', 'master', 'descript.txt'), 'name,x\r\n');
  const before = tree(mine);
  fs.symlinkSync(mine, w, 'junction');
  assert.deepEqual(workLeftovers(s).map(e => [e.name, e.kind, e.path]), [['', null, w]]);
  const c = await checkSite(s);
  assert.deepEqual([c.ok, c.work.map(x => x.path)], [false, [`${WORK_DIR}/`]], 'Check names it, not what it points to');
  const r = await recoverWork(s);
  assert.deepEqual(r.entries.map(e => [e.name, e.action]), [['', 'deleted']]);
  assert.equal(r.clean, true);
  assert.ok(!fs.existsSync(w), 'the link is gone');
  assert.deepEqual(tree(mine), before, 'what it pointed to is as it was');
  assert.ok(!fs.existsSync(path.join(s, 'ghost', 'x')));
});

test('the work folder is never uploaded, Check names what is left in it, Prepare upload settles it first', async t => {
  const s = await site(t);
  put(path.join(s, WORK_DIR, 'new-eeeeee-x', 'ghost', 'master', 'descript.txt'), 'name,x\r\n');
  assert.ok(!uploadList(s).some(f => f.path.startsWith(`${WORK_DIR}/`)), 'never in the upload list');
  const c = await checkProblems(s, { core });
  assert.ok(c.problems.some(p => p.code === 'work.leftover' && p.params.path === `${WORK_DIR}/new-eeeeee-x`), JSON.stringify(c.problems));
  assert.ok(!c.problems.some(p => p.code === 'site.link'));
  const { work } = await import('../../admin/server/work.mjs');
  await work('index', { site: s }, { core });
  assert.ok(!fs.existsSync(path.join(s, WORK_DIR)), 'a write job settles it first');
});
