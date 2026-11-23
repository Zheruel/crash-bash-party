"""Fit a custom character rig to the disc animation frames.
Requires NumPy, SciPy and ImageMagick 7. Outputs share the base model and disc equipment buffers.
"""
import json
from pathlib import Path
import subprocess

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

MODELS = Path(__file__).resolve().parents[1] / 'assets/models'
# A face atlas the size of a disc texture page: 128 texels, a 256-colour CLUT and 15-bit colour.
PS1_TEXTURE = ['-filter', 'Lanczos', '-resize', '128x128!', '+dither', '-colors', '256',
               '-channel', 'RGB', '-fx', 'round(u*31)/31', '+channel', '-strip',
               '-define', 'png:exclude-chunk=time,date', 'png:-']
# Cortex is the animation and equipment donor for Big Stein.
DONORS = [970, 954, 890, 828, 812, 844, 938, 858, 874, 906]


def load(number):
    return json.loads((MODELS / f'{number:04}.gltf').read_text())


def read(doc, data, index):
    acc = doc['accessors'][index]
    view = doc['bufferViews'][acc['bufferView']]
    size = {'SCALAR': 1, 'VEC3': 3, 'VEC4': 4}[acc['type']]
    dtype = {5121: 'u1', 5126: '<f4'}[acc['componentType']]
    values = np.frombuffer(data, dtype, acc['count'] * size,
                           view.get('byteOffset', 0) + acc.get('byteOffset', 0)).reshape(-1, size)
    return values / 255 if acc.get('normalized') else values


def body_vertices():
    # Connected shells of the unmounted model. The two lowest-reaching shells are its weapon.
    doc = load(986)
    data = (MODELS / '0986.bin').read_bytes()
    shells = []
    for prim in doc['meshes'][0]['primitives']:
        for triangle in read(doc, data, prim['attributes']['POSITION']).reshape(-1, 3, 3):
            points = set(map(tuple, triangle))
            for shell in shells.copy():
                if points & shell:
                    shells.remove(shell)
                    points.update(shell)
            shells.append(points)
    return cKDTree(list(set.union(*(s for s in shells if max(p[1] for p in s) <= 0))))


def polar_stun_rest_triangles():
    """Register stunned vertices to the neutral pose before Melt's material splits."""
    normal = load(954)
    data = (MODELS / '0954.bin').read_bytes()
    positions = [{p['material']: read(normal, data, p['attributes']['POSITION']).reshape(-1,3,3)
                  for p in mesh['primitives']} for mesh in normal['meshes']]
    result = {}
    for material, triangles in positions[1].items():
        # Two patches have a separate texture in the stunned model.
        rest = positions[0][{13: 1, 14: 11}.get(material, material)]
        assert len(rest) == len(triangles)
        for triangle, neutral in zip(triangles, rest):
            result[tuple(map(tuple, triangle))] = neutral
    return result


def unit(v):
    return v / np.maximum(1e-8, np.linalg.norm(v, axis=-1, keepdims=True))


def limb_basis(up, lateral):
    """Keep the roll of the mesh continuous when a limb points sideways."""
    y = unit(up)
    right = unit(lateral)
    forward = unit(np.cross(right, y))
    x = np.cross(y, forward)
    for frame in range(len(y)):
        strength = np.linalg.norm(np.cross(right[frame], y[frame]))
        if frame == 0:
            if strength < .05:
                axis = np.eye(3)[np.argmin(np.abs(y[frame]))]
                x[frame] = unit(axis - (axis @ y[frame]) * y[frame])
            continue
        # Move the previous lateral axis through the limb's swing before pulling
        # it toward the actor's lateral axis. The latter is undefined in a T-pose.
        swing = np.cross(y[frame - 1], y[frame])
        divisor = 1 + y[frame - 1] @ y[frame]
        prior = x[frame - 1]
        if divisor > .0001:
            prior = prior + np.cross(swing, prior) + np.cross(swing, np.cross(swing, prior)) / divisor
        prior = unit(prior - (prior @ y[frame]) * y[frame])
        if strength < .05:
            x[frame] = prior
            continue
        angle = np.arctan2(np.cross(prior, x[frame]) @ y[frame], prior @ x[frame])
        angle = np.clip(angle, -.38, .38) * min(1, strength / .35)
        x[frame] = unit(np.cos(angle) * prior + np.sin(angle) * np.cross(y[frame], prior))
    return np.stack([x, y, unit(np.cross(x, y))], axis=-1)


def two_bone(root, hint, target, first, second, fallback):
    """Place a joint so both segments keep the given lengths, bending in the plane of the hint joint."""
    reach = target - root
    direction = unit(reach)
    distance = np.clip(np.linalg.norm(reach, axis=1, keepdims=True), abs(first - second) + .01, first + second - .01)
    along = (distance**2 + first**2 - second**2) / (2 * distance)
    above = np.sqrt(np.maximum(0, first**2 - along**2))
    bend = hint - root
    bend -= np.sum(bend * direction, axis=1, keepdims=True) * direction
    fallback = fallback - np.sum(fallback * direction, axis=1, keepdims=True) * direction
    bend = np.where(np.linalg.norm(bend, axis=1, keepdims=True) > .01, bend, fallback)
    return root + along * direction + above * unit(bend), root + distance * direction


# Rest lengths of the custom rig's segments in donor units: the mesh length times the bone's size.
REST = {'Jacket': .45*282, 'Shoulder': .231*260, 'Elbow': .29*250, 'Hip': .278*225, 'Knee': .38*235}
# A segment keeps one length through every clip of a model, so it never stretches between frames. The torso takes
# the donor's median length. An arm or leg scales both its segments by one factor, from the donor's median length
# for the whole limb, so the elbow and knee stay where the rest model has them. Past these factors of the rest
# length, a hand or foot stops short of the donor's.
STRETCH = {('Jacket',): (.85, 1.35), ('Shoulder', 'Elbow'): (.95, 1.4), ('Hip', 'Knee'): (.8, 1.2)}


def proportions(samples):
    """One length per segment from the per-frame lengths the donor's joints ask for."""
    result = {}
    for names, (low, high) in STRETCH.items():
        if not all(name in s for s in samples for name in names):
            continue
        limb = np.concatenate([sum(s[name] for name in names) for s in samples])
        factor = np.clip(np.median(limb) / sum(REST[name] for name in names), low, high)
        result.update({name: float(factor * REST[name]) for name in names})
    return result


def poses(points, has_legs, on_foot, lengths=None):
    """Local Y follows each limb. Local X uses the actor's lateral direction.

    Without `lengths`, return the per-frame segment lengths the donor's joints ask for.
    """
    def at(x, y, z):
        return points[(x, y, z)]
    shoulder = [at(s*80, -232, 6) for s in (-1, 1)]
    waist = (at(-40, -89, 0) + at(40, -89, 0)) / 2
    collar = sum(shoulder) / 2
    lateral = shoulder[1] - shoulder[0]
    result = {}
    wanted = {}

    def size(v):
        return np.linalg.norm(v, axis=1)

    def bone(name, origin, up, size, length=None, right=lateral, pitch=0):
        rot = Rotation.from_matrix(limb_basis(up, right))
        if pitch:
            rot = rot * Rotation.from_euler('x', pitch, degrees=True)
        scale = np.full(origin.shape, size, dtype=float)
        if length:
            scale[:, 1] = np.linalg.norm(up, axis=1) / length
        result[name] = (origin, rot.as_quat(), scale)

    spine = collar - waist
    # Cortex has very short legs. Lengthen Stein's stride up from the soles,
    # keeping the sampled grips fixed to the equipment throughout each clip.
    rise = unit(spine) * (72 if on_foot else 0)
    collar = collar + rise
    shoulder = [p + rise for p in shoulder]
    wanted['Jacket'] = [np.clip(size(spine), 105, 191)]
    torso = unit(spine) * (lengths['Jacket'] if lengths else wanted['Jacket'][0][:, None])
    waist_adjust = spine - torso
    waist = collar - torso
    spine = torso
    forward = unit(np.cross(lateral, spine))
    bone('BigStein', waist, spine, 265)
    bone('Jacket', waist, spine, 282, .45)
    eye = (at(68,-317,-153) + at(-68,-317,-153)) / 2
    crown = (at(131,-459,-88) + at(-131,-459,-88)) / 2
    # The donor's crown-to-eye vector tilts back in its neutral pose.
    bone('Head', collar + spine*.24, crown-eye, 340,
         right=at(68,-317,-153)-at(-68,-317,-153), pitch=24.6)
    for i, (s, side) in enumerate([(-1,'R'), (1,'L')]):
        elbow = at(s*79,-162,-20) + rise*.5
        hand = at(s*53,-10,-22)
        wanted.setdefault('Shoulder', []).append(size(elbow - shoulder[i]))
        wanted.setdefault('Elbow', []).append(size(hand - elbow))
        if lengths:
            elbow, hand = two_bone(shoulder[i], elbow, hand, lengths['Shoulder'], lengths['Elbow'], forward)
            bone('Shoulder'+side, shoulder[i], shoulder[i]-elbow, 260, .231)
            bone('Elbow'+side, elbow, elbow-hand, 250, .29)
        if has_legs:
            if (s*16,-99,-8) in points:
                stance = unit(lateral)*s*(21 if on_foot else 0)
                hip = at(s*16,-99,-8) + rise + waist_adjust + stance
                knee = at(s*18,-68,-21) + (rise + waist_adjust)*.52 + stance
                heel = at(s*13,0,10) + stance
            else:  # The original polar rider ends at the saddle.
                right, up = unit(lateral), unit(spine)
                hip = waist + s*right*34
                knee = hip + s*right*43 + unit(np.cross(right, up))*38 - up*34
                heel = knee - up*70
            wanted.setdefault('Hip', []).append(size(hip - knee))
            wanted.setdefault('Knee', []).append(size(knee - heel))
            if lengths:
                knee, heel = two_bone(hip, knee, heel, lengths['Hip'], lengths['Knee'], forward)
                bone('Hip'+side, hip, hip-knee, 225, .278)
                bone('Knee'+side, knee, knee-heel, 235, .38)
    if lengths is None:
        return {name: np.concatenate(values) for name, values in wanted.items()}
    return result


def build(donor, number, body, *, base_model=9001, rig_name='BigSteinRig'):
    source = load(donor)
    base = load(base_model)
    data = (MODELS / source['buffers'][0]['uri']).read_bytes()
    doc = {k:source[k] for k in ('asset','buffers','bufferViews','accessors','images','textures','samplers','materials')}
    # Both originals remain independent external buffers. Indices for the retained
    # equipment and the new rigid-body animation tracks live in a small third buffer.
    na, nv, nm = (len(doc[k]) for k in ('accessors','bufferViews','materials'))
    nt, ns, ni = (len(doc[k]) for k in ('textures','samplers','images'))
    doc['buffers'] += base['buffers']
    doc['bufferViews'] += [dict(v, buffer=1) for v in base['bufferViews']]
    doc['accessors'] += [dict(a, bufferView=a['bufferView']+nv) for a in base['accessors']]
    doc['images'] += [dict(i, bufferView=i['bufferView']+nv) for i in base['images']]
    doc['samplers'] += base['samplers']
    doc['textures'] += [dict(t, source=t['source']+ni, sampler=t['sampler']+ns) for t in base['textures']]
    for m in base['materials']:
        tex = m['pbrMetallicRoughness'].get('baseColorTexture')
        if tex: tex['index'] += nt
    doc['materials'] += base['materials']
    extra = bytearray()

    def add_view(data, target=None):
        extra.extend(bytes(-len(extra) % 4))
        v = dict(buffer=2, byteOffset=len(extra), byteLength=len(data))
        if target: v['target'] = target
        doc['bufferViews'].append(v)
        extra.extend(data)
        return len(doc['bufferViews'])-1

    def append(values, kind, indices=False):
        arr = np.asarray(values, dtype='<u2' if indices else '<f4')
        assert np.isfinite(arr).all()
        doc['accessors'].append(dict(bufferView=add_view(arr.tobytes(), 34963 if indices else None),
                                     componentType=5123 if indices else 5126, type=kind, count=len(arr)))
        return len(doc['accessors'])-1

    meshes, nodes, roots = [], [], []
    equipment_nodes = {}
    vertex_tracks = {}
    polar_mount = donor in (954, 922)
    melt = donor == 922
    source_parts = (0, 1) if polar_mount else (0,)
    offset = np.array([0,-82,-4.5]) if polar_mount else np.zeros(3)
    rest = polar_stun_rest_triangles() if polar_mount else {}
    for part in source_parts:
        original = source['meshes'][part]
        equipment, tracks = [], {}
        for p in original['primitives']:
            pos = read(source, data, p['attributes']['POSITION'])
            deltas = np.stack([read(source,data,t['POSITION']) for t in p['targets']])
            match = pos if part == 0 else np.concatenate([rest[tuple(map(tuple, t))] for t in pos.reshape(-1,3,3)])
            dist, nearest = body.query((match-offset) / (1.125 if donor == 906 else 1))
            for j in np.flatnonzero(dist < 2):
                tracks[tuple(body.data[nearest[j]])] = pos[j]*[1,-1,-1], deltas[:,j]*[1,-1,-1]
            keep = ~(dist.reshape(-1,3) < 2).all(axis=1)
            if keep.any():
                indices = np.arange(len(pos)).reshape(-1,3)[keep].flatten()
                equipment.append(dict(p, indices=append(indices,'SCALAR',True)))
        vertex_tracks[part] = tracks, len(original['weights'])
        if equipment:
            equipment_nodes[part] = len(nodes)
            roots.append(len(nodes))
            nodes.append(dict(name='Equipment' if part == 0 else 'StunnedEquipment',
                              mesh=len(meshes), scale=[1,-1,-1] if part == 0 else [0,0,0]))
            meshes.append(dict(primitives=equipment, weights=original['weights']))

    if melt:
        # The disc switches the bear to a cyan palette. Give the rider a second
        # set of materials and vertex colors for that animation group.
        view = base['bufferViews'][base['images'][0]['bufferView']]
        base_data = (MODELS / base['buffers'][0]['uri']).read_bytes()
        start = view.get('byteOffset', 0)
        atlas = subprocess.check_output(['magick','-','-colorspace','Gray','-evaluate','multiply','0.9',
            '-evaluate','add','10%','-colorspace','sRGB','-channel','R','-evaluate','set','0','+channel',
            *PS1_TEXTURE], input=base_data[start:start+view['byteLength']])
        frozen_texture = len(doc['textures'])
        doc['textures'].append(dict(source=len(doc['images']), sampler=ns))
        doc['images'].append(dict(name='Frozen portrait atlas', mimeType='image/png', bufferView=add_view(atlas)))
        frozen_material = len(doc['materials'])
        for m in base['materials']:
            pbr = m['pbrMetallicRoughness']
            if 'baseColorTexture' in pbr:
                pbr = dict(pbr, baseColorTexture=dict(index=frozen_texture))
            doc['materials'].append(dict(m, name='Frozen '+m['name'], pbrMetallicRoughness=pbr))

    palette_nodes = []
    parts = {}
    for n in base['nodes']:
        if 'mesh' not in n or (donor in (890,828,906) and n['name'].startswith(('Hip','Knee'))): continue
        mesh = base['meshes'][n['mesh']]
        if melt:
            frozen_primitives = []
            for p in mesh['primitives']:
                attrs = {k: v+na for k, v in p['attributes'].items()}
                if 'TEXCOORD_0' not in attrs:
                    rgb = read(base, base_data, p['attributes']['COLOR_0'])
                    gray = .1 + .9 * (rgb @ [.213,.715,.072])
                    attrs['COLOR_0'] = append(np.column_stack([np.zeros(len(gray)), gray, gray]), 'VEC3')
                frozen_primitives.append(dict(attributes=attrs, indices=p['indices']+na, material=p['material']+frozen_material))
        for p in mesh['primitives']:
            p['attributes'] = {k:v+na for k,v in p['attributes'].items()}
            p['indices'] += na
            p['material'] += nm
        parts[n['name']] = len(nodes)
        roots.append(len(nodes))
        if melt:
            normal, frozen = len(nodes)+1, len(nodes)+2
            nodes.append(dict(name=n['name'], children=[normal, frozen]))
            nodes.append(dict(name=n['name']+'Normal', mesh=len(meshes)))
            nodes.append(dict(name=n['name']+'Frozen', mesh=len(meshes)+1, scale=[0,0,0]))
            meshes.extend([mesh, dict(primitives=frozen_primitives)])
            palette_nodes.append((normal, frozen))
            continue
        nodes.append(dict(name=n['name'], mesh=len(meshes)))
        meshes.append(mesh)
    doc.update(nodes=nodes,meshes=meshes,scene=0,scenes=[dict(nodes=[len(nodes)])],animations=[])
    nodes.append(dict(name=rig_name,children=roots,scale=[1/1024]*3))
    if palette_nodes:
        palette_time = append([0], 'SCALAR')
        doc['accessors'][palette_time].update(min=[0], max=[0])
        palette_scale = [append([scale], 'VEC3') for scale in ([0,0,0], [1,1,1])]

    def points(part, weights):
        tracks, _ = vertex_tracks[part]
        return {k: center + weights @ delta for k, (center, delta) in tracks.items()}

    has_legs, on_foot = 'HipR' in parts, donor in (858,874)
    clips = []
    for a in source['animations']:
        part = a['channels'][0]['target']['node']
        if part not in vertex_tracks: continue
        sampler = a['samplers'][0]
        clips.append((a, part, sampler, read(source,data,sampler['output']).reshape(-1,vertex_tracks[part][1])))
    lengths = proportions([poses(points(part, weights), has_legs, on_foot) for _, part, _, weights in clips])
    print(number, 'segment stretch', {k: round(v / REST[k], 2) for k, v in lengths.items()})

    def add_clip(source_clip, part, sampler, weights):
        pose = poses(points(part, weights), has_legs, on_foot, lengths)
        anim = dict(name=source_clip['name'],channels=[],samplers=[])
        if 'extras' in source_clip:
            # The frame count tells nativePose when a word runs past the group's table.
            anim['extras'] = source_clip['extras']

        def channel(node, path, values):
            anim['channels'].append(dict(sampler=len(anim['samplers']),target=dict(node=node,path=path)))
            anim['samplers'].append(dict(input=sampler['input'], output=append(values,'VEC4' if path=='rotation' else 'VEC3')))

        if part in equipment_nodes:
            anim['samplers'].append(sampler)
            anim['channels'].append(dict(sampler=0,target=dict(node=equipment_nodes[part],path='weights')))
        if len(equipment_nodes) > 1:
            # The render word selects one disc mesh. Keep the custom body and
            # display only the bear belonging to the sampled animation group.
            for other, node in equipment_nodes.items():
                scale = [1,-1,-1] if part == other else [0,0,0]
                channel(node, 'scale', [scale]*len(weights))
        for name, node in parts.items():
            pose_name = 'BigStein' if name == 'Hips' else name
            for path, values in zip(('translation','rotation','scale'),pose[pose_name]):
                if path == 'rotation':
                    for j in range(1,len(values)):
                        if values[j]@values[j-1]<0: values[j] *= -1
                nodes[node].setdefault(path,values[0].tolist())
                channel(node, path, values)
        for normal, frozen in palette_nodes:
            for node, visible in [(normal, part == 0), (frozen, part == 1)]:
                anim['channels'].append(dict(sampler=len(anim['samplers']), target=dict(node=node, path='scale')))
                anim['samplers'].append(dict(input=palette_time, output=palette_scale[int(visible)]))
        doc['animations'].append(anim)

    for clip in clips:
        add_clip(*clip)
    if melt:
        # Render word 0x2002 uses the static alternate mesh's bind pose.
        weights = np.zeros((1, vertex_tracks[1][1]))
        add_clip({'name': 'Frozen'}, 1, dict(input=palette_time, output=append(weights.flatten(), 'SCALAR')), weights)
    doc['buffers'].append(dict(uri=f'{number}.bin',byteLength=len(extra)))
    (MODELS/f'{number}.bin').write_bytes(extra)
    (MODELS/f'{number}.gltf').write_text(json.dumps(doc,separators=(',',':'),allow_nan=False)+'\n')


if __name__ == '__main__':
    from big_stein_equipment import paint_variants

    reference = body_vertices()
    for i, donor in enumerate(DONORS, 9002):
        build(donor, i, reference)
    build(922, 9013, reference)
    paint_variants()
