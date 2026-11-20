"""Build Top G's character, equipment variants, podium model and HUD portrait.

Run with Python, NumPy, SciPy and ImageMagick 7. The rig uses the same
joint placements as Big Stein so it can reuse locomotion and crate grips.
"""

import copy
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from scipy.spatial import Delaunay

from build_stein_variants import DONORS, body_vertices, build, load
from custom_character_assets import GltfBuffer, Shape, replace_kart, tint_barrel_bands, tint_equipment

ASSETS = Path(__file__).resolve().parents[1] / 'assets'
MODELS = ASSETS / 'models'
BASE = 9101
PODIUM = 9112
PORTRAIT = ASSETS / 'portraits/top-g.png'
PORTRAIT_SIZE = 1254

SKIN = 'c58970'
BEARD = '41332f'
BLAZER = '858289'
LAPEL = '97949a'
SEAM = '5b5963'
SHIRT = '1d2028'
PANTS = '32323a'
SHOES = '25232a'
SILVER = 'c6c5c9'
Z = (0, 0, 0)


class Model(GltfBuffer):
    def __init__(self, donor):
        super().__init__({
            'asset': {'version': '2.0', 'generator': 'tools/build_top_g.py'},
            'scene': 0,
            'scenes': donor['scenes'],
            'nodes': [{k: v for k, v in node.items() if k != 'mesh'} for node in donor['nodes']],
            'materials': [{'name': 'Facets', 'doubleSided': True,
                           'pbrMetallicRoughness': {'metallicFactor': 0, 'roughnessFactor': 1}}],
            'meshes': [],
            'animations': [],
            'bufferViews': [],
            'accessors': [],
        })
        self.nodes = {node['name']: i for i, node in enumerate(self.doc['nodes'])}
        self.doc['nodes'][self.nodes['BigStein']]['name'] = 'Hips'
        atlas = subprocess.check_output([
            'magick', str(PORTRAIT), '-background', '#c0744a', '-alpha', 'remove',
            '-resize', '512x512!', '-strip', '-sampling-factor', '4:4:4', '-quality', '92', 'jpeg:-',
        ])
        self.doc['images'] = [{'name': 'Top G portrait', 'mimeType': 'image/jpeg',
                               'bufferView': self.buffer_view(atlas)}]
        self.doc['samplers'] = [{'magFilter': 9728, 'minFilter': 9728, 'wrapS': 33071, 'wrapT': 33071}]
        self.doc['textures'] = [{'source': 0, 'sampler': 0}]
        self.doc['materials'].append({
            'name': 'Portrait', 'doubleSided': True,
            'pbrMetallicRoughness': {'baseColorTexture': {'index': 0}, 'metallicFactor': 0, 'roughnessFactor': 1},
        })

    def mesh(self, part, *shapes):
        self.doc['nodes'][self.nodes[part]]['mesh'] = len(self.doc['meshes'])
        self.doc['meshes'].append({'primitives': [self.primitive(shape, int(bool(shape.uvs))) for shape in shapes]})

    def clip(self, name, frames, rotations):
        time = self.accessor([(f / 30,) for f in frames], 1)
        animation = {'name': name, 'channels': [], 'samplers': []}
        for part, angles in rotations.items():
            output = self.accessor([quaternion(*a) for a in angles], 4)
            animation['channels'].append({'sampler': len(animation['samplers']),
                                          'target': {'node': self.nodes[part], 'path': 'rotation'}})
            animation['samplers'].append({'input': time, 'output': output, 'interpolation': 'LINEAR'})
        return animation

def quaternion(x, y, z):
    x, y, z = [math.radians(a) / 2 for a in (x, y, z)]
    a, b, c = map(math.cos, (x, y, z))
    d, e, f = map(math.sin, (x, y, z))
    return d*b*c+a*e*f, a*e*c-d*b*f, a*b*f+d*e*c, a*b*c-d*e*f


def head():
    # Trace the portrait's skull and jaw, then give the forehead, shades, nose
    # and lips depth. Each landmark is x, y in the generated portrait and Z in
    # local model space. The UVs keep the likeness registered on the mesh.
    rim = [
        (580,33,.004), (630,30,-.01), (680,36,.001), (738,70,-.011),
        (813,145,-.029), (845,247,-.04), (840,296,-.036), (829,354,-.028),
        (822,420,-.022), (812,482,-.026), (812,550,-.016), (795,604,.003),
        (759,671,.025), (705,725,.076), (674,743,.098), (583,743,.098),
        (549,725,.076), (498,674,.025), (462,615,.003), (444,556,-.016),
        (443,483,-.026), (433,418,-.022), (425,353,-.028), (414,291,-.035),
        (412,242,-.043), (437,145,-.029), (500,82,-.013), (548,50,-.003),
    ]
    relief = [
        (630,64,.073), (550,116,.094), (625,126,.128), (706,115,.095),
        (474,190,.084), (554,196,.138), (631,206,.168), (699,199,.145), (790,204,.069),
        (464,278,.078), (536,279,.152), (624,278,.183), (725,278,.153), (788,281,.081),
        (455,359,.097),(487,340,.146),(548,338,.189),(590,347,.204),(626,347,.211),
        (663,345,.212),(706,338,.183),(770,343,.148),(806,359,.097),
        (456,410,.095),(501,450,.154),(551,450,.183),(585,425,.178),
        (673,425,.181),(708,452,.183),(763,447,.151),(799,410,.097),
        (597,411,.201),(625,392,.217),(653,412,.201),
        (589,486,.201),(607,491,.237),(632,506,.259),(655,488,.238),(678,480,.199),
        (621,536,.200),(514,516,.117),(559,541,.160),(707,542,.162),(757,515,.117),
        (555,589,.170),(593,582,.197),(631,581,.218),(669,579,.198),(704,588,.176),
        (587,620,.191),(631,631,.204),(677,620,.192),(500,601,.092),(749,605,.096),
        (557,667,.130),(623,675,.167),(690,668,.136),(622,719,.135),
    ]

    def register(u, v, depth):
        return ((u-628)*.00096, .616-(v-30)*.000817, depth)

    samples = rim + relief
    points = [register(*p) for p in samples]
    uv = [(u/PORTRAIT_SIZE, v/PORTRAIT_SIZE) for u,v,_ in samples]
    face = Shape()
    for triangle in Delaunay([(u,v) for u,v,_ in samples]).simplices:
        # Delaunay gives counterclockwise pixels. Registration reverses Y.
        a,b,c = triangle[::-1]
        face.polygon('ffffff', points[a], points[b], points[c], uv=(uv[a], uv[b], uv[c]))

    skull = Shape()
    outline = points[:len(rim)]
    mid = [(x*.97, .33+(y-.33)*.97, -.103 if y>.21 else -.061) for x,y,z in outline]
    rear = [(x*.70, .34+(y-.34)*.84, -.171 if y>.21 else -.113) for x,y,z in outline]
    nape = [(x*.40, .34+(y-.34)*.72, -.193 if y>.23 else -.147) for x,y,z in outline]
    for i, a in enumerate(outline):
        j = (i+1) % len(outline)
        b = outline[j]
        # The beard wraps across the sides of the jaw and ends below the ears.
        color = BEARD if (a[1]+b[1])/2 < .197 else 'c58a6d'
        skull.polygon(color, a, b, mid[j], mid[i])
        skull.polygon('ad765d', mid[i], mid[j], rear[j], rear[i])
        skull.polygon('ad785e', rear[i], rear[j], nape[j], nape[i])
    skull.polygon('ae795f', *nape)
    for side in (-1, 1):
        # Use a separate ear shell so it still has a silhouette in profile.
        skull.rings('d19478', [(.226,.025,.036,.014,side*.185), (.250,.039,.046,.01,side*.212),
                               (.369,.05,.046,.004,side*.216), (.392,.022,.027,.001,side*.208)], 6)
        ear = [(side*x,y,z) for x,y,z in ((.201,.253,.051),(.247,.304,.041),(.230,.361,.051),(.196,.334,.052))]
        skull.polygon('9d644f', *ear if side > 0 else ear[::-1])
        temple = [(side*x,y,z) for x,y,z in ((.214,.365,.01),(.221,.365,.01),(.194,.352,.074),(.183,.351,.075))]
        skull.polygon(SILVER, *temple if side > 0 else temple[::-1])
    return skull, face


def build_body(model):
    waist = Shape()
    waist.rings(PANTS, [(-.078,.183,.118,0,0), (.035,.192,.133,0,0), (.094,.162,.115,0,0)])
    model.mesh('BigStein', waist)

    torso = Shape()
    torso.rings(BLAZER, [(-.032,.185,.115,0,0), (.05,.189,.140,0,0), (.25,.229,.160,.001,0),
                        (.425,.287,.164,0,0), (.481,.267,.142,-.008,0), (.546,.103,.097,0,0)])
    torso.rings(SKIN, [(.46,.103,.091,.019,0), (.609,.092,.089,.02,0), (.657,.081,.076,.018,0)])
    shirt = [(-.035,.121,.120),(.08,.103,.148),(.242,.079,.162),(.35,.095,.169),(.46,.104,.148)]
    for (y0,x0,z0),(y1,x1,z1) in zip(shirt,shirt[1:]):
        torso.polygon(SHIRT, (-x0,y0,z0),(x0,y0,z0),(x1,y1,z1),(-x1,y1,z1))
    torso.polygon(SHIRT, (-.104,.46,.148), (.104,.46,.148), (.089,.512,.118),
                  (.06,.492,.137), (0,.484,.144), (-.06,.492,.137), (-.089,.512,.118))
    for side in (-1, 1):
        def panel(color, points):
            corners = [(side*x,y,z) for x,y,z in points]
            torso.polygon(color, *corners if side > 0 else corners[::-1])
        panel(SEAM, [(.092,.472,.139),(.175,.462,.130),(.139,.412,.156),(.065,.231,.168)])
        panel(LAPEL, [(.096,.537,.112),(.173,.473,.132),(.133,.441,.145),(.101,.478,.145)])
        panel(LAPEL, [(.117,.440,.154),(.164,.426,.15),(.093,.276,.169),(.074,.249,.168)])
        panel('77747c', [(.117,.151,.143),(.203,.143,.110),(.2,.117,.109),(.115,.126,.139)])
        torso.stripe(SEAM, .009, (side*.118,.15,.147), (side*.205,.141,.113))
    torso.stripe('55535c', .008, (.151,.341,.143), (.213,.326,.113))
    torso.disc('4d4a52', .089, .148, .153, .012)

    # A small silver knight on the lapel nods to his family's chess background.
    knight = [(.110,.390,.163),(.137,.387,.158),(.134,.394,.159),(.126,.398,.164),
              (.136,.413,.162),(.131,.427,.158),(.122,.431,.163),(.121,.425,.164),
              (.110,.421,.168),(.104,.412,.17),(.112,.409,.169),(.123,.416,.165),
              (.115,.397,.165)]
    for indices in ((0,1,2,3,12),(3,4,5,6,7,12),(7,8,9,10,11,12)):
        torso.polygon(SILVER, *(knight[i] for i in indices))
    model.mesh('Jacket', torso)
    model.mesh('Head', *head())

    for side, label in [(-1, 'R'), (1, 'L')]:
        arm = Shape()
        arm.rings(BLAZER, [(-.246,.077,.079,0,side*.044), (-.155,.089,.091,0,side*.04),
                          (-.035,.107,.106,0,side*.022), (.045,.085,.089,0,0)])
        model.mesh('Shoulder'+label, arm)

        forearm = Shape()
        forearm.rings(BLAZER, [(-.229,.057,.064,.029,0), (-.166,.067,.071,.023,side*.005),
                               (-.065,.085,.079,.008,0), (.036,.079,.078,0,0)])
        forearm.rings(SEAM, [(-.231,.057,.065,.029,0), (-.217,.060,.068,.026,0)])
        forearm.rings(SKIN, [(-.333,.053,.055,.064,0), (-.291,.072,.078,.052,0),
                            (-.249,.069,.071,.043,0), (-.209,.05,.053,.027,0)])
        forearm.rings('cd947d', [(-.307,.025,.035,.095,-side*.039), (-.274,.036,.038,.085,-side*.043),
                                (-.241,.028,.032,.066,-side*.032)], 6)
        for i in (-1, 0, 1):
            x = i*.019
            forearm.stripe('9a6351', .003, (x,-.303,.119),(x,-.324,.117))
        for y, z in ((-.203,.091),(-.182,.091)):
            forearm.disc('4c4850', side*.031, y, z, .008)
        model.mesh('Elbow'+label, forearm)

        thigh = Shape()
        thigh.rings(PANTS, [(-.296,.081,.082,0,0), (-.155,.102,.102,-.006,0), (.028,.111,.115,0,0)])
        model.mesh('Hip'+label, thigh)
        calf = Shape()
        calf.rings(PANTS, [(-.286,.079,.081,-.004,0), (-.194,.069,.078,-.014,0),
                          (-.075,.088,.091,-.012,0), (.017,.082,.085,.002,0)])
        calf.rings(SHOES, [(-.38,.093,.15,.056,0), (-.356,.101,.155,.056,0),
                          (-.325,.096,.15,.05,0), (-.28,.076,.108,.002,0), (-.25,.07,.073,0,0)])
        calf.rings('51453e', [(-.38,.093,.151,.056,0), (-.367,.099,.155,.056,0)])
        model.mesh('Knee'+label, calf)


def copy_clips(model, number, overrides):
    donor = load(number)
    buffers = [(MODELS / b['uri']).read_bytes() for b in donor['buffers']]
    copied = {}
    def copy_accessor(index):
        if index not in copied:
            accessor = donor['accessors'][index]
            view = donor['bufferViews'][accessor['bufferView']]
            start = view.get('byteOffset', 0)
            data = buffers[view['buffer']][start:start+view['byteLength']]
            copied[index] = len(model.doc['accessors'])
            model.doc['accessors'].append(dict(accessor, bufferView=model.buffer_view(data)))
        return copied[index]

    for index, clip in enumerate(donor['animations']):
        if index in overrides:
            model.doc['animations'].append(overrides[index])
            continue
        model.doc['animations'].append(dict(clip, samplers=[
            dict(s, input=copy_accessor(s['input']), output=copy_accessor(s['output']))
            for s in clip['samplers']
        ]))


def build_character():
    model = Model(load(9001))
    build_body(model)
    geometry = copy.deepcopy(model)
    # Match the fingertip diamond from the reference while the player idles.
    composure = {
        'Jacket': [Z,(-1,0,0),(-2,0,0),(-1,0,0),Z],
        'Head': [Z,(-1,-2,0),(-2,0,0),(-1,2,0),Z],
        'ShoulderR': [(-22,3,9),(-23,3,9),(-24,3,9),(-23,3,9),(-22,3,9)],
        'ShoulderL': [(-22,-3,-9),(-23,-3,-9),(-24,-3,-9),(-23,-3,-9),(-22,-3,-9)],
        'ElbowR': [(-12,3,37),(-12,3,37),(-14,3,37),(-12,3,37),(-12,3,37)],
        'ElbowL': [(-12,-3,-37),(-12,-3,-37),(-14,-3,-37),(-12,-3,-37),(-12,-3,-37)],
    }
    idle = model.clip('idle', [0, 20, 40, 60, 80], composure)
    # Raise both fists into a compact kickboxing guard before the salute.
    guard = (-36,0,-23), (-43,0,22), (-113,0,5), (-104,0,-10)
    victory = {
        'Jacket': [Z, (9,-8,0), (-5,9,5), (-8,8,5), (-5,9,5)],
        'Head': [Z, (8,6,0), (-6,1,-6), (-9,-5,-3), (-6,1,-6)],
        'ShoulderR': [Z, guard[0], (-22,0,-110), (-29,0,-126), (-22,0,-110)],
        'ShoulderL': [Z, guard[1], (-19,0,24), (-15,0,22), (-19,0,24)],
        'ElbowR': [Z, guard[2], (-40,0,4), (-30,0,5), (-40,0,4)],
        'ElbowL': [Z, guard[3], (-85,0,0), (-75,0,0), (-85,0,0)],
    }
    win = model.clip('win', [0, 6, 12, 21, 33, 43], {k: v+[Z] for k,v in victory.items()})
    # Triangle: tip the sunglasses, hold eye contact, and lower the hand.
    taunt = model.clip('taunt', [0, 6, 13, 21, 31, 39], {
        'Jacket': [Z, (1,3,-1), (6,4,-4), (5,7,-4), (2,2,-1), Z],
        'Head': [Z, (-3,0,0), (10,-7,4), (-3,-3,2), (-1,3,0), Z],
        'ShoulderR': [Z, (-60,-8,-18), (-136,0,12), (-143,0,14), (-42,-5,-15), Z],
        'ElbowR': [Z, (-52,0,-12), (-16,0,0), (-15,0,0), (-48,0,-15), Z],
    })
    copy_clips(model, 9001, {0: idle, 4: win, 13: taunt})
    model.write(BASE)

    # Animation indices and hold frames follow the podium VM's existing scripts.
    podium = geometry
    podium.doc['buffers'] = [model.doc['buffers'][0]]
    podium.data.clear()
    grip = podium.nodes['CrateGrip']
    podium.doc['nodes'][podium.nodes['Jacket']]['children'].remove(grip)
    podium.doc['nodes'].pop()
    salute = podium.clip('Guard and salute', [0, 4, 9, 16, 24, 31], {
        name: [keys[0], keys[1], keys[2], keys[3], keys[2], keys[2]] for name, keys in victory.items()
    })
    podium_idle = podium.clip('Podium idle', [0, 8, 16, 24, 31], composure)
    copy_clips(podium, 9012, {0: salute, 2: podium_idle})
    podium.write(PODIUM)


def build_hud():
    subprocess.run([
        'magick', str(PORTRAIT), '-crop', '570x735+340+20', '+repage',
        '-filter', 'Lanczos', '-resize', '52x25!', '-channel', 'A', '-threshold', '50%',
        '+channel', '-background', 'none', '-gravity', 'North', '-extent', '64x32',
        '+dither', '-colors', '248', '-channel', 'RGB', '-fx', 'round(u*31)/31', '+channel',
        '-strip', '-define', 'png:exclude-chunk=time,date', str(ASSETS / 'hud/top-g-ps1.png'),
    ], check=True)


COPPER = 'cf8354'
COPPER_EDGE = 'f0ad73'
CARBON = '302930'


def kart_body():
    car = Shape()

    def deck(sections, color=COPPER):
        def section(z, width, low, high):
            return [(-width*.84,low,z), (width*.84,low,z), (width,low+18,z),
                    (width*.82,high,z), (-width*.82,high,z), (-width,low+18,z)]
        car.loft([CARBON, '704837', color, color, color, '704837'],
                 [section(*s) for s in sections])

    # Keep the short, wide footprint of the disc's hover kart.
    deck([(-254,142,-39,13),(-200,190,-53,72),(-90,192,-51,60),(33,183,-51,58),
          (139,190,-48,63),(218,157,-36,49),(229,142,-22,29)], '935539')
    deck([(40,128,44,87),(98,165,43,118),(155,185,38,104),(209,159,35,88),(222,140,31,70)])
    deck([(-249,137,22,58),(-222,181,38,103),(-162,182,45,105),(-100,143,49,87)])
    car.polygon(CARBON, (-108,63,41),(108,63,41),(130,65,-107),(-130,65,-107))
    car.polygon('19171d', (-80,69,-81),(80,69,-81),(68,127,-112),(-68,127,-112))

    # Horseshoe grille and the horizontal four-block lights read from the
    # game's high follow camera as well as from the front.
    grille = [(-48,31), (48,31), (53,48), (49,77), (37,90),
              (21,96), (-21,96), (-37,90), (-49,77), (-53,48)]
    def grille_point(x, y, offset=0):
        return x, y, 232 - .27*(y-32) + offset
    car.polygon(COPPER_EDGE, *(grille_point(x,y) for x,y in grille))
    car.polygon('19171a', *(grille_point(x*.85, 60+(y-60)*.84, 1.4) for x,y in grille))
    car.disc('b54333', 0, 90, 218, 6)
    car.polygon('2a2329', (-146,-18,230),(146,-18,230),(150,-33,225),(-150,-33,225))

    for side in (-1, 1):
        def panel(color, points):
            corners = [(side*x,y,z) for x,y,z in points]
            car.polygon(color, *corners if side > 0 else corners[::-1])

        panel('35272b', [(60,67,222),(145,67,212),(154,81,210),(67,84,219)])
        for i in range(4):
            x, z = 72+18*i, 222-2.15*i
            panel('fff2cb', [(x,73,z),(x+13,72,z-1.9),(x+14,80,z-2),(x+1,81,z)])

        panel(COPPER, [(110,54,103),(176,37,121),(191,52,69),(192,79,-111),
                       (166,104,-149),(119,86,-96),(108,66,45)])
        panel('49312d', [(189,38,74),(192,-14,92),(195,-14,-149),(188,54,-156),(183,83,-105)])
        # The side intake has the Chiron's open C picked out in lighter copper.
        trim = [(68,55),(78,7),(72,-56),(54,-100),(28,-121),(6,-114),(-10,-78),(-10,40)]
        for (y0,z0),(y1,z1) in zip(trim,trim[1:]):
            dy,dz = y1-y0,z1-z0
            norm = math.hypot(dy,dz)
            off_y,off_z = -dz*5/norm,dy*5/norm
            panel(COPPER_EDGE, [(197,y0-off_y,z0-off_z),(197,y1-off_y,z1-off_z),
                                (197,y1+off_y,z1+off_z),(197,y0+off_y,z0+off_z)])

        for z in (139,-154):
            def wheel_ring(x, r):
                ring = [(side*x, 19+r*math.cos(a), z+r*math.sin(a))
                        for a in (i*math.tau/10 for i in range(10))]
                return ring if side > 0 else ring[::-1]
            car.loft([CARBON]*10, [wheel_ring(x,r) for x,r in ((144,49),(152,63),(194,64),(211,49))])
            car.polygon('635452', *wheel_ring(212, 31))
            car.polygon('29252b', *wheel_ring(213, 23))
            car.polygon(COPPER, *wheel_ring(214, 10))

        panel(CARBON, [(88,83,-187),(102,82,-227),(125,140,-242),(112,140,-212)])

    # Fixed rear wing and one red strip across the tail between the vents.
    deck([(-263,174,135,149),(-227,194,134,147),(-204,181,132,142)], '5a3b31')
    car.polygon('d95244', (148,61,-251),(-148,61,-251),(-140,72,-250),(140,72,-250))
    car.polygon('1d181d', (53,2,-256),(-53,2,-256),(-47,30,-256),(47,30,-256))
    car.polygon('715048', (24,8,-258),(-24,8,-258),(-22,22,-258),(22,22,-258))
    # Low steering rim. It sits in the existing hand poses' space.
    for i in range(10):
        a,b = i*math.tau/10,(i+1)*math.tau/10
        def wheel_point(angle, radius):
            return math.cos(angle)*radius, 115+math.sin(angle)*radius*.75, 53-math.sin(angle)*radius*.5
        car.polygon(CARBON, wheel_point(a,36),wheel_point(b,36),wheel_point(b,27),wheel_point(a,27))
    car.stripe(COPPER, 7, (-27,115,53),(27,115,53))
    return car


def paint_variants():
    polished = (.45,-.09,-.38)
    dark = (.12,-.20,-.26)
    saddle = {2: dark, 3: dark, 5: polished}
    for number in (9102, 9103, 9108, 9113):
        # Trim on the pogo hardware, saddle and foot gear. Leave the bear's
        # face and the Melt variant's frozen meshes on the disc palettes.
        tint_equipment(number, saddle)
    tint_equipment(9106, {6: (.48,.01,-.29)}, lambda p: np.clip((p[:,1]+100)/230, 0, 1))
    # Warm accent on the dragon's back while keeping its green body and face.
    tint_equipment(9107, {2: (.26,-.10,-.23)},
                   lambda p: np.clip((p[:,1]-175)/200,0,1) * np.clip((65-p[:,2])/143,0,1))
    tint_equipment(9109, {0: (.17,-.07,-.16), 7: dark, 8: polished})
    tint_barrel_bands(9110, 'Copper-banded barrel', (.28,-.10,-.29))
    tint_equipment(9111, {1: dark, 5: polished})


if __name__ == '__main__':
    build_character()
    build_hud()
    reference = body_vertices()
    for i, donor in enumerate(DONORS, BASE + 1):
        build(donor, i, reference, base_model=BASE, rig_name='TopGRig')
    build(922, PODIUM + 1, reference, base_model=BASE, rig_name='TopGRig')
    replace_kart(9105, kart_body(), 'Copper and carbon')
    paint_variants()
