#!/usr/bin/env python3
"""List / extract files from a PS1 MODE2/2352 disc image (ISO9660)."""
import sys, os, struct
SEC, HDR, DATA = 2352, 24, 2048

class Disc:
    def __init__(s, path): s.f = open(path, 'rb')
    def read(s, lba, n=1):
        out = b''
        for i in range(n):
            s.f.seek((lba + i) * SEC + HDR); out += s.f.read(DATA)
        return out
    def walk(s, lba=None, size=None, path=''):
        if lba is None:
            pvd = s.read(16)
            root = pvd[156:190]
            lba, size = struct.unpack_from('<I', root, 2)[0], struct.unpack_from('<I', root, 10)[0]
        data = s.read(lba, (size + DATA - 1) // DATA)
        i = 0
        while i < len(data):
            l = data[i]
            if l == 0:
                i = (i // DATA + 1) * DATA; continue
            r = data[i:i + l]
            elba, esize, flags = struct.unpack_from('<I', r, 2)[0], struct.unpack_from('<I', r, 10)[0], r[25]
            name = r[33:33 + r[32]]
            i += l
            if name in (b'\x00', b'\x01'): continue
            name = name.decode('ascii', 'replace').split(';')[0]
            p = f'{path}/{name}'
            if flags & 2: yield from s.walk(elba, esize, p)
            else: yield p, elba, esize

if __name__ == '__main__':
    d = Disc(sys.argv[1])
    out = sys.argv[2] if len(sys.argv) > 2 else None
    for p, lba, size in d.walk():
        print(f'{size:>10}  lba={lba:<7} {p}')
        if out:
            dst = os.path.join(out, p.lstrip('/'))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, 'wb') as f: f.write(d.read(lba, (size + DATA - 1) // DATA)[:size])
