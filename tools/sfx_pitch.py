"""Per-id sound data from the disc's VABs. Run after `render_music.ts sfx index` (reads assets/audio/index.json).

pitch.json {bank: {id: rate}} (ids at 1 omitted): every effect id plays at note 60 (FUN_80022660 pitch 0x1e00 >> 7,
FUN_8002b5b0 -> SsUtKeyOn) against its VAB tone's centre note + fine tune (FUN_80042a20: fine raises pitch), so the SPU
rate is 44100 * 2^((60 - centre + fine/128) / 12). Divided by the sample's own (VAG) rate this gives the playback rate
of our file. The game reuses one sample at several pitches (one tone per sound id), so the rate is per bank and id.
Checked against an emulator recording of the podium (bank 0181).

voices.json {families: {name: [bank per voice block]}, ids: {bank: {id: file}}}: the character voice banks. The exe
table 0x80058f0c[family - 0x101][engine char - 1] names the bank FUN_80022140 loads per player; a bank's tones carry the
ids block*0x32 + n, so the block is read off the bank itself."""
import glob, json, os, struct
ROOT = os.path.join(os.path.dirname(__file__), '..')
idx = json.load(open(os.path.join(ROOT, 'assets/audio/index.json')))['sfx']['banks']


def tones(bank):
    d = open(os.path.join(ROOT, 'disc/dat/%s.t0c.bin' % bank), 'rb').read()
    i = d.find(b'pBAV')
    if i < 0 or bank not in idx: return
    h = d[i:]; samples = idx[bank]['samples']
    for p in range(128):
        for t in range(h[0x20 + p * 16]):
            o = 0x820 + p * 512 + t * 32
            vag = struct.unpack_from('<H', h, o + 22)[0]
            if 1 <= vag <= len(samples): yield h[o + 6] | h[o + 7] << 8, h[o + 4], h[o + 5], samples[vag - 1]


per = {}
for f in sorted(glob.glob(os.path.join(ROOT, 'disc/dat/*.t0c.bin'))):
    b = os.path.basename(f)[:4]
    for sid, centre, fine, sample in tones(b):
        r = 44100 * 2 ** ((60 - centre + fine / 128) / 12) / sample['rate']
        if abs(r - 1) > 0.01: per.setdefault(b, {})[str(sid)] = round(r, 3)
json.dump(per, open(os.path.join(ROOT, 'assets/audio/pitch.json'), 'w'), separators=(',', ':'), sort_keys=True)
print(sum(len(v) for v in per.values()), 'off-pitch ids in', len(per), 'banks')

# voice banks: exe rows 0x106 Tank Wars, 0x107 Pogo (= 0x108 Ballistix, 0x10a Crash Dash), 0x109 Polar Push (= 0x10b Dragon
# Drop), 0x103 Ring Ding (= 0x104 Crate Crush, 0x10d Keg Kaboom, 0x10e Mallet Mash)
exe = open(os.path.join(ROOT, 'disc/files/SCUS_945.70'), 'rb').read()
u32 = lambda a: struct.unpack_from('<I', exe, a - 0x80010000 + 0x800)[0]
families, ids = {}, {}
for name, family in (('tank', 0x106), ('a2', 0x107), ('b', 0x109), ('c', 0x103)):
    row = [None] * 8
    for char in range(8):
        bank = '%04d' % ((u32(0x80058f0c + ((family - 0x101) * 8 + char) * 4) - 0x8004e110) // 8)
        ids[bank] = {str(sid): sample['file'] for sid, _, _, sample in tones(bank) if sample['file']}
        row[min(map(int, ids[bank])) // 0x32] = bank
    families[name] = row
json.dump({'families': families, 'ids': dict(sorted(ids.items()))}, open(os.path.join(ROOT, 'assets/audio/voices.json'), 'w'), separators=(',', ':'))
print('voices.json:', {k: v[0] + '..' for k, v in families.items()})
