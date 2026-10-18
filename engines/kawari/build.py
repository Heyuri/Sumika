"""Compile KAWARI (華和梨) Phase 8.2.8 (vendor/kawari-8.2.8) to WebAssembly.

usage: python engines/kawari/build.py [--opt O2|Oz] [--debug] [--out DIR] [--allow-vendor-drift] [-j N]
output in DIR (default site/sumika/engines; a --debug build engines/kawari/build/out-debug unless --out is given):
kawari.js + kawari.wasm, kawari.build-info.json, kawari.LICENSES.txt (the notices of everything compiled in)

Steps (the plan in scratch kawari/plan.md section 1; to be docs/research/kawari-wasm.md):
 0. check the input: vendor/kawari-8.2.8 is not a git repository, so it is pinned by a tree hash (SHA-256 over every
    file in sorted relative path order of `path NUL size NUL bytes`); a mismatch stops the build unless
    --allow-vendor-drift (build-info then says drift). The emcc version goes into build-info and every object's hash.
 1. copy build/src/**/*.{cpp,h} into engines/kawari/build/src as UTF-8 with LF line ends (EUC-JP; else CP932; else
    EUC-JP with replacement: all non-ASCII is in comments, no string or char literal holds a non-ASCII byte, so this
    cannot change the program), plus Sumika's glue em_kawari.cpp / em_kawari.h
 2. generate misc/cp932_table.h (engines/common/gen_cp932.py, shared with Satori and YAYA and checked against the dumps
    made on Windows in engines/common/cp932) and apply patches.py (each `old` exactly once)
 3. compile files.mak's CORESRC + CORESRC_NATIVE (saori/saori_native, which patch K5 turns into the JS bridge) + SHIOSRC
    and em_kawari.cpp: 41 units (unchanged objects are kept: obj-O2, obj-Oz, obj-debug); never compiled: tool/*,
    saori_java, saori_python, py_shiori
 4. link with the stack below the static data (-Wl,--stack-first: an overflow traps instead of overwriting globals; the
    worker restores the stack pointer after a throw with stackSave/stackRestore), refuse output that names the
    builder's folders (user name), write build-info and kawari.LICENSES.txt (engines/common/notices.py)
"""
import os, re, sys, shutil, subprocess, argparse, concurrent.futures, json, hashlib

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
VENDOR = os.path.join(ROOT, 'vendor', 'kawari-8.2.8')
VSRC = os.path.join(VENDOR, 'build', 'src')
COMMON = os.path.join(ROOT, 'engines', 'common')
BUILD = os.path.join(HERE, 'build')
SRC = os.path.join(BUILD, 'src')
OUT = os.path.join(ROOT, 'site', 'sumika', 'engines')
OUT_DEBUG = os.path.join(BUILD, 'out-debug')
EMSDK = os.path.join(ROOT, 'toolchain', 'emsdk')
PY = os.path.join(EMSDK, 'python', '3.13.3_64bit', 'python.exe')
EMXX = [PY if os.path.exists(PY) else sys.executable, os.path.join(EMSDK, 'upstream', 'emscripten', 'em++.py')]
EMCC = [EMXX[0], os.path.join(EMSDK, 'upstream', 'emscripten', 'emcc.py')]
# EM_CONFIG absolute: a relative one makes Emscripten see another LLVM_ROOT and clear its whole library cache.
# EMSDK_PYTHON: a library missing from that cache is rebuilt through the emcc.exe launcher, which otherwise runs the
# python.exe on PATH (here an embeddable Python whose ._pth hides emcc.py's folder: "No module named 'tools'").
ENV = {**os.environ, 'EM_CONFIG': os.path.join(EMSDK, '.emscripten'), 'PYTHONDONTWRITEBYTECODE': '1',
       'EMSDK_PYTHON': PY}

sys.dont_write_bytecode = True   # no __pycache__ beside patches.py
sys.path.insert(0, HERE)
sys.path.insert(0, COMMON)
import patches  # noqa: E402
import notices  # noqa: E402

# vendor/kawari-8.2.8 as downloaded (SOURCE.txt; bin/ left out): 177 files.
# A new pin means matching the patches again (each must match exactly once) and re-running the checks.
TREE_PIN = 'b15b97d814d7d94b695e4951bf9af43b6a05ad34d0a6a91f9466cd9a4df2a7b0'

# files.mak: CORESRC (with KISSRC and CRYPTSRC) + CORESRC_NATIVE + SHIOSRC = 40 units, plus Sumika's glue
KISSRC = '''kis/kis_echo kis/kis_dict kis/kis_date kis/kis_counter kis/kis_file kis/kis_escape kis/kis_urllist
kis/kis_substitute kis/kis_split kis/kis_communicate kis/kis_xargs kis/kis_string kis/kis_help kis/kis_saori
kis/kis_system'''.split()
CRYPTSRC = ['libkawari/kawari_crypt', 'misc/base64']
CORESRC = '''libkawari/kawari_engine libkawari/kawari_ns libkawari/kawari_dict libkawari/kawari_code
libkawari/kawari_codeset libkawari/kawari_codeexpr libkawari/kawari_codekis libkawari/kawari_vm libkawari/kawari_lexer
libkawari/kawari_compiler libkawari/kawari_log libkawari/kawari_rc misc/misc misc/mt19937ar misc/l10n misc/phttp
saori/saori saori/saori_module saori/saori_unique'''.split() + KISSRC + CRYPTSRC
CORESRC_NATIVE = ['saori/saori_native']
SHIOSRC = ['shiori/kawari_shiori', 'shiori/shiori_object', 'shiori/shiori']
GLUE = ['em_kawari']
SOURCES = CORESRC + CORESRC_NATIVE + SHIOSRC + GLUE

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
        sys.exit(f'{os.path.relpath(VSRC, ROOT)} is missing: vendor/kawari-8.2.8 is the unpacked kawari-828.zip')
    pin, n = tree_pin(VENDOR)
    drift = pin != TREE_PIN
    if drift and not allow_drift:
        sys.exit(f'vendor/kawari-8.2.8 ({n} files) has tree pin {pin}, expected {TREE_PIN}\n'
                 '(pass --allow-vendor-drift to build anyway; build-info then says drift)')
    if drift:
        print(f'warning: vendor/kawari-8.2.8 has tree pin {pin}, expected {TREE_PIN}')
    return pin, drift


def zip_sha256():
    with open(os.path.join(VENDOR, 'SOURCE.txt'), encoding='utf-8') as fh:
        m = re.search(r'sha256 of kawari-828\.zip: ([0-9a-f]{64})', fh.read())
    return m.group(1) if m else ''


def emcc_version():
    code, out = run(EMCC + ['--version'])
    m = re.search(r'\d+\.\d+\.\d+ \([0-9a-f]+\)', out)
    if code or not m:
        sys.exit('emcc --version failed:\n' + out)
    return m.group(0)


def decode(raw):
    for enc in ('euc_jp', 'cp932'):
        try:
            return raw.decode(enc), enc
        except UnicodeDecodeError:
            pass
    return raw.decode('euc_jp', errors='replace'), 'euc_jp with replacement'


def prepare():
    if os.path.isdir(SRC):
        shutil.rmtree(SRC)
    counts = {}
    for d, dirs, files in os.walk(VSRC):
        dirs.sort()
        for f in sorted(files):
            if os.path.splitext(f)[1] not in ('.cpp', '.h'):
                continue
            rel = os.path.relpath(os.path.join(d, f), VSRC)
            with open(os.path.join(d, f), 'rb') as fh:
                text, enc = decode(fh.read())
            counts[enc] = counts.get(enc, 0) + 1
            dst = os.path.join(SRC, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'w', encoding='utf-8', newline='\n') as fh:
                fh.write(text.replace('\r\n', '\n'))
    for f in ('em_kawari.cpp', 'em_kawari.h'):
        shutil.copyfile(os.path.join(HERE, f), os.path.join(SRC, f))
    print('sources:', ', '.join(f'{n} {e}' for e, n in sorted(counts.items())))
    code, out = run([sys.executable, '-I', os.path.join(COMMON, 'gen_cp932.py'), os.path.join(SRC, 'misc', 'cp932_table.h'),
                     '--verify', os.path.join(COMMON, 'cp932')])
    if code:
        sys.exit(out)
    print(out.strip())
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
    with open(os.path.join(SRC, 'libkawari', 'kawari_version.h'), encoding='utf-8') as fh:
        text = fh.read()
    return '.'.join(re.search(rf'#define\s+KAWARI_{k}\s+"([^"]*)"', text).group(1) for k in ('MAJOR', 'MINOR', 'SUBMINOR'))


def licenses(version, pin, zsha):
    return '\n'.join([
        f'kawari.wasm and kawari.js are KAWARI (華和梨) Phase {version} by the KAWARI Development Team\n'
        '(https://sourceforge.net/projects/kawari/, kawari-828.zip with sha256\n'
        f'{zsha};\n'
        f'source tree pin {pin}),\n'
        'compiled to WebAssembly with patches by Sumika (engines/kawari/build.py), and the code compiled\n'
        'into it. Every notice in that code follows (include/shiori.h, the SHIORI header, says it is public\n'
        'domain).\n',
        '== KAWARI (modified BSD), license.txt\n\n' + notices.file_text(os.path.join(VENDOR, 'license.txt')),
        '== MT19937 (BSD-3-Clause), build/src/misc/mt19937ar.cpp, its header:\n\n'
        + notices.comment_notice(os.path.join(VSRC, 'misc', 'mt19937ar.cpp'), 'Copyright (C) 1997 - 2002',
                                 'EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE'),
        notices.emscripten(EMSDK),
    ])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--opt', choices=['O2', 'Oz'], default='O2')
    ap.add_argument('--debug', action='store_true', help='-O0 -g with assertions; written outside site/ unless --out')
    ap.add_argument('--out', help='output folder (default site/sumika/engines, or engines/kawari/build/out-debug)')
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
    # -DENABLE_SAORI_NATIVE and -DNDEBUG as gcc.mak; config.h picks KAWARI_POSIX (Emscripten defines neither WIN32 nor
    # linux). -Wno-writable-strings: every KIS header has `char *Name_ = "..."` (776 warnings, no effect on the code)
    cxxflags = opt + ['-std=c++11', '-fwasm-exceptions', '-DNDEBUG', '-DENABLE_SAORI_NATIVE',
                      '-Wall', '-Wno-unknown-pragmas', '-Wno-overloaded-virtual', '-Wno-writable-strings', '-I', SRC,
                      # assert() strings would otherwise carry the builder's absolute path (user name) into the wasm
                      '-ffile-prefix-map=' + SRC + '=src', '-ffile-prefix-map=' + SRC.replace('\\', '/') + '=src']
    if a.debug:   # DWARF names the working directory (comp_dir) and the emsdk headers (libc++ lambdas) too
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
            print(f'\n===== {s}\n' + '\n'.join(out.splitlines()[:60]))
        sys.exit(1)
    print(f'{len(objs)} units' + (f', {warnings} compiler warnings (logs in {os.path.relpath(logdir, ROOT)})'
                                  if warnings else ''))

    # link next to the objects, check, then move: a failed check leaves the published files as they were
    link_dir = os.path.join(BUILD, 'link-' + variant)
    os.makedirs(link_dir, exist_ok=True)
    ldflags = opt + ['-fwasm-exceptions',
                     '-sMODULARIZE=1', '-sEXPORT_NAME=createKawari', '-sENVIRONMENT=web,worker,node',
                     '-sFORCE_FILESYSTEM=1', '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=32MB',
                     '-sSTACK_SIZE=1MB', '-sCASE_INSENSITIVE_FS=1', '-Wl,--stack-first',
                     '-sEXPORTED_FUNCTIONS=' + ','.join(EXPORTED),
                     '-sEXPORTED_RUNTIME_METHODS=' + ','.join(RUNTIME)]
    if a.debug:
        ldflags += ['-sASSERTIONS=2', '-sSTACK_OVERFLOW_CHECK=2']
    code, out = run(EMXX + objs + ldflags + ['-o', os.path.join(link_dir, 'kawari.js')])
    if code:
        print(out)
        sys.exit(1)
    if out.strip():
        print(out.strip()[:2000])
    marks = builder_marks()
    for f in ('kawari.js', 'kawari.wasm'):
        with open(os.path.join(link_dir, f), 'rb') as fh:
            data = fh.read().lower()
        found = [m for m in marks if m.lower().encode() in data]
        if found:
            sys.exit(f'{f} contains {", ".join(found)}: a builder path got in (see -ffile-prefix-map); not copied')

    version = kawari_version()
    os.makedirs(out_dir, exist_ok=True)
    for f in ('kawari.js', 'kawari.wasm'):
        shutil.move(os.path.join(link_dir, f), os.path.join(out_dir, f))
    info = {'kawari': version, 'treePin': pin, 'zipSha256': zsha, 'drift': drift, 'emcc': emcc,
            'patches': len(patches.PATCHES), 'opt': 'O0' if a.debug else a.opt, 'debug': a.debug}
    with open(os.path.join(out_dir, 'kawari.build-info.json'), 'w', newline='\n') as fh:
        json.dump(info, fh, indent=1)
    with open(os.path.join(out_dir, 'kawari.LICENSES.txt'), 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(licenses(version, pin, zsha))
    for f in ('kawari.js', 'kawari.wasm'):
        print(f'{f}: {os.path.getsize(os.path.join(out_dir, f)):,} bytes')
    print(f'-> {out_dir} (KAWARI {version}, {variant})')


if __name__ == '__main__':
    main()
