"""Fit Big Stein to the disc animation frames. Run after build_big_stein.py.
Requires NumPy and SciPy. Outputs share the base model and disc equipment buffers.
"""
import json
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from scipy.spatial.transform import Rotation

MODELS = Path(__file__).resolve().parents[1] / 'assets/models'
# Cortex is the animation and equipment donor for Big Stein.
DONORS = [970, 954, 890, 828, 812, 844, 938, 858, 874, 906]


def load(number):
    return json.loads((MODELS / f'{number:04}.gltf').read_text())


def read(doc, data, index):
    acc = doc['accessors'][index]
    view = doc['bufferViews'][acc['bufferView']]
    size = {'SCALAR': 1, 'VEC3': 3}[acc['type']]
    return np.frombuffer(data, '<f4', acc['count'] * size,
                         view.get('byteOffset', 0) + acc.get('byteOffset', 0)).reshape(-1, size)


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


def unit(v):
    return v / np.maximum(1e-8, np.linalg.norm(v, axis=-1, keepdims=True))


def poses(points, has_legs, on_foot):
    """Local Y follows each limb. Local X uses the actor's lateral direction."""
    def at(x, y, z):
        return points[(x, y, z)]
    shoulder = [at(s*80, -232, 6) for s in (-1, 1)]
    waist = (at(-40, -89, 0) + at(40, -89, 0)) / 2
    collar = sum(shoulder) / 2
    lateral = shoulder[1] - shoulder[0]
    result = {}

    def bone(name, origin, up, size, length=None, right=lateral):
        y = unit(up)
        z = unit(np.cross(right, y))
        x = unit(np.cross(y, z))
        rot = Rotation.from_matrix(np.stack([x, y, z], axis=-1)).as_quat()
        scale = np.full(origin.shape, size, dtype=float)
        if length:
            scale[:, 1] = np.linalg.norm(up, axis=1) / length
        result[name] = (origin, rot, scale)

    spine = collar - waist
    # Cortex has very short legs. Lengthen Stein's stride up from the soles,
    # keeping the sampled grips fixed to the equipment throughout each clip.
    rise = unit(spine) * (72 if on_foot else 0)
    waist = waist + rise
    collar = collar + rise
    shoulder = [p + rise for p in shoulder]
    bone('BigStein', waist, spine, 265)
    bone('Jacket', waist, spine, 282, .45)
    eye = (at(68,-317,-153) + at(-68,-317,-153)) / 2
    crown = (at(131,-459,-88) + at(-131,-459,-88)) / 2
    bone('Head', collar + spine*.24, crown-eye, 340,
         right=at(68,-317,-153)-at(-68,-317,-153))
    for i, (s, side) in enumerate([(-1,'R'), (1,'L')]):
        elbow = at(s*79,-162,-20) + rise*.5
        hand = at(s*53,-10,-22)
        bone('Shoulder'+side, shoulder[i], shoulder[i]-elbow, 260, .231)
        bone('Elbow'+side, elbow, elbow-hand, 250, .29)
        if has_legs:
            if (s*16,-99,-8) in points:
                stance = unit(lateral)*s*(21 if on_foot else 0)
                hip = at(s*16,-99,-8) + rise + stance
                knee = at(s*18,-68,-21) + rise*.52 + stance
                heel = at(s*13,0,10) + stance
            else:  # The original polar rider ends at the saddle.
                right, up = unit(lateral), unit(spine)
                hip = waist + s*right*34
                knee = hip + s*right*43 + unit(np.cross(right, up))*38 - up*34
                heel = knee - up*70
            bone('Hip'+side, hip, hip-knee, 225, .278)
            bone('Knee'+side, knee, knee-heel, 235, .38)
    return result


def build(donor, number, body):
    source = load(donor)
    base = load(9001)
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

    def append(values, kind, indices=False):
        arr = np.asarray(values, dtype='<u2' if indices else '<f4')
        assert np.isfinite(arr).all()
        extra.extend(bytes(-len(extra) % 4))
        v = dict(buffer=2, byteOffset=len(extra), byteLength=arr.nbytes)
        if indices: v['target'] = 34963
        doc['bufferViews'].append(v)
        extra.extend(arr.tobytes())
        doc['accessors'].append(dict(bufferView=len(doc['bufferViews'])-1, componentType=5123 if indices else 5126,
                                     type=kind, count=len(arr)))
        return len(doc['accessors'])-1

    equipment = []
    tracks = {}
    offset = np.array([0,-82,-4.5]) if donor == 954 else np.zeros(3)
    for p in source['meshes'][0]['primitives']:
        pos = read(source, data, p['attributes']['POSITION'])
        deltas = np.stack([read(source,data,t['POSITION']) for t in p['targets']])
        dist, nearest = body.query((pos-offset) / (1.125 if donor == 906 else 1))
        for j in np.flatnonzero(dist < 2):
            tracks[tuple(body.data[nearest[j]])] = (pos[j]+deltas[:,j])*[1,-1,-1]
        keep = ~(dist.reshape(-1,3) < 2).all(axis=1)
        if keep.any():
            indices = np.arange(len(pos)).reshape(-1,3)[keep].flatten()
            equipment.append(dict(p, indices=append(indices,'SCALAR',True)))

    meshes, nodes, roots = [], [], []
    if equipment:
        meshes.append(dict(primitives=equipment,weights=source['meshes'][0]['weights']))
        nodes.append(dict(name='Equipment',mesh=0,scale=[1,-1,-1]))
        roots.append(0)
    parts = {}
    for n in base['nodes']:
        if 'mesh' not in n or (donor in (890,828,906) and n['name'].startswith(('Hip','Knee'))): continue
        mesh = base['meshes'][n['mesh']]
        for p in mesh['primitives']:
            p['attributes'] = {k:v+na for k,v in p['attributes'].items()}
            p['indices'] += na
            p['material'] += nm
        parts[n['name']] = len(nodes)
        roots.append(len(nodes))
        nodes.append(dict(name=n['name'],mesh=len(meshes)))
        meshes.append(mesh)
    doc.update(nodes=nodes,meshes=meshes,scene=0,scenes=[dict(nodes=[len(nodes)])],animations=[])
    nodes.append(dict(name='BigSteinRig',children=roots,scale=[1/1024]*3))
    for a in source['animations']:
        if a['channels'][0]['target']['node'] != 0: continue
        sampler = a['samplers'][0]
        weights = read(source,data,sampler['output']).reshape(-1,len(deltas))
        pose = poses({k:weights@v for k,v in tracks.items()}, 'HipR' in parts, donor in (858,874))
        anim = dict(name=a['name'],channels=[],samplers=[])
        if equipment:
            anim['samplers'].append(sampler)
            anim['channels'].append(dict(sampler=0,target=dict(node=0,path='weights')))
        for name, node in parts.items():
            for path, values in zip(('translation','rotation','scale'),pose[name]):
                if path == 'rotation':
                    for j in range(1,len(values)):
                        if values[j]@values[j-1]<0: values[j] *= -1
                nodes[node].setdefault(path,values[0].tolist())
                anim['channels'].append(dict(sampler=len(anim['samplers']),target=dict(node=node,path=path)))
                anim['samplers'].append(dict(input=sampler['input'], output=append(values,'VEC4' if path=='rotation' else 'VEC3')))
        doc['animations'].append(anim)
    doc['buffers'].append(dict(uri=f'{number}.bin',byteLength=len(extra)))
    (MODELS/f'{number}.bin').write_bytes(extra)
    (MODELS/f'{number}.gltf').write_text(json.dumps(doc,separators=(',',':'),allow_nan=False)+'\n')


if __name__ == '__main__':
    reference = body_vertices()
    for i, donor in enumerate(DONORS, 9002):
        build(donor, i, reference)
