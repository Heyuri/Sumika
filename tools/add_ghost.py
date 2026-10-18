"""Copy a ghost from an SSP installation into the site, leaving out personal and Windows-only files,
then refresh the site index.

usage: python tools/add_ghost.py <path to SSP ghost folder> [--id NAME] [--site SITE_DIR]
                                 [--archive PATH [--keep PATH]... [--from-archive]] [--skip PATH]...
example: python tools/add_ghost.py C:/ssp/ghost/tsubasa

admin/core/add.mjs (node admin/cli.mjs add) does the same, byte for byte (tests/admin/ and admin/parity.mjs compare the
two), and adds from a .nar / .zip too: a change is made in both.

Left out on purpose:
  profile/ folders          SSP's per-user state (stats, shell/dress-up state, variables)
  satori_savedata*, satori_savebackup*, *_variable.*, *.log
                            the engine's memory of the person who ran it in SSP (names, birthday, ...) and its logs
  index_site.PERSONAL_PATHS files an SSP run created inside a ghost (ghost-root-relative)
                            (index_site.PERSONAL_*; indexing refuses a site that still has them)
  *.dll / *.exe             never run in a browser; the runtime brings its own engines

--archive PATH compares the installed folder with the ghost's original by file names and contents: a .nar / .zip (its
member names, CRC-32s and sizes) or an update list (updates2.dau / updates.txt: each line's path, MD5 and size=).
Nothing personal is opened: the files compared are the ones the copy reads anyway. install.txt and every
updates*.dau / updates*.txt count as listed at any level (an update list names neither, and SSP rewrites them). A file
of the folder that the archive does not list (any case, `\\` = `/`), or whose bytes differ from the archive's, and that
the list above does not leave out is one SSP's run created or rewrote (a playlist the ghost wrote over its shipped
one, a downloaded counter): add_ghost names them and copies nothing until each one is in index_site.PERSONAL_PATHS, or
is named with --keep PATH (a legitimate file; ghost-root-relative), or is left out with --skip PATH.

--skip PATH (repeatable; ghost-root-relative, any case, `\\` = `/`) leaves one more file out of the copy: it is neither
compared nor checked nor copied. It only ever removes a file; nothing the list above leaves out comes back with it.

Kawari saves: a Kawari ghost (engine kawari / kawari7) names its save files itself, so in one a file that starts with
Kawari's save header (index_site.KAWARI_SAVE_HEAD) stops the copy, as it would stop the index, unless
index_site.KAWARI_SHIPPED_SAVES lists it with these contents (an author's default: with --archive, add_ghost prints the
line to add for each file the archive holds as it is); else it is a save of SSP's run, for PERSONAL_PATHS. So such a
ghost is added from its own .nar / .zip [decision]: --from-archive
says that src is the extraction of --archive (a .nar / .zip, as admin/parity_extract.py or any unzip writes it; the
admin core reads the archive itself); then each such file the archive holds as it is (the comparison of --archive
checks every file) is the author's starting file: copied, and recorded with its CRC-32 in the site's
sumika/kawari-shipped.json (index_site.KAWARI_RECORD), which both index tools read. Every add sets its ghost's entries
there (none: an older add's go), so a record that exists and does not read (index_site.KawariRecordError) stops every
add before anything is copied. From a folder, an installed ghost, such files stop the copy. In a ghost of another
engine such a file is only named. install.txt's refreshundeletemask (what a refresh install keeps: often the author's
own list of save files) is printed with the files to copy it names, to look at before publishing [decision:
kawari-wasm.md §12].

A bundled balloon: SSP moves the balloon an archive brings (install.txt `balloon.directory`) to its shared balloon/
folder at install, so the installed ghost folder lacks it (emily4). add_ghost then copies <SSP>/balloon/<directory>
into the site ghost, with the same files left out. It never deletes a site ghost folder that holds a bundled balloon
the source lacks and SSP's balloon/ folder cannot give back.
"""
import os, re, sys, shutil, argparse, fnmatch, zipfile, zlib, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True   # no __pycache__ beside index_site.py (a .pyc names the folder it was compiled in)
sys.path.insert(0, HERE)
import index_site

SKIP_DIRS = index_site.PERSONAL_DIRS
SKIP_FILES = list(index_site.PERSONAL_FILES) + ['*.dll', '*.exe', 'thumbs.db', 'desktop.ini']
ALWAYS_LISTED = re.compile(r'(^|/)(install\.txt|updates[^/]*\.(dau|txt))$', re.I)


def skip_file(rel):
    """rel: the file's ghost-root-relative path"""
    name = rel.replace('\\', '/').rsplit('/', 1)[-1].lower()
    return any(fnmatch.fnmatch(name, p) for p in SKIP_FILES) or index_site.is_personal_path(rel)


def source_files(src):
    """(folders, files) to copy, ghost-root-relative (personal folders are never entered)"""
    folders, out = [], []
    for root, dirs, files in os.walk(src):
        dirs[:] = sorted(d for d in dirs if d.lower() not in SKIP_DIRS)
        rel = os.path.relpath(root, src).replace(os.sep, '/')
        folders.append(rel)
        for f in sorted(files):
            p = f if rel == '.' else f'{rel}/{f}'
            if not skip_file(p):
                out.append(p)
    return folders, out


def zip_name(info):
    """A member's name as the archive holds it. zipfile on Windows turns every 0x5C byte of the CP437-decoded name into
    '/', which breaks a CP932 name whose trail byte is 0x5C (表, ソ, 能): decode orig_filename, then swap backslashes,
    as tools/sweep/zip.mjs does."""
    n = info.orig_filename
    if not info.flag_bits & 0x800:                  # not flagged UTF-8: CP932 bytes read as CP437
        try:
            n = n.encode('cp437').decode('cp932')
        except UnicodeError:
            pass
    return n.replace('\\', '/')


def archive_index(path):
    """{lower-cased ghost-root-relative name: [(kind, digest, size)]} of an archive or an update list: kind 'crc32'
    (a .nar / .zip member; digest an int) or 'md5' (an update list's line; digest None and size None when missing)"""
    out = {}
    if path.lower().endswith(('.nar', '.zip')):
        with zipfile.ZipFile(path) as z:
            members = [(zip_name(i), i) for i in z.infolist()]
        members = [(n, i) for n, i in members if not n.endswith('/')]
        desc = sorted((n for n, _ in members if re.search(r'(^|/)ghost/master/descript\.txt$', n, re.I)), key=len)
        prefix = desc[0][:-len('ghost/master/descript.txt')] if desc else ''
        for n, i in members:
            if n.startswith(prefix):
                out.setdefault(n[len(prefix):].lower().lstrip('/'), []).append(('crc32', i.CRC, i.file_size))
    else:
        data = open(path, 'rb').read()
        try:
            text = data.decode('utf-8-sig')
        except UnicodeDecodeError:
            text = data.decode('cp932', 'replace')
        for line in re.split(r'\r\n|\r|\n', text):
            fields = line.split('\x01')
            first = fields[0].strip()
            if first.lower().startswith('file,'):        # updates.txt: file,<path>\x01…
                first = first[5:].strip()
            if not first:
                continue
            md5 = fields[1].strip().lower() if len(fields) > 1 else ''
            md5 = md5 if re.fullmatch(r'[0-9a-f]{32}', md5) else None
            size = next((int(f.strip()[5:]) for f in fields[2:] if re.fullmatch(r'size=\d+', f.strip())), None)
            out.setdefault(first.replace('\\', '/').lower().lstrip('/'), []).append(('md5', md5, size))
    return out


def archive_names(path):
    """lower-cased ghost-root-relative file names an archive or an update list holds"""
    return set(archive_index(path))


def matches(data, kind, digest, size):
    if size is not None and len(data) != size:
        return False
    if digest is None:
        return True
    if kind == 'crc32':
        return zlib.crc32(data) & 0xFFFFFFFF == digest
    return hashlib.md5(data).hexdigest() == digest


def unlisted(src, files, archive, keep):
    """[(path, why)]: files the archive does not list ('not listed') or holds with other bytes ('differs'), that
    --keep does not name"""
    index = archive_index(archive)
    kept = {k.replace('\\', '/').lower().lstrip('/') for k in keep}
    out = []
    for p in files:
        if p.lower() in kept or ALWAYS_LISTED.search(p):
            continue
        listed = index.get(p.lower())
        if not listed:
            out.append((p, 'not listed'))
            continue
        with open(os.path.join(src, p), 'rb') as fh:
            data = fh.read()
        if not any(matches(data, *e) for e in listed):
            out.append((p, 'differs from it'))
    return out


def undelete_mask(src, files):
    """(names, hits): install.txt's refreshundeletemask names (every such line; `:`, `;` or `,` between them, as the
    corpus writes them) and the files to copy that they name, relative to the ghost root or to ghost/master (the
    corpus' names are bare file names of ghost/master: savefile1.txt)"""
    path = os.path.join(src, 'install.txt')
    names = []
    if os.path.isfile(path):
        for line in index_site.read_text(path).splitlines():
            key, sep, value = line.partition(',')
            if sep and key.strip().lower() == 'refreshundeletemask':
                names += [n.strip().replace('\\', '/').lstrip('/') for n in re.split(r'[:;,]', value) if n.strip()]
    pats = [q for n in names for q in (n.lower(), f'ghost/master/{n.lower()}')]
    return names, [p for p in files if any(fnmatch.fnmatchcase(p.lower(), q) for q in pats)]


def kawari_refused(src, files, archive):
    """[(path, CRC-32, line)]: the files a Kawari ghost's index would refuse for their save header
    (index_site.kawari_unlisted), each with the KAWARI_SHIPPED_SAVES line to add when the archive holds it as it is
    (else None: a save of SSP's run)"""
    index = archive_index(archive) if archive else {}
    out = []
    for p, crc in index_site.kawari_unlisted(src, files):
        with open(os.path.join(src, p), 'rb') as fh:
            data = fh.read()
        shipped = any(matches(data, *e) for e in index.get(p.lower(), ()))
        out.append((p, crc, f'({p!r}, 0x{crc:08x}),    # {os.path.basename(archive)}' if shipped else None))
    return out


def ssp_balloon(src):
    """(directory, folder) of the balloon install.txt names when the ghost folder lacks it and SSP's shared balloon/
    folder has it (<SSP>/ghost/<name> -> <SSP>/balloon/<directory>), else None"""
    want = index_site.read_descript(os.path.join(src, 'install.txt')).get('balloon.directory', '').strip()
    if not want or '/' in want or '\\' in want or want in ('.', '..'):
        return None
    if any(d.lower() == want.lower() for d in os.listdir(src) if os.path.isdir(os.path.join(src, d))):
        return None
    parent = os.path.dirname(src)
    folder = os.path.join(os.path.dirname(parent), 'balloon', want)
    if os.path.basename(parent).lower() != 'ghost' or not os.path.isfile(os.path.join(folder, 'descript.txt')):
        return None
    return want, folder


def lost_balloons(src, dst, balloon):
    """bundled balloons of the site ghost folder dst that a re-copy from src would delete for good"""
    if not os.path.isdir(dst):
        return []
    have = {d.lower() for d in os.listdir(src) if os.path.isdir(os.path.join(src, d))}
    if balloon:
        have.add(balloon[0].lower())
    return [b for b in index_site.bundled_balloons(dst) if b['dir'].lower() not in have]


def copy_tree(src, dst, folders, files):
    for d in folders:
        os.makedirs(os.path.join(dst, d), exist_ok=True)
    for p in files:
        shutil.copyfile(os.path.join(src, p), os.path.join(dst, p))
    return len(files)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--id', default=None, help='folder name on the site (default: same as the source folder)')
    ap.add_argument('--site', default=os.path.join(HERE, '..', 'site'))
    ap.add_argument('--archive', default=None, help="the ghost's .nar / .zip, or an updates2.dau / updates.txt list")
    ap.add_argument('--keep', action='append', default=[], help='a file the archive misses or holds otherwise that is '
                    'not personal')
    ap.add_argument('--skip', action='append', default=[], help='a file to leave out of the copy (it only ever removes '
                    'one)')
    ap.add_argument('--from-archive', action='store_true', help='src is the extraction of --archive (a .nar / .zip): '
                    'a Kawari ghost\'s save-header files that the archive holds as they are get copied and recorded')
    a = ap.parse_args()
    if a.from_archive and not (a.archive and a.archive.lower().endswith(('.nar', '.zip'))):
        ap.error('--from-archive needs --archive: the .nar / .zip that src was extracted from')
    src = os.path.abspath(a.src)
    if not os.path.isfile(os.path.join(src, 'ghost', 'master', 'descript.txt')):
        sys.exit(f'{src} does not look like a ghost folder (no ghost/master/descript.txt)')
    try:
        # the site's record of Kawari archive files: one that does not read is never written over (every add sets its
        # ghost's entries), so nothing is changed until it is repaired or deleted [decision]
        index_site.read_kawari_record(os.path.abspath(a.site))
    except index_site.KawariRecordError as e:
        sys.exit(str(e))
    gid = a.id or os.path.basename(src.rstrip('/\\'))
    dst = os.path.join(os.path.abspath(a.site), 'ghost', gid)
    folders, files = source_files(src)
    skip = {k.replace('\\', '/').lower().lstrip('/') for k in a.skip}
    left = [p for p in files if p.lower() in skip]
    files = [p for p in files if p.lower() not in skip]
    if left:
        print('left out with --skip: ' + ', '.join(left))
    if a.archive:
        extra = unlisted(src, files, a.archive, a.keep)
        if extra:
            sys.exit(f'not copied: {len(extra)} file(s) of {src} are not in {a.archive} as they are there, so an SSP '
                     'run probably made or rewrote them:\n  ' + '\n  '.join(f'{p} ({why})' for p, why in extra)
                     + '\nadd each one SSP created or rewrote to PERSONAL_PATHS in tools/index_site.py and '
                     'admin/core/rules.mjs, or name a legitimate one with --keep PATH (or leave it out of the copy with '
                     '--skip PATH)')
        print(f'{len(files)} files, all listed in {os.path.basename(a.archive)} with the same contents'
              + (f' or kept ({len(a.keep)})' if a.keep else ''))
    names, hits = undelete_mask(src, files)
    if names:
        print('install.txt refreshundeletemask (what a refresh install keeps, often the saves): ' + ', '.join(names)
              + ('; to be copied, look at them before publishing: ' + ', '.join(hits) if hits else '; none to be copied'))
    kept = []                   # [(path, CRC-32)]: the archive's own Kawari save-header files, for the site's record
    if index_site.folder_engine(src, files) in index_site.KAWARI_ENGINES:
        refused = kawari_refused(src, files, a.archive)
        if a.from_archive:
            # the author's starting files: those the archive holds as they are [decision]
            kept = [(p, crc) for p, crc, line in refused if line]
            refused = [x for x in refused if not x[2]]
            if kept:
                print('note: ' + ', '.join(p for p, _ in kept) + ' start with Kawari\'s save header and are copied: in '
                      f'the ghost\'s own archive they are the author\'s starting files (recorded in '
                      f'{index_site.KAWARI_RECORD})')
        if refused:
            msg = [f'not copied: {len(refused)} file(s) of {src} start with Kawari\'s save header, so they may hold '
                   'what a user told the ghost:'] + [f'  {p}' for p, _, _ in refused]
            msg.append('a Kawari ghost with such files is added only from its own .nar or .zip, which holds them as '
                       'they are: in a folder they may keep what a user told the ghost, in its archive they are the '
                       'author\'s starting files (add_ghost.py: the archive\'s extraction, with --archive and '
                       '--from-archive)')
            saves = [p for p, _, line in refused if not line]
            shipped = [line for _, _, line in refused if line]
            if saves:
                msg.append('add each save SSP\'s run wrote to PERSONAL_PATHS in tools/index_site.py and '
                           'admin/core/rules.mjs: ' + ', '.join(saves)
                           + ('' if a.archive else ' (--archive tells an author\'s default from a save)'))
            if shipped:
                name = os.path.basename(a.archive)
                own = f'add the ghost from {name} itself, or ' if name.lower().endswith(('.nar', '.zip')) else ''
                msg.append(f'{name} ships these as they are (an author\'s default): {own}list them in '
                           'KAWARI_SHIPPED_SAVES in tools/index_site.py and admin/core/rules.mjs:')
                msg += [f'    {line}' for line in shipped]
            sys.exit('\n'.join(msg))
    else:
        for p, _ in index_site.kawari_saved(src, files):
            print(f'note: {p} starts with Kawari\'s save header (a Kawari SAORI\'s save?); copied, as the ghost is no '
                  'Kawari ghost')
    balloon = ssp_balloon(src)
    lost = lost_balloons(src, dst, balloon)
    if lost:
        sys.exit(f'not copied: {dst} holds the bundled balloon(s) '
                 + ', '.join(f'{b["dir"]}/ ({b["name"]})' for b in lost)
                 + f', which {src} lacks and SSP\'s balloon/ folder cannot give back; re-copying would delete them. '
                 'Put each into the source ghost folder first, or delete the site folder by hand to drop them')
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    n = copy_tree(src, dst, folders, files)
    print(f'copied {n} files to {dst}')
    if balloon:
        bfolders, bfiles = source_files(balloon[1])
        n = copy_tree(balloon[1], os.path.join(dst, balloon[0]), bfolders, bfiles)
        print(f'copied {n} files of its balloon from {balloon[1]} (install.txt balloon.directory) to {dst}/{balloon[0]}')
    # the site's record of this ghost's archive files: what this add kept, else none (an older add's entries go)
    index_site.set_kawari_record(os.path.abspath(a.site), gid, kept)
    index_site.main([os.path.abspath(a.site)])


if __name__ == '__main__':
    main()
