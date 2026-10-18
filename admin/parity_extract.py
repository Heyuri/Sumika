"""Extract a .nar / .zip for the parity run (admin/parity.mjs, tests/admin/): the documented way to add a ghost from an
archive (CLAUDE.md Commands: extract it into a new empty folder, then add_ghost.py <that folder> --archive <it>), with
add_ghost.py's member names (zip_name: CP932 names decoded) and the guards of admin/core/archive.mjs, so that the
two tools are compared on the same files.

usage: python -I admin/parity_extract.py ARCHIVE DEST        (DEST: a new empty folder)

Prints the ghost root's prefix inside the archive ('' for the archive's root) as its only line. Exit 3, nothing
written: no ghost/master/descript.txt, or a member admin/core/archive.mjs refuses (a name that leaves the folder or
that Windows would change, encrypted, an unknown method, a file and a folder of one name). Links are not written (the
admin core never writes one); every other member is, personal files too: leaving them out is add_ghost.py's work.
Archives are untrusted data: nothing extracted is run.
"""
import os, re, sys, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.dont_write_bytecode = True                     # no tools/__pycache__ (a .pyc names the folder it was compiled in)
sys.path.insert(0, os.path.join(HERE, '..', 'tools'))
import add_ghost                                   # noqa: E402 (zip_name only)

BAD = re.compile(r'[<>:"|?*\x00-\x1f]')
DEVICE = re.compile(r'^(con|prn|aux|nul|conin\$|conout\$|com[0-9\xb9\xb2\xb3]|lpt[0-9\xb9\xb2\xb3])(\..*)?$', re.I)


def bad_segment(s):
    return (s in ('', '.', '..') or BAD.search(s) or s.endswith(('.', ' '))
            or DEVICE.match(re.sub(r'[. ]+$', '', s)))


def is_link(info):
    host = info.create_system
    if host == 3 and (info.external_attr >> 16) & 0o170000 == 0o120000:
        return True
    return host in (0, 10, 11, 14) and info.external_attr & 0x400


def main(archive, dest):
    with zipfile.ZipFile(archive) as z:
        members = [(add_ghost.zip_name(i), i) for i in z.infolist()]
        desc = sorted((n for n, _ in members if not n.endswith('/')
                       and re.search(r'(^|/)ghost/master/descript\.txt$', n, re.I)), key=len)
        if not desc:
            print(f'{archive} holds no ghost', file=sys.stderr)
            return 3
        prefix = desc[0][:-len('ghost/master/descript.txt')]
        plan, seen = [], {}
        for n, info in members:
            rel = n[len(prefix):].lstrip('/')         # as archive_index and zipfile drop them
            if not n.startswith(prefix) or not rel:
                continue
            is_dir = rel.endswith('/')
            segs = (rel[:-1] if is_dir else rel).split('/')
            if any(bad_segment(s) for s in segs):
                print(f'refused: {n}', file=sys.stderr)
                return 3
            for k in range(1, len(segs) + 1):
                key = '/'.join(segs[:k]).lower()
                kind = 'file' if k == len(segs) and not is_dir else 'dir'
                if seen.setdefault(key, kind) != kind:
                    print(f'refused: {n} (a file and a folder of one name)', file=sys.stderr)
                    return 3
            if not is_dir and (info.flag_bits & 1 or info.compress_type not in (0, 8)):
                print(f'refused: {n} (encrypted or method {info.compress_type})', file=sys.stderr)
                return 3
            plan.append((segs, is_dir, info))
        os.makedirs(dest, exist_ok=True)
        for segs, is_dir, info in plan:
            target = os.path.join(dest, *segs)
            if is_dir:
                os.makedirs(target, exist_ok=True)
                continue
            os.makedirs(os.path.dirname(target), exist_ok=True)
            if is_link(info):
                continue
            with z.open(info) as src, open(target, 'wb') as out:
                out.write(src.read())
    sys.stdout.buffer.write(prefix.encode('utf-8') + b'\n')     # a pipe's code page may lack its characters
    return 0


if __name__ == '__main__':
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    sys.exit(main(sys.argv[1], sys.argv[2]))
