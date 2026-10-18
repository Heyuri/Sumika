"""messagetxt_builtin.h: vendor/yaya-shiori/messagetxt/*.txt as C string literals, the tables aya5.rc embeds into
yaya.dll as MESSAGETXT resources (patch Y9 looks them up like LoadMessageFromTxtResource). The bytes are kept as they
are (UTF-8 with a BOM at the pinned commit); every other byte than printable ASCII is an octal escape, which never
runs into a following digit.
"""
import os


def c_literal(data):
    out = []
    for b in data:
        if 0x20 <= b < 0x7F and b not in b'"\\?':
            out.append(chr(b))
        else:
            out.append('\\%03o' % b)
    return '"' + ''.join(out) + '"'


def write_builtin_messages(src, repo):
    out = ['// generated from vendor/yaya-shiori/messagetxt by engines/yaya/msgtables.py -- do not edit', '#pragma once',
           'static const struct { const char *name; const char *text; } yaya_builtin_messagetxt[] = {']
    mdir = os.path.join(repo, 'messagetxt')
    for f in sorted(os.listdir(mdir)):
        if not f.endswith('.txt'):
            continue
        with open(os.path.join(mdir, f), 'rb') as fh:
            data = fh.read()
        out.append('{ "%s",' % f[:-4])
        for line in data.splitlines(keepends=True):
            out.append(c_literal(line))
        out.append('},')
    out.append('};')
    with open(os.path.join(src, 'messagetxt_builtin.h'), 'w', encoding='ascii', newline='\n') as fh:
        fh.write('\n'.join(out) + '\n')
