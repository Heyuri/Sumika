"""Compile Satori (vendor/satoriya-shiori, unicode branch) to WebAssembly.

usage: python engines/satori/build.py [--debug] [--out DIR] [-j N]
output in DIR (default site/sumika/engines; a --debug build engines/satori/build/out-debug unless --out is given):
satori.js + satori.wasm (+ satori.build-info.json, and satori.LICENSES.txt: every notice in the code compiled in,
engines/common/notices.py)

Steps (docs/research/satori-wasm.md sections 3, 4, 8, 9):
 0. the commits build-info and the licences name: a git checkout's own, or COPY_OF for the repository's copy; the files
    read from it against INPUTS_PIN (a warning, recorded as drift) (identity, engines/common/vendor.py)
 1. copy the Shift_JIS sources into engines/satori/build/src as UTF-8, decoded with Python's cp932 codec
    (GNU iconv maps some characters differently from Windows), LF line ends; drop _/Memory.h (it would shadow
    <memory.h> on case-insensitive disks)
 2. generate _/cp932_table.h (engines/common/gen_cp932.py, the code page 932 table YAYA shares, checked against the
    dumps made on Windows in engines/common/cp932) and apply patches.py
 3. compile each file with em++, link in engines/satori/build/link-<variant>, and refuse output that names the
    builder's folders (user name), as YAYA's and Kawari's builds do: emsdk's cached debug libc++
    libraries carry the builder's path in their DWARF, so a --debug build is refused until that cache is rebuilt
"""
import os, sys, subprocess, shutil, argparse, concurrent.futures, json, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
REPO = os.path.join(ROOT, 'vendor', 'satoriya-shiori')
SATORIYA = os.path.join(REPO, 'satoriya')
COMMON = os.path.join(ROOT, 'engines', 'common')
BUILD = os.path.join(HERE, 'build')
SRC = os.path.join(BUILD, 'src')
OUT = os.path.join(ROOT, 'site', 'sumika', 'engines')
OUT_DEBUG = os.path.join(BUILD, 'out-debug')
EMSDK = os.path.join(ROOT, 'toolchain', 'emsdk')
PY = os.path.join(EMSDK, 'python', '3.13.3_64bit', 'python.exe')
EMXX = [PY if os.path.exists(PY) else sys.executable, os.path.join(EMSDK, 'upstream', 'emscripten', 'em++.py')]
ENV = {**os.environ, 'EM_CONFIG': os.path.join(EMSDK, '.emscripten'), 'PYTHONDONTWRITEBYTECODE': '1',
       'EMSDK_PYTHON': PY}   # emcc.exe rebuilds a library missing from emsdk's cache with it (engines/kawari/build.py)

sys.dont_write_bytecode = True   # no __pycache__ beside patches.py
sys.path.insert(0, HERE)
sys.path.insert(0, COMMON)
import patches  # noqa: E402
import notices  # noqa: E402
import vendor  # noqa: E402

# The repository's copy of vendor/satoriya-shiori (no .git of its own: engines/common/vendor.py) is of these commits
# (unicode branch, Mc203-6, and its deelx submodule); the files the build reads from it (inputs()) have INPUTS_PIN.
# A git checkout of its own names its commits itself. A pin that differs is a warning, recorded in build-info as drift.
COPY_OF = {'satori': 'e2bf34804fcdd1d8973e237f166fce8f53d800f9', 'deelx': 'af1a690cc8333620ca4f86f46058bb9b8eaf055f'}
INPUTS_PIN = 'de9dd11d221a2628c8584c6f6c3c1ecf958bfcae90f12aef5daabab2a8afa78b'   # 134 files

# makefile.linux's LIBSATORI_OBJ minus SaoriHost (only needed when building ssu as a separate SAORI), plus the FMO
# reader SakuraFMO / satoriFMO (patch P8: the FMO text comes from the page)
SOURCES = '''_/Sender _/charset _/Utilities _/calc _/calc_float _/stltool _/mt19937ar _/random
satori/SakuraCS satori/SakuraClient satori/SakuraDLLClient satori/SakuraDLLHost satori/SaoriClient
satori/satori satori/satoriTranslate satori/satori_AnalyzeRequest satori/satori_builtin satori/satori_CreateResponce
satori/satori_EventOperation satori/satori_Kakko satori/satori_load_dict satori/satori_load_unload satori/satori_sentence
satori/satori_tool satori/shiori_plugin satori/ssu satori/SakuraFMO satori/satoriFMO'''.split()

EXPORTED = ['_load', '_request', '_unload', '_satori_load_resume', '_satori_save',
            '_satori_get_talk_count', '_satori_get_since_last_talk', '_satori_set_talk_state', '_malloc', '_free']
RUNTIME = ['FS', 'HEAPU8', 'HEAP32', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8']


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', env=ENV)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def head(path):
    """The commit checked out at path, '' when path is no git checkout of its own (vendor.own_checkout)."""
    if not vendor.own_checkout(path):
        return ''
    r = subprocess.run(['git', '-C', path, 'rev-parse', 'HEAD'], capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else ''


def inputs():
    """What the build reads from vendor/satoriya-shiori: LICENSE, and the .cpp / .h files prepare copies (the notices'
    sources among them)."""
    return ['LICENSE'] + [f for sub in ('satori', '_', 'deelx')
                          for f in vendor.listed(REPO, 'satoriya/' + sub, exts=('.cpp', '.h'))]


def identity():
    """{'satori', 'deelx'}: the commits (a checkout's own, else COPY_OF), the pin of inputs() and whether it differs
    from INPUTS_PIN (printed as a warning)."""
    satori, deelx = head(REPO), head(os.path.join(SATORIYA, 'deelx'))
    if not satori:
        satori, deelx = COPY_OF['satori'], COPY_OF['deelx']
    pin, n = vendor.files_pin(REPO, inputs())
    if pin != INPUTS_PIN:
        print(f'warning: the {n} files the build reads from vendor/satoriya-shiori have pin {pin}, '
              f'expected {INPUTS_PIN}')
    return {'satori': satori, 'deelx': deelx, 'inputsPin': pin, 'drift': pin != INPUTS_PIN}


def prepare():
    if not os.path.isfile(os.path.join(SATORIYA, 'deelx', 'deelx.h')):
        sys.exit('deelx.h missing: run  git -C vendor/satoriya-shiori submodule update --init satoriya/deelx')
    if os.path.isdir(SRC):
        shutil.rmtree(SRC)
    for sub in ('satori', '_', 'deelx'):
        os.makedirs(os.path.join(SRC, sub))
        for f in os.listdir(os.path.join(SATORIYA, sub)):
            if os.path.splitext(f)[1].lower() not in ('.cpp', '.h'):
                continue
            text = open(os.path.join(SATORIYA, sub, f), 'rb').read().decode('cp932').replace('\r\n', '\n')
            open(os.path.join(SRC, sub, f), 'w', encoding='utf-8', newline='\n').write(text)
    os.remove(os.path.join(SRC, '_', 'Memory.h'))
    code, out = run([sys.executable, '-I', os.path.join(COMMON, 'gen_cp932.py'), os.path.join(SRC, '_', 'cp932_table.h'),
                     '--verify', os.path.join(COMMON, 'cp932')])
    if code:
        sys.exit(out)
    print(out.strip())
    for rel, old, new in patches.PATCHES:
        p = os.path.join(SRC, rel)
        text = open(p, encoding='utf-8').read()
        n = text.count(old)
        if n != 1:
            sys.exit(f'patch for {rel}: expected exactly one match, found {n}:\n{old[:300]}')
        open(p, 'w', encoding='utf-8', newline='\n').write(text.replace(old, new))


def builder_marks():
    """Strings that would put the builder's folders (with the Windows user name) into a published file (YAYA's rule:
    engines/yaya/build.py). AppData only as a folder."""
    tail = os.path.splitdrive(os.path.expanduser('~'))[1].strip('\\/')      # Users\<name>
    return sorted({m for m in (tail, tail.replace('\\', '/'), 'AppData\\', 'AppData/', ROOT, ROOT.replace('\\', '/'))
                   if m})


def licenses(commit):
    """satori.LICENSES.txt: Satori's licence and the notices of the code compiled with it (BSD-2-Clause and MT19937's
    BSD-3-Clause want their notice with a binary too)"""
    parts = [
        'satori.wasm and satori.js are Satori (https://github.com/ukatech/satoriya-shiori, unicode branch, commit\n'
        f'{commit}), compiled to WebAssembly with patches by Sumika (engines/satori/build.py),\n'
        'and the code compiled into it. Every notice in that code follows.\n',
        '== Satori (BSD-2-Clause), LICENSE\n\n' + notices.file_text(os.path.join(REPO, 'LICENSE')),
        '== MT19937 (BSD-3-Clause), satoriya/_/mt19937ar.cpp, its header:\n\n'
        + notices.comment_notice(os.path.join(SATORIYA, '_', 'mt19937ar.cpp'), 'Copyright (C) 1997 - 2002',
                                 'EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE', 'cp932'),
        '== DEELX (satoriya/deelx/deelx.h), its header:\n\n'
        + notices.head_lines(os.path.join(SATORIYA, 'deelx', 'deelx.h'), 12),
        notices.emscripten(EMSDK),
    ]
    return '\n'.join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--debug', action='store_true', help='-O0 -g with assertions; written outside site/ unless --out')
    ap.add_argument('--out', help='output folder (default site/sumika/engines, or engines/satori/build/out-debug)')
    ap.add_argument('-j', type=int, default=os.cpu_count() or 4)
    a = ap.parse_args()
    out_dir = os.path.abspath(a.out) if a.out else OUT_DEBUG if a.debug else OUT
    ident = identity()
    prepare()
    opt = ['-O0', '-g'] if a.debug else ['-O2']
    cflags = opt + ['-std=c++11', '-fwasm-exceptions', '-DPOSIX', '-DSATORI_DLL',
                    '-Wall', '-Wno-unknown-pragmas', '-Wno-overloaded-virtual',
                    '-iquote', os.path.join(SRC, 'satori'), '-iquote', os.path.join(SRC, '_'),
                    # assert() strings would otherwise carry the builder's absolute path (user name) into the published wasm
                    '-ffile-prefix-map=' + SRC + '=src', '-ffile-prefix-map=' + SRC.replace('\\', '/') + '=src']
    if a.debug:   # same reason: DWARF names the working directory (comp_dir) and the emsdk headers (libc++ lambdas)
        cflags += ['-fdebug-compilation-dir=.', '-ffile-prefix-map=' + EMSDK + '=emsdk',
                   '-ffile-prefix-map=' + EMSDK.replace('\\', '/') + '=emsdk']
    objdir = os.path.join(BUILD, 'obj-debug' if a.debug else 'obj')
    os.makedirs(objdir, exist_ok=True)

    def compile_one(s):
        src = os.path.join(SRC, s + '.cpp')
        obj = os.path.join(objdir, s.replace('/', '__') + '.o')
        # skip unchanged files (hash of the patched source + flags; headers are hashed as a whole below)
        stamp = obj + '.hash'
        h = hashlib.sha1((open(src, 'rb').read().hex() + HEADERS_HASH + ' '.join(cflags)).encode()).hexdigest()
        if os.path.exists(obj) and os.path.exists(stamp) and open(stamp).read() == h:
            return s, obj, 0, '', True
        code, out = run(EMXX + cflags + ['-c', src, '-o', obj])
        if code == 0:
            open(stamp, 'w').write(h)
        return s, obj, code, out, False

    global HEADERS_HASH
    hh = hashlib.sha1()
    for sub in ('satori', '_', 'deelx'):
        for f in sorted(os.listdir(os.path.join(SRC, sub))):
            if f.endswith('.h'):
                hh.update(open(os.path.join(SRC, sub, f), 'rb').read())
    HEADERS_HASH = hh.hexdigest()

    objs, failed = [], []
    with concurrent.futures.ThreadPoolExecutor(a.j) as ex:
        for s, obj, code, out, cached in ex.map(compile_one, SOURCES):
            objs.append(obj)
            print(f'{"FAIL" if code else "same" if cached else "ok  "} {s}')
            if code:
                failed.append((s, out))
    if failed:
        for s, out in failed:
            print(f'\n===== {s}\n' + '\n'.join(out.splitlines()[:60]))
        sys.exit(1)

    # link next to the objects, check, then move: a failed check leaves the published files as they were
    link_dir = os.path.join(BUILD, 'link-debug' if a.debug else 'link-O2')
    os.makedirs(link_dir, exist_ok=True)
    ldflags = opt + ['-fwasm-exceptions',
                     '-sMODULARIZE=1', '-sEXPORT_NAME=createSatori', '-sENVIRONMENT=web,worker,node',
                     '-sFORCE_FILESYSTEM=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=32MB',
                     '-sSTACK_SIZE=1MB', '-sCASE_INSENSITIVE_FS=1',
                     '-sEXPORTED_FUNCTIONS=' + ','.join(EXPORTED),
                     '-sEXPORTED_RUNTIME_METHODS=' + ','.join(RUNTIME)]
    if a.debug:
        ldflags += ['-sASSERTIONS=2', '-sSTACK_OVERFLOW_CHECK=2']
    code, out = run(EMXX + objs + ldflags + ['-o', os.path.join(link_dir, 'satori.js')])
    if code:
        print(out)
        sys.exit(1)
    if out.strip():
        print(out.strip()[:2000])
    marks = builder_marks()
    for f in ('satori.js', 'satori.wasm'):
        with open(os.path.join(link_dir, f), 'rb') as fh:
            data = fh.read().lower()
        found = [m for m in marks if m.lower().encode() in data]
        if found:
            sys.exit(f'{f} contains {", ".join(found)}: a builder path got in (see -ffile-prefix-map; a --debug build '
                     'also links the DWARF of emsdk\'s cached libc++ libraries); not copied')
    os.makedirs(out_dir, exist_ok=True)
    for f in ('satori.js', 'satori.wasm'):
        shutil.move(os.path.join(link_dir, f), os.path.join(out_dir, f))
    info = {**ident, 'patches': len(patches.PATCHES), 'debug': a.debug}
    json.dump(info, open(os.path.join(out_dir, 'satori.build-info.json'), 'w'), indent=1)
    with open(os.path.join(out_dir, 'satori.LICENSES.txt'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(licenses(info['satori']))
    for f in ('satori.js', 'satori.wasm'):
        print(f'{f}: {os.path.getsize(os.path.join(out_dir, f)) // 1024} KB')
    print(f'-> {out_dir}')


HEADERS_HASH = ''

if __name__ == '__main__':
    main()
