// Every code the admin core reports (refusals, the files they name, what a copy leaves out, notes, an engine the site
// cannot run, a stale index, the hub.json gate, links in a site) with its English text: what the Python tools print,
// and what admin/cli.mjs prints. The admin page translates by code (CODE_LIST: the strings test asks a translation for
// each); `message` is the English fallback. Params are plain JSON values; file lists travel beside them (`files`).

import { KAWARI_RECORD } from './rules.mjs';

const list = a => a.join(', ');
const lines = (files, f) => files.map(x => `  ${f(x)}`).join('\n');
const KAWARI_LISTS = 'tools/index_site.py and admin/core/rules.mjs';

/** code -> (params, files) => English text */
export const CODES = Object.freeze({
  // ---- refusals (AdminRefusal.code) ----
  'source.missing': p => `${p.path}: no such file or folder`,
  'source.notSource': p => `${p.path}: not a ghost folder, a .nar or a .zip`,
  'source.notGhost': p => `${p.label} does not look like a ghost folder (no ghost/master/descript.txt)`,
  'id.bad': p => `site id ${JSON.stringify(p.id)}: ${CODES[p.problem]({})}`,
  'archive.unreadable': p => `${p.file}: not an archive Sumika can read (${p.error})`,
  'archive.noGhost': p => `${p.file} holds no ghost (no ghost/master/descript.txt)`,
  'archive.unsafe': (p, files) => `not extracted: ${p.file} holds ${files.length} member(s) Sumika will not write:\n`
    + lines(files, x => `${x.path} (${CODES[x.code](x.params || {})})`),
  'archive.damaged': p => `not extracted: ${p.file}: ${p.member}: ${p.error}`,
  'compare.unreadable': p => `${p.archive}: not an archive or update list Sumika can read (${p.error})`,
  'compare.unlisted': (p, files) => `not copied: ${files.length} file(s) of ${p.label} are not in ${p.archive} as they `
    + `are there, so an SSP run probably made or rewrote them:\n${lines(files, x => `${x.path} (${CODES[x.code]({})})`)}\n`
    + `add each one SSP created or rewrote to PERSONAL_PATHS in ${KAWARI_LISTS}, or name a legitimate one with --keep `
    + 'PATH (or leave it out of the copy with --skip PATH)',
  // a folder (an installed ghost) with such files: added only from its own archive [decision]; the developers'
  // lines after it are the CLI's and add_ghost.py's (the page leaves them out)
  'kawari.saveHeader': (p, files) => {
    const out = [`not copied: ${files.length} file(s) of ${p.label} start with Kawari's save header, so they may hold `
      + `what a user told the ghost:\n${lines(files, x => x.path)}`];
    out.push('a Kawari ghost with such files is added only from its own .nar or .zip, which holds them as they are: in '
      + 'a folder they may keep what a user told the ghost, in its archive they are the author\'s starting files '
      + '(add_ghost.py: the archive\'s extraction, with --archive and --from-archive)');
    const saves = files.filter(x => x.code === 'kawari.runSave').map(x => x.path);
    const shipped = files.filter(x => x.code === 'kawari.shippedDefault').map(x => x.line);
    if (saves.length) {
      out.push(`add each save SSP's run wrote to PERSONAL_PATHS in ${KAWARI_LISTS}: ${list(saves)}`
        + (p.archive ? '' : ' (--archive tells an author\'s default from a save)'));
    }
    if (shipped.length) {
      const own = /\.(nar|zip)$/i.test(String(p.archiveName)) ? `add the ghost from ${p.archiveName} itself, or ` : '';
      out.push(`${p.archiveName} ships these as they are (an author's default): ${own}list them in KAWARI_SHIPPED_SAVES `
        + `in ${KAWARI_LISTS}:\n${shipped.map(l => `    ${l}`).join('\n')}`);
    }
    return out.join('\n');
  },
  'balloon.wouldLose': (p, files) => `not copied: ${p.dst} holds the bundled balloon(s) `
    + `${list(files.map(x => `${x.path} (${x.params.name})`))}, which ${p.label} lacks and SSP's balloon/ folder cannot `
    + 'give back; re-copying would delete them. Put each into the source ghost folder first, or delete the site folder '
    + 'by hand to drop them',
  // the site's Kawari record (shipped.mjs) exists and does not read: add, removal and index stop before anything is
  // written, so it is never written again without the other ghosts' entries [decision]; {problem}: a
  // record.* code (index_site.py KawariRecordError, the same text)
  'kawari.record': p => `stopped, nothing changed: ${KAWARI_RECORD} cannot be read: `
    + `${CODES[p.problem] ? CODES[p.problem]({}) : p.problem}. That file is the site's list of the Kawari save-header `
    + 'files that ghosts added from their own .nar or .zip brought (the index accepts such a file while the list names '
    + 'it): repair it, or delete it and add those Kawari ghosts again from their .nar or .zip',
  'site.exists': p => `${p.dst} exists: replace it to add this ghost again`,
  'site.personal': (p, files) => 'refusing to index: these files hold a user\'s personal state and must not be '
    + `published:\n${lines(files, x => x.path)}\ndelete them from the site (tools/add_ghost.py copies ghosts without `
    + 'them); in a Kawari ghost a file that starts with Kawari\'s save header counts, unless KAWARI_SHIPPED_SAVES lists '
    + `it with its archive's CRC-32, or ${KAWARI_RECORD} lists it unchanged since the ghost was added from its .nar or `
    + '.zip',
  'ghost.missing': p => `${p.path}: no such ghost folder`,
  'work.rename': p => `${p.path} could not be moved (${p.error}): another program may be using its files (a virus `
    + 'scanner, an Explorer window); nothing was changed, try again',
  'work.undo': p => `${p.path} could not be moved into place nor back (${p.error}): its old folder is kept as `
    + `${p.kept}, and sumika-admin puts it back before its next change to the site`,

  // ---- the files a refusal names ----
  'compare.notListed': () => 'not listed',
  'compare.differs': () => 'differs from it',
  'kawari.runSave': () => 'a save of an SSP run',
  'kawari.shippedDefault': () => 'an author\'s default the archive ships',
  'balloon.lost': p => `a bundled balloon the source lacks (${p.name})`,
  'personal.kawariSave': () => 'starts with Kawari\'s save header',
  'member.leaves': () => 'a path that leaves the folder or names none',
  'member.fileAndFolder': () => 'a file and a folder of one name',
  'member.encrypted': () => 'encrypted',
  'member.method': p => `compression method ${p.method} (not supported)`,

  // ---- why the Kawari record does not read (kawari.record's problem; index_site.py KAWARI_RECORD_PROBLEMS) ----
  'record.open': () => 'opening it failed',
  'record.json': () => 'it is not JSON',
  'record.format': () => 'it is not a format 1 record',
  'record.entries': () => 'an entry is not a [path, CRC-32] pair',

  // ---- names (a member's segment, a site id) ----
  'name.empty': () => 'no name',
  'name.dots': () => 'a path that leaves the folder or names none',
  'name.separator': () => 'a site id is one folder name (no / or \\)',
  'name.badChar': () => 'a character Windows refuses in a name (<>:"|?* or a control character)',
  'name.trailingDotSpace': () => 'a name ending with a dot or a space (Windows would change it)',
  'name.device': () => 'a Windows device name',

  // ---- left out of a copy (excluded[].code; personal.* also in the index's refusal) ----
  'personal.profile': () => 'SSP\'s record of the user (profile/): never read',
  'personal.satoriSave': () => 'Satori\'s save (what the user told the ghost)',
  'personal.satoriBackup': () => 'Satori\'s save backup (what the user told the ghost)',
  'personal.variable': () => 'the YAYA / AYA save (what the user told the ghost)',
  'personal.log': () => 'an engine log',
  'personal.path': p => `a file an SSP run made in this ghost (PERSONAL_PATHS ${p.pattern})`,
  'program.dll': () => 'a Windows program (never run: Sumika brings its own engines)',
  'program.exe': () => 'a Windows program (never run)',
  'windows.thumbsDb': () => 'Windows\' thumbnail cache',
  'windows.desktopIni': () => 'Windows\' folder settings',
  'link.file': () => 'a link: never followed',
  'link.folder': () => 'a linked folder: never followed',
  'archive.link': () => 'a link in the archive: never written',
  'admin.leaveOut': () => 'left out by the admin (--skip)',

  // ---- notes: what add_ghost.py prints on the way ----
  'note.compared': p => `${p.count} files, all listed in ${p.archiveName} with the same contents`
    + (p.kept ? ` or kept (${p.kept})` : ''),
  'note.undeleteMask': p => 'install.txt refreshundeletemask (what a refresh install keeps, often the saves): '
    + list(p.names) + (p.hits.length ? '; to be copied, look at them before publishing: ' + list(p.hits) : '; none to be copied'),
  'note.kawariHeader': p => `note: ${p.path} starts with Kawari's save header (a Kawari SAORI's save?); copied, as the `
    + 'ghost is no Kawari ghost',
  'note.kawariKept': p => `note: ${list(p.paths)} start with Kawari's save header and are copied: in the ghost's own `
    + `archive they are the author's starting files (recorded in ${KAWARI_RECORD})`,
  'note.leftOut': p => `left out with --skip: ${list(p.paths)}`,

  // ---- an engine the site cannot run (runs.code) ----
  'engine.needs': p => `needs ${p.engine}`,

  // ---- the index against the disk (indexState / checkSite) ----
  'index.missing': () => 'missing',
  'index.differs': () => 'differs',

  // ---- sumika/hub.json (checkSite: hubJsonProblems' findings) ----
  'hub.unreadable': p => `sumika/hub.json is unreadable (${p.error})`,
  'hub.unusable': p => `sumika/hub.json: ${p.error} (the hub would answer no page)`,
  'hub.loopback': p => `sumika/hub.json lists the loopback origin ${p.entry}: remove it before publishing (test with `
    + 'tools/serve.py --hub-allow)',
  'hub.ignored': p => `sumika/hub.json: ${JSON.stringify(p.entry)} is ignored: ${p.why}`,

  // ---- links inside a site (checkSite) ----
  'site.link': () => 'a link or junction inside the site: the index and the copy never follow one',

  // ---- the work folder (staging.mjs; checkSite) ----
  'work.leftover': () => 'left by an add or a removal that was cut off: sumika-admin deletes it (or puts a ghost back) '
    + 'before its next change to the site, such as Update the index; never uploaded',
});

/** Every code, for the admin page's strings test. */
export const CODE_LIST = Object.freeze(Object.keys(CODES));

/** The English text of a code. */
export function message(code, params = {}, files = []) {
  const f = CODES[code];
  if (!f) throw new Error(`no such code: ${code}`);
  return f(params || {}, files || []);
}

/** {code, params?, message}: a finding as the API returns it. */
export function finding(code, params = undefined) {
  return params === undefined ? { code, message: message(code) } : { code, params, message: message(code, params) };
}
