"""Per-sample playback rate as the game keys it: every effect id plays at note 60 (FUN_80022660 pitch 0x1e00 >> 7)
against its VAB tone's centre note + fine tune (fine raises pitch), so the SPU rate is
44100 * 2^((60 - centre + fine/128) / 12). Divided by the sample's own (VAG) rate this gives the playback rate of our
file. The game reuses one sample at several pitches (one tone per sound id), so the rate is per bank and id. Checked against an emulator recording of the podium (bank 0181).
Output: assets/audio/pitch.json {bank: {id: rate}} (ids at 1 omitted)."""
import glob, json, os, struct
ROOT = os.path.join(os.path.dirname(__file__), '..')
idx = json.load(open(os.path.join(ROOT, 'assets/audio/index.json')))['sfx']['banks']
per = {}
for f in sorted(glob.glob(os.path.join(ROOT, 'disc/dat/*.t0c.bin'))):
    b = os.path.basename(f)[:4]
    d = open(f, 'rb').read(); i = d.find(b'pBAV')
    if i < 0 or b not in idx: continue
    h = d[i:]; samples = idx[b]['samples']
    for p in range(128):
        for t in range(h[0x20 + p * 16]):
            o = 0x820 + p * 512 + t * 32
            centre, fine, lo, hi = h[o + 4], h[o + 5], h[o + 6], h[o + 7]
            vag = struct.unpack_from('<H', h, o + 22)[0]
            if not 1 <= vag <= len(samples): continue
            r = 44100 * 2 ** ((60 - centre + fine / 128) / 12) / samples[vag - 1]['rate']
            if abs(r - 1) > 0.01: per.setdefault(b, {})[str(lo | hi << 8)] = round(r, 3)
json.dump(per, open(os.path.join(ROOT, 'assets/audio/pitch.json'), 'w'), separators=(',', ':'), sort_keys=True)
print(sum(len(v) for v in per.values()), 'off-pitch ids in', len(per), 'banks')
