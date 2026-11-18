#!/usr/bin/env python3
"""Build assets/arenas.json from the game executable, code overlay and DAT dir.

usage: python3 -I tools/build_arenas.py DISC_DIR OUT_JSON
  DISC_DIR contains files/SCUS_945.70 and dat/NNNN.tXX.bin (extracted by dat.py)

Everything is read from the user's own disc data. Tables used (all addresses
are PS1 RAM addresses; exe loads at 0x80010000 with a 0x800 header, the code
overlay 0991 is mapped at 0x80078c90):
  0x8004dcbc  u32[45]   pointers to level-name strings
  0x8004ddd0  6-byte    level table: {family(0x1xx), variant, alt} per level
  0x8004e110  8-byte    archive file table {sector, size} x 992
  0x80050010  12-byte   file GROUP table {first_file, count, bytes} x 130
  0x80052a54  0x38-byte model slot table; +0 -> t29 file entry, +4 -> t08 entry
  0x80058b88  20-byte   per-level sound record {t10 music, 2, t0c sfx, t0c sfx, ?}
  0x800a001c  u32[45]   (overlay) per-level pointer into level data blocks
"""
import glob
import json
import os
import struct
import sys

EXE_BASE, EXE_HDR = 0x80010000, 0x800
OVL_BASE = 0x80078C90
FILE_TAB = 0x8004E110
GROUP_TAB = 0x80050010
NGROUPS = 130
NLEVELS = 45

FAMILIES = {
    0x101: ("Titles/Menu", None, 722),
    0x102: ("Warp rooms / podium", None, 721),
    0x103: ("Ring Ding", 148, 720),
    0x104: ("Crate Crush", 151, 728),
    0x105: ("Papu Pummel (boss)", 146, 727),
    0x106: ("Tank Wars", 141, 726),
    0x107: ("Pogo Painter", 145, 725),
    0x108: ("Ballistix", 152, 724),
    0x109: ("Polar Push", 144, 487),
    0x10A: ("Crash Dash", 143, 723),
    0x10B: ("Dragon Drop", 142, 719),
    0x10C: ("Oxide Ride (boss)", 147, 717),
    0x10D: ("Keg Kaboom", 149, 716),
    0x10E: ("Mallet Mash", 150, 718),
}
# level -> inferred model/texture group (see docs/formats/arenas.md)
GROUP_GUESS = {}
for lv in range(18, 23):
    GROUP_GUESS[lv] = ([19], "medium")          # whole Polar Push family group
for i, lv in enumerate(range(23, 32)):
    GROUP_GUESS[lv] = ([20 + i], "medium-low")  # one group per arena, in order
for lv in range(0, 18):
    GROUP_GUESS[lv] = (list(range(5, 19)), "unresolved (candidate range only)")


def main(disc, out):
    exe = open(os.path.join(disc, "files", "SCUS_945.70"), "rb").read()
    ovl = open(os.path.join(disc, "dat", "0991.code.bin"), "rb").read()
    dat = os.path.join(disc, "dat")
    types = {}
    for p in glob.glob(os.path.join(dat, "*.bin")):
        n = os.path.basename(p)
        types[int(n[:4])] = n.split(".")[1]

    def rb(a, n):
        o = a - EXE_BASE + EXE_HDR
        if o < 0 or o + n > len(exe):
            raise ValueError(hex(a))
        return exe[o:o + n]

    def u32(a): return struct.unpack("<I", rb(a, 4))[0]
    def u16(a): return struct.unpack("<H", rb(a, 2))[0]

    def cstr(a):
        return rb(a, 32).split(b"\0")[0].decode("ascii", "replace")

    def file_of(p):
        if not (FILE_TAB <= p < FILE_TAB + 992 * 8 and (p - FILE_TAB) % 8 == 0):
            return None
        return (p - FILE_TAB) // 8

    def desc(i):
        return {"index": i, "file": "%04d.%s.bin" % (i, types.get(i, "?"))}

    groups = []
    for g in range(NGROUPS):
        s, c, b = struct.unpack("<III", rb(GROUP_TAB + 12 * g, 12))
        kinds = {}
        for i in range(s, s + c):
            kinds[types[i]] = kinds.get(types[i], 0) + 1
        groups.append({"group": g, "first_file": s, "count": c, "bytes_on_disc": b,
                       "types": kinds})

    levels = []
    for lv in range(NLEVELS):
        p = u32(0x8004DCBC + 4 * lv)
        name = cstr(p) if p else ""
        fam, var, alt = struct.unpack("<HHH", rb(0x8004DDD0 + 6 * lv, 6))
        rec = [u32(0x80058B88 + 20 * lv + 4 * j) for j in range(5)]
        music, sfx1, sfx2 = file_of(rec[0]), file_of(rec[2]), file_of(rec[3])
        fname, text, anim = FAMILIES.get(fam, ("?", None, None))
        ov_ptr = struct.unpack_from("<I", ovl, 0x800A001C - OVL_BASE + 4 * lv)[0]
        g, gconf = GROUP_GUESS.get(lv, (None, "unknown"))
        e = {
            "level_id": lv,
            "name": name,
            "family_code": "0x%03x" % fam,
            "family": fname,
            "arena_variant": var,
            "alt_variant": alt,
            "files": {
                "text": {**desc(text), "confidence": "high"} if text else None,
                "music_t10": {**desc(music), "confidence": "medium-high"} if music is not None else None,
                "sfx_bank_t0c": [{**desc(x), "confidence": "medium-high"} for x in
                                 sorted({sfx1, sfx2}) if x is not None],
                "character_anim_table": {**desc(anim), "confidence": "medium-high"} if anim else None,
                "model_texture_groups": g,
                "model_texture_confidence": gconf,
            },
            "overlay_level_data_ptr": "0x%08x" % ov_ptr,
        }
        levels.append(e)

    slots = []
    for k in range(283):
        a = 0x80052A54 + 0x38 * k
        p1, p2 = u32(a), u32(a + 4)
        if p1 and file_of(p1) is not None and file_of(p2) is not None:
            slots.append({"slot": k, "t29": file_of(p1), "t08": file_of(p2)})

    doc = {
        "_notes": "Generated by tools/build_arenas.py from the user's own disc. "
                  "t0c/t10/t14 files are SOUND banks (VAB+SEQ), not level geometry. "
                  "Arena geometry lives in t29 (model) + t08 (texture) pairs inside the file groups.",
        "always_resident_groups": {"0": "global models/textures (68 pairs)", "1": "5 TGA images",
                                   "2": "12 text files", "3": "126 t0c sfx/voice banks",
                                   "4": "25 t10/t14 music files", "30": "character animation tables",
                                   "29": "warp rooms (110 files, t26 hub)"},
        "levels": levels,
        "groups": groups,
        "model_slots": slots,
    }
    with open(out, "w") as f:
        json.dump(doc, f, indent=1)
    print("wrote", out, len(levels), "levels,", len(groups), "groups,", len(slots), "slots")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(2)
    main(sys.argv[1], sys.argv[2])
