#!/usr/bin/env python3
"""PODIUM (level 43) scene data -> assets/stages/podium.json + assets/stages/placements/L43.json

usage: podium.py [re/dumps/L43.ram]

Everything comes out of a RAM dump taken inside the scene (re/notes/podium.md): the level's static objects,
the two camera paths, the eight tie layouts, the pedestal table and the per-character animation scripts of the
warp/podium overlay (0721.t6a, loaded at 0x800b32b4).
"""
import json, os, struct, sys

root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ram = open(sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, 're/dumps/L43.ram'), 'rb').read()
u32 = lambda a: struct.unpack_from('<I', ram, a - 0x80000000)[0]
s32 = lambda a: struct.unpack_from('<i', ram, a - 0x80000000)[0]
u16 = lambda a: struct.unpack_from('<H', ram, a - 0x80000000)[0]
s16 = lambda a: struct.unpack_from('<h', ram, a - 0x80000000)[0]
u8 = lambda a: ram[a - 0x80000000]
ok = lambda a: 0x80000000 < a < 0x80200000

MODEL = 379   # level model slot 205 (0x8005572c): title screen / podium set
SCALE = 3.0   # same unit as the 744-758 characters (crash = 1.47 world units tall)

# ---- static objects (podium disc + machine), same walk as tools/levels/place.py
d = open(os.path.join(root, 'disc/dat/%04d.t29.bin' % MODEL), 'rb').read()
du = lambda o: struct.unpack_from('<I', d, o)[0]
t = 0x1c + du(0x1c)
ids, k = {}, 0
while t + 16 + 12 * k <= len(d) and du(t + 8 + 12 * k) == (-(16 + 12 * k)) & 0xffffffff:
    ids[k + 1] = 'extra_%x' % ((du(t + 4 + 12 * k) + 8) & 0xffffffff)
    k += 1
base = u32(0x80058ad0)
objs, p = [], u32(base + 0x1c)
while ok(p) and len(objs) < 64:
    w = [u32(p + 4 * i) for i in range(32)]
    if w[29] >> 8 == 0x50:
        objs.append(dict(id=hex(w[29]), part=ids.get(w[29] & 0xff), drawn=bool(w[0] & 0x2000000), flags=hex(w[0]),
                         pos=[s32(p + 4), s32(p + 8), s32(p + 12)], scale=[w[8] / 4096, w[9] / 4096, w[10] / 4096],
                         m=[s16(p + 0x30 + 2 * i) / 4096 for i in range(9)]))
    p = w[23]
os.makedirs(os.path.join(root, 'assets/stages/placements'), exist_ok=True)
json.dump(dict(model=MODEL, source='emulator RAM object list', objects=objs),
          open(os.path.join(root, 'assets/stages/placements/L43.json'), 'w'), indent=1)

# ---- camera paths: *(level + 0x28) = id list, *(level + 0x2c) = self-relative path pointers.
# path: +4 end distance, node 0 at +0x30 = look-at target, nodes 1.. = camera polyline (x, y, z, distance), 28 bytes each
paths = {}
idt, ptab = u32(base + 0x28), u32(base + 0x2c)
for i in range(u32(idt)):
    e = idt + 4 + 4 * i
    pid = u32(e + u32(e) + 0xc)
    q = ptab + 4 * i
    path = q + s32(q)
    nodes, a = [], path + 0x30
    while True:
        n = [s32(a + 4 * j) for j in range(4)]
        nodes.append(n)
        if len(nodes) > 1 and (n[3] >= s32(path + 4) or u32(a + 20) & 0x2000):
            break
        a += 28
    paths[str(pid)] = dict(target=nodes[0][:3], nodes=nodes[1:], end=s32(path + 4))

# ---- layouts (0x800bd210, 8 x 4 x 12 bytes): x, z, pedestal 1..4, loser flag; order = best score first
layouts = [[[s32(0x800bd210 + L * 0x30 + i * 12), s32(0x800bd210 + L * 0x30 + i * 12 + 4),
             u8(0x800bd210 + L * 0x30 + i * 12 + 8), u8(0x800bd210 + L * 0x30 + i * 12 + 9)] for i in range(4)] for L in range(8)]
ped_ids = [u16(0x800bd1f0 + 4 * i) for i in range(4)]            # render id = 0x2000 + part + 1
ped_h = [s32(0x800bd200 + 4 * i) for i in range(4)]

# ---- character scripts: {0, table, 0x401}; table = [win idle, win, 0, ->0, lose idle, lose, 0, ->4]
# engine character 1..8 -> (script struct, podium model), FUN_800b93b4. Engine 6 is the grey koala in red, 8 the ape in shorts.
CHARS = {1: (0x800bd008, 758), 2: (0x800bcfb8, 756), 3: (0x800bd070, 754), 4: (0x800bcf68, 752),
         5: (0x800bd18c, 750), 6: (0x800bd1e4, 748), 7: (0x800bd0d8, 746), 8: (0x800bd134, 744)}
# the same character's in-game model (model slots 1..8): the client matches the catalog entry on it
BASE = {m['slot']: m['t29'] for m in json.load(open(os.path.join(root, 'assets/arenas.json')))['model_slots'] if 1 <= m['slot'] <= 8}


def script(a):
    out, p = [], a + 2
    while True:
        op = u16(p); p += 2
        if op == 0x8000:
            return dict(seg=out, loop=True)
        if op == 0x8001:
            return dict(seg=out, loop=False)
        assert op in (0x8011, 0x8012), hex(op)
        n, pose = u16(p), u16(p + 2); p += 4
        out.append([1 if op == 0x8011 else -1, n, (pose - 0x4000) >> 7, pose & 0x7f])   # dir, frames, clip, first frame


def hash_(s):
    return sum(ord(c) * (i + 1) for i, c in enumerate(s))


NAMES = {hash_(n): n for n in ('WIN_BREATHE', 'WIN', 'LOSE_BREATHE', 'LOSE')}
chars, props = {}, {}
for eng, (st, model) in CHARS.items():
    tab = u32(st + 4)
    t4 = [u32(tab + 4 * i) for i in range(8)]
    assert t4[3] == 0 and t4[7] == 4
    md = open(os.path.join(root, 'disc/dat/%04d.t29.bin' % model), 'rb').read()
    g0 = 0x44 + struct.unpack_from('<I', md, 0x44)[0]
    clips = [NAMES.get(struct.unpack_from('<I', md, g0 + 24 * g + 16)[0], '?') for g in range(struct.unpack_from('<I', md, 0x40)[0])]
    chars[str(eng)] = dict(engine=eng, base=BASE[eng], model=model, clips=clips,
                       # frames of WIN_BREATHE before the next WIN: rand(n) + base (FUN_800b92a0); losers use rand(40)
                       winWait=[30, 20] if eng == 3 else [60, 60] if eng == 4 else [40, 10], loseWait=[40, 0],
                       # crowd sample of bank 0181 (ids 0x352-0x354) and the two firework colours (FUN_800b8f50)
                       cheer=0 if eng in (1, 2) else 1 if eng in (5, 7) else 2, sparks=[2, 3] if eng in (3, 4, 6, 8) else [0, 1],
                       scripts=dict(winIdle=script(t4[0]), win=script(t4[1]), loseIdle=script(t4[4]), lose=script(t4[5])))
    props['podiumChar_%d' % eng] = dict(model=model, scale=SCALE, parts=['part0'])

part = lambda rid: 'part%d' % ((rid & 0xff) - 1)
out = dict(
    _notes='PODIUM = level 43 (family 0x102, overlay 0721). Generated by tools/levels/podium.py from re/dumps/L43.ram; see '
           're/notes/podium.md. Level model 0379 (title / podium set): statics extra_df8c (disc) + extra_eb1c (machine) at the '
           'origin, sky layers part6 / part7, pedestals part11 / part10 / part8, trophy part9. Fireworks = shared pack 0377 '
           '(heads part32.., trails 0376 tex007-012). Characters = 744-758 (WIN / LOSE clips only), keyed by engine character 1..8; '
           '`base` = the same character in play (990..976). PS1 units, world = '
           '(x, -y, -z) / 1024 * 3.',
    arenas=dict(podium=dict(model=MODEL, scale=SCALE, parts=[o['part'] for o in objs])),
    props=dict(podiumSky=dict(model=MODEL, scale=SCALE, parts=['part6']), podiumStars=dict(model=MODEL, scale=SCALE, parts=['part7']),
               podiumTrophy=dict(model=MODEL, scale=SCALE, parts=['part9']),
               **{'podiumPed%d' % (i + 1): dict(model=MODEL, scale=SCALE, parts=[part(ped_ids[i])]) for i in range(1, 4)},
               podiumSparks=dict(model=377, scale=SCALE, parts=['part32', 'part36', 'part33', 'part35', 'part38', 'part37']),
               podiumStripTrophy=dict(model=732, scale=SCALE, parts=['part0']),  # the score strip's spinning trophy (HUD pack 0732)
               **props),
    podium=dict(
        level=43, scale=SCALE,
        layouts=layouts, pedestalHeight=ped_h,
        trophy=dict(pos=[0, -1196, 644]),
        camera=dict(paths=paths, speed=0x20, hold=0x3c, H=0x200, div=[s32(0x800ad0f4 + 4 * i) for i in range(9)]),
        # sky layers (type-100 parts): rotation = frame * speed >> 12 per axis, drawn with H = 320 (table 0x800a02d8)
        sky=dict(H=0x140, layers=[dict(prop='podiumSky', speed=[s32(0x800a02d8 + 4 * i) for i in range(3)]),
                                  dict(prop='podiumStars', speed=[s32(0x800a02ec + 4 * i) for i in range(3)])]),
        fireworks=dict(first=0x5a, wait=[0x14, 10], life=30, x=0x2000, y=[-0xc00, 0x400], z=0x1000,
                       heads=['part32', 'part36', 'part33', 'part35', 'part38', 'part37'],
                       trails=['textures/0376/tex007.png', 'textures/0376/tex011.png', 'textures/0376/tex008.png',
                               'textures/0376/tex010.png', 'textures/0376/tex009.png', 'textures/0376/tex012.png'],
                       bang=['sfx/0181/3.mp3', 'sfx/0181/4.mp3', 'sfx/0181/5.mp3'], crackle=['sfx/0181/6.mp3', 'sfx/0181/7.mp3', 'sfx/0181/8.mp3'],
                       # per sound id 0x355-0x35a / 0x35b-0x360: note 60 against the tone's centre note, fine tune raising pitch (VAB 0181; checked on an emulator recording)
                       bangRate=[1, 1, 1, 0.927, 0.927, 0.927], crackleRate=[1, 0.96, 1, 0.919, 1, 0.956]),
        cheer=['sfx/0181/0.mp3', 'sfx/0181/1.mp3', 'sfx/0181/2.mp3'],
        chars=chars))
json.dump(out, open(os.path.join(root, 'assets/stages/podium.json'), 'w'), indent=1)
print('podium.json:', len(objs), 'statics,', len(paths), 'camera paths,', len(chars), 'characters')
for n, c in chars.items():
    print(' ', n, c['model'], c['clips'], {k: v['seg'] for k, v in c['scripts'].items()})
