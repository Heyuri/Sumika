"""Rebuild the site index: the browser's replacement for SSP scanning its ghost/ and balloon/ folders.

usage: python tools/index_site.py [SITE_DIR]          (default: ../site)

Writes:
  SITE/sumika/index/ghosts.json           small list of every ghost and balloon (read on every page load),
                                          defaultBalloon: the shared balloon for ghosts that bring none (BA §9),
                                          manifests: each manifest's hashed name, versions: the `?v=` of each
                                          thumbnail and icon it names (written last)
  SITE/sumika/index/ghost.<id>.<hash>.json         one ghost's full file list and each file's version (read when that
                                                   ghost starts)
  SITE/sumika/index/ghost.<id>.<hash>.pack.gz      the ghost's text files in one gzip'd download
  SITE/sumika/index/balloon.<id>.<hash>.json       one balloon's: a shared one (site/balloon/<id>/), or one a ghost
                                                   bundles (site/ghost/<gid>/<id>/), listed for every ghost as SSP
                                                   installs it
  SITE/sumika/index/balloon.<id>.<hash>.pack.gz    its text files

Every name a page reads through ghosts.json is content-addressed (safe updates): a manifest is named
after the SHA-1 of its bytes (10 hex), a pack after the SHA-1 of its content before gzip (10 hex: gzip bytes differ by
zlib, and admin/core, the JS twin of this tool, deflates with Node's), a ghost or balloon file keeps its own name and
gets `versions`, the SHA-1 of its bytes (8 hex), which the runtime fetches as `?v=`. The same site gives the same names
and bytes, and a pack file that holds the same content is kept as it is, whichever tool wrote it; nothing in
sumika/index/ is deleted (the older manifests and packs are tools/prune.mjs's, run before an upload).
admin/core/index.mjs writes the same files (tests/admin/ and admin/parity.mjs compare the two): a change is made in
both.
Shells and balloons are listed in SSP's menu order (compare_names, as src/core/shells.js; BA §12.1).
A ghost's `engine` (and YAYA's `module`) comes from detect_engine. A site holding personal files is refused (a Kawari
ghost's save files by their header too: kawari_saves; but not those an add from the ghost's own .nar / .zip recorded in
SITE/sumika/kawari-shipped.json while they are unchanged: KAWARI_RECORD). This tool only reads that record, and refuses
the site while that file exists and does not read (KawariRecordError), as add_ghost.py refuses to add.
"""
import os, re, sys, json, gzip, hashlib, struct, fnmatch, zlib
from functools import cmp_to_key

# 2: hashed manifest names in ghosts.json `manifests`, `versions` (src/core/loader.js INDEX_FORMAT, kept equal by
# tests/runtime/index_versions.test.mjs); a reader of format 1 could not find the manifests
FORMAT = 2
NAME_HASH = 10          # hex digits of a manifest's or pack's SHA-1 in its name
VERSION_HASH = 8        # hex digits of a file's SHA-1 in its `?v=`


# ---- SSP's name order (ssp.exe 2.9.08f wcsicmpex / wcsicmp_custom [disasm]; the same rules as src/core/shells.js) ----

def _units(s):
    """UTF-16 code units, as SSP compares them"""
    b = str(s).encode('utf-16-le', 'surrogatepass')
    return struct.unpack(f'<{len(b) // 2}H', b)


def _fold(c):
    """SSP's case folding: Unicode simple lower case, except Latin-1 capitals"""
    if c < 0x100:
        return c + 32 if 0x41 <= c <= 0x5a else c
    if 0xd800 <= c <= 0xdfff:
        return c
    low = chr(c).lower()
    return ord(low) if len(low) == 1 and ord(low) < 0x10000 else c


def _ex_key(c):
    if 0xff01 <= c <= 0xff9f:          # full-width ASCII (and half-width kana) shifted down
        c -= 0xfee0
    elif 0x30a1 <= c <= 0x30f4:        # katakana = hiragana
        c -= 0x60
    return _fold(c)


def _is_digit(c):
    return 0x30 <= c <= 0x39 or 0xff10 <= c <= 0xff19


def _i32(n):
    n &= 0xffffffff
    return n - (1 << 32) if n >= 1 << 31 else n


def _run(u, i):
    """a digit run's value from u[i] (SSP: the first digit is not width-normalised) and the index after it"""
    n = u[i] - 0x30
    i += 1
    while i < len(u) and _is_digit(u[i]):
        n = _i32(n * 10 + (u[i] - 0x30 if u[i] <= 0x39 else u[i] - 0xff10))
        i += 1
    return n, i


def compare_names(a, b):
    """wcsicmpex: case-insensitive, digit runs compared as numbers"""
    a, b = _units(a), _units(b)
    i = j = 0
    while i < len(a) and j < len(b):
        ca, cb = a[i], b[j]
        if _is_digit(ca) and _is_digit(cb):
            na, i = _run(a, i)
            nb, j = _run(b, j)
            if na != nb:
                return 1 if na > nb else -1
            if i >= len(a) or j >= len(b):
                break
            ca, cb = a[i], b[j]
        ka, kb = _ex_key(ca), _ex_key(cb)
        if ka != kb:
            return 1 if ka > kb else -1
        i += 1
        j += 1
    if i >= len(a) and j >= len(b):
        return 0
    return -1 if j < len(b) else 1


def compare_folders(a, b):
    """wcsicmp_custom: plain case-insensitive"""
    a, b = _units(a), _units(b)
    for ca, cb in zip(a, b):
        ka, kb = _fold(ca), _fold(cb)
        if ka != kb:
            return 1 if ka > kb else -1
    return (len(a) > len(b)) - (len(a) < len(b))


def menu_order(entries):
    """by name, ties by folder id (SSP's SPProp::operator<): Balloon ▸, Shell ▸ and Change ghost ▸"""
    return sorted(entries, key=cmp_to_key(lambda x, y: compare_names(x['name'], y['name']) or compare_folders(x['id'], y['id'])))


def read_text(path):
    data = open(path, 'rb').read()
    head = data[:4096].decode('ascii', 'replace').lower()
    enc = 'utf-8' if ('charset,utf-8' in head or data[:3] == b'\xef\xbb\xbf') else 'cp932'
    return data.decode(enc, 'replace').lstrip('﻿')


def read_descript(path):
    """descript.txt / install.txt -> dict (first value wins, keys lower-cased)"""
    d = {}
    if not os.path.isfile(path):
        return d
    for line in read_text(path).splitlines():
        line = line.strip()
        if not line or line.startswith('//') or ',' not in line:
            continue
        k, v = line.split(',', 1)
        d.setdefault(k.strip().lower(), v.strip())
    return d


# What SSP and the engines write about the person using the ghost (names, birthday, stats). It must never be
# published: add_ghost.py leaves it out, and indexing refuses a site that has it.
PERSONAL_DIRS = {'profile'}
# Satori; YAYA/AYA saves (<module>_variable.cfg, .cfg.ays with save.encode; SSP's own list names yaya_variable.ays);
# engine logs (YAYA's `log` key; some archives even ship one)
PERSONAL_FILES = ('satori_savedata*', 'satori_savebackup*', '*_variable.*', '*.log')
# Files an SSP run created or rewrote inside one ghost, found by comparing the install with the ghost's archive by
# file names and contents (add_ghost.py --archive): ghost-root-relative patterns, any case. add_ghost.py leaves them out
# too.
PERSONAL_PATHS = (
    # bonsyou: what SSP's \![execute,http-get,…,--file=bonsyou.txt] downloaded, and its menu counter's
    # --file=bonsyou_now.txt (yaya_all.txt OnMenu_DispCount)
    'ghost/master/var/bonsyou*.txt',
    # bthver.5 (BloodTeaHOUSE ver.5): its saves (Save1 / Save3 in event.OnClose, OnGhostChanging, first-boot answers),
    # written by an SSP run; they hold what the user told it
    'ghost/master/savefile1.txt',
    'ghost/master/savebackup.txt',
)


def is_personal_path(rel):
    """a ghost-root-relative path that PERSONAL_PATHS names"""
    low = rel.replace('\\', '/').lower()
    return any(fnmatch.fnmatchcase(low, p.lower()) for p in PERSONAL_PATHS)


def is_personal(rel, ghost=False):
    """rel: a path below site/ghost or site/balloon ('<id>/…'); ghost: also PERSONAL_PATHS, without the '<id>/'"""
    parts = rel.lower().split('/')
    if any(d in PERSONAL_DIRS for d in parts[:-1]) or any(fnmatch.fnmatch(parts[-1], p) for p in PERSONAL_FILES):
        return True
    return ghost and is_personal_path('/'.join(parts[1:]))


# Kawari's saves have no fixed name: each ghost picks its own (savefile1.txt, dict-keeps-savedata.txt, brain/…), and
# BTH4th_last's holds the user's name, sex and birthday [corpus]. Its `save` / `savecrypt` start the file with a header
# [src libkawari/kawari_engine.cpp:313: "#", "# Kawari saved file", "#"; Phase 7.0 wrote 華和梨セーブファイル in CP932]. In a
# Kawari ghost (engine kawari or kawari7) a file that starts with it is refused, unless KAWARI_SHIPPED_SAVES lists it
# with the CRC-32 its archive has (an author's default; 16 such files in 9 corpus archives [measured]), or the site's
# record KAWARI_RECORD lists it for that ghost with its CRC-32. A net, not the gate: `textsave` writes no header, so
# add_ghost.py --archive and a PERSONAL_PATHS line per save stay the rule [decision: kawari-wasm.md §12].
KAWARI_ENGINES = ('kawari', 'kawari7')
KAWARI_SAVE_HEAD = re.compile(rb'#[ \t]*\r?\n#[ \t]*(?:Kawari saved file|'
                              + re.escape('華和梨セーブファイル'.encode('cp932')) + rb')[ \t]*\r?\n#')
# (ghost-root-relative path, CRC-32) of each such file a site ghost's archive ships as is, any case; add_ghost.py prints
# the line, e.g. ('ghost/master/runonce.txt', 0xe9a9075b),    # brynhild_conf1.13.nar
KAWARI_SHIPPED_SAVES = (
    ('ghost/master/mayura.ini', 0x1344d712),    # mayura_v350.nar
    ('ghost/master/news.dat', 0x2dbe2cb7),    # mayura_v350.nar
)
# A ghost added from its own .nar / .zip brings such files as the author's starting files [decision]:
# add_ghost.py --from-archive (and the admin core's archive source) copies them and
# records each, ghost-root-relative with its CRC-32, under the site folder's id in this site file, {"format": 1,
# "ghosts": {"<id>": [["ghost/master/x.txt", <crc32>], ...]}}; both index tools accept a file it lists for its ghost
# while the CRC-32 is the same. An add sets its ghost's entries (none: its key goes), admin/core's removal drops them,
# a record without entries is deleted. admin/core/shipped.mjs writes the same bytes: a change is made in both.
KAWARI_RECORD = 'sumika/kawari-shipped.json'
# Why a record that exists does not read (KawariRecordError.problem; admin/core/codes.mjs `record.*`, the same texts).
# Such a record is never read as empty [decision]: the next add or removal would write it again without the
# other ghosts' entries, and the index would then refuse their files as saves. So add_ghost.py, both index tools and
# the admin core's removal stop, nothing changed, until it is repaired or deleted (and those ghosts added again).
KAWARI_RECORD_PROBLEMS = {
    'record.open': 'opening it failed',
    'record.json': 'it is not JSON',
    'record.format': 'it is not a format 1 record',
    'record.entries': 'an entry is not a [path, CRC-32] pair',
}


class KawariRecordError(ValueError):
    """KAWARI_RECORD exists and does not read; `problem` is a KAWARI_RECORD_PROBLEMS key, str() what both tools print
    (admin/core/codes.mjs 'kawari.record', byte for byte)"""

    def __init__(self, problem):
        super().__init__(f'stopped, nothing changed: {KAWARI_RECORD} cannot be read: '
                         f'{KAWARI_RECORD_PROBLEMS[problem]}. That file is the site\'s list of the Kawari save-header '
                         'files that ghosts added from their own .nar or .zip brought (the index accepts such a file '
                         'while the list names it): repair it, or delete it and add those Kawari ghosts again from '
                         'their .nar or .zip')
        self.problem = problem


def _no_constant(name):
    raise ValueError(f'{name} is no JSON value')    # json.loads takes NaN and Infinity, JSON.parse does not


def _json_int(s):
    """json.loads' int; one of more digits than int() takes (int_max_str_digits, 4300) the float JSON.parse makes of
    it (inf), so such a number is no CRC-32 nor format 1 in both tools, and one under another key is ignored alike"""
    try:
        return int(s)
    except ValueError:
        return float(s)


def _writable(s):
    """a str UTF-8 can write: no lone surrogate (both JSON readers take an escaped one, "\\ud800", and neither tool
    could write the record again)"""
    try:
        s.encode('utf-8')
        return True
    except UnicodeEncodeError:
        return False


def kawari_saved(root, paths):
    """[(path, CRC-32)]: the files of paths (relative to root) that start with Kawari's save header"""
    found = []
    for rel in paths:
        with open(os.path.join(root, rel), 'rb') as f:
            head = f.read(128)
            if not KAWARI_SAVE_HEAD.match(head):
                continue
            found.append((rel, zlib.crc32(head + f.read()) & 0xFFFFFFFF))
    return found


def kawari_unlisted(root, paths, shipped=()):
    """[(path, CRC-32)] of kawari_saved that neither KAWARI_SHIPPED_SAVES nor `shipped` (the ghost's entries of the
    site's record) lists with these contents"""
    known = {(p.replace('\\', '/').lower(), crc) for p, crc in (*KAWARI_SHIPPED_SAVES, *shipped)}
    return [(p, crc) for p, crc in kawari_saved(root, paths) if (p.replace('\\', '/').lower(), crc) not in known]


def kawari_saves(root, paths, shipped=()):
    """the paths of kawari_unlisted"""
    return [p for p, _ in kawari_unlisted(root, paths, shipped)]


def read_kawari_record(site):
    """KAWARI_RECORD as {ghost id: [(path, CRC-32)]}; {} when it is missing. One that exists reads whole or raises
    KawariRecordError (never read as empty: KAWARI_RECORD_PROBLEMS): strict UTF-8, one BOM (an editor's) dropped; JSON
    as JSON.parse reads it (no NaN or Infinity; an int too long for int() as its float); {"format": 1, "ghosts": {id:
    [[path, CRC-32], ...]}}, every id a string UTF-8 can write (else record.format), every entry such a string and an
    int of 0..0xFFFFFFFF (a number written with a fraction or an exponent is no int), other keys ignored.
    admin/core/shipped.mjs readShipped reads the same, refuses the same with the same problem."""
    try:
        with open(os.path.join(site, *KAWARI_RECORD.split('/')), 'rb') as f:
            raw = f.read()
    except FileNotFoundError:
        return {}
    except OSError:
        raise KawariRecordError('record.open')
    try:
        data = json.loads(raw.decode('utf-8-sig'), parse_constant=_no_constant, parse_int=_json_int)
    except (ValueError, RecursionError):            # UnicodeDecodeError and JSONDecodeError are ValueErrors
        raise KawariRecordError('record.json')
    ok = isinstance(data, dict) and data.get('format') == 1 and not isinstance(data.get('format'), bool)
    ghosts = data.get('ghosts') if ok else None
    if not isinstance(ghosts, dict) or not all(_writable(gid) for gid in ghosts):    # the ids first: any order alike
        raise KawariRecordError('record.format')
    record = {}
    for gid, v in ghosts.items():
        if not isinstance(v, list) or not all(isinstance(e, list) and len(e) == 2 and isinstance(e[0], str)
                                              and _writable(e[0]) and type(e[1]) is int and 0 <= e[1] <= 0xFFFFFFFF
                                              for e in v):
            raise KawariRecordError('record.entries')
        record[gid] = [(e[0], e[1]) for e in v]
    return record


def kawari_record_bytes(record):
    """The record's bytes as both tools write them: the ghosts with entries by id, each one's entries by path (sorted),
    json.dumps with a 1-space indent, LF line ends; None when no ghost has entries"""
    ghosts = {gid: sorted([p, crc] for p, crc in v) for gid, v in sorted(record.items()) if v}
    if not ghosts:
        return None
    return (json.dumps({'format': 1, 'ghosts': ghosts}, ensure_ascii=False, indent=1) + '\n').encode('utf-8')


def set_kawari_record(site, gid, entries):
    """Sets ghost gid's entries of KAWARI_RECORD ([(path, CRC-32)]; none drops its key) and returns its old ones. The
    file is written only when its bytes change, atomically (a temporary file beside it, then a rename; a write or a
    rename that fails deletes the temporary file), and deleted when no ghost has entries left. A record that does not
    read raises KawariRecordError, nothing written: it is never written over."""
    path = os.path.join(site, *KAWARI_RECORD.split('/'))
    record = read_kawari_record(site)
    old = record.pop(gid, [])
    if entries:
        record[gid] = list(entries)
    data = kawari_record_bytes(record)
    if data is None:
        if os.path.isfile(path):
            os.remove(path)
        return old
    try:
        with open(path, 'rb') as f:
            if f.read() == data:
                return old
    except OSError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f'{path}.tmp-{os.urandom(4).hex()}'
    f = open(tmp, 'xb')                 # one of that name is not this run's: FileExistsError, left alone
    try:
        with f:
            f.write(data)
        os.replace(tmp, path)
        tmp = None
    finally:
        if tmp is not None:             # what a cut-off run leaves the admin program deletes (staging.mjs recoverWork)
            try:
                os.remove(tmp)
            except OSError:
                pass
    return old


def folder_engine(root, paths):
    """detect_engine's engine for a ghost folder on disk (paths: its ghost-root-relative files)"""
    d = read_descript(os.path.join(root, 'ghost', 'master', 'descript.txt'))
    return detect_engine(paths, lambda p: open(os.path.join(root, p), 'rb').read(), d)[0]


def personal_files(site):
    """the site files that hold a user's personal state; a Kawari record that does not read raises KawariRecordError
    first (without it a Kawari ghost's starting files cannot be told from saves)"""
    record = read_kawari_record(site)
    found = []
    for top in ('ghost', 'balloon'):
        d = os.path.join(site, top)
        if os.path.isdir(d):
            found += [f'{top}/{e[0]}' for e in file_list(d) if is_personal(e[0], top == 'ghost')]
    gdir = os.path.join(site, 'ghost')
    for gid in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        root = os.path.join(gdir, gid)
        if not os.path.isfile(os.path.join(root, 'ghost', 'master', 'descript.txt')):
            continue
        paths = [e[0] for e in file_list(root) if not is_personal(f'{gid}/{e[0]}', True)]
        if folder_engine(root, paths) in KAWARI_ENGINES:
            found += [f'ghost/{gid}/{p}' for p in kawari_saves(root, paths, record.get(gid, ()))]
    return found


# ---- the engine a ghost needs (the same rule as tools/sweep/views.mjs detectEngine; keep the two in step) ----
#
# The engine is the lower-cased stem of descript's `shiori` DLL (a missing line counts as shiori.dll), except for the
# AYA family: the site never has the DLL, so its config ghost/master/<stem>.txt decides. A listed dictionary that
# defines `request` is AYA5 / YAYA (engine 'yaya', and `module` = the stem: YAYA reads <module>.txt and saves
# <module>_variable.cfg); one that defines only `OnRequest` is AYA4 ('aya'); yaya.dll / aya5.dll with dictionaries
# that define neither (`request` in an encrypted .ayc) are 'yaya' too. Then Kawari by its files (kawari_phase).

NOT_AYA = ('satori', 'lang_switch', 'gcore')    # whatever <stem>.txt holds (the proxies run only in the sweep)
# Kawari (kawari-wasm.md §12 [decision]): after the AYA probe, for these stems (shiori: a missing line too; the corpus'
# 26 say shiori.dll or nothing): ghost/master/kawarirc.kis (any case), the only file Phase 8 loads, is 'kawari'; else
# ghost/master/kawari.ini (Phase 7, SHIORI/2.x) or a kawari* stem is 'kawari7' (nothing 8.2.8 could load); else the
# stem. Other stems keep their name: snow girl (satori.dll, Kawari only as a SAORI) stays satori. A future
# "satori_conf.txt -> satori" rule must come after this one: asri101 is a Satori emulator written in KIS.
KAWARI_STEMS = ('shiori', 'kawari', 'kawari8', 'kawarirc')
CONFIG_DEPTH = 8
_BOM = b'\xef\xbb\xbf'
_SPACE = ' \t\u3000'                             # YAYA's IsSpace


def shiori_stem(descript):
    """descript's `shiori` DLL without folder and extension, case kept ('shiori' without a line)"""
    name = (descript.get('shiori') or 'shiori.dll').replace('\\', '/').rsplit('/', 1)[-1]
    return re.sub(r'\.[^.]*$', '', name)


def _root_path(path):
    """`\\` as `/`, `.` and `..` resolved; None when the path leaves the ghost root"""
    out = []
    for p in path.replace('\\', '/').split('/'):
        if p in ('', '.'):
            continue
        if p == '..':
            if not out:
                return None
            out.pop()
        else:
            out.append(p)
    return '/'.join(out)


def _find_code(s, tok):
    """tok's index outside '…' and "…" (YAYA's Find_IgnoreDQ), or -1"""
    q = ''
    for i, c in enumerate(s):
        if q:
            if c == q:
                q = ''
        elif s.startswith(tok, i):
            return i
        elif c in '"\'':
            q = c
    return -1


def _code(line, block):
    """One line without comments, as YAYA's CComment: a line that starts with // goes, /* … */ may span lines (its
    start outside quotes), then // to the end outside quotes. Returns (code, still inside /* … */)."""
    if line.lstrip(' \t').startswith('//'):
        return '', block
    while True:
        if block:
            j = line.find('*/')
            if j < 0:
                return '', True
            line, block = line[j + 2:], False
        else:
            i = _find_code(line, '/*')
            if i < 0:
                break
            j = line.find('*/', i + 2)
            if j < 0:
                line, block = line[:i], True
                break
            line = line[:i] + line[j + 2:]
    i = _find_code(line, '//')
    return (line if i < 0 else line[:i]), block


def _lines(text):
    return re.split(r'\r\n|\r|\n', text)


def _folder(path):
    return path.rsplit('/', 1)[0] if '/' in path else ''


def config_dics(paths, read, module):
    """The dictionaries ghost/master/<module>.txt lists, as YAYA's config reader finds them (CBasis::SetParameter,
    basis.cpp:613-731): `dic` (missing files too) and `dicif` (only existing ones) relative to the current folder,
    `include` read in place, `includeEX` with its own folder as the current one, `dicdir` every file below a folder
    except *.bak / *.tmp (or its _loading_order[_override].txt, read as an includeEX). Keys in any case, at most
    CONFIG_DEPTH levels, each config read once. A config is UTF-8 with a BOM, else CP932 (ASCII outside comments).
    @param paths every ghost-root-relative file path; read(path) -> bytes. Returns ghost-root-relative paths ([] when
    there is no such config)."""
    by_lower = {p.lower(): p for p in paths}
    seen, dics = set(), []

    def dicdir(folder, cs, depth):
        if depth > CONFIG_DEPTH:
            return
        if not cs:
            for name in ('_loading_order_override.txt', '_loading_order.txt'):
                order = by_lower.get(f'{folder}/{name}'.lower())
                if order:
                    walk(order, folder, depth + 1)
                    return
        pre, subs = folder.lower() + '/', []
        for p in paths:
            if not p.lower().startswith(pre):
                continue
            first = p[len(pre):].split('/', 1)[0]
            if '.' in first and first.rsplit('.', 1)[1] in ('bak', 'tmp'):
                continue
            if '/' in p[len(pre):]:
                if first not in subs:
                    subs.append(first)
            else:
                dics.append(p)
        for s in subs:
            dicdir(f'{folder}/{s}', cs, depth + 1)

    def walk(real, base, depth):
        if depth > CONFIG_DEPTH or real.lower() in seen:
            return
        seen.add(real.lower())
        data = read(real)
        text = data[3:].decode('utf-8', 'replace') if data.startswith(_BOM) else data.decode('cp932', 'replace')
        block = False
        for line in _lines(text):
            line, block = _code(line, block)
            key, sep, param = line.partition(',')
            if not sep:
                continue
            key = key.strip(_SPACE).lower()
            path, _, cs = param.partition(',')
            target = _root_path(f'{base}/{path.strip(_SPACE)}')
            if not target:
                continue
            found = by_lower.get(target.lower())
            if key in ('include', 'includeex'):
                if found:
                    walk(found, base if key == 'include' else _folder(found), depth + 1)
            elif key == 'dic' or (key == 'dicif' and found):
                dics.append(found or target)
            elif key == 'dicdir':
                dicdir(target, cs.strip(_SPACE), depth + 1)

    config = by_lower.get(f'ghost/master/{module}.txt'.lower())
    if config:
        walk(config, 'ghost/master', 0)
    return dics


def defines(text, name):
    """a top-level-looking `NAME`, `NAME : option…` or `NAME {…` line outside comments (case-sensitive)"""
    pat = re.compile(r'^[ \t]*' + re.escape(name) + r'[ \t]*(?::[ \t]*[A-Za-z0-9_]+[ \t]*)*(?:\{.*)?$')
    block = False
    for line in _lines(text):
        line, block = _code(line, block)
        if pat.match(line):
            return True
    return False


def aya_config_kind(paths, read, module):
    """'yaya' when a dictionary ghost/master/<module>.txt lists defines `request` (AYA5 / YAYA), 'aya' when one defines
    `OnRequest` and none `request` (AYA4), 'unknown' when its dictionaries define neither (encrypted .ayc are not
    read), None when there is no such config or it lists no dictionary. Dictionaries are read byte for byte (Latin-1):
    the names are ASCII, and CP932 trail bytes are never a quote, `/` or `*`."""
    dics = config_dics(paths, read, module)
    if not dics:
        return None
    by_lower = {p.lower(): p for p in paths}
    aya = False
    for p in dict.fromkeys(d.lower() for d in dics):
        real = by_lower.get(p)
        if real is None or p.endswith('.ayc'):
            continue
        data = read(real)
        text = (data[3:] if data.startswith(_BOM) else data).decode('latin-1')
        if defines(text, 'request'):
            return 'yaya'
        aya = aya or defines(text, 'OnRequest')
    return 'aya' if aya else 'unknown'


def kawari_phase(paths, base):
    """'kawari', 'kawari7' or None for a ghost root's paths and its lower-cased shiori stem (KAWARI_STEMS)"""
    if base not in KAWARI_STEMS:
        return None
    low = {p.replace('\\', '/').lower() for p in paths}
    if 'ghost/master/kawarirc.kis' in low:
        return 'kawari'
    if 'ghost/master/kawari.ini' in low or base != 'shiori':
        return 'kawari7'
    return None


def detect_engine(paths, read, descript):
    """(engine, module or None) for a ghost root (see above)"""
    stem = shiori_stem(descript)
    base = stem.lower()
    if base not in NOT_AYA:
        kind = aya_config_kind(paths, read, stem)
        if kind == 'yaya' or (kind == 'unknown' and base in ('yaya', 'aya5')):
            return 'yaya', stem
        if kind == 'aya':
            return 'aya', None
    return kawari_phase(paths, base) or base, None


DEFAULT_BALLOON = 'sumika'          # Sumika's own balloon (tools/make_default_balloon.py)


def default_balloon(balloons):
    """The balloon SSP would call the user's default one: Sumika's own when the site has it, else the first
    shared balloon, else None (the runtime's built-in balloon). A page may override it (data-default-balloon)."""
    ids = [b['id'] for b in balloons]
    return DEFAULT_BALLOON if DEFAULT_BALLOON in ids else (ids[0] if ids else None)


PACK_EXT = ('.txt', '.dic', '.ini', '.csv', '.aym', '.sat', '.ayc')
# network-update lists and readmes stay out of the pack: Satori's worker never gets them (the readme window fetches its
# one file). A YAYA or Kawari ghost's worker gets every file of its ROOT_PACK_EXT pattern with its bytes
# (../../updates2.dau, readme.txt, Kawari's .kis), so its pack holds them all, and the engine's start needs no request
# of its own.
PACK_SKIP = ('updates', 'readme')
YAYA_PACK_EXT = re.compile(r'\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u)$', re.I)   # = YAYA_TEXT
KAWARI_PACK_EXT = re.compile(r'\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u|kis|kaw)$', re.I)   # = KAWARI_TEXT
# Kawari 7: Kawari's set plus the .kdf and .dat dictionaries Phase 7 ghosts name in kawari.ini (maria_re, mayura)
KAWARI7_PACK_EXT = re.compile(r'\.(txt|dic|ayc|aym|ini|csv|dau|json|xml|ya?ml|toml|html?|m3u|kis|kaw|kdf|dat)$', re.I)   # = KAWARI7_TEXT
ROOT_PACK_EXT = {'yaya': YAYA_PACK_EXT, 'kawari': KAWARI_PACK_EXT, 'kawari7': KAWARI7_PACK_EXT}    # src/core/engine-files.js, by ghosts.json engine
PACK_MAX = 4 * 1024 * 1024


def png_size(path):
    """width, height from a PNG's IHDR (PNA masks are PNGs too), or None"""
    with open(path, 'rb') as f:
        head = f.read(24)
    if head[1:4] == b'PNG' and head[12:16] == b'IHDR':
        return struct.unpack('>II', head[16:24])
    return None


def file_list(root):
    out = []
    for r, dirs, files in os.walk(root):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(r, f)
            entry = [os.path.relpath(p, root).replace(os.sep, '/'), os.path.getsize(p)]
            if f.lower().endswith(('.png', '.pna')):
                wh = png_size(p)
                if wh:
                    entry += list(wh)
            out.append(entry)
    return out


_versions = {}          # absolute path -> its version (a bundled balloon's files are listed twice)


def file_version(path):
    """A file's `?v=`: the SHA-1 of its bytes, VERSION_HASH hex (memoised per absolute path for one run)"""
    key = os.path.abspath(path)
    v = _versions.get(key)
    if v is None:
        with open(key, 'rb') as f:
            v = _versions[key] = hashlib.sha1(f.read()).hexdigest()[:VERSION_HASH]
    return v


def file_versions(root, files):
    """`versions` of a manifest: one per entry of files (file_list), in the same order"""
    return [file_version(os.path.join(root, e[0])) for e in files]


def write_if_changed(path, data):
    """Write bytes unless the file already holds them: a file left as it was keeps its mtime, which a server's ETag and
    Last-Modified and a sync upload compare (a touched file would be uploaded and downloaded again)"""
    try:
        with open(path, 'rb') as f:
            if f.read() == data:
                return
    except OSError:
        pass
    with open(path, 'wb') as f:
        f.write(data)


def write_manifest(manifest, out_dir, stem):
    """Write a manifest as <stem>.<hash>.json, the hash the SHA-1 of its bytes; returns its file name. The same manifest
    gives the same name and bytes (json.dumps, no sorting, no whitespace)."""
    data = json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    name = f'{stem}.{hashlib.sha1(data).hexdigest()[:NAME_HASH]}.json'
    write_if_changed(os.path.join(out_dir, name), data)
    return name


def index_versions(site, paths):
    """ghosts.json `versions`: {site path: its `?v=`} for each path ghosts.json names (thumbnails, icons)"""
    return {p: file_version(os.path.join(site, *p.split('/'))) for p in paths}


def named_paths(ghosts, balloons):
    """The site paths ghosts.json names: ghost, shell, bundled-balloon and balloon `thumbnails`, `icon`, `iconMinimize`"""
    out = []
    for g in ghosts:
        out += g.get('thumbnails', [])
        for k in ('icon', 'iconMinimize'):
            if g.get(k):
                out.append(g[k])
        for item in g.get('shells', []) + g.get('bundledBalloons', []):
            out += item.get('thumbnails', [])
    for b in balloons:
        out += b.get('thumbnails', [])
    return list(dict.fromkeys(out))


def write_pack_file(path, raw):
    """Write raw gzip'd unless the file already holds raw gzip'd, by any zlib (Node's deflates otherwise: the admin
    core's packs), so it keeps its bytes and mtime; returns the file's size"""
    try:
        with open(path, 'rb') as f:
            old = f.read()
        if gzip.decompress(old) == raw:
            return len(old)
    except (OSError, EOFError, zlib.error):
        pass
    gz = gzip.compress(raw, 9, mtime=0)
    with open(path, 'wb') as f:
        f.write(gz)
    return len(gz)


def write_pack(root, files, out_dir, stem, ext=None):
    """Pack a folder's text files into one gzip'd file named after the SHA-1 of the pack before gzip (see TextPack in
    src/core/loader.js): one content, one name, from this tool and from admin/core alike.
    ext: a root engine's pattern (ROOT_PACK_EXT), what its worker reads with bytes, every name; else PACK_EXT without
    PACK_SKIP."""
    entries, blobs, off = [], [], 0
    for entry in files:
        rel, size = entry[0], entry[1]
        name = rel.rsplit('/', 1)[-1].lower()
        wanted = ext.search(name) if ext else name.endswith(PACK_EXT) and not name.startswith(PACK_SKIP)
        if not wanted or size > PACK_MAX:
            continue
        data = open(os.path.join(root, rel), 'rb').read()
        entries.append([rel, off, len(data)])
        blobs.append(data)
        off += len(data)
    if not entries:
        return None
    header = json.dumps({'files': entries}, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    raw = b'SMKP' + struct.pack('<I', len(header)) + header + b''.join(blobs)
    name = f'{stem}.{hashlib.sha1(raw).hexdigest()[:NAME_HASH]}.pack.gz'
    size = write_pack_file(os.path.join(out_dir, name), raw)
    return name, len(entries), len(raw), size


def shell_entries(root):
    """Shell ▸'s shells [disasm SPGhostBase::EnumShells]: every shell/<dir>/ with a descript.txt (no `name`: 'default'),
    plus master/ or surface/ without one ('Default'); `menu,hidden` (any value containing 'hid') marks it hidden"""
    shells = []
    shell_root = os.path.join(root, 'shell')
    if os.path.isdir(shell_root):
        for s in sorted(os.listdir(shell_root)):
            sd = os.path.join(shell_root, s)
            if not os.path.isdir(sd):
                continue
            if os.path.isfile(os.path.join(sd, 'descript.txt')):
                sdesc = read_descript(os.path.join(sd, 'descript.txt'))
                entry = {'id': s, 'name': sdesc.get('name') or 'default'}
                if 'hid' in sdesc.get('menu', '').lower():
                    entry['hidden'] = True
            elif s.lower() in ('master', 'surface'):
                entry = {'id': s, 'name': 'Default'}
            else:
                continue
            shells.append(entry)
    return menu_order(shells)


def default_shell(descript, shells):
    """[disasm SPGhost::GetDefaultShellID] descript seriko.defaultsurfacedirectoryname (a folder), else master, else
    surface, else the first shell in name order (defaultShellId in src/core/shells.js)"""
    want = descript.get('seriko.defaultsurfacedirectoryname', '').strip().replace('\\', '/').strip('/')
    for f in (want, want.rsplit('/', 1)[-1], 'master', 'surface'):
        for s in shells if f else ():
            if compare_folders(s['id'], f) == 0:
                return s['id']
    return shells[0]['id'] if shells else None


def bundled_balloons(root):
    """balloons shipped inside a ghost folder (as in a .nar that bundles one): [{'dir', 'name'}] in folder order"""
    bundled = []
    for b in sorted(os.listdir(root)):
        bd = os.path.join(root, b)
        if os.path.isdir(bd) and b not in ('ghost', 'shell'):
            bdesc = read_descript(os.path.join(bd, 'descript.txt'))
            if bdesc.get('type', '').lower() == 'balloon' or os.path.isfile(os.path.join(bd, 'balloons0.png')):
                bundled.append({'dir': b, 'name': bdesc.get('name', b)})
    return bundled


# JLibGra's image extensions (ssp.exe 2.9.10 table at 0xb87910 [disasm]): 'tif' and 'mdi' match as a prefix ('tiff');
# 'exe' and 'dll' (icons in a program) are in the table too, but GetThumbnailReal skips them (code 12) [disasm]
THUMB_EXT = frozenset((
    'png', 'pnr', 'apng', 'apnr', 'dgp', 'dfp', 'ddp', 'dap', 'webp', 'gif', 'jpg', 'jpeg', 'jpe', 'jfif', 'jfi', 'jif',
    'pjpeg', 'pjp', 'bmp', 'dib', 'rle', 'btf', 'tf8', 'ico', 'cur', 'mag', 'pi', 'xbm', 'xpm', 'tga', 'targa', 'vda',
    'icb', 'vst', 'pbm', 'pgm', 'ppm', 'pam', 'pnm', 'pfm', 'pcx', 'qoi', 'psd', 'psp', 'pspimage', 'ora', 'kra', 'krz',
    'clip', 'lip', 'xcf'))
THUMB_EXT_PREFIX = ('tif', 'mdi')


def thumbnail_ext_ok(name):
    """SSP's test of a thumbnail candidate's extension [disasm SPUtils::GetExtension, JLibGra::IsLoadableExtension]:
    the text after the name's last '.', each UTF-16 unit cut to its low byte (so a full-width 'ｒ' reads as 'r'), at
    most 15, ASCII lower-cased"""
    if '.' not in name:
        return False
    ext = ''.join(chr(u & 0xff) for u in _units(name.rsplit('.', 1)[1])[:15])
    ext = ext.split('\0', 1)[0].translate({c: c + 32 for c in range(0x41, 0x5b)})
    return ext in THUMB_EXT or ext.startswith(THUMB_EXT_PREFIX)


def thumbnail_names(folder):
    """The files SSP finds with `thumbnail*.*` in a folder (any case) and takes as images [disasm
    SPProp::GetThumbnailReal], in NTFS order"""
    try:
        names = os.listdir(folder)
    except OSError:
        return []
    found = [n for n in names if n.lower().startswith('thumbnail') and thumbnail_ext_ok(n)
             and os.path.isfile(os.path.join(folder, n))]
    return sorted(found, key=lambda n: (n.upper(), n))


def ghost_thumbnails(root, gid):
    """A ghost's thumbnail candidates as site paths [disasm SPGhostProp::GetThumbnail]: the ghost folder's, else
    ghost/master/'s; SSP picks one at random each time it shows one (genrand)"""
    names = thumbnail_names(root)
    if names:
        return [f'ghost/{gid}/{n}' for n in names]
    return [f'ghost/{gid}/ghost/master/{n}' for n in thumbnail_names(os.path.join(root, 'ghost', 'master'))]


def descript_last(path, keys):
    """The value of the descript's last line whose key (any case) is one of `keys` (lower case), else None: ssp.exe's
    LoadDescript assigns on every line, so the last one wins [disasm 0x6241f0] (read_descript keeps the first). Lines
    split as src/core/trayicon.js descriptIcons splits them"""
    if not os.path.isfile(path):
        return None
    found = None
    for line in re.split(r'\r\n|\r|\n', read_text(path)):
        line = line.strip()
        if not line or line.startswith('//') or ',' not in line:
            continue
        k, v = line.split(',', 1)
        if k.strip().lower() in keys:
            found = v.strip()
    return found


def icon_rel(name, base=''):
    """An icon name as a ghost-root-relative path (src/core/trayicon.js iconRel): '\\' as '/', empty and '.' segments
    dropped, '..' going up; None when it would leave the ghost folder or names a drive (':') [decision: a site serves
    the ghost folder only]"""
    if not name or ':' in name:
        return None
    out = []
    for seg in f'{base}/{name}'.replace('\\', '/').split('/'):
        if seg in ('', '.'):
            continue
        if seg == '..':
            if not out:
                return None
            out.pop()
        else:
            out.append(seg)
    return '/'.join(out) or None


def find_icon(by_lower, name):
    """Where ssp.exe finds an icon file [disasm SPGhost::GetIconName 0x6373c0, GetIconMinimizeName 0x6375f0]: the ghost
    root + name, then ghost\\master\\ + name, the first file that exists (any case); its real path, else None.
    Numbered frames (icon1.ico…) are not followed (trayicon.js findIcon) [decision]. by_lower: {lower path: path}"""
    for base in ('', 'ghost/master/'):
        rel = icon_rel(name, base)
        if rel and rel.lower() in by_lower:
            return by_lower[rel.lower()]
    return None


def ghost_icons(root, gid, files):
    """A ghost's tray icons as site paths (ssp-ui.md §2.6; trayicon.js ghostIcons): `icon` = descript icon /
    iconfilename (the last line; none or empty: icon.ico) [disasm LoadDescript 0x6246ad, GetIconName 0x637423],
    `iconMinimize` = descript icon.minimize (none: no key) [disasm GetIconMinimizeName 0x637652]; each only when its
    file exists"""
    desc = os.path.join(root, 'ghost', 'master', 'descript.txt')
    by_lower = {e[0].lower(): e[0] for e in files}
    out = {}
    icon = find_icon(by_lower, descript_last(desc, ('icon', 'iconfilename')) or 'icon.ico')
    if icon:
        out['icon'] = f'ghost/{gid}/{icon}'
    name = descript_last(desc, ('icon.minimize',))
    minimize = find_icon(by_lower, name) if name else None
    if minimize:
        out['iconMinimize'] = f'ghost/{gid}/{minimize}'
    return out


def ghost_entry(site, gid):
    root = os.path.join(site, 'ghost', gid)
    d = read_descript(os.path.join(root, 'ghost', 'master', 'descript.txt'))
    inst = read_descript(os.path.join(root, 'install.txt'))
    shells = shell_entries(root)
    bundled = bundled_balloons(root)
    # Shell ▸ / Balloon ▸ thumbnails (ssp-ui.md §2.14): SPProp::GetThumbnail, `thumbnail*.*` in the item's own folder
    for sh in shells:
        th = [f'ghost/{gid}/shell/{sh["id"]}/{n}' for n in thumbnail_names(os.path.join(root, 'shell', sh['id']))]
        if th:
            sh['thumbnails'] = th
    for b in bundled:
        th = [f'ghost/{gid}/{b["dir"]}/{n}' for n in thumbnail_names(os.path.join(root, b['dir']))]
        if th:
            b['thumbnails'] = th
    preferred = None
    if inst.get('balloon.directory') and any(b['dir'] == inst['balloon.directory'] for b in bundled):
        preferred = inst['balloon.directory']
    elif bundled:
        preferred = bundled[0]['dir']
    shiori = d.get('shiori', 'shiori.dll')
    files = file_list(root)
    engine, module = detect_engine([e[0] for e in files], lambda p: open(os.path.join(root, p), 'rb').read(), d)
    entry = {
        'id': gid,
        'name': d.get('name', gid),
        'sakuraName': d.get('sakura.name', ''),
        'keroName': d.get('kero.name', ''),
        'craftman': d.get('craftmanw') or d.get('craftman', ''),
        'shiori': shiori,
        'engine': engine,
    }
    if module is not None:                      # YAYA's <module>.txt / <module>_variable.cfg
        entry['module'] = module
    entry.update({
        'thumbnails': ghost_thumbnails(root, gid),
        **ghost_icons(root, gid, files),        # the launcher's image (the tray icon, ssp-ui.md §2.6)
        'shells': shells,
        'defaultShell': default_shell(d, shells),
        'bundledBalloons': bundled,
        'balloon': preferred or d.get('balloon') or None,
    })
    manifest = {'format': FORMAT, 'id': gid, 'root': f'ghost/{gid}/', 'files': files, 'versions': file_versions(root, files)}
    return entry, manifest, root


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(errors='backslashreplace')     # folder names in a console without their characters
    site = os.path.abspath(argv[0] if argv else os.path.join(os.path.dirname(__file__), '..', 'site'))
    out = os.path.join(site, 'sumika', 'index')
    try:
        personal = personal_files(site)
    except KawariRecordError as e:
        sys.exit(str(e))
    if personal:
        sys.exit('refusing to index: these files hold a user\'s personal state and must not be published:\n  '
                 + '\n  '.join(personal) + '\ndelete them from the site (tools/add_ghost.py copies ghosts without them); '
                 'in a Kawari ghost a file that starts with Kawari\'s save header counts, unless KAWARI_SHIPPED_SAVES '
                 f'lists it with its archive\'s CRC-32, or {KAWARI_RECORD} lists it unchanged since the ghost was added '
                 'from its .nar or .zip')
    os.makedirs(out, exist_ok=True)
    # nothing here is deleted: a page still running the last version reads its own manifests and packs, which
    # tools/prune.mjs removes once no upload needs them
    _versions.clear()                   # this run's files (add_ghost.py calls main after copying)
    ghosts, balloons = [], []
    manifests = {'ghost': {}, 'balloon': {}}
    gdir = os.path.join(site, 'ghost')
    for gid in sorted(os.listdir(gdir)) if os.path.isdir(gdir) else []:
        if not os.path.isfile(os.path.join(gdir, gid, 'ghost', 'master', 'descript.txt')):
            continue
        entry, manifest, root = ghost_entry(site, gid)
        ghosts.append(entry)
        packed = write_pack(root, manifest['files'], out, f'ghost.{gid}', ROOT_PACK_EXT.get(entry['engine']))
        if packed:
            manifest['pack'] = f'sumika/index/{packed[0]}'
            print(f'  {gid}: packed {packed[1]} text files, {packed[2] // 1024} KB -> {packed[3] // 1024} KB gzip')
        manifests['ghost'][gid] = f'sumika/index/{write_manifest(manifest, out, f"ghost.{gid}")}'

    def add_balloon(bid, root, rel, entry):
        th = [rel + n for n in thumbnail_names(root)]        # Balloon ▸ thumbnails (ssp-ui.md §2.14)
        if th:
            entry['thumbnails'] = th
        bfiles = file_list(root)
        bman = {'format': FORMAT, 'id': bid, 'root': rel, 'files': bfiles, 'versions': file_versions(root, bfiles)}
        packed = write_pack(root, bfiles, out, f'balloon.{bid}')
        if packed:
            bman['pack'] = f'sumika/index/{packed[0]}'
        manifests['balloon'][bid] = f'sumika/index/{write_manifest(bman, out, f"balloon.{bid}")}'
        balloons.append(entry)

    bdir = os.path.join(site, 'balloon')
    for bid in sorted(os.listdir(bdir)) if os.path.isdir(bdir) else []:
        root = os.path.join(bdir, bid)
        if not os.path.isfile(os.path.join(root, 'descript.txt')):
            continue
        bdesc = read_descript(os.path.join(root, 'descript.txt'))
        add_balloon(bid, root, f'balloon/{bid}/', {'id': bid, 'name': bdesc.get('name', bid)})
    default = default_balloon(balloons)         # chosen among the site's own balloons only
    # SSP installs a ghost's bundled balloon into the shared balloon/ folder, so every ghost can wear it (BA §1.6): list
    # it with its own manifest and pack (another ghost never downloads this one's dictionaries). A site balloon with the
    # same folder id wins, then the first ghost in id order [guess: in SSP the later install overwrites the folder].
    taken = {b['id'].lower(): b for b in balloons}
    for g in ghosts:
        for b in g['bundledBalloons']:
            if b['dir'].lower() in taken:
                if taken[b['dir'].lower()].get('ghost') != g['id']:
                    print(f'  {g["id"]}/{b["dir"]}: not listed for other ghosts, the folder id is taken')
                continue
            entry = {'id': b['dir'], 'name': b['name'], 'ghost': g['id']}
            taken[b['dir'].lower()] = entry
            add_balloon(b['dir'], os.path.join(gdir, g['id'], b['dir']), f'ghost/{g["id"]}/{b["dir"]}/', entry)
    balloons = menu_order(balloons)
    # Change ghost ▸'s order, as ssp.exe lists the ghosts: by descript name, ties by folder [observed];
    # the loops above stay in id order (the lines they print, the ghost whose bundled balloon takes an id)
    ghosts = menu_order(ghosts)
    index = {'format': FORMAT, 'ghosts': ghosts, 'balloons': balloons, 'defaultBalloon': default,
             'manifests': manifests, 'versions': index_versions(site, named_paths(ghosts, balloons))}
    # last: it names everything above (lines end as a text-mode write on this system ends them)
    text = json.dumps(index, ensure_ascii=False, indent=1).replace('\n', os.linesep)
    write_if_changed(os.path.join(out, 'ghosts.json'), text.encode('utf-8'))
    shared = sum(1 for b in balloons if 'ghost' not in b)
    print(f'indexed {len(ghosts)} ghost(s), {shared} shared balloon(s) + {len(balloons) - shared} bundled, '
          f'default balloon {default} -> {out}')


if __name__ == '__main__':
    main()
