"""Generate cp932_table.h: Windows code page 932 for both engines (Satori's patch 1, YAYA's Y1).

usage: python engines/common/gen_cp932.py OUT.h [--verify DIR]

Exactly what Windows does, measured on Windows 11 (the dumps and scripts in cp932/, see its README):
 - decode: MultiByteToWideChar(932, 0) = Python's cp932 codec for every valid sequence (cp932_single_hi, cp932_dbcs;
   0 = invalid). An invalid pair, even a lead byte before a newline, becomes one U+30FB that takes both bytes, and a
   lead byte at the end U+30FB: the C code does that (the decode model below is the same rule);
 - cp932_enc_*: WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS), satori.dll's flag. The decoder's inverse; a code point
   with several byte sequences takes JIS X 0208 / NEC row 13 first and the IBM extension (0xFA-0xFC) before the
   NEC-selected copy (0xED/0xEE), where Python's encoder picks 0xED/0xEE (U+2170: Windows 0xFA40, Python 0xEEEF);
 - cp932_bf_*: the 85 encodings flags 0 (best fit, yaya.dll's) adds, e.g. U+00E9 -> 'e', U+00A5 -> 0x5C.
Anything else encodes to '?'. Both arrays are sorted by code point (binary search).
--verify DIR checks the tables against DIR/windec.txt, win932_nobestfit.txt and win932_bestfit.txt; exit 1 on any
mismatch.
"""
import os, sys

LEADS = list(range(0x81, 0xA0)) + list(range(0xE0, 0xFD))   # 60 lead bytes; trails 0x40..0xFC (189)
BEST_FIT = {  # WideCharToMultiByte(932, 0) only (win932_bestfit.txt minus win932_nobestfit.txt)
    0x00A1: 0x21, 0x00A5: 0x5C, 0x00A6: 0x7C, 0x00A9: 0x63, 0x00AA: 0x61, 0x00AB: 0x81E1, 0x00AD: 0x2D, 0x00AE: 0x52,
    0x00AF: 0x8150, 0x00B2: 0x32, 0x00B3: 0x33, 0x00B5: 0x83CA, 0x00B7: 0x8145, 0x00B8: 0x8143, 0x00B9: 0x31,
    0x00BA: 0x6F, 0x00BB: 0x81E2, 0x00C0: 0x41, 0x00C1: 0x41, 0x00C2: 0x41, 0x00C3: 0x41, 0x00C4: 0x41, 0x00C5: 0x41,
    0x00C6: 0x41, 0x00C7: 0x43, 0x00C8: 0x45, 0x00C9: 0x45, 0x00CA: 0x45, 0x00CB: 0x45, 0x00CC: 0x49, 0x00CD: 0x49,
    0x00CE: 0x49, 0x00CF: 0x49, 0x00D0: 0x44, 0x00D1: 0x4E, 0x00D2: 0x4F, 0x00D3: 0x4F, 0x00D4: 0x4F, 0x00D5: 0x4F,
    0x00D6: 0x4F, 0x00D8: 0x4F, 0x00D9: 0x55, 0x00DA: 0x55, 0x00DB: 0x55, 0x00DC: 0x55, 0x00DD: 0x59, 0x00DE: 0x54,
    0x00DF: 0x73, 0x00E0: 0x61, 0x00E1: 0x61, 0x00E2: 0x61, 0x00E3: 0x61, 0x00E4: 0x61, 0x00E5: 0x61, 0x00E6: 0x61,
    0x00E7: 0x63, 0x00E8: 0x65, 0x00E9: 0x65, 0x00EA: 0x65, 0x00EB: 0x65, 0x00EC: 0x69, 0x00ED: 0x69, 0x00EE: 0x69,
    0x00EF: 0x69, 0x00F0: 0x64, 0x00F1: 0x6E, 0x00F2: 0x6F, 0x00F3: 0x6F, 0x00F4: 0x6F, 0x00F5: 0x6F, 0x00F6: 0x6F,
    0x00F8: 0x6F, 0x00F9: 0x75, 0x00FA: 0x75, 0x00FB: 0x75, 0x00FC: 0x75, 0x00FD: 0x79, 0x00FE: 0x74, 0x00FF: 0x79,
    0x3094: 0x8394, 0x3099: 0x814A, 0x309A: 0x814B,
    0x00A2: 0x8191, 0x00A3: 0x8192, 0x00AC: 0x81CA,  # also encode-only: 0x8191 decodes to U+FFE0
}


def rank(mb):
    """Which byte sequence Windows writes for a code point that has several: lowest rank first."""
    lead = mb >> 8
    if 0xED <= lead <= 0xEE:
        return 3          # NEC-selected IBM extension: last
    if 0xFA <= lead <= 0xFC:
        return 2          # IBM extension
    return 1 if mb > 0xFF else 0


def tables():
    dec = []
    for lead in LEADS:
        for trail in range(0x40, 0xFD):
            u = 0
            if trail != 0x7F:
                try:
                    s = bytes([lead, trail]).decode('cp932')
                    if len(s) == 1 and ord(s) < 0x10000:
                        u = ord(s)
                except UnicodeDecodeError:
                    pass
            dec.append(u)
    single = {}
    for b in range(0x80, 0x100):
        if b in LEADS:
            continue
        try:
            s = bytes([b]).decode('cp932')
            if len(s) == 1:
                single[b] = ord(s)
        except UnicodeDecodeError:
            pass
    seqs = {}
    for b, u in single.items():
        seqs.setdefault(u, []).append(b)
    for i, u in enumerate(dec):
        if u:
            seqs.setdefault(u, []).append(LEADS[i // 189] << 8 | (0x40 + i % 189))
    base = {u: sorted(mbs, key=lambda m: (rank(m), m))[0] for u, mbs in seqs.items()}
    for u in BEST_FIT:
        assert u not in base, hex(u)
    return dec, single, base


def decode(b, dec, single):
    """The C decoders' rule (Satori SJIStoW, YAYA EmCp932Decode), for --verify."""
    out, i = [], 0
    while i < len(b):
        c = b[i]
        i += 1
        if c < 0x80:
            out.append(c)
        elif c not in LEADS:
            out.append(single.get(c) or 0x30FB)
        elif i >= len(b):
            out.append(0x30FB)
        else:
            t = b[i]
            i += 1
            out.append((dec[LEADS.index(c) * 189 + t - 0x40] if 0x40 <= t <= 0xFC else 0) or 0x30FB)
    return out


def encode(units, table):
    """The C encoders' rule over UTF-16 units: ASCII as is, the table, else '?' (a surrogate pair is "??")."""
    out = b''
    for u in units:
        mb = u if u < 0x80 else table.get(u, 0x3F)
        out += bytes([mb >> 8, mb & 0xFF]) if mb > 0xFF else bytes([mb])
    return out


def write(path, dec, single, base):
    def rows(values):
        return [','.join('0x%04X' % x for x in values[i:i + 16]) + ',' for i in range(0, len(values), 16)]

    out = ['// generated by engines/common/gen_cp932.py (Windows code page 932, measured) -- do not edit', '#pragma once',
           'static const unsigned short cp932_single_hi[128] = {  // bytes 0x80..0xFF (0 = lead byte or invalid)',
           ','.join('0x%04X' % single.get(b, 0) for b in range(0x80, 0x100)) + '};',
           'static const unsigned short cp932_dbcs[60*189] = {  // [lead index][trail-0x40], 0 = invalid']
    out += rows(dec) + ['};']
    for name, table, what in (('enc', base, 'WideCharToMultiByte(932, WC_NO_BEST_FIT_CHARS)'),
                              ('bf', BEST_FIT, 'what WideCharToMultiByte(932, 0) adds (best fit)')):
        keys = sorted(table)
        out += ['// %s, sorted by code point' % what,
                'static const unsigned int cp932_%s_count = %d;' % (name, len(keys)),
                'static const unsigned short cp932_%s_ucs[%d] = {' % (name, len(keys))]
        out += rows(keys) + ['};', 'static const unsigned short cp932_%s_mb[%d] = {' % (name, len(keys))]
        out += rows([table[k] for k in keys]) + ['};']
    with open(path, 'w', encoding='ascii', newline='\n') as f:
        f.write('\n'.join(out) + '\n')


def verify(folder, dec, single, base):
    bad = []
    both = {**base, **BEST_FIT}

    def lines(name):
        with open(os.path.join(folder, name), encoding='ascii') as f:
            return [line.split() for line in f if line.strip()]

    def check_decode(p, where):
        want = ''.join(p[2:])   # windec.ps1 writes the units joined, bestfit.ps1 space-separated: every one counts
        mine = ''.join('%04X' % u for u in decode(bytes.fromhex(p[1]), dec, single))
        if mine != want:
            bad.append('%s: decode %s -> %s, Windows %s' % (where, p[1], mine, want))

    for p in lines('windec.txt'):
        check_decode(p, 'windec.txt')
    for name, table in (('win932_nobestfit.txt', base), ('win932_bestfit.txt', both)):
        win = {}
        for p in lines(name):
            if p[0] == 'E':
                win[int(p[1], 16)] = int(p[2], 16)
            elif p[0] == 'D':
                check_decode(p, name)
            elif p[0] == 'S':   # one code point above U+FFFF, sent as its surrogate pair
                cp = int(p[1], 16) - 0x10000
                mine = encode([0xD800 | cp >> 10, 0xDC00 | cp & 0x3FF], table).hex().upper()
                if mine != p[2]:
                    bad.append('%s: encode U+%s -> %s, Windows %s' % (name, p[1], mine, p[2]))
        for u in range(0x80, 0x10000):
            if not 0xD800 <= u <= 0xDFFF and table.get(u) != win.get(u):
                mine, want = ('%X' % x if x is not None else '?' for x in (table.get(u), win.get(u)))
                bad.append('%s: encode U+%04X -> %s, Windows %s' % (name, u, mine, want))
    for line in bad[:20]:
        print('mismatch', line)
    print('verify %s: %d mismatches' % (folder, len(bad)))
    return len(bad)


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args or args[0].startswith('-'):
        sys.exit(__doc__)
    dec, single, base = tables()
    write(args[0], dec, single, base)
    print('cp932: dbcs %d, single %d, encode %d + %d best fit' %
          (sum(1 for u in dec if u), len(single), len(base), len(BEST_FIT)))
    if '--verify' in args:
        sys.exit(1 if verify(args[args.index('--verify') + 1], dec, single, base) else 0)
