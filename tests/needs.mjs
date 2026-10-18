// Tests that read data the repository does not ship: the ghosts in site/ghost/ (a site adds its own with
// tools/add_ghost.py), the real-DLL corpora in tests/corpus/, SSP's own site/sumika/word_compatible.txt, and the test
// fixtures derived from a ghost (FIXTURES below). Such a test passes needs(<paths from the project root>) as its
// options (spread it next to others): while a path is missing it skips with the reason, and once the data is there it
// runs as before.
//   test('…', needs('site/ghost/tsubasa'), async () => { … });
//   test('…', { ...needs('site/ghost/katari', 'tests/corpus'), timeout: 60000 }, async () => { … });
// A file that reads the data at import time checks needs(…).skip first.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const list = xs => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0]);

/** Fixtures made from a ghost's files: what each is and how it is made. None ships, as the ghost does not. */
const FIXTURES = {
  'tests/shell/fixtures/renders': 'renders of the shell of site/ghost/tsubasa, derived from a ghost that is not '
    + 'shipped; made by a script that is not shipped',
  'tests/balloon/fixtures/corpus.json.gz': 'menu scripts of site/ghost/tsubasa from tests/corpus, derived from a ghost '
    + 'that is not shipped; made by a script that is not shipped',
  'tests/balloon/fixtures/golden.json': 'scripts of site/ghost/tsubasa from tests/corpus, derived from a ghost that is '
    + 'not shipped; made by a script that is not shipped',
};

/** node:test options: { skip: why } while one of these paths is missing, else { skip: false }. */
export function needs(...rels) {
  const ghosts = [], why = [];
  for (const rel of rels) {
    if (fs.existsSync(path.join(ROOT, ...rel.split('/')))) continue;
    const ghost = /^site\/ghost\/([^/]+)/.exec(rel);
    if (ghost) { if (!ghosts.includes(ghost[1])) ghosts.push(ghost[1]); continue; }
    const text = FIXTURES[rel] ? `needs ${rel} (${FIXTURES[rel]})`
      : /^tests\/corpus(\/|$)/.test(rel) ? 'needs tests/corpus (not shipped)'
      : rel === 'site/sumika/word_compatible.txt' ? 'needs site/sumika/word_compatible.txt (SSP\'s own file, not shipped)'
      : `needs ${rel}`;
    if (!why.includes(text)) why.push(text);
  }
  if (ghosts.length === 1) {
    why.unshift(`needs site/ghost/${ghosts[0]} (not shipped: add it with tools/add_ghost.py <folder> --id ${ghosts[0]})`);
  } else if (ghosts.length) {
    why.unshift(`needs ${list(ghosts.map(id => 'site/ghost/' + id))} (not shipped: add each with tools/add_ghost.py `
      + '<folder> --id <id>, under the id named here)');
  }
  return { skip: why.length ? why.join('; ') : false };
}
