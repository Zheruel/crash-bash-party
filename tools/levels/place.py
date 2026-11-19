#!/usr/bin/env python3
"""Real level object placements -> assets/stages/placements/<name>.json

usage: place.py <objs.json from the emulator object list> <model number of the level t29> <name>

objs.json: the static object list walked from *(*(0x80058ad0)+0x1c) (next = +0x5c), 32 words per object
(see re/notes/engine.md 'Level objects'). Object id 0x50kk = entry k of the model's 0x1c mesh table
(self-relative ptr + 8 = file offset = the glTF node name extra_<hex>). Position +4/+8/+0xc, scale +0x20/24/28
(4.12), rotation matrix 9 shorts from +0x30, flags +0 (bit 0x2000000 = drawn).
"""
import json, struct, sys, os

objs = json.loads(json.loads(open(sys.argv[1]).read()))['o']
model = int(sys.argv[2])
name = sys.argv[3]
root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
d = open(os.path.join(root, 'disc/dat/%04d.t29.bin' % model), 'rb').read()
u = lambda o: struct.unpack_from('<I', d, o)[0]
v = u(0x1c); t = 0x1c + v
# the count word at t is not reliable (Ballistix tables run past it): entry k's second word is -(16 + 12k)
ids = {}
k = 0
while t + 16 + 12 * k <= len(d) and u(t + 8 + 12 * k) == (-(16 + 12 * k)) & 0xffffffff:
    ids[k + 1] = 'extra_%x' % ((u(t + 4 + 12 * k) + 8) & 0xffffffff)
    k += 1
s16 = lambda x: x - 0x10000 if x & 0x8000 else x
s32 = lambda x: x - 0x100000000 if x & 0x80000000 else x
out = []
for o in objs:
    w = [int(x, 16) for x in o['w']]
    oid = w[29]
    if oid >> 8 != 0x50:
        continue
    sh = []
    for k in range(12, 17):
        sh += [s16(w[k] & 0xffff), s16(w[k] >> 16)]
    out.append(dict(id=hex(oid), part=ids.get(oid & 0xff), drawn=bool(w[0] & 0x2000000), flags=hex(w[0]),
                    pos=[s32(w[1]), s32(w[2]), s32(w[3])], scale=[w[8] / 4096, w[9] / 4096, w[10] / 4096],
                    m=[x / 4096 for x in sh[:9]]))
dst = os.path.join(root, 'assets/stages/placements')
os.makedirs(dst, exist_ok=True)
json.dump(dict(model=model, source='emulator RAM object list', objects=out), open(os.path.join(dst, name + '.json'), 'w'), indent=1)
print(len(out), 'objects ->', name)
for o in out: print(o['id'], o['part'], o['drawn'], o['pos'], [round(x, 3) for x in o['m']])
