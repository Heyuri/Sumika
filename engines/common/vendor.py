"""What the Satori and YAYA builds know of their vendored source folder: whether it is a git checkout of its own, and
the pin of the files a build reads from it. Shared by engines/satori/build.py and engines/yaya/build.py.

vendor/satoriya-shiori and vendor/yaya-shiori are copies in this repository: no .git of their own, and git run in them
answers for the enclosing repository (its HEAD, its status), so a build takes the commits the copy was made from and
checks the files it reads by their pin instead. A git checkout of its own (a clone of the upstream at the pinned commit,
submodules included) still names its commits itself.

The pin is the tree pin of docs/research/kawari-wasm.md §1 (engines/kawari/build.py tree_pin: SHA-256 over
`path NUL size NUL bytes` in sorted relative POSIX path order) over a list of files instead of a whole folder.
"""
import hashlib, os, subprocess


def own_checkout(path):
    """Whether path is the top of a git checkout (a submodule's included); False without git."""
    try:
        r = subprocess.run(['git', '-C', path, 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
    except OSError:
        return False
    top = r.stdout.strip()
    if r.returncode or not top:
        return False
    return os.path.normcase(os.path.realpath(top)) == os.path.normcase(os.path.realpath(path))


def listed(root, sub='', exts=None, recursive=False):
    """The files directly in root/sub (and below it when recursive), relative to root with '/', those with one of
    exts (lower-case extensions with the dot) when given."""
    out = []
    for d, dirs, names in os.walk(os.path.join(root, *sub.split('/')) if sub else root):
        dirs.sort()
        for n in names:
            if exts is None or os.path.splitext(n)[1].lower() in exts:
                out.append(os.path.relpath(os.path.join(d, n), root).replace(os.sep, '/'))
        if not recursive:
            break
    return out


def files_pin(root, files):
    """(SHA-256 hex, how many files) of the files (relative to root, '/'-separated) in sorted order."""
    names = sorted(set(files))
    h = hashlib.sha256()
    for rel in names:
        with open(os.path.join(root, *rel.split('/')), 'rb') as fh:
            data = fh.read()
        h.update(rel.encode('utf-8') + b'\0' + str(len(data)).encode('ascii') + b'\0' + data)
    return h.hexdigest(), len(names)
