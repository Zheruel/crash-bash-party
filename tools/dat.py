#!/usr/bin/env python3
"""Find CRASHBSH.DAT file table in the PS1 exe and extract entries.
usage: dat.py EXE DAT [OUTDIR]"""
import sys, os, struct
exe, dat = open(sys.argv[1], 'rb').read(), sys.argv[2]
datsize = os.path.getsize(dat)
best = (0, 0)
for start in range(0, len(exe) - 8, 4):
    n, prev = 0, -1
    while start + n * 8 + 8 <= len(exe):
        lba, size = struct.unpack_from('<II', exe, start + n * 8)
        if lba <= prev or size == 0 or lba * 2048 + size > datsize: break
        prev = lba; n += 1
    if n > best[1]: best = (start, n)
start, n = best
print(f'table @0x{start:X}, {n} entries')
table = [struct.unpack_from('<II', exe, start + i * 8) for i in range(n)]
out = sys.argv[3] if len(sys.argv) > 3 else None
f = open(dat, 'rb')
from collections import Counter
types = Counter()
for i, (lba, size) in enumerate(table):
    f.seek(lba * 2048); buf = f.read(size)
    t = struct.unpack_from('<H', buf)[0]
    kind = 'tga' if buf[-18:-1] == b'TRUEVISION-XFILE.' else ('code' if t & 0xFF00 else f't{t:02x}')
    types[kind] += 1
    if out:
        os.makedirs(out, exist_ok=True)
        open(os.path.join(out, f'{i:04d}.{kind}.bin'), 'wb').write(buf)
print(dict(sorted(types.items())))
