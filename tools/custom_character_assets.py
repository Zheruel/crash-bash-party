"""Build and recolor custom equipment without replacing its disc animation tracks."""

import json
import math
import struct
import subprocess

import numpy as np
from scipy.spatial.transform import Rotation

from build_stein_variants import MODELS, load, read


# The stock cast is Gouraud shaded from one baked key light: smooth across a surface, hard at creases, and darker
# on the side away from the light than the old flat facet shading was.
LIGHT = tuple(v / math.hypot(-.42, .76, .49) for v in (-.42, .76, .49))
CREASE = math.cos(math.radians(55))


def gouraud(corners):
    """Vertex colours for (position, face normal, base colour) corners, averaging normals of one colour's surface."""
    surfaces = {}
    for index, (position, normal, color) in enumerate(corners):
        surfaces.setdefault((position, color), []).append(index)
    colors = []
    for position, normal, color in corners:
        smooth = [0, 0, 0]
        for other in surfaces[position, color]:
            n = corners[other][1]
            if sum(a*b for a, b in zip(n, normal)) > CREASE:
                smooth = [a + b for a, b in zip(smooth, n)]
        size = math.hypot(*smooth) or 1
        shade = .64 + .36 * sum(a*b/size for a, b in zip(smooth, LIGHT))
        colors.append(tuple(min(1, c * shade) for c in color))
    return colors


# Cortex's on-foot model (0986) groups, their frame counts and the custom role clip with the same motion: hit, idle,
# run, jump, spin (script 10), carry (0x10), pick-up (0xf), throw (0x12), carry walk (0x11), an unused group, taunt
# (scripts 2 and 0xc), lose (0x13) and win (also Ring Ding's jump 0x2c, whose custom clip the game poses itself).
ON_FOOT_GROUPS = [(0, 'hit', 26), (1, 'idle', 32), (2, 'run', 22), (3, 'jump', 20), (4, 'spin', 19), (5, 'carry', 24),
                  (6, 'lift', 9), (7, 'throw', 13), (8, 'carryRun', 24), (9, 'idle', 32), (10, 'taunt', 40),
                  (11, 'lose', 21), (12, 'win', 48)]
# Role clips that end in a held pose: the group covers the motion up to this time, not the hold.
MOTION_END = {'lose': 20 / 30}


def add_group_clips(doc, data, accessor):
    """Name each Cortex group after the role clip with its motion, so his render words resolve on the custom rig.

    A group clip shares the role clip's keys on a timeline stretched to the group's frame count. `data` holds every
    accessor of the role clips. `accessor(values, width)` appends one float accessor and returns its index.
    """
    clips = {clip['name']: clip for clip in doc['animations']}
    for group, role, frames in ON_FOOT_GROUPS:
        clip = clips[role]
        inputs = {}
        for sampler in clip['samplers']:
            if sampler['input'] not in inputs:
                source = doc['accessors'][sampler['input']]
                view = doc['bufferViews'][source['bufferView']]
                start = view.get('byteOffset', 0) + source.get('byteOffset', 0)
                times = struct.unpack_from(f"<{source['count']}f", data, start)
                factor = (frames - 1) / 30 / MOTION_END.get(role, times[-1])
                inputs[sampler['input']] = accessor([(t * factor,) for t in times], 1)
        doc['animations'].append({
            'name': f'group{group}_part0', 'extras': {'frames': frames}, 'channels': clip['channels'],
            'samplers': [dict(sampler, input=inputs[sampler['input']]) for sampler in clip['samplers']],
        })


class GltfBuffer:
    def __init__(self, doc, data=b''):
        self.doc = doc
        self.data = bytearray(data)

    def buffer_view(self, data, target=None):
        self.data.extend(bytes(-len(self.data) % 4))
        view = {'buffer': len(self.doc.get('buffers', [])),
                'byteOffset': len(self.data), 'byteLength': len(data)}
        if target is not None:
            view['target'] = target
        self.data.extend(data)
        self.doc['bufferViews'].append(view)
        return len(self.doc['bufferViews']) - 1

    def accessor(self, values, width, target=None):
        data = b''.join(struct.pack('<' + 'f' * width, *row) for row in values)
        columns = list(zip(*values))
        self.doc['accessors'].append({
            'bufferView': self.buffer_view(data, target),
            'componentType': 5126,
            'count': len(values),
            'type': ['SCALAR', 'VEC2', 'VEC3', 'VEC4'][width - 1],
            'min': [min(col) for col in columns],
            'max': [max(col) for col in columns],
        })
        return len(self.doc['accessors']) - 1

    def primitive(self, shape, material):
        textured = bool(shape.uvs)
        colors = shape.colors if textured else gouraud(list(zip(shape.positions, shape.normals, shape.colors)))
        arrays = [shape.positions, shape.normals, colors]
        attributes = [('POSITION', 3), ('NORMAL', 3), ('COLOR_0', 3)]
        if textured:
            arrays.append(shape.uvs)
            attributes.append(('TEXCOORD_0', 2))
        corners = list(zip(*arrays))
        vertices = dict.fromkeys(corners)
        for index, corner in enumerate(vertices):
            vertices[corner] = index
        vertex_attributes = {
            name: self.accessor(values, width, 34962)
            for (name, width), values in zip(attributes, zip(*vertices))
        }
        data = struct.pack(f'<{len(corners)}H', *(vertices[v] for v in corners))
        indices = len(self.doc['accessors'])
        self.doc['accessors'].append({
            'bufferView': self.buffer_view(data, 34963),
            'componentType': 5123,
            'count': len(corners),
            'type': 'SCALAR',
        })
        return {'attributes': vertex_attributes, 'indices': indices, 'material': material}

    def write(self, number):
        uri = f'{number}.bin'
        buffers = self.doc.setdefault('buffers', [])
        buffers.append({'uri': uri, 'byteLength': len(self.data)})
        (MODELS / uri).write_bytes(self.data)
        (MODELS / f'{number}.gltf').write_text(json.dumps(self.doc, separators=(',', ':'), allow_nan=False) + '\n')


class Shape:
    def __init__(self):
        self.positions, self.normals, self.colors = [], [], []
        self.uvs = []

    def polygon(self, color, *points, uv=None):
        a = points[0]
        rgb = tuple(int(color[i:i+2], 16) / 255 for i in (0, 2, 4))
        for n, (b, c) in enumerate(zip(points[1:], points[2:]), 1):
            x, y, z = [v-u for u, v in zip(a, b)]
            i, j, k = [v-u for u, v in zip(a, c)]
            normal = (y*k-z*j, z*i-x*k, x*j-y*i)
            size = math.hypot(*normal)
            if size < 1e-9:
                continue
            normal = tuple(v / size for v in normal)
            if uv:
                self.uvs.extend((uv[0], uv[n], uv[n+1]))
            self.positions.extend((a, b, c))
            self.normals.extend([normal] * 3)
            self.colors.extend([rgb] * 3)

    def rings(self, color, rows, sides=8):
        """Horizontal sections with height, half-width, half-depth, Z and X."""
        angles = [(i + .5) * math.tau / sides for i in range(sides)]
        rings = [[(x + dx*math.sin(a), y, z + dz*math.cos(a)) for a in angles]
                 for y, dx, dz, z, x in rows]
        self.polygon(color, *reversed(rings[0]))
        for low, high in zip(rings, rings[1:]):
            for i in range(sides):
                j = (i + 1) % sides
                self.polygon(color, low[i], low[j], high[j], high[i])
        self.polygon(color, *rings[-1])

    def stripe(self, color, width, a, b):
        dx, dy = b[0]-a[0], b[1]-a[1]
        factor = width / (2 * math.hypot(dx,dy))
        def edge(p, s):
            return p[0]-s*factor*dy, p[1]+s*factor*dx, p[2]
        self.polygon(color, edge(a,-1), edge(b,-1), edge(b,1), edge(a,1))

    def disc(self, color, x, y, z, radius):
        points = [(x + radius*math.cos(i*math.tau/8), y + radius*math.sin(i*math.tau/8), z) for i in range(8)]
        self.polygon(color, *points)

    def loft(self, colors, sections):
        """Join same-sized profile loops to form a faceted solid."""
        self.polygon(colors[0], *reversed(sections[0]))
        for lower, upper in zip(sections, sections[1:]):
            for i, tint in enumerate(colors):
                j = (i+1) % len(lower)
                self.polygon(tint, lower[i], lower[j], upper[j], upper[i])
        self.polygon(colors[0], *sections[-1])


def replace_kart(number, kart, finish):
    doc = load(number)
    equipment = next(i for i,n in enumerate(doc['nodes']) if n['name'] == 'Equipment')
    node = doc['nodes'][equipment]
    original = doc['meshes'][node['mesh']]
    stock = (MODELS / doc['buffers'][0]['uri']).read_bytes()
    output = GltfBuffer(doc, (MODELS / doc['buffers'].pop()['uri']).read_bytes())

    # The original rear grille is a rigid submesh, even when the rest of the
    # hover pod deforms. Follow its translation and pitch on every disc frame,
    # including the out-of-view move used when the pilot is thrown off.
    grille = next(p for p in original['primitives'] if p['material'] == 9)
    orientation = np.array([1,-1,-1])
    rest = read(doc, stock, grille['attributes']['POSITION']) * orientation
    deltas = np.stack([read(doc, stock, t['POSITION']) * orientation for t in grille['targets']])
    origin = rest.mean(axis=0)
    centered = rest - origin
    for animation in doc['animations']:
        channel = next(c for c in animation['channels'] if c['target']['node'] == equipment)
        sampler = animation['samplers'][channel['sampler']]
        weights = read(doc, stock, sampler['output']).reshape(-1,len(deltas))
        frames = rest + np.einsum('fk,kvc->fvc', weights, deltas)
        midpoint = frames.mean(axis=1)
        left,_,right = np.linalg.svd(centered.T @ (frames-midpoint[:,None,:]))
        right = np.swapaxes(right, 1, 2)
        left = np.swapaxes(left, 1, 2)
        right[:,:,-1] *= np.sign(np.linalg.det(right @ left))[:,None]
        rotations = right @ left
        shifts = midpoint - rotations @ origin
        quaternions = Rotation.from_matrix(rotations).as_quat()
        for i in range(1,len(quaternions)):
            if quaternions[i] @ quaternions[i-1] < 0:
                quaternions[i] *= -1
        channel['target']['path'] = 'translation'
        sampler['output'] = output.accessor(shifts, 3)
        animation['channels'].append({'sampler': len(animation['samplers']),
                                      'target': {'node': equipment, 'path': 'rotation'}})
        animation['samplers'].append({'input': sampler['input'], 'output': output.accessor(quaternions, 4)})
    node.pop('scale')
    material = len(doc['materials'])
    doc['materials'].append({'name': finish, 'doubleSided': True,
                             'pbrMetallicRoughness': {'metallicFactor': 0, 'roughnessFactor': 1}})
    doc['meshes'][node['mesh']] = {'primitives': [output.primitive(kart, material)]}
    output.write(number)


def tint_equipment(number, paints, coverage=None):
    doc = load(number)
    equipment = next(n for n in doc['nodes'] if n['name'] == 'Equipment')
    stock = (MODELS / doc['buffers'][0]['uri']).read_bytes()
    output = GltfBuffer(doc, (MODELS / doc['buffers'].pop()['uri']).read_bytes())
    for part in doc['meshes'][equipment['mesh']]['primitives']:
        paint = paints.get(part['material'])
        if paint is None:
            continue
        attrs = part['attributes']
        original = read(doc, stock, attrs['COLOR_0'])
        amount = 1
        if coverage is not None:
            rest = read(doc, stock, attrs['POSITION']) * [1,-1,-1]
            amount = coverage(rest)[:,None]
        colors = np.clip(original * (1 + amount * np.array([*paint,0])), 0, 1)
        attrs['COLOR_0'] = output.accessor(colors, 4, 34962)
    output.write(number)


def tint_barrel_bands(number, finish, metal_paint):
    doc = load(number)
    output = GltfBuffer(doc, (MODELS / doc['buffers'].pop()['uri']).read_bytes())
    # Preserve the readable wood grain and tint the neutral stamped metal.
    for index, image in enumerate(doc['images']):
        uri = image.get('uri', '')
        if not uri.startswith('../textures/0873/') or uri.split('/')[-1] not in {
            'tex005.png', 'tex006.png', 'tex007.png', 'tex008.png', 'tex009.png',
        }:
            continue
        source = MODELS / uri
        width, height = map(int, subprocess.check_output(['magick', 'identify', '-format', '%w %h', str(source)]).split())
        data = subprocess.check_output(['magick', str(source), '-alpha', 'on', '-depth', '8', 'rgba:-'])
        pixels = np.frombuffer(data, dtype='u1').reshape(-1,4).astype(float)
        rgb = pixels[:,:3]
        steel = np.clip((30-np.ptp(rgb, axis=1))/25, 0, 1)[:,None]
        pixels[:,:3] = np.clip(rgb*(1+steel*np.array(metal_paint)), 0, 255)
        png = subprocess.check_output(['magick', '-size', f'{width}x{height}', '-depth', '8',
                                       'rgba:-', '-strip', 'png:-'], input=pixels.astype('u1').tobytes())
        doc['images'][index] = {'name': finish, 'mimeType': 'image/png',
                                'bufferView': output.buffer_view(png)}
    output.write(number)
