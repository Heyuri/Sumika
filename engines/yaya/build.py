"""Compile YAYA (vendor/yaya-shiori) to WebAssembly.

usage: python engines/yaya/build.py [--opt O2|Oz] [--debug] [--out DIR] [--allow-vendor-drift] [-j N]
output in DIR (default site/sumika/engines; a --debug build engines/yaya/build/out-debug unless --out is given):
yaya.js + yaya.wasm, yaya.build-info.json, yaya.LICENSES.txt (the texts of everything compiled in)

Steps (docs/research/yaya-wasm.md):
 0. check the inputs: vendor/yaya-shiori and its five submodules at the commits in PINNED, with a clean tree, when it
    is a git checkout of its own; the repository's copy (no .git: engines/common/vendor.py), the files the build reads
    against INPUTS_PIN (else stop, unless --allow-vendor-drift, which build-info records as drift); the emcc version
    goes into build-info and into every object's hash
 1. copy into engines/yaya/build/src: the root .cpp/.h decoded from CP932 (strict) to UTF-8 with LF line ends; the root
    .c files, parson, tinyxml2, sqlite, deelx.h and gumbo/src byte for byte (what makefile.linux compiles)
 2. generate cp932_table.h (engines/common/gen_cp932.py, shared with Satori and checked against the dumps made on
    Windows in engines/common/cp932) and messagetxt_builtin.h (msgtables.py); apply patches.py
 3. compile makefile.linux's three groups with em++/emcc (unchanged objects are kept: obj-O2, obj-Oz, obj-debug), link,
    patch the linked yaya.js (patches.JS_PATCHES: J1, MEMFS), and refuse output that names the builder's folders (user
    name)
 4. write build-info and yaya.LICENSES.txt: every notice in the code compiled in (engines/common/notices.py)
"""
import os, re, sys, shutil, subprocess, argparse, concurrent.futures, json, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
REPO = os.path.join(ROOT, 'vendor', 'yaya-shiori')
COMMON = os.path.join(ROOT, 'engines', 'common')
BUILD = os.path.join(HERE, 'build')
SRC = os.path.join(BUILD, 'src')
OUT = os.path.join(ROOT, 'site', 'sumika', 'engines')
OUT_DEBUG = os.path.join(BUILD, 'out-debug')
EMSDK = os.path.join(ROOT, 'toolchain', 'emsdk')
PY = os.path.join(EMSDK, 'python', '3.13.3_64bit', 'python.exe')
EMXX = [PY if os.path.exists(PY) else sys.executable, os.path.join(EMSDK, 'upstream', 'emscripten', 'em++.py')]
EMCC = [EMXX[0], os.path.join(EMSDK, 'upstream', 'emscripten', 'emcc.py')]
ENV = {**os.environ, 'EM_CONFIG': os.path.join(EMSDK, '.emscripten'), 'PYTHONDONTWRITEBYTECODE': '1',
       'EMSDK_PYTHON': PY}   # emcc.exe rebuilds a library missing from emsdk's cache with it (engines/kawari/build.py)

sys.dont_write_bytecode = True   # no __pycache__ beside patches.py
sys.path.insert(0, HERE)
sys.path.insert(0, COMMON)
import patches  # noqa: E402
import notices  # noqa: E402
import vendor  # noqa: E402
from msgtables import write_builtin_messages  # noqa: E402

# Tc606-2 and its submodules (git submodule status). Upstream moves daily; a new pin means re-matching the
# patches (each must match exactly once) and re-running the gates. The patch anchors guard only the root sources:
# sqlite3.c, gumbo, parson and tinyxml2 are copied as they are, so these commits are what pins them.
PINNED = {
    '.': 'e69fefb2c713360eef590fa031d63135586a0933',
    'deelx': 'af1a690cc8333620ca4f86f46058bb9b8eaf055f',
    'gumbo': 'c8846007c4d9a86046102c99fdbbd295f366f813',
    'parson': 'ec53fb6528b45811df9db0db22cab96a94a96a11',
    'sqlite': 'f0bc67bdbde2f8ebebc72a7bd02d342541814ab0',
    'tinyxml2': '007577b22c50b4d8bc72f127644669f4096773bb',
}
NEEDED = ['parson/parson.c', 'tinyxml2/tinyxml2.cpp', 'sqlite/sqlite3.c', 'deelx/deelx.h', 'gumbo/src/parser.c']
# The repository's copy of vendor/yaya-shiori (no .git of its own: engines/common/vendor.py) is of PINNED; the files
# the build reads from it (prepare, msgtables.py, licenses: inputs()) have this pin. A new pin means a new copy.
INPUTS_PIN = '261b2c049541babdf5062ae5e6b1d314b1fae3c902e2c32c3dcd70c9996ee2d9'   # 151 files

# makefile.linux LIBAYA5_OBJ, split by how the makefile compiles each one
CXX_CPP = '''aya5 ayavm basis ccct comment dir_enum duplevinfo file file1 function globalvariable html jsonxml lib lib1
localvariable log logexcode manifest messages misc mt19937ar parser0 parser1 selecter sqlitedb sysfunc value variable
wsex yamltoml posix_utils tinyxml2/tinyxml2'''.split()
CXX_C = 'crc32 md5c sha1 parson/parson'.split()          # its .c.o rule uses $(CXX): compiled as C++
CC_C = ['sqlite3_yaya'] + ['gumbo/src/' + n for n in      # must be C (sqlite3_yaya.c #includes sqlite/sqlite3.c)
        'attribute char_ref char_ref_gperf error parser string_buffer string_piece tag tokenizer utf8 util vector'.split()]
INCLUDED = ['sqlite/sqlite3.c']                           # compiled through another file: hashed like a header

EXPORTED = ['_load', '_request', '_unload', '_malloc', '_free', '_CI_check_failed', '_yaya_set_module_name',
            '_yaya_save', '_yaya_load_resume', '_yaya_load_status']
RUNTIME = ['FS', 'HEAPU8', 'HEAP32', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8', 'ENV']


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', env=ENV)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def git(*args, repo=REPO):
    r = subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ''


def inputs():
    """What the build reads from vendor/yaya-shiori: the files directly in it (the sources prepare copies, LICENSE and
    the notices' sources among them), messagetxt/ and gumbo/src/ (below too), and the submodules' files it copies or
    quotes."""
    return (vendor.listed(REPO) + vendor.listed(REPO, 'messagetxt', recursive=True)
            + vendor.listed(REPO, 'gumbo/src', recursive=True)
            + ['parson/parson.c', 'parson/parson.h', 'parson/LICENSE', 'tinyxml2/tinyxml2.cpp', 'tinyxml2/tinyxml2.h',
               'tinyxml2/LICENSE.txt', 'sqlite/sqlite3.c', 'sqlite/sqlite3.h', 'sqlite/sqlite3ext.h', 'sqlite/LICENSE',
               'deelx/deelx.h', 'gumbo/doc/COPYING'])


def check_vendor(allow_drift):
    """The vendor commits ({'.': root, submodule: commit}) and whether they differ from PINNED or the tree is dirty
    (a git checkout of its own), or whether the files the build reads differ from INPUTS_PIN (the repository's copy)."""
    missing = [n for n in NEEDED if not os.path.isfile(os.path.join(REPO, n))]
    if missing:
        sys.exit(f'missing {", ".join(missing)}: run  git -C vendor/yaya-shiori submodule update --init parson tinyxml2 '
                 'deelx sqlite gumbo')
    if vendor.own_checkout(REPO):
        commits = {k: git('rev-parse', 'HEAD', repo=REPO if k == '.' else os.path.join(REPO, k)) for k in PINNED}
        problems = [f'{"vendor/yaya-shiori" if k == "." else k} is at {commits[k] or "?"}, expected {v}'
                    for k, v in PINNED.items() if commits[k] != v]
        dirty = git('status', '--porcelain')   # submodules' changes included
        if dirty:
            problems.append('vendor/yaya-shiori has local changes:\n' + dirty)
    else:   # the repository's copy: git there would answer for the enclosing repository
        commits = dict(PINNED)
        pin, n = vendor.files_pin(REPO, inputs())
        problems = [] if pin == INPUTS_PIN else [
            f'the {n} files the build reads from vendor/yaya-shiori have pin {pin}, expected {INPUTS_PIN}']
    if problems and not allow_drift:
        sys.exit('\n'.join(problems) + '\n(pass --allow-vendor-drift to build anyway; build-info then says drift)')
    for p in problems:
        print('warning: ' + p)
    return commits, bool(problems)


def emcc_version():
    code, out = run(EMCC + ['--version'])
    m = re.search(r'\d+\.\d+\.\d+ \([0-9a-f]+\)', out)
    if code or not m:
        sys.exit('emcc --version failed:\n' + out)
    return m.group(0)


def prepare():
    if os.path.isdir(SRC):
        shutil.rmtree(SRC)
    os.makedirs(SRC)
    for f in sorted(os.listdir(REPO)):
        p = os.path.join(REPO, f)
        ext = os.path.splitext(f)[1].lower()
        if not os.path.isfile(p) or ext not in ('.cpp', '.h', '.c'):
            continue
        with open(p, 'rb') as fh:
            raw = fh.read()
        if ext == '.c':
            with open(os.path.join(SRC, f), 'wb') as fh:
                fh.write(raw)
        else:   # non-ASCII in the headers is comments only, apart from one literal under !POSIX (misc.h)
            with open(os.path.join(SRC, f), 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(raw.decode('cp932').replace('\r\n', '\n'))
    for sub, names in (('parson', ['parson.c', 'parson.h']), ('tinyxml2', ['tinyxml2.cpp', 'tinyxml2.h']),
                       ('sqlite', ['sqlite3.c', 'sqlite3.h', 'sqlite3ext.h']), ('deelx', ['deelx.h'])):
        os.makedirs(os.path.join(SRC, sub))
        for n in names:
            shutil.copyfile(os.path.join(REPO, sub, n), os.path.join(SRC, sub, n))
    shutil.copytree(os.path.join(REPO, 'gumbo', 'src'), os.path.join(SRC, 'gumbo', 'src'))

    code, out = run([sys.executable, '-I', os.path.join(COMMON, 'gen_cp932.py'), os.path.join(SRC, 'cp932_table.h'),
                     '--verify', os.path.join(COMMON, 'cp932')])
    if code:
        sys.exit(out)
    print(out.strip())
    write_builtin_messages(SRC, REPO)
    for rel, old, new in patches.PATCHES:
        p = os.path.join(SRC, rel)
        with open(p, encoding='utf-8') as fh:
            text = fh.read()
        n = text.count(old)
        if n != 1:
            sys.exit(f'patch for {rel}: expected exactly one match, found {n}:\n{old[:300]}')
        with open(p, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text.replace(old, new))
    print(f'{len(patches.PATCHES)} patches applied')


def headers_hash():
    h = hashlib.sha1()
    for d, dirs, files in os.walk(SRC):
        dirs.sort()
        for f in sorted(files):
            rel = os.path.relpath(os.path.join(d, f), SRC).replace('\\', '/')
            if f.endswith('.h') or rel in INCLUDED:
                h.update(rel.encode())
                with open(os.path.join(d, f), 'rb') as fh:
                    h.update(fh.read())
    return h.hexdigest()


def patch_js(path):
    """patches.JS_PATCHES on the linked yaya.js (Emscripten's MEMFS); each expression must match exactly once. Line
    ends stay as emcc wrote them."""
    with open(path, encoding='utf-8', newline='') as fh:
        js = fh.read()
    for name, old, new in patches.JS_PATCHES:
        js, n = re.subn(old, new, js)
        if n != 1:
            sys.exit(f'JS patch {name}: expected exactly one match in yaya.js, found {n} (a new emcc?)')
    with open(path, 'w', encoding='utf-8', newline='') as fh:
        fh.write(js)
    print(f'{len(patches.JS_PATCHES)} JS patches applied')


def builder_marks():
    """Strings that would put the builder's folders (with the Windows user name) into a published file. AppData only
    as a folder: a debug build's DWARF has SQLite's parameter pAppData."""
    tail = os.path.splitdrive(os.path.expanduser('~'))[1].strip('\\/')      # Users\<name>
    return sorted({m for m in (tail, tail.replace('\\', '/'), 'AppData\\', 'AppData/', ROOT, ROOT.replace('\\', '/'))
                   if m})


def licenses(commits, version):
    def text(rel):
        return notices.file_text(os.path.join(REPO, rel))

    def notice(rel, first, last):   # the root sources are CP932
        return notices.comment_notice(os.path.join(REPO, rel), first, last, 'utf-8' if '/' in rel else 'cp932')

    parts = [
        f'yaya.wasm and yaya.js are YAYA {version} (https://github.com/YAYA-shiori/yaya-shiori, commit\n'
        f'{commits["."]}), compiled to WebAssembly with patches by Sumika (engines/yaya/build.py),\n'
        'and the code compiled into it. Every notice in that code follows (sha1.c, the SHA-1 of RFC 3174, has none).\n',
        '== YAYA (BSD-3-Clause), LICENSE\n\n' + text('LICENSE'),
        '== MT19937 (BSD-3-Clause), mt19937ar.cpp, its header:\n\n'
        + notice('mt19937ar.cpp', 'Copyright (C) 1997 - 2002', 'EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE'),
        '== MD5 (md5c.c): the RSA Data Security, Inc. MD5 Message-Digest Algorithm, its header:\n\n'
        + notice('md5c.c', 'Copyright (C) 1991-2, RSA Data Security', 'documentation and/or software.'),
        '== CRC-32 (crc32.c, from zlib), its header:\n\n'
        + notice('crc32.c', 'Copyright (C) 1995-2002 Mark Adler', 'Modified for AYA5'),
        '== parson (MIT), parson/LICENSE\n\n' + text('parson/LICENSE'),
        '== TinyXML-2 (zlib), tinyxml2/LICENSE.txt\n\n' + text('tinyxml2/LICENSE.txt'),
        '== Gumbo (Apache-2.0), gumbo/src/*.c: Copyright 2010 Google Inc. All Rights Reserved. (char_ref.c, tag.c\n'
        'and four headers: Copyright 2011 Google Inc. All Rights Reserved.)\n\n'
        + text('gumbo/doc/COPYING'),
        "== Gumbo's UTF-8 decoder (MIT), gumbo/src/utf8.c, its header:\n\n"
        + notice('gumbo/src/utf8.c', 'Copyright (c) 2008-2009 Bjoern Hoehrmann', 'all copies or substantial portions'),
        '== DEELX (deelx/deelx.h), its header:\n\n' + notices.head_lines(os.path.join(REPO, 'deelx', 'deelx.h'), 12),
        '== SQLite (sqlite/sqlite3.c, the amalgamation): public domain. Its header reads: "The author disclaims\n'
        'copyright to this source code. In place of a legal notice, here is a blessing: May you do good and not\n'
        'evil. May you find forgiveness for yourself and forgive others. May you share freely, never taking more\n'
        'than you give."\n',
        '== sqlite/LICENSE (the BSD licence of the sqlite-amalgamation repository YAYA takes SQLite from)\n\n'
        + text('sqlite/LICENSE'),
        notices.emscripten(EMSDK),
    ]
    return '\n'.join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--opt', choices=['O2', 'Oz'], default='O2')
    ap.add_argument('--debug', action='store_true', help='-O0 -g with assertions; written outside site/ unless --out')
    ap.add_argument('--out', help='output folder (default site/sumika/engines, or engines/yaya/build/out-debug)')
    ap.add_argument('--allow-vendor-drift', action='store_true')
    ap.add_argument('-j', type=int, default=os.cpu_count() or 4)
    a = ap.parse_args()
    out_dir = os.path.abspath(a.out) if a.out else OUT_DEBUG if a.debug else OUT
    commits, drift = check_vendor(a.allow_vendor_drift)
    emcc = emcc_version()
    prepare()

    variant = 'debug' if a.debug else a.opt
    opt = ['-O0', '-g'] if a.debug else ['-' + a.opt]
    common = opt + ['-fwasm-exceptions', '-DPOSIX', '-D_FILE_OFFSET_BITS=64', '-I', SRC, '-Wall',
                    # assert() strings would otherwise carry the builder's absolute path (user name) into the wasm
                    '-ffile-prefix-map=' + SRC + '=src', '-ffile-prefix-map=' + SRC.replace('\\', '/') + '=src']
    if a.debug:   # DWARF names the working directory (comp_dir) and the emsdk headers (libc++ lambdas) too
        common += ['-fdebug-compilation-dir=.', '-ffile-prefix-map=' + EMSDK + '=emsdk',
                   '-ffile-prefix-map=' + EMSDK.replace('\\', '/') + '=emsdk']
    cxxflags = common + ['-std=c++11']
    jobs = [(s, '.cpp', EMXX, cxxflags) for s in CXX_CPP] + \
           [(s, '.c', EMXX, cxxflags + ['-x', 'c++']) for s in CXX_C] + \
           [(s, '.c', EMCC, common) for s in CC_C]
    objdir = os.path.join(BUILD, 'obj-' + variant)
    logdir = os.path.join(BUILD, 'logs-' + variant)
    os.makedirs(objdir, exist_ok=True)
    os.makedirs(logdir, exist_ok=True)
    hh = headers_hash()

    def compile_one(job):
        s, ext, tool, flags = job
        src = os.path.join(SRC, s + ext)
        obj = os.path.join(objdir, s.replace('/', '__') + '.o')
        stamp = obj + '.hash'
        with open(src, 'rb') as fh:
            h = hashlib.sha1(fh.read() + (hh + ' '.join(tool + flags) + emcc).encode()).hexdigest()
        if os.path.exists(obj) and os.path.exists(stamp) and open(stamp).read() == h:
            return s, obj, 0, '', True
        code, out = run(tool + flags + ['-c', src, '-o', obj])
        with open(os.path.join(logdir, s.replace('/', '__') + '.log'), 'w', encoding='utf-8') as fh:
            fh.write(out)
        if code == 0:
            with open(stamp, 'w') as fh:
                fh.write(h)
        return s, obj, code, out, False

    objs, failed, warnings = [], [], 0
    with concurrent.futures.ThreadPoolExecutor(a.j) as ex:
        for s, obj, code, out, cached in ex.map(compile_one, jobs):
            objs.append(obj)
            warnings += out.count('warning:')
            print(f'{"FAIL" if code else "same" if cached else "ok  "} {s}')
            if code:
                failed.append((s, out))
    if failed:
        for s, out in failed:
            print(f'\n===== {s}\n' + '\n'.join(out.splitlines()[:60]))
        sys.exit(1)
    if warnings:
        print(f'{warnings} compiler warnings (logs in {os.path.relpath(logdir, ROOT)})')

    # link next to the objects, check, then move: a failed check leaves the published files as they were
    link_dir = os.path.join(BUILD, 'link-' + variant)
    os.makedirs(link_dir, exist_ok=True)
    ldflags = opt + ['-fwasm-exceptions',
                     '-sMODULARIZE=1', '-sEXPORT_NAME=createYaya', '-sENVIRONMENT=web,worker,node',
                     '-sFORCE_FILESYSTEM=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=32MB',
                     '-sSTACK_SIZE=1MB', '-sCASE_INSENSITIVE_FS=1',
                     '-sEXPORTED_FUNCTIONS=' + ','.join(EXPORTED),
                     '-sEXPORTED_RUNTIME_METHODS=' + ','.join(RUNTIME)]
    if a.debug:
        ldflags += ['-sASSERTIONS=2', '-sSTACK_OVERFLOW_CHECK=2']
    code, out = run(EMXX + objs + ldflags + ['-o', os.path.join(link_dir, 'yaya.js')])
    if code:
        print(out)
        sys.exit(1)
    if out.strip():
        print(out.strip()[:2000])
    patch_js(os.path.join(link_dir, 'yaya.js'))
    marks = builder_marks()
    for f in ('yaya.js', 'yaya.wasm'):
        with open(os.path.join(link_dir, f), 'rb') as fh:
            data = fh.read().lower()
        found = [m for m in marks if m.lower().encode() in data]
        if found:
            sys.exit(f'{f} contains {", ".join(found)}: a builder path got in (see -ffile-prefix-map); not copied')

    with open(os.path.join(SRC, 'manifest.cpp'), encoding='utf-8') as fh:
        version = re.search(r'aya_version\s*=\s*L"([^"]*)"', fh.read()).group(1)
    os.makedirs(out_dir, exist_ok=True)
    for f in ('yaya.js', 'yaya.wasm'):
        shutil.move(os.path.join(link_dir, f), os.path.join(out_dir, f))
    info = {'yaya': commits['.'], 'version': version, 'submodules': {k: v for k, v in commits.items() if k != '.'},
            'drift': drift, 'emcc': emcc, 'patches': len(patches.PATCHES), 'jsPatches': len(patches.JS_PATCHES),
            'opt': 'O0' if a.debug else a.opt,
            'debug': a.debug}
    with open(os.path.join(out_dir, 'yaya.build-info.json'), 'w', newline='\n') as fh:
        json.dump(info, fh, indent=1)
    with open(os.path.join(out_dir, 'yaya.LICENSES.txt'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(licenses(commits, version))
    for f in ('yaya.js', 'yaya.wasm'):
        print(f'{f}: {os.path.getsize(os.path.join(out_dir, f)):,} bytes')
    print(f'-> {out_dir} (YAYA {version}, {variant})')


if __name__ == '__main__':
    main()
