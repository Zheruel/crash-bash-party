#!/usr/bin/env python3
"""Decode Crash Bash (PS1) type-0x08 texture-set files to PNG + JSON.

usage: python3 -I tools/t08.py IN.t08.bin OUTDIR [--all-cluts]

Stdlib only. Input is treated as untrusted: every read is bounds-checked.
Format spec: docs/formats/t08.md
"""
import json, os, struct, sys, zlib

MAX_TEX = 4096
MAX_CLUT = 4096


class T08Error(Exception):
    pass


# ---------------------------------------------------------------- PNG writer
def write_png(path, w, h, rgba):
    """rgba: bytes/bytearray of w*h*4."""
    raw = bytearray()
    stride = w * 4
    for y in range(h):
        raw.append(0)
        raw += rgba[y * stride:(y + 1) * stride]

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)

    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 6)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def bgr555_rgba(c):
    """PS1 colour -> (r,g,b,a). 0x0000 is fully transparent; bit15 = STP."""
    if c == 0:
        return (0, 0, 0, 0)
    r, g, b = c & 31, (c >> 5) & 31, (c >> 10) & 31
    return ((r << 3) | (r >> 2), (g << 3) | (g >> 2), (b << 3) | (b >> 2), 255)


# ------------------------------------------------------------------- parsing
def parse(d):
    if len(d) < 0x20:
        raise T08Error('file too short')
    typ, size, ntex, nclut, off, clut_bits, unk14, extra_off = struct.unpack_from('<IIHHIIII', d, 0)
    # +0x1C is not covered by the unpack above (28 bytes); read separately
    pad1c = struct.unpack_from('<I', d, 0x1c)[0]
    if typ != 8:
        raise T08Error('type id %d != 8' % typ)
    if size != len(d):
        raise T08Error('size field %d != file length %d' % (size, len(d)))
    if not (0 < ntex <= MAX_TEX and 0 < nclut <= MAX_CLUT):
        raise T08Error('implausible counts tex=%d clut=%d (not a texture set)' % (ntex, nclut))
    hdr = dict(type=typ, size=size, num_textures=ntex, num_cluts=nclut, tex_section_rel=off,
               clut_color_bits=clut_bits, unk14=unk14, extra_offset=extra_off, pad1c=pad1c)

    o = 0x20
    cluts = []
    for i in range(nclut):
        if o + 4 > len(d):
            raise T08Error('CLUT %d header out of bounds' % i)
        n = struct.unpack_from('<I', d, o)[0]
        if n not in (16, 256) or o + 4 + 2 * n > len(d):
            raise T08Error('CLUT %d bad entry count %d' % (i, n))
        cols = struct.unpack_from('<%dH' % n, d, o + 4)
        cluts.append(dict(index=i, file_offset=o + 4, colors=n, data=cols))
        o += 4 + 2 * n
    if o != off + 12:
        raise T08Error('CLUT section end 0x%x != header offset+12 (0x%x)' % (o, off + 12))
    tex_start = o

    texs = []
    for i in range(ntex):
        if o + 20 > len(d):
            raise T08Error('texture %d header out of bounds' % i)
        w16, h = struct.unpack_from('<HH', d, o)
        aux0, aux1, rowb, hb = struct.unpack_from('<BBBB', d, o + 4)  # tight bbox of non-zero-index pixels
        zero8, ref, frames = struct.unpack_from('<III', d, o + 8)
        clut_ref = ref & 0xffff
        flags = ref >> 16
        bpp = 8 if clut_ref & 1 else 4
        clut_idx = nclut - 1 if clut_ref == 0xfffe else clut_ref >> 1
        nbytes = w16 * 2 * h
        if o + 20 + nbytes > len(d):
            raise T08Error('texture %d pixel data out of bounds' % i)
        if clut_idx >= nclut or cluts[clut_idx]['colors'] != (256 if bpp == 8 else 16):
            raise T08Error('texture %d CLUT ref 0x%x invalid for bpp %d' % (i, ref, bpp))
        texs.append(dict(index=i, file_offset=o + 20, w16=w16, h=h,
                         width=w16 * 2 * (2 if bpp == 4 else 1), height=h, bpp=bpp,
                         clut=clut_idx, clut_ref_raw=ref, clut_is_last_alias=(clut_ref == 0xfffe),
                         flags=flags, frames=frames, crop_x_bytes=aux0, crop_y=aux1, crop_w_bytes=rowb, crop_h=hb, zero8=zero8))
        o += 20 + nbytes
    tex_end = o

    extra = None
    if extra_off:
        if extra_off != tex_end:
            raise T08Error('extra_offset 0x%x != end of textures 0x%x' % (extra_off, tex_end))
        extra = dict(offset=extra_off, length=len(d) - extra_off)
        words = struct.unpack_from('<%dI' % min(32, extra['length'] // 4), d, extra_off)
        extra['head_u32'] = list(words)
        extra['kind'] = words[0] if words else None
        # low-confidence entry decode
        if len(words) >= 4:
            cnt, esz = words[2], words[3]
            ents = []
            if extra['kind'] == 0 and cnt * 16 + 12 <= extra['length']:
                for k in range(cnt):
                    ents.append(dict(zip(('tex', 'value_s32', 'z0', 'z1'),
                                         struct.unpack_from('<IiII', d, extra_off + 12 + 16 * k))))
            elif extra['kind'] == 8 and esz == cnt * 20 and 16 + esz <= extra['length']:
                for k in range(cnt):
                    ents.append(dict(zip(('tex', 'frames', 'size', 'z', 'off'),
                                         struct.unpack_from('<IIIII', d, extra_off + 16 + 20 * k))))
            extra['entries_guess'] = ents
    else:
        trailer = len(d) - tex_end
        if trailer not in (4, 8, 12) or any(d[tex_end:]):
            raise T08Error('unexpected trailer of %d bytes' % trailer)
        hdr['trailer_zero_bytes'] = trailer
    return hdr, cluts, texs, extra, tex_start, tex_end


def decode_indices(d, t):
    """Return list of palette indices, row-major, width*height."""
    raw = d[t['file_offset']:t['file_offset'] + t['w16'] * 2 * t['h']]
    if t['bpp'] == 8:
        return raw
    out = bytearray(len(raw) * 2)
    out[0::2] = bytes(b & 15 for b in raw)  # low nibble = left pixel
    out[1::2] = bytes(b >> 4 for b in raw)
    return bytes(out)


def render(idx, w, h, clut):
    pal = [bgr555_rgba(c) for c in clut['data']]
    pal_b = [bytes(p) for p in pal]
    out = bytearray()
    for v in idx:
        out += pal_b[v] if v < len(pal_b) else b'\0\0\0\0'
    return out


# ---------------------------------------------------------------------- main
def main(argv):
    args = [a for a in argv[1:] if not a.startswith('--')]
    all_cluts = '--all-cluts' in argv
    if len(args) != 2:
        print(__doc__)
        return 2
    inp, outdir = args
    with open(inp, 'rb') as f:
        d = f.read()
    try:
        hdr, cluts, texs, extra, tex_start, tex_end = parse(d)
    except T08Error as e:
        print('%s: not a decodable t08 texture set: %s' % (inp, e), file=sys.stderr)
        return 1
    os.makedirs(outdir, exist_ok=True)

    # animation grouping: a block with frames>1 is followed by frames-1 blocks that share its CLUT ref
    for t in texs:
        t['anim_head'] = None
    i = 0
    while i < len(texs):
        t = texs[i]
        if t['frames'] > 1:
            n = t['frames']
            members = list(range(i, min(i + n, len(texs))))
            # blocks in-file only if the following blocks repeat the same ref with frames==1
            if all(texs[j]['clut_ref_raw'] & 0xffff == t['clut_ref_raw'] & 0xffff and
                   (j == i or texs[j]['frames'] == 1) for j in members) and i + n <= len(texs) \
                    and (i + 1 < len(texs) and texs[i + 1]['clut_ref_raw'] & 0xffff == t['clut_ref_raw'] & 0xffff):
                for j in members:
                    texs[j]['anim_head'] = i
                t['anim_blocks'] = members
                i += n
                continue
        i += 1

    meta_tex = []
    sheet_items = []
    for t in texs:
        idx = decode_indices(d, t)
        w, h = t['width'], t['height']
        pairs = [t['clut']]
        if all_cluts:
            pairs = [c['index'] for c in cluts if c['colors'] == (256 if t['bpp'] == 8 else 16)]
        files = {}
        for ci in pairs:
            name = 'tex%03d.png' % t['index'] if ci == t['clut'] else 'tex%03d_clut%03d.png' % (t['index'], ci)
            if w and h:
                rgba = render(idx, w, h, cluts[ci])
                write_png(os.path.join(outdir, name), w, h, rgba)
                files[ci] = name
                if ci == t['clut']:
                    sheet_items.append((t['index'], w, h, rgba))
        m = {k: v for k, v in t.items() if k != 'file_offset'}
        m['file_offset'] = t['file_offset']
        m['png'] = files.get(t['clut'])
        m['png_all_cluts'] = {str(k): v for k, v in files.items()} if all_cluts else None
        meta_tex.append(m)

    # CLUT strip image (one row per CLUT)
    mw = max(c['colors'] for c in cluts)
    rows = bytearray()
    for c in cluts:
        r = bytearray()
        for col in c['data']:
            r += bytes(bgr555_rgba(col))
        r += b'\0\0\0\0' * (mw - c['colors'])
        rows += r
    write_png(os.path.join(outdir, 'cluts.png'), mw, len(cluts), rows)

    # contact sheet (shelf packed, 1024 wide, 2px gutter)
    SW, G = 1024, 2
    placed, x, y, rowh = [], 0, 0, 0
    for (ti, w, h, rgba) in sheet_items:
        if x + w > SW:
            x, y, rowh = 0, y + rowh + G, 0
        placed.append((ti, x, y, w, h, rgba))
        x += w + G
        rowh = max(rowh, h)
    SH = y + rowh
    sheet_map = {}
    if SH:
        sheet = bytearray(SW * SH * 4)
        for ti, px, py, w, h, rgba in placed:
            for r in range(h):
                s = ((py + r) * SW + px) * 4
                sheet[s:s + w * 4] = rgba[r * w * 4:(r + 1) * w * 4]
            sheet_map[ti] = dict(x=px, y=py, w=w, h=h)
        write_png(os.path.join(outdir, 'sheet.png'), SW, SH, sheet)

    if extra:
        with open(os.path.join(outdir, 'extra.bin'), 'wb') as f:
            f.write(d[extra['offset']:])

    meta = dict(source=os.path.basename(inp), header=hdr,
                cluts=[dict(index=c['index'], file_offset=c['file_offset'], colors=c['colors'],
                            rgb555=['%04x' % v for v in c['data']]) for c in cluts],
                textures=meta_tex, sheet=dict(png='sheet.png' if SH else None, size=[SW, SH],
                                               placements={str(k): v for k, v in sheet_map.items()}),
                extra=extra,
                vram_placement=None,
                notes='No VRAM x/y in this format: textures are packed into VRAM by the engine at load time. '
                      'Polygons reference a texture by block index; palette = textures[i].clut.')
    with open(os.path.join(outdir, 'meta.json'), 'w') as f:
        json.dump(meta, f, indent=1)
    print('%s: %d textures, %d cluts%s' % (inp, len(texs), len(cluts), ', extra %d B' % extra['length'] if extra else ''))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
