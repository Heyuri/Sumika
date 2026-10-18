"""Compile KAWARI (華和梨) Phase 7.5.0 (vendor/kawari-7.5.0) to WebAssembly.

usage: python engines/kawari7/build.py [--opt O2|Oz] [--debug] [--out DIR] [--allow-vendor-drift] [-j N]
output in DIR (default site/sumika/engines; a --debug build engines/kawari7/build/out-debug unless --out is given):
kawari7.js + kawari7.wasm, kawari7.build-info.json, kawari7.LICENSES.txt (the notices of everything compiled in)

Steps (docs/research/kawari7-wasm.md):
 0. check the input: vendor/kawari-7.5.0 is not a git repository, so it is pinned by a tree hash (SHA-256 over every
    file in sorted relative path order of `path NUL size NUL bytes`); a mismatch stops the build unless
    --allow-vendor-drift (build-info then says drift). The emcc version goes into build-info and every object's hash.
 1. copy src/**/*.{cpp,h} into engines/kawari7/build/src with LF line ends, every byte 0x80-0xFF written as an octal
    escape as the authors' own Linux build did (sjis2ascii.rb): the sources are Shift_JIS and some string literals hold
    Shift_JIS text, which must reach the program as the same bytes (a raw 0x5C trail byte would also end a comment line
    with a backslash); plus Sumika's glue em_kawari7.cpp / em_kawari7.h
 2. generate misc/cp932_table.h (engines/common/gen_cp932.py, shared with the other engines and checked against the
    dumps made on Windows) and apply patches.py (each `old` exactly once)
 3. compile files.mak's KAWASRC (with KISSRC and CRYPTSRC) + SHIOSRC, shiori_so/shiori.cpp (the POSIX exports) and
    em_kawari7.cpp, with -DI18N_HACK as the shipped DLL (KAWARI.kdt.i18n, mingw_kawari.mak); never compiled: tool/*,
    saori/saori_win32 (patch K7-5 turns saori.cpp's module into the JS bridge), shiori_dll, misc/_dirent (MSVC only)
 4. link with the stack below the static data (-Wl,--stack-first), refuse output that names the builder's folders,
    write build-info and kawari7.LICENSES.txt (engines/common/notices.py)
"""
import os, re, sys, shutil, subprocess, argparse, concurrent.futures, json, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
VENDOR = os.path.join(ROOT, 'vendor', 'kawari-7.5.0')
VSRC = os.path.join(VENDOR, 'src')
COMMON = os.path.join(ROOT, 'engines', 'common')
BUILD = os.path.join(HERE, 'build')
SRC = os.path.join(BUILD, 'src')
OUT = os.path.join(ROOT, 'site', 'sumika', 'engines')
OUT_DEBUG = os.path.join(BUILD, 'out-debug')
EMSDK = os.path.join(ROOT, 'toolchain', 'emsdk')
PY = os.path.join(EMSDK, 'python', '3.13.3_64bit', 'python.exe')
EMXX = [PY if os.path.exists(PY) else sys.executable, os.path.join(EMSDK, 'upstream', 'emscripten', 'em++.py')]
EMCC = [EMXX[0], os.path.join(EMSDK, 'upstream', 'emscripten', 'emcc.py')]
# EM_CONFIG absolute and EMSDK_PYTHON: as engines/kawari/build.py (a relative EM_CONFIG clears the library cache; a
# rebuilt cache library would otherwise run the python.exe on PATH)
ENV = {**os.environ, 'EM_CONFIG': os.path.join(EMSDK, '.emscripten'), 'PYTHONDONTWRITEBYTECODE': '1',
       'EMSDK_PYTHON': PY}

sys.dont_write_bytecode = True   # no __pycache__ beside patches.py
sys.path.insert(0, HERE)
sys.path.insert(0, COMMON)
import patches  # noqa: E402
import notices  # noqa: E402

# vendor/kawari-7.5.0 as downloaded (SOURCE.txt; the three Windows programs left out): 143 files. A new pin means
# matching the patches again (each must match exactly once) and re-running the checks.
TREE_PIN = '4e501a2fc38129646cc2c1ba245658e4438668779c4fc72aa7db9c54578018d3'

# files.mak: KAWASRC (with KISSRC and CRYPTSRC) + SHIOSRC = 32 units, the POSIX exports and Sumika's glue
KISSRC = '''kis/kis_echo kis/kis_dict kis/kis_test kis/kis_date kis/kis_counter kis/kis_cpiro kis/kis_expr kis/kis_file
kis/kis_escape kis/kis_help kis/kis_urllist kis/kis_saori kis/kis_substitute'''.split()
CRYPTSRC = ['libkawari/kawari_crypt', 'misc/base64']
KAWASRC = '''libkawari/kawari libkawari/kawari_engine libkawari/kawari_dict libkawari/kawari_code libkawari/kawari_iscript
libkawari/kawari_lexer libkawari/kawari_matchdict libkawari/kawari_matchcode libkawari/sequence_gen misc/misc
misc/mt19937ar misc/phttp misc/i18n saori/saori'''.split() + KISSRC + CRYPTSRC
SHIOSRC = ['shiori/shiori_interface']
POSIX = ['shiori_so/shiori']
GLUE = ['em_kawari7']
SOURCES = KAWASRC + SHIOSRC + POSIX + GLUE

EXPORTED = ['_load', '_request', '_unload', '_malloc', '_free'] + patches.EXTRA_EXPORTS
RUNTIME = ['FS', 'HEAPU8', 'HEAP32', 'UTF8ToString', 'stringToUTF8', 'lengthBytesUTF8', 'stackSave', 'stackRestore']


def run(cmd):
    r = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='replace', env=ENV)
    return r.returncode, (r.stdout or '') + (r.stderr or '')


def tree_pin(root):
    """SHA-256 over every file under root, in sorted relative POSIX path order: path NUL size NUL bytes"""
    files = []
    for d, dirs, names in os.walk(root):
        dirs.sort()
        for n in names:
            p = os.path.join(d, n)
            if os.path.isfile(p) and not os.path.islink(p):
                files.append(os.path.relpath(p, root).replace(os.sep, '/'))
    h = hashlib.sha256()
    for rel in sorted(files):
        with open(os.path.join(root, rel), 'rb') as fh:
            data = fh.read()
        h.update(rel.encode('utf-8') + b'\0' + str(len(data)).encode('ascii') + b'\0' + data)
    return h.hexdigest(), len(files)


def check_vendor(allow_drift):
    """The tree pin and whether it differs from TREE_PIN."""
    if not os.path.isfile(os.path.join(VSRC, 'files.mak')):
        sys.exit(f'{os.path.relpath(VSRC, ROOT)} is missing: vendor/kawari-7.5.0 is the unpacked kawari-750-kdt.zip')
    pin, n = tree_pin(VENDOR)
    drift = pin != TREE_PIN
    if drift and not allow_drift:
        sys.exit(f'vendor/kawari-7.5.0 ({n} files) has tree pin {pin}, expected {TREE_PIN}\n'
                 '(pass --allow-vendor-drift to build anyway; build-info then says drift)')
    if drift:
        print(f'warning: vendor/kawari-7.5.0 has tree pin {pin}, expected {TREE_PIN}')
    return pin, drift


def zip_sha256():
    with open(os.path.join(VENDOR, 'SOURCE.txt'), encoding='utf-8') as fh:
        m = re.search(r'sha256 of kawari-750-kdt\.zip: ([0-9a-f]{64})', fh.read())
    return m.group(1) if m else ''


def emcc_version():
    code, out = run(EMCC + ['--version'])
    m = re.search(r'\d+\.\d+\.\d+ \([0-9a-f]+\)', out)
    if code or not m:
        sys.exit('emcc --version failed:\n' + out)
    return m.group(0)


def sjis_escape(raw):
    """sjis2ascii.rb's rewrite: a Shift_JIS lead byte (0x81-0x9F, 0xE0-0xFC) and the byte after it, whatever it is, as
    two 3-digit octal escapes; any other byte 0x80-0xFF as one (sjis2ascii.rb wrote half-width kana raw; an escape is
    the same byte in a literal and keeps the file ASCII). CRLF -> LF."""
    out = bytearray()
    i, n = 0, len(raw)
    while i < n:
        c = raw[i]
        if 0x81 <= c <= 0x9F or 0xE0 <= c <= 0xFC:
            out += b'\\%03o' % c
            if i + 1 < n:
                out += b'\\%03o' % raw[i + 1]
            i += 2
        elif c >= 0x80:
            out += b'\\%03o' % c
            i += 1
        else:
            out.append(c)
            i += 1
    return bytes(out).replace(b'\r\n', b'\n').decode('ascii')


def prepare():
    if os.path.isdir(SRC):
        shutil.rmtree(SRC)
    n = 0
    for d, dirs, files in os.walk(VSRC):
        dirs.sort()
        for f in sorted(files):
            if os.path.splitext(f)[1] not in ('.cpp', '.h'):
                continue
            rel = os.path.relpath(os.path.join(d, f), VSRC)
            with open(os.path.join(d, f), 'rb') as fh:
                text = sjis_escape(fh.read())
            dst = os.path.join(SRC, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'w', encoding='ascii', newline='\n') as fh:
                fh.write(text)
            n += 1
    for f in ('em_kawari7.cpp', 'em_kawari7.h'):
        shutil.copyfile(os.path.join(HERE, f), os.path.join(SRC, f))
    print(f'sources: {n} files, Shift_JIS bytes escaped')
    code, out = run([sys.executable, '-I', os.path.join(COMMON, 'gen_cp932.py'), os.path.join(SRC, 'misc', 'cp932_table.h'),
                     '--verify', os.path.join(COMMON, 'cp932')])
    if code:
        sys.exit(out)
    print(out.strip())
    for rel, old, new in patches.PATCHES:
        p = os.path.join(SRC, rel)
        with open(p, encoding='ascii') as fh:
            text = fh.read()
        k = text.count(old)
        if k != 1:
            sys.exit(f'patch for {rel}: expected exactly one match, found {k}:\n{old[:300]}')
        with open(p, 'w', encoding='utf-8', newline='\n') as fh:
            fh.write(text.replace(old, new))
    print(f'{len(patches.PATCHES)} patches applied')


def headers_hash():
    h = hashlib.sha1()
    for d, dirs, files in os.walk(SRC):
        dirs.sort()
        for f in sorted(files):
            if f.endswith('.h'):
                h.update(os.path.relpath(os.path.join(d, f), SRC).replace('\\', '/').encode())
                with open(os.path.join(d, f), 'rb') as fh:
                    h.update(fh.read())
    return h.hexdigest()


def builder_marks():
    """Strings that would put the builder's folders (with the Windows user name) into a published file."""
    tail = os.path.splitdrive(os.path.expanduser('~'))[1].strip('\\/')      # Users\<name>
    return sorted({m for m in (tail, tail.replace('\\', '/'), 'AppData\\', 'AppData/', ROOT, ROOT.replace('\\', '/'))
                   if m})


def kawari_version():
    with open(os.path.join(SRC, 'libkawari', 'kawari.h'), encoding='utf-8') as fh:
        text = fh.read()
    return '.'.join(re.search(rf'#define\s+KAWARI_{k}\s+"([^"]*)"', text).group(1) for k in ('MAJOR', 'MINOR', 'SUBMINOR'))


def licenses(version, pin, zsha):
    return '\n'.join([
        f'kawari7.wasm and kawari7.js are KAWARI (華和梨) Phase {version} by the KAWARI Development Team\n'
        '(https://sourceforge.net/projects/kawari/, kawari-750-kdt.zip with sha256\n'
        f'{zsha};\n'
        f'source tree pin {pin}),\n'
        'compiled to WebAssembly with patches by Sumika (engines/kawari7/build.py), and the code compiled\n'
        'into it. Every notice in that code follows.\n',
        '== KAWARI (modified BSD), license.txt\n\n' + notices.file_text(os.path.join(VENDOR, 'license.txt')),
        '== MT19937 (BSD-3-Clause), src/misc/mt19937ar.cpp, its header:\n\n'
        + notices.comment_notice(os.path.join(VSRC, 'misc', 'mt19937ar.cpp'), 'Copyright (C) 1997 - 2002',
                                 'EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE'),
        notices.emscripten(EMSDK),
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--opt', choices=['O2', 'Oz'], default='O2')
    ap.add_argument('--debug', action='store_true', help='-O0 -g with assertions; written outside site/ unless --out')
    ap.add_argument('--out', help='output folder (default site/sumika/engines, or engines/kawari7/build/out-debug)')
    ap.add_argument('--allow-vendor-drift', action='store_true')
    ap.add_argument('-j', type=int, default=os.cpu_count() or 4)
    a = ap.parse_args()
    out_dir = os.path.abspath(a.out) if a.out else OUT_DEBUG if a.debug else OUT
    pin, drift = check_vendor(a.allow_vendor_drift)
    zsha = zip_sha256()
    emcc = emcc_version()
    prepare()

    variant = 'debug' if a.debug else a.opt
    opt = ['-O0', '-g'] if a.debug else ['-' + a.opt]
    # -DI18N_HACK as mingw_kawari.mak (the shipped DLL is KAWARI.kdt.i18n); config.h has nothing for Emscripten (no
    # _MSC_VER, __BORLANDC__ or __MINGW32__), so POSIX readdir and the plain `for` scope apply
    cxxflags = opt + ['-std=c++11', '-fwasm-exceptions', '-DNDEBUG', '-DI18N_HACK',
                      '-Wall', '-Wno-unknown-pragmas', '-Wno-overloaded-virtual', '-Wno-writable-strings',
                      '-Wno-deprecated', '-Wno-deprecated-declarations', '-I', SRC,
                      '-ffile-prefix-map=' + SRC + '=src', '-ffile-prefix-map=' + SRC.replace('\\', '/') + '=src']
    if a.debug:
        cxxflags += ['-fdebug-compilation-dir=.', '-ffile-prefix-map=' + EMSDK + '=emsdk',
                     '-ffile-prefix-map=' + EMSDK.replace('\\', '/') + '=emsdk']
    cxxflags += patches.EXTRA_CFLAGS
    objdir = os.path.join(BUILD, 'obj-' + variant)
    logdir = os.path.join(BUILD, 'logs-' + variant)
    os.makedirs(objdir, exist_ok=True)
    os.makedirs(logdir, exist_ok=True)
    hh = headers_hash()

    def compile_one(s):
        src = os.path.join(SRC, s + '.cpp')
        obj = os.path.join(objdir, s.replace('/', '__') + '.o')
        stamp = obj + '.hash'
        with open(src, 'rb') as fh:
            h = hashlib.sha1(fh.read() + (hh + ' '.join(EMXX + cxxflags) + emcc).encode()).hexdigest()
        if os.path.exists(obj) and os.path.exists(stamp) and open(stamp).read() == h:
            return s, obj, 0, '', True
        code, out = run(EMXX + cxxflags + ['-c', src, '-o', obj])
        with open(os.path.join(logdir, s.replace('/', '__') + '.log'), 'w', encoding='utf-8') as fh:
            fh.write(out)
        if code == 0:
            with open(stamp, 'w') as fh:
                fh.write(h)
        return s, obj, code, out, False

    objs, failed, warnings = [], [], 0
    with concurrent.futures.ThreadPoolExecutor(a.j) as ex:
        for s, obj, code, out, cached in ex.map(compile_one, SOURCES):
            objs.append(obj)
            warnings += out.count('warning:')
            print(f'{"FAIL" if code else "same" if cached else "ok  "} {s}')
            if code:
                failed.append((s, out))
    if failed:
        for s, out in failed:
            print(f'\n===== {s}\n' + '\n'.join(out.splitlines()[:40]))
        sys.exit(1)
    print(f'{len(objs)} units' + (f', {warnings} compiler warnings (logs in {os.path.relpath(logdir, ROOT)})'
                                  if warnings else ''))

    link_dir = os.path.join(BUILD, 'link-' + variant)
    os.makedirs(link_dir, exist_ok=True)
    ldflags = opt + ['-fwasm-exceptions',
                     '-sMODULARIZE=1', '-sEXPORT_NAME=createKawari7', '-sENVIRONMENT=web,worker,node',
                     '-sFORCE_FILESYSTEM=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=32MB',
                     '-sSTACK_SIZE=1MB', '-sCASE_INSENSITIVE_FS=1', '-Wl,--stack-first',
                     '-sEXPORTED_FUNCTIONS=' + ','.join(EXPORTED),
                     '-sEXPORTED_RUNTIME_METHODS=' + ','.join(RUNTIME)]
    if a.debug:
        ldflags += ['-sASSERTIONS=2', '-sSTACK_OVERFLOW_CHECK=2']
    code, out = run(EMXX + objs + ldflags + ['-o', os.path.join(link_dir, 'kawari7.js')])
    if code:
        print(out)
        sys.exit(1)
    if out.strip():
        print(out.strip()[:2000])
    marks = builder_marks()
    for f in ('kawari7.js', 'kawari7.wasm'):
        with open(os.path.join(link_dir, f), 'rb') as fh:
            data = fh.read().lower()
        found = [m for m in marks if m.lower().encode() in data]
        if found:
            sys.exit(f'{f} contains {", ".join(found)}: a builder path got in (see -ffile-prefix-map); not copied')

    version = kawari_version()
    os.makedirs(out_dir, exist_ok=True)
    for f in ('kawari7.js', 'kawari7.wasm'):
        shutil.move(os.path.join(link_dir, f), os.path.join(out_dir, f))
    info = {'kawari': version, 'treePin': pin, 'zipSha256': zsha, 'drift': drift, 'emcc': emcc,
            'patches': len(patches.PATCHES), 'opt': 'O0' if a.debug else a.opt, 'debug': a.debug}
    with open(os.path.join(out_dir, 'kawari7.build-info.json'), 'w', newline='\n') as fh:
        json.dump(info, fh, indent=1)
    with open(os.path.join(out_dir, 'kawari7.LICENSES.txt'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(licenses(version, pin, zsha))
    for f in ('kawari7.js', 'kawari7.wasm'):
        print(f'{f}: {os.path.getsize(os.path.join(out_dir, f)):,} bytes')
    print(f'-> {out_dir} (KAWARI {version}, {variant})')


if __name__ == '__main__':
    main()
