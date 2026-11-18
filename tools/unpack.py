#!/usr/bin/env python3
"""Split / decode the t0c, t10 and t14 containers of CRASHBSH.DAT.

IMPORTANT: despite the first guess, these are NOT level data. They are PS1
sound banks:
    t0c : [u32 0x0c][u32 vab_off][u32 end]            + ADPCM + VAB (sound effects / voices)
    t10 : [u32 0x10][u32 vab_off][u32 seq1][u32 seq2] + ADPCM + VAB + 2x SEQ (music)
    t14 : [u32 0x14][u32 vab_off][seq1][seq2][seq3]   + ADPCM + VAB + 3x SEQ (music)
(The few "text" files that share a type id - 0143, 0147, 0141.. - are plain
string tables and are rejected here.)

Layout after the u32 table: raw SPU-ADPCM ("VAG" body, first block is silence),
then a Sony VAB header ('pBAV'), then Sony SEQ ('pQES') sequences.

usage:
    python3 -I unpack.py info  FILE...                 # print JSON summary
    python3 -I unpack.py split FILE OUTDIR [--wav] [--rate HZ]
        writes OUTDIR/vab.bin, vagNN.vag (raw ADPCM), seqN.seq, info.json
        and, with --wav, vagNN.wav (16-bit mono PCM).
Stdlib only. Input is treated as untrusted: every offset is bounds-checked.
"""
import json
import os
import struct
import sys

FILTERS = ((0, 0), (60, 0), (115, -52), (98, -55), (122, -60))
MAX_FILE = 64 * 1024 * 1024


class FormatError(Exception):
    pass


def _u16(d, o):
    if o < 0 or o + 2 > len(d):
        raise FormatError("read past end")
    return struct.unpack_from("<H", d, o)[0]


def parse_container(d):
    """Return dict with kind, vag (start,end), vab (start,end), seqs [(s,e)]."""
    if len(d) < 16 or len(d) > MAX_FILE:
        raise FormatError("bad size")
    kind = struct.unpack_from("<I", d)[0]
    nsec = {0x0C: 1, 0x10: 3, 0x14: 4}.get(kind)  # offsets after the type word
    if nsec is None:
        raise FormatError("type 0x%x is not a sound container" % kind)
    n_off = {0x0C: 2, 0x10: 3, 0x14: 4}[kind]
    offs = list(struct.unpack_from("<%dI" % n_off, d, 4))
    vag_start = 4 * (1 + n_off)
    if kind == 0x0C:
        offs.append(len(d))  # [vab, end]; end == file size
    else:
        offs.append(len(d))
    for a, b in zip(offs, offs[1:]):
        if not (vag_start <= a <= b <= len(d)):
            raise FormatError("offsets not monotonic / in range")
    vab = (offs[0], offs[1] if kind == 0x0C else None)
    seqs = []
    if kind != 0x0C:
        # sections: vab | seq1 | seq2 [| seq3] | EOF
        sec = offs
        vab = (sec[0], sec[1])
        seqs = [(sec[i], sec[i + 1]) for i in range(1, len(sec) - 1)]
    else:
        vab = (offs[0], min(offs[1], len(d)))
    return dict(kind=kind, vag=(vag_start, vab[0]), vab=vab, seqs=seqs)


def parse_vab(d, vo, ve):
    if d[vo:vo + 4] != b"pBAV":
        raise FormatError("no VAB magic")
    ver, vabid, fsz, _r, ps, ts, vs, mvol, pan, a1, a2, _r2 = struct.unpack_from(
        "<IIIHHHHBBBBI", d, vo + 4)
    if ps > 128 or ts > ps * 16 or vs > 254:
        raise FormatError("implausible VAB counts")
    prog_o = vo + 32
    tone_o = prog_o + 128 * 16
    sz_o = tone_o + ps * 16 * 32
    nsz = min(256, vs + 1) if ve - sz_o < 512 else 256
    if sz_o + 2 * (vs + 1) > ve:
        raise FormatError("VAB truncated")
    sizes = [_u16(d, sz_o + 2 * i) * 8 for i in range(vs + 1)]
    programs = []
    for p in range(ps):
        b = prog_o + 16 * p
        ntones, pvol, prio, pmode, ppan = struct.unpack_from("<BBBBB", d, b)
        programs.append(dict(index=p, tones=ntones, vol=pvol, pan=ppan))
    tones = []
    for p in range(ps):
        for t in range(16):
            b = tone_o + (p * 16 + t) * 32
            (prior, mode, vol, pan, center, shift, mn, mx, vw, vt, pw, pt,
             pbmin, pbmax, r1, r2, adsr1, adsr2, prog, vag) = struct.unpack_from(
                "<BBBBBBBBBBBBBBBBHHhh", d, b)
            if vag <= 0 or (vag > vs):
                continue
            tones.append(dict(program=p, tone=t, vag=vag - 1, vol=vol, pan=pan,
                              center=center, fine=shift, min=mn, max=mx,
                              adsr1=adsr1, adsr2=adsr2, mode=mode))
    return dict(version=ver, id=vabid, programs=programs, tones=tones,
                vag_sizes=sizes[1:], nprograms=ps, ntones=ts, nvags=vs)


def vag_slices(d, start, end, sizes):
    """Cut the ADPCM region (silence block first) into per-sample slices."""
    out, pos = [], start + 16  # skip leading silence block
    for s in sizes:
        e = pos + s
        if s % 16 or e > end + 16:
            # table rounding: clamp to region end
            e = min(e, end)
        out.append((pos, max(pos, e)))
        pos = e
    return out


def decode_adpcm(buf):
    """SPU ADPCM -> list of int16. Stops at an 'end' flag block."""
    out = []
    s1 = s2 = 0
    for b in range(0, len(buf) - 15, 16):
        head, flags = buf[b], buf[b + 1]
        shift, filt = head & 0xF, min(head >> 4, 4)
        if shift > 12:
            shift = 9
        f0, f1 = FILTERS[filt]
        for i in range(28):
            byte = buf[b + 2 + i // 2]
            nib = (byte >> 4) if i & 1 else (byte & 0xF)
            v = (nib << 12) & 0xFFFF
            if v & 0x8000:
                v -= 0x10000
            v >>= shift
            v += (s1 * f0 + s2 * f1 + 32) >> 6
            v = max(-32768, min(32767, v))
            out.append(v)
            s2, s1 = s1, v
        if flags & 1:
            break
    return out


def write_wav(path, samples, rate):
    data = struct.pack("<%dh" % len(samples), *samples)
    with open(path, "wb") as f:
        f.write(b"RIFF" + struct.pack("<I", 36 + len(data)) + b"WAVEfmt ")
        f.write(struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16))
        f.write(b"data" + struct.pack("<I", len(data)) + data)


def load(path):
    with open(path, "rb") as f:
        d = f.read(MAX_FILE + 1)
    c = parse_container(d)
    vab = parse_vab(d, c["vab"][0], c["vab"][1] if c["vab"][1] else len(d))
    c["vab_info"] = vab
    return d, c


def summary(c):
    v = c["vab_info"]
    return dict(kind="t%02x" % c["kind"], vag_bytes=c["vag"][1] - c["vag"][0],
                vab=c["vab"], seqs=c["seqs"], programs=v["nprograms"],
                tones=len(v["tones"]), vags=v["nvags"], vag_sizes_sum=sum(v["vag_sizes"]))


def main(argv):
    if len(argv) < 3 or argv[1] not in ("info", "split"):
        print(__doc__)
        return 2
    if argv[1] == "info":
        for p in argv[2:]:
            try:
                d, c = load(p)
                print(os.path.basename(p), json.dumps(summary(c)))
            except FormatError as e:
                print(os.path.basename(p), "SKIP:", e)
        return 0
    path, outdir = argv[2], argv[3]
    wav = "--wav" in argv
    rate = 22050
    if "--rate" in argv:
        rate = int(argv[argv.index("--rate") + 1])
    d, c = load(path)
    os.makedirs(outdir, exist_ok=True)
    v = c["vab_info"]
    vb = c["vab"]
    open(os.path.join(outdir, "vab.bin"), "wb").write(d[vb[0]:vb[1] or len(d)])
    for i, (a, b) in enumerate(c["seqs"]):
        if d[a:a + 4] == b"pQES":
            open(os.path.join(outdir, "seq%d.seq" % i), "wb").write(d[a:b])
    slices = vag_slices(d, c["vag"][0], c["vag"][1], v["vag_sizes"])
    for i, (a, b) in enumerate(slices):
        open(os.path.join(outdir, "vag%02d.vag" % i), "wb").write(d[a:b])
        if wav:
            write_wav(os.path.join(outdir, "vag%02d.wav" % i), decode_adpcm(d[a:b]), rate)
    info = summary(c)
    info["tones"] = v["tones"]
    info["program_list"] = v["programs"]
    json.dump(info, open(os.path.join(outdir, "info.json"), "w"), indent=1)
    print("wrote", len(slices), "vags,", len(c["seqs"]), "seqs to", outdir)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
