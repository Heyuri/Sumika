"""Licence notices for the files a WebAssembly build ships next to its wasm (satori.LICENSES.txt, yaya.LICENSES.txt,
kawari.LICENSES.txt, kawari7.LICENSES.txt), shared by the four engines/*/build.py. A notice that is not where it was
stops the build: the vendor commit changed, so the list has to be checked again. Every engine's notices end with
emscripten(): the toolchain's runtime and libraries compiled into each engine."""
import os, re, sys, textwrap


def file_text(path, encoding='utf-8'):
    """a licence file: LF line ends, ending in one newline"""
    with open(path, encoding=encoding) as fh:
        return fh.read().replace('\r\n', '\n').strip() + '\n'


def head_lines(path, n, encoding='utf-8'):
    """the first n lines of a file (DEELX's header), LF line ends"""
    with open(path, encoding=encoding) as fh:
        return ''.join(fh.read().replace('\r\n', '\n').splitlines(keepends=True)[:n])


def comment_notice(path, first, last, encoding='utf-8'):
    """The notice in a source file's comment: the lines from the one containing `first` through the one containing
    `last`, without the comment markers (`//`, `/*`, a leading `*`) and the common indent."""
    with open(path, encoding=encoding) as fh:
        lines = fh.read().replace('\r\n', '\n').split('\n')
    try:
        i = next(n for n, line in enumerate(lines) if first in line)
        j = next(n for n in range(i, len(lines)) if last in lines[n])
    except StopIteration:
        sys.exit(f'{os.path.basename(path)}: the notice from "{first}" to "{last}" is not there any more; check the '
                 'licences again')
    body = [re.sub(r'^(\s*)(//|/\*|\*(?!/)) ?', r'\1', line).rstrip() for line in lines[i:j + 1]]
    return textwrap.dedent('\n'.join(body)).strip() + '\n'


def emscripten(emsdk):
    """The last section of every engine's notices: what Emscripten compiles into each engine (emsdk: the toolchain/emsdk
    the build compiles with). The .js file is Emscripten's JavaScript runtime and the .wasm links its system libraries:
    Emscripten's own code (MIT or University of Illinois/NCSA) and musl libc (MIT) want their texts (Emscripten's
    LICENSE, musl's COPYRIGHT); dlmalloc is public domain (CC0); LLVM's libc++, libc++abi, libunwind and compiler-rt
    are Apache-2.0 WITH LLVM-exception, which asks for no notice for its code compiled into a program, so they are
    named only. The versions are read from the emsdk; a version or licence that is not where it was stops the build."""
    em = os.path.join(emsdk, 'upstream', 'emscripten')

    def find(rel, pattern):
        with open(os.path.join(em, rel), encoding='utf-8', errors='replace') as fh:
            m = re.search(pattern, fh.read())
        if not m:
            sys.exit(f'upstream/emscripten/{rel}: "{pattern}" is not there any more; check the licences again')
        return m.group(1)

    version = find('emscripten-version.txt', r'(\d+\.\d+\.\d+)')
    musl = find('system/lib/libc/musl/VERSION', r'(\d+\.\d+\.\d+)')
    dlmalloc = find('system/lib/dlmalloc.c', r'Doug Lea and released to the public domain, as explained at\s+'
                    r'http://creativecommons\.org/publicdomain/zero/1\.0/[^*]*\* Version (\d+\.\d+\.\d+) ')
    llvm = set()
    for d in ('libcxx', 'libcxxabi', 'libunwind', 'compiler-rt'):
        find(f'system/lib/{d}/LICENSE.TXT', r'(The LLVM Project is under the Apache License v2\.0 with LLVM Exceptions)')
        llvm.add(find(f'system/lib/{d}/README.md', r'llvm-project based on release (\d+\.\d+\.\d+)'))
    if len(llvm) != 1:
        sys.exit(f'libc++, libc++abi, libunwind and compiler-rt are of LLVM {", ".join(sorted(llvm))}; check the '
                 'licences again')
    return '\n'.join([
        '== Emscripten runtime and C/C++ libraries\n\n'
        f"Compiled with Emscripten {version} (https://emscripten.org): the .js file is mostly Emscripten's JavaScript\n"
        "runtime, and the .wasm file links Emscripten's system libraries:\n"
        "- Emscripten's own code (MIT or University of Illinois/NCSA): its LICENSE follows;\n"
        f'- musl libc {musl} (MIT): its COPYRIGHT follows;\n'
        f'- dlmalloc {dlmalloc} by Doug Lea (the memory allocator): public domain, CC0\n'
        '  (http://creativecommons.org/publicdomain/zero/1.0/);\n'
        f"- LLVM's libc++, libc++abi, libunwind and compiler-rt (release {llvm.pop()}): Apache-2.0 WITH LLVM-exception,\n"
        '  which asks for no notice for its code compiled into a program.\n',
        '=== Emscripten (MIT or University of Illinois/NCSA), upstream/emscripten/LICENSE\n\n'
        + file_text(os.path.join(em, 'LICENSE')),
        '=== musl libc (MIT), upstream/emscripten/system/lib/libc/musl/COPYRIGHT\n\n'
        + file_text(os.path.join(em, 'system', 'lib', 'libc', 'musl', 'COPYRIGHT')),
    ])
