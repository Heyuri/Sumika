#!/usr/bin/env node
// The admin core on the command line (CLAUDE.md "The admin tool"): the same work, messages in the same spirit and exit
// statuses as the Python tools.
//
//   node admin/cli.mjs index [SITE]                       = python tools/index_site.py [SITE]
//   node admin/cli.mjs add <src> [--id ID] [--site SITE] [--archive A] [--keep P ...] [--skip P ...]
//                                                         = python tools/add_ghost.py …; <src> may also be a .nar / .zip
//   node admin/cli.mjs remove <id> [--site SITE]          delete a site ghost (a link as a link), then re-index
//   node admin/cli.mjs check [SITE]                       index up to date, the Kawari record readable, no personal
//                                                         files, no links, hub.json usable
//   node admin/cli.mjs inspect <src> [--site SITE] [--id ID] [--archive A] [--keep P ...] [--skip P ...]
//                                                         what an add would do (JSON)
//
// SITE defaults to the project's site/ folder, as the Python tools' does. Status 0: done; 1: refused (the reason on
// stderr) or failed; 2: a usage error.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inspectSource, addGhost, removeGhost, indexSite, checkSite, AdminRefusal } from './core/api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SITE = path.join(HERE, '..', 'site');

const USAGE = {
  index: 'usage: cli.mjs index [SITE]',
  add: 'usage: cli.mjs add [-h] [--id ID] [--site SITE] [--archive ARCHIVE] [--keep KEEP] [--skip SKIP] src',
  remove: 'usage: cli.mjs remove [-h] [--site SITE] id',
  check: 'usage: cli.mjs check [SITE]',
  inspect: 'usage: cli.mjs inspect [-h] [--id ID] [--site SITE] [--archive ARCHIVE] [--keep KEEP] [--skip SKIP] src',
};
const REPEATED = ['keep', 'skip'];

class UsageError extends Error {}

class Help extends Error {}

/**
 * argparse's way with a command's arguments: `--opt value` or `--opt=value` (a unique prefix of a long option too),
 * `--keep` and `--skip` repeatable, one positional.
 */
function parse(cmd, argv, options) {
  const out = { positional: [] };
  for (const o of options) out[o] = REPEATED.includes(o) ? [] : null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') throw new Help();
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq < 0 ? undefined : eq);
      const hits = options.filter(o => o === key || o.startsWith(key));
      const opt = hits.includes(key) ? key : hits.length === 1 ? hits[0] : null;
      if (!opt) {
        throw new UsageError(hits.length > 1 ? `ambiguous option: --${key} could match ${hits.map(h => '--' + h).join(', ')}`
          : `unrecognized arguments: ${a}`);
      }
      let value;
      if (eq >= 0) value = a.slice(eq + 1);
      else {
        if (i + 1 >= argv.length) throw new UsageError(`argument --${opt}: expected one argument`);
        value = argv[++i];
      }
      if (REPEATED.includes(opt)) out[opt].push(value);
      else out[opt] = value;
    } else out.positional.push(a);
  }
  return out;
}

/**
 * The command line: what the process prints and its exit status.
 * @param {string[]} argv  the arguments after the script
 * @param {{out?: (line: string) => void, err?: (text: string) => void}} [io] stdout lines, stderr text
 * @returns {Promise<number>}
 */
export async function run(argv, { out = line => console.log(line), err = text => console.error(text) } = {}) {
  const log = out;
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '-h' || cmd === '--help' || !USAGE[cmd]) {
    (cmd === '-h' || cmd === '--help' ? out : err)(Object.values(USAGE).join('\n'));
    return cmd === '-h' || cmd === '--help' ? 0 : 2;
  }
  try {
    if (cmd === 'index' || cmd === 'check') {
      if (rest[0] === '-h' || rest[0] === '--help') throw new Help();
      const site = path.resolve(rest[0] || DEFAULT_SITE);
      if (cmd === 'index') {
        await indexSite(site, { log });
        return 0;
      }
      const r = await checkSite(site);
      const items = list => list.map(x => `  ${x.path} (${x.why || x.code})`).join('\n');
      if (r.record) out(r.record.message);
      if (r.personal.length) out(`personal files (the index refuses the site):\n${items(r.personal)}`);
      if (r.index) {
        out(r.index.upToDate ? 'the index is up to date' : `the index is not up to date (run the index):\n${items(r.index.stale)}`);
      }
      if (r.links.length) out(`links or junctions in the site:\n${items(r.links)}`);
      if (r.work.length) out(`left by a cut-off add or removal (the admin program settles it):\n${items(r.work)}`);
      out(!r.hub.present ? 'no sumika/hub.json (the hub answers no page)'
        : r.hub.problems.length ? `sumika/hub.json:\n  ${r.hub.problems.map(p => p.message).join('\n  ')}` : 'sumika/hub.json is usable');
      return r.ok ? 0 : 1;
    }
    if (cmd === 'remove') {
      const a = parse(cmd, rest, ['site']);
      if (a.positional.length !== 1) throw new UsageError(a.positional.length ? `unrecognized arguments: ${a.positional.slice(1).join(' ')}` : 'the following arguments are required: id');
      await removeGhost(path.resolve(a.site || DEFAULT_SITE), a.positional[0], { log });
      return 0;
    }
    const a = parse(cmd, rest, ['id', 'site', 'archive', 'keep', 'skip']);
    if (a.positional.length !== 1) throw new UsageError(a.positional.length ? `unrecognized arguments: ${a.positional.slice(1).join(' ')}` : 'the following arguments are required: src');
    const src = path.resolve(a.positional[0]);
    const opts = { id: a.id || null, archive: a.archive, keep: a.keep, leaveOut: a.skip };
    if (cmd === 'inspect') {
      out(JSON.stringify(await inspectSource(src, { ...opts, site: a.site ? path.resolve(a.site) : null }), null, 1));
      return 0;
    }
    await addGhost(src, path.resolve(a.site || DEFAULT_SITE), { ...opts, replace: true, log });
    return 0;
  } catch (e) {
    if (e instanceof Help) {
      out(USAGE[cmd]);
      return 0;
    }
    if (e instanceof UsageError) {
      err(`${USAGE[cmd]}\ncli.mjs ${cmd}: error: ${e.message}`);
      return 2;
    }
    if (e instanceof AdminRefusal) {
      err(e.message);
      return 1;
    }
    err(e && e.stack ? e.stack : String(e));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
