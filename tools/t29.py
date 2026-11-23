#!/usr/bin/env python3
"""Decode Crash Bash (PS1, USA) type-0x29 model files to glTF 2.0 (.gltf + .bin).

usage: python3 -I tools/t29.py IN.bin|INDIR OUTDIR [TEXROOT]
(TEXROOT = assets/textures: binds tN textures of the paired t08, file number - 1)
Format notes: docs/formats/t29.md.  Pure stdlib.  Input is treated as untrusted:
every offset is bounds-checked and bad meshes are skipped, never raised.

Geometry stays in raw PS1 units (Y down); the root node carries scale 1/1024 and
a (1,-1,-1) flip so the result is Y-up, right-handed.
"""
import json, os, struct, sys

SCALE = 1.0 / 1024.0
MAX_MESH_TRIS = 20000
# Stock character models: riders, equipped models, pilots, and on-foot models.
# The flags are constant across the animation keys of each part.
STOCK_CHARACTERS = {f'{n:04}' for n in range(800, 991, 2)}


def u32(d, o):
    return struct.unpack_from('<I', d, o)[0] if 0 <= o and o + 4 <= len(d) else 0


def rel(d, o):
    """Self-relative pointer: target = address of the field + value (0 = null)."""
    v = u32(d, o)
    t = o + v
    return t if v and 0 <= t <= len(d) else 0


# --------------------------------------------------------------------------- parse
class Mesh:
    pass


def parse_mesh(d, e, colours, uvs, idx):
    m = Mesh()
    m.index = idx
    m.extra = False
    m.entry = e
    m.flags = u32(d, e)
    m.ntri_hdr = m.flags & 0xFFF
    verts, strips, uvi, texr, col = (rel(d, e + 8), rel(d, e + 0xC), rel(d, e + 0x10),
                                     rel(d, e + 0x14), rel(d, e + 0x18))
    if not (verts and strips and uvi and texr and col):
        return None
    # strip control: (flag, ntri) byte pairs, terminated by ntri == 0xFF
    s, o = [], strips
    while o + 1 < len(d) and d[o + 1] != 0xFF and len(s) < 4096:
        s.append((d[o], d[o + 1]))
        o += 2
    if not s:
        return None
    ntri = sum(c for _, c in s)
    nvert = sum(c + 2 for _, c in s)
    if ntri == 0 or ntri > MAX_MESH_TRIS:
        return None
    vbase = verts + 0x14                       # 20-byte header: bbox min/max, centre, radius
    if vbase + 8 * nvert > len(d) or uvi + 2 * ntri > len(d) or col + 2 * ntri > len(d):
        return None
    m.verts_off, m.strips_off, m.uvi_off, m.texr_off, m.col_off = verts, strips, uvi, texr, col
    m.strips, m.ntri, m.nvert = s, ntri, nvert
    m.hdr = struct.unpack_from('<10h', d, verts)
    m.pos = [struct.unpack_from('<3h', d, vbase + 8 * i) for i in range(nvert)]
    m.vflag = [struct.unpack_from('<h', d, vbase + 8 * i + 6)[0] & 3 for i in range(nvert)]
    # per-triangle attributes
    tris = []
    vi = 0
    t = 0
    run_left, run_tex = -1, 0
    texp = texr
    for flag, cnt in s:
        for k in range(cnt):
            a, b, c = vi + k, vi + k + 1, vi + k + 2
            if k & 1:
                a, b = b, a                    # alternate winding
            # texture run list: u16 {bits0-8 tex id, 9-14 run-1, 15 table select}
            run_left -= 1
            if run_left < 0:
                w = struct.unpack_from('<H', d, texp)[0] if texp + 2 <= len(d) else 0
                texp += 2
                run_tex, run_left = w, (w >> 9) & 0x3F
            ci = struct.unpack_from('<H', d, col + 2 * t)[0]
            ui = struct.unpack_from('<H', d, uvi + 2 * t)[0]
            textured = not (flag & 1)
            # vertex colours: 3 consecutive 4-byte entries
            cs = None
            c0 = ci & 0x1FFF
            if colours and c0 + 3 <= colours[1]:
                cs = [tuple(d[colours[0] + 4 * (c0 + j): colours[0] + 4 * (c0 + j) + 3]) for j in range(3)]
            uv = None
            if textured and uvs and ui + 3 <= uvs[1]:
                uv = []
                for j in range(3):
                    w = struct.unpack_from('<H', d, uvs[0] + 2 * (ui + j))[0]
                    uv.append((w & 0xFF, w >> 8))
            if k & 1:
                # a,b were swapped for winding; uv/colour entries are in strip order (v[k], v[k+1], v[k+2]),
                # so swap them with the vertices or they land on the wrong corners
                if cs:
                    cs[0], cs[1] = cs[1], cs[0]
                if uv:
                    uv[0], uv[1] = uv[1], uv[0]
            tris.append(dict(v=(a, b, c), textured=textured, tex=run_tex & 0x1FF,
                             tsel=(run_tex >> 15) & 1, semi=bool(ci & 0x8000), abr=(ci >> 13) & 3,
                             col=cs, uv=uv, sflag=flag, rawuv=ui, rawcol=c0,
                             facing=0 if m.vflag[c] & 2 else 1 + ((m.vflag[c] ^ k) & 1)))
            t += 1
        vi += cnt + 2
    m.tris = tris
    return m


def parse_model(d):
    info = dict(size=len(d), meshes=[], anims=[], notes=[])
    if len(d) < 0x60 or struct.unpack_from('<H', d, 0)[0] != 0x29:
        info['notes'].append('not a type-0x29 file')
        return info
    colours = uvs = None
    p = rel(d, 0x20)
    if p and p + 0x20 <= len(d):
        # colour table runs up to the UV table
        q = rel(d, 0x24)
        end = q if q > p else len(d)
        colours = (p, (end - p) // 4)
    q = rel(d, 0x24)
    if q:
        # UV table (u16 = u | v<<8) ends where the next header table starts; just bound by file
        nxt = [x for x in (rel(d, 0x28), rel(d, 0x2C), rel(d, 0x1C), rel(d, 0x3C), rel(d, 0x4C)) if x > q]
        end = min(nxt) if nxt else len(d)
        uvs = (q, (end - q) // 2)
    info['colour_table'] = colours
    info['uv_table'] = uvs
    n = u32(d, 0x54)
    n = min(n, (len(d) - 0x60) // 0x34 + 1, 4096)
    for k in range(n):
        e = 0x60 + 0x34 * k
        if e + 0x2C > len(d):
            break
        m = parse_mesh(d, e, colours, uvs, k)
        if m:
            info['meshes'].append(m)
    info['nparts'] = n
    # meshes outside the part table (reached through the 0x1c table at run time): strict scan
    have = {m.entry for m in info['meshes']}
    for e in range(0x60, len(d) - 0x30, 4):
        if e in have or (u32(d, e) >> 12) not in (0x40, 0x50, 0x60, 0x70):
            continue
        m = parse_mesh(d, e, colours, uvs, n + len(info['meshes']))
        # vertex block may end before the UV index list (padding) - strict equality dropped e.g. the Jungle Bash temple
        if m and (m.verts_off + 0x14 + 8 * m.nvert == m.uvi_off or (m.verts_off + 0x14 + 8 * m.nvert < m.uvi_off and m.ntri >= 4)) and m.ntri == m.flags & 0xFFF:
            m.extra = True
            info['meshes'].append(m)
    info['anims'] = parse_anims(d, info['meshes'])
    return info


def parse_anims(d, meshes):
    """Vertex-morph animations stored after the model body (see docs).

    Descriptor word +16 is a self-relative pointer to (target part entry - 8); it names the part the
    keyframes drive (matches a part for 1036/1036 groups, vertex counts agree).
    """
    out = []
    ng = u32(d, 0x40)
    g0 = rel(d, 0x44)
    if not g0 or ng == 0 or ng > 64:
        return out
    by_entry = {m.entry: m for m in meshes}
    for g in range(ng):
        ge = g0 - 4 + 24 * g                  # 24-byte descriptors: ?, tail, pool_end, nframes, part, rate
        if ge < 0 or ge + 24 > len(d):
            break
        T, nfr = u32(d, ge + 4), u32(d, ge + 12)
        if T == 0 or T + 16 > len(d) or nfr == 0 or nfr > 4096 or T + 16 * nfr > len(d):
            continue
        mesh = by_entry.get(ge + 24 + struct.unpack_from('<i', d, ge + 16)[0])
        pool = rel(d, T) or rel(d, 0x28)      # per-group pool, else the model-level pool
        recs = []
        ok = True
        for i in range(nfr):
            r = T + 16 * i
            a, b = rel(d, r + 4), rel(d, r + 8)
            w = struct.unpack_from('<i', d, r + 12)[0]
            if not a or a >= len(d):
                ok = False
                break
            recs.append((a, b, w))
        if not ok or not pool or mesh is None:
            continue
        nv = mesh.nvert
        keys = sorted({x for a, b, w in recs for x in (a, b) if x})
        if any(k + 20 + 2 * nv > len(d) for k in keys) or len(keys) > 512:
            continue
        frames = []
        for k in keys:
            lst = struct.unpack_from('<%dH' % nv, d, k + 20)
            pts = []
            for x in lst:
                po = pool + 6 * (x >> 2)
                if po + 6 > len(d):
                    ok = False
                    break
                pts.append(struct.unpack_from('<3h', d, po))
            if not ok:
                break
            frames.append(pts)
        if not ok:
            continue
        seq = [(keys.index(a), keys.index(b) if b else -1, w) for a, b, w in recs]
        out.append(dict(group=g, tail=T, mesh=mesh, keys=frames, seq=seq,
                        rate=u32(d, ge + 20), nrec=nfr))
    return out


# --------------------------------------------------------------------------- glTF
class Buf:
    def __init__(self):
        self.b = bytearray()
        self.views, self.accs = [], []

    def add(self, data, target=None):
        while len(self.b) % 4:
            self.b.append(0)
        self.views.append(dict(buffer=0, byteOffset=len(self.b), byteLength=len(data),
                               **({'target': target} if target else {})))
        self.b += data
        return len(self.views) - 1

    def acc(self, data, ctype, typ, count, target=None, minmax=None, norm=False):
        v = self.add(data, target)
        a = dict(bufferView=v, componentType=ctype, count=count, type=typ)
        if norm:
            a['normalized'] = True
        if minmax:
            a['min'], a['max'] = minmax
        self.accs.append(a)
        return len(self.accs) - 1


def f32(vals):
    return struct.pack('<%df' % len(vals), *vals)


def mname(m):
    return ('extra_%x' % m.entry) if m.extra else ('part%d' % m.index)


def png_size(path):
    try:
        with open(path, 'rb') as f:
            h = f.read(24)
        if h[:8] == b'\x89PNG\r\n\x1a\n':
            return struct.unpack('>II', h[16:24])
    except OSError:
        pass
    return None


def tex_lookup(texroot, outdir, stem, idx):
    """Texture `idx` of the paired t08 (file number - 1) -> (relative uri, w, h) or None."""
    if not texroot or not stem.isdigit():
        return None
    d = os.path.join(texroot, '%04d' % (int(stem) - 1))
    p = os.path.join(d, 'tex%03d.png' % idx)
    sz = png_size(p)
    if not sz:
        return None
    return os.path.relpath(os.path.realpath(p), os.path.realpath(outdir)).replace(os.sep, '/'), sz[0], sz[1]


def build_gltf(info, stem, texroot=None, outdir='.'):
    B = Buf()
    images, textures = [], []
    mat_tex = {}
    meshes_json, nodes, materials, mat_idx = [], [], [], {}
    mesh_of = {}

    def material(tr):
        key = (tr['textured'], tr['tex'] if tr['textured'] else -1, tr['tsel'] if tr['textured'] else 0,
               tr['semi'], tr['abr'] if tr['semi'] else 0)
        if key not in mat_idx:
            mat = dict(name=('tex%d%s' % (key[1], 'b' if key[2] else '')) if key[0] else 'untextured',
                       pbrMetallicRoughness=dict(baseColorFactor=[1, 1, 1, 1], metallicFactor=0, roughnessFactor=1),
                       doubleSided=True,
                       extras=dict(textured=key[0], texture_index=key[1], texture_table=key[2],
                                   semi_transparent=key[3], abr=key[4]))
            # texture-run bit 15 does not select another table: ids resolve in the paired t08 either way;
            # ids past its end (only seen with bit 15) have no texture here
            ti = tex_lookup(texroot, outdir, stem, key[1]) if key[0] else None
            if ti:
                images.append(dict(uri=ti[0]))
                textures.append(dict(source=len(images) - 1, sampler=0))
                mat['pbrMetallicRoughness']['baseColorTexture'] = dict(index=len(textures) - 1)
                mat_tex[len(materials)] = (ti[1], ti[2])
                mat['alphaMode'] = 'MASK'
                mat['alphaCutoff'] = 0.5
            if key[3]:
                mat['alphaMode'] = 'BLEND'
            mat_idx[key] = len(materials)
            materials.append(mat)
        return mat_idx[key]

    anim_by_mesh = {}
    for a in info['anims']:
        anim_by_mesh.setdefault(a['mesh'].index, []).append(a)
    anim_json = []
    for m in info['meshes']:
        groups = {}
        for t in m.tris:
            groups.setdefault(material(t), []).append(t)
        ans = anim_by_mesh.get(m.index)
        allkeys = [kf for a in ans for kf in a['keys']] if ans else []
        prims = []
        for mi, trs in sorted(groups.items()):
            pos, colr, uvs = [], [], []
            vsrc = []
            for t in trs:
                for j, vi in enumerate(t['v']):
                    p = m.pos[vi]
                    pos += p
                    vsrc.append(vi)
                    if t['col']:
                        c = t['col'][j]           # raw PS1 value, 0x80 = 1.0 for textured (runtime applies x2)
                        colr += [c[0], c[1], c[2], 255]
                    else:
                        colr += [255, 255, 255, 255]
                    if t['textured'] and t['uv']:
                        u, v = t['uv'][j]
                        tw, th = mat_tex.get(mi, (256, 256))
                        uvs += [u / float(tw), v / float(th)]
                    else:
                        uvs += [0.0, 0.0]
            n = len(pos) // 3
            mn = [min(pos[i::3]) for i in range(3)]
            mx = [max(pos[i::3]) for i in range(3)]
            attrs = dict(
                POSITION=B.acc(f32(pos), 5126, 'VEC3', n, 34962, ([float(x) for x in mn], [float(x) for x in mx])),
                COLOR_0=B.acc(bytes(colr), 5121, 'VEC4', n, 34962, norm=True),
                TEXCOORD_0=B.acc(f32(uvs), 5126, 'VEC2', n, 34962))
            prim = dict(attributes=attrs, material=mi, mode=4)
            if stem in STOCK_CHARACTERS or (stem == '0131' and 14 <= m.index <= 21):
                # 0 is two-sided, 1 faces clockwise, 2 faces counterclockwise after strip expansion.
                prim['extras'] = dict(ps1Facing=''.join(str(t['facing']) for t in trs))
            if ans:
                tg = []
                for kf in allkeys:
                    dl = []
                    for vi in vsrc:
                        a, b = kf[vi], m.pos[vi]
                        dl += [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
                    dl = [float(x) for x in dl]
                    mm = ([min(dl[i::3]) for i in range(3)], [max(dl[i::3]) for i in range(3)]) if dl else None
                    tg.append(dict(POSITION=B.acc(f32(dl), 5126, 'VEC3', n, minmax=mm)))  # glTF requires min/max on POSITION accessors
                prim['targets'] = tg
            prims.append(prim)
        mj = dict(name=mname(m), primitives=prims,
                  extras=dict(part=m.index, table_entry=not m.extra, file_offset=m.entry, flags=m.flags, triangles=m.ntri, vertices=m.nvert,
                              bbox_centre_radius=list(m.hdr[6:10]), bbox=list(m.hdr[:6])))
        if ans:
            mj['weights'] = [0.0] * len(allkeys)
            mj['extras']['morph_keyframes'] = len(allkeys)
        mesh_of[m.index] = len(meshes_json)
        meshes_json.append(mj)
        nodes.append(dict(name=mname(m), mesh=mesh_of[m.index]))
        if ans:
            off = 0
            for an in ans:
                anim_json.append((len(nodes) - 1, an, off, len(allkeys)))
                off += len(an['keys'])

    animations = []
    for ni, an, off, K in anim_json:
        times, wts = [], []
        for i, (a, b, w) in enumerate(an['seq']):
            ws = [0.0] * K
            f = max(0.0, min(1.0, w / 4096.0)) if b >= 0 else 0.0
            ws[off + a] += 1.0 - f
            if b >= 0:
                ws[off + b] += f
            wts += ws
            times.append(i / 30.0)
        ta = B.acc(f32(times), 5126, 'SCALAR', len(times), minmax=([times[0]], [times[-1]]))
        wa = B.acc(f32(wts), 5126, 'SCALAR', len(wts))
        animations.append(dict(name='group%d_%s' % (an['group'], mname(an['mesh'])),
                               samplers=[dict(input=ta, output=wa, interpolation='LINEAR')],
                               channels=[dict(sampler=0, target=dict(node=ni, path='weights'))],
                               extras=dict(frames=an['nrec'], assumed_fps=30, rate_field=an['rate'])))
    root = dict(name=stem, children=list(range(len(nodes))), scale=[SCALE, -SCALE, -SCALE])
    nodes.append(root)
    g = dict(asset=dict(version='2.0', generator='crash-bash t29.py'),
             scene=0, scenes=[dict(nodes=[len(nodes) - 1])], nodes=nodes, meshes=meshes_json,
             materials=materials, accessors=B.accs, bufferViews=B.views,
             buffers=[dict(uri=stem + '.bin', byteLength=len(B.b))])
    if animations:
        g['animations'] = animations
    if textures:
        g['images'], g['textures'] = images, textures
        g['samplers'] = [dict(magFilter=9728, minFilter=9728, wrapS=33071, wrapT=33071)]
    return g, bytes(B.b)


def convert(path, outdir, texroot=None):
    d = open(path, 'rb').read()
    stem = os.path.basename(path)
    for suf in ('.bin', '.t29'):
        if stem.endswith(suf):
            stem = stem[:-len(suf)]
    info = parse_model(d)
    if not info['meshes']:
        return stem, 0, 0, 0, info['notes'] or ['no meshes']
    g, b = build_gltf(info, stem, texroot, outdir)
    os.makedirs(outdir, exist_ok=True)
    with open(os.path.join(outdir, stem + '.bin'), 'wb') as f:
        f.write(b)
    with open(os.path.join(outdir, stem + '.gltf'), 'w') as f:
        json.dump(g, f, separators=(',', ':'))
    return stem, len(info['meshes']), sum(m.ntri for m in info['meshes']), len(info['anims']), []


def main():
    if len(sys.argv) not in (3, 4):
        print(__doc__)
        sys.exit(2)
    src, out = sys.argv[1], sys.argv[2]
    texroot = sys.argv[3] if len(sys.argv) == 4 else None
    files = [src]
    if os.path.isdir(src):
        files = [os.path.join(src, f) for f in sorted(os.listdir(src)) if f.endswith('.t29.bin')]
    for f in files:
        try:
            stem, nm, nt, na, notes = convert(f, out, texroot)
        except Exception as ex:      # keep batch going on hostile input
            print('%s: ERROR %r' % (f, ex))
            continue
        print('%s: meshes=%d tris=%d anims=%d %s' % (stem, nm, nt, na, ' '.join(notes)))


if __name__ == '__main__':
    main()
