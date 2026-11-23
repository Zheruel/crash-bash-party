"""Build assets/models/9001.{gltf,bin}: python3 tools/build_big_stein.py.
Requires ImageMagick 7 on PATH for the portrait atlas. Y up, +Z forward, feet at 0.
Dimensions are game world units; all lighting is baked into COLOR_0 or the atlas.
"""
import json
import math
from pathlib import Path
import struct
import subprocess
from collections import defaultdict

from build_stein_variants import PS1_TEXTURE
from custom_character_assets import add_group_clips, gouraud

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/models'
portrait = ROOT / 'assets/portraits/big-stein.png'
# All eight disc HUD portraits occupy the upper 25 rows of a 64x32 CLUT texture.
hud_dir = ROOT / 'assets/hud'
subprocess.run([
    'magick', str(hud_dir / 'big-stein.png'), '-trim', '+repage', '-filter', 'Lanczos',
    '-resize', '61x25!', '-channel', 'A', '-threshold', '50%', '+channel', '-background', 'none',
    '-gravity', 'North', '-extent', '64x32', '+dither', '-colors', '248',
    '-channel', 'RGB', '-fx', 'round(u*31)/31', '+channel', '-strip',
    '-define', 'png:exclude-chunk=time,date', str(hud_dir / 'big-stein-ps1.png')
], check=True)
blob = bytearray()
g = dict(asset={'version': '2.0', 'generator': 'tools/build_big_stein.py'}, scene=0,
         scenes=[{'nodes': [0]}], nodes=[], meshes=[], materials=[], animations=[],
         accessors=[], bufferViews=[])
geometry = defaultdict(list)


def view(data, target=None):
    blob.extend(b'\0' * (-len(blob) % 4))
    d = dict(buffer=len(g.get('buffers', [])), byteOffset=len(blob), byteLength=len(data))
    if target:
        d['target'] = target
    blob.extend(data)
    g['bufferViews'].append(d)
    return len(g['bufferViews']) - 1


def accessor(values, size, vertex=False):
    data = b''.join(struct.pack('<' + 'f' * size, *v) for v in values)
    g['accessors'].append(dict(bufferView=view(data, 34962 if vertex else None),
        componentType=5126, count=len(values), type=['SCALAR','VEC2','VEC3','VEC4'][size-1],
        min=list(map(min, zip(*values))), max=list(map(max, zip(*values)))))
    return len(g['accessors']) - 1


def node(name, parent=None, xyz=(0,0,0)):
    i = len(g['nodes'])
    g['nodes'].append(dict(name=name, translation=xyz))
    if parent is not None:
        g['nodes'][parent].setdefault('children', []).append(i)
    return i


def tri(n, points, color, uv=None):
    a,b,c = points
    u,v = [tuple(p[i]-a[i] for i in range(3)) for p in (b,c)]
    normal = (u[1]*v[2]-u[2]*v[1], u[2]*v[0]-u[0]*v[2], u[0]*v[1]-u[1]*v[0])
    length = math.hypot(*normal)
    if length < 1e-12:
        return
    normal = tuple(k/length for k in normal)
    # Untextured corners keep their base colour here and are Gouraud shaded per surface below.
    rgb = tuple(int(color[i:i+2],16)/255 for i in (0,2,4))
    for i, p in enumerate(points):
        geometry[n, int(uv is not None)].append((p,normal,rgb,uv[i] if uv else None))


def poly(n, pts, color):
    for i in range(1,len(pts)-1):
        tri(n,[pts[0],pts[i],pts[i+1]],color)


def lathe(n, rows, color, count=8):
    """Tailored horizontal sections: height, half-width, half-depth, Z center, X center."""
    rings=[]
    for y,rx,rz,z,x in rows:
        rings.append([(x+rx*math.sin(a),y,z+rz*math.cos(a)) for a in
                      [(i+.5)*2*math.pi/count for i in range(count)]])
    poly(n,rings[0][::-1],color)
    for low, high in zip(rings,rings[1:]):
        for i in range(count):
            j=(i+1)%count
            poly(n,[low[i],low[j],high[j],high[i]],color)
    poly(n,rings[-1],color)


def band(n, a,b,width,color):
    # Ribbon on a front-facing garment panel.
    dx,dy=b[0]-a[0],b[1]-a[1]
    t=width/(2*math.hypot(dx,dy))
    def edge(p,s): return (p[0]-s*t*dy,p[1]+s*t*dx,p[2])
    poly(n,[edge(a,-1),edge(b,-1),edge(b,1),edge(a,1)],color)


hips=node('BigStein',xyz=(0,.67,0)); chest=node('Jacket',hips,(0,.025,0))
head=node('Head',chest,(0,.577,.012))
navy='303269'; trim='242548'; piping='515487'; skin='dd8954'; gold='ecc05d'; pants='37384c'
lathe(hips,[(-.075,.184,.113,0,0),(.035,.19,.13,0,0),(.09,.16,.116,0,0)],pants)
lathe(chest,[(0,.171,.127,0,0),(.06,.208,.148,0,0),(.30,.25,.157,.004,0),
             (.455,.312,.151,-.004,0),(.515,.265,.133,-.009,0),(.55,.104,.096,0,0)],navy)
lathe(chest,[(0,.18,.131,0,0),(.033,.199,.143,0,0)],trim)
lathe(chest,[(.455,.099,.084,.015,0),(.63,.092,.083,.018,0)],skin)
# Open standing collar, cut low at the throat. Raised outside edge also reads from the back.
collar=[]
for i in range(11):
    a=.40+i*(2*math.pi-.8)/10
    collar.append(((.16*math.sin(a),.47,.132*math.cos(a)),
                   (.172*math.sin(a),.597-.083*max(0,math.cos(a))**3,.148*math.cos(a))))
for (a,b),(c,d) in zip(collar,collar[1:]):
    poly(chest,[a,c,d,b],trim)
    poly(chest,[b,d,(d[0]*.85,d[1]-.008,d[2]*.85),(b[0]*.85,b[1]-.008,b[2]*.85)],piping)
poly(chest,[(-.076,.526,.135),(0,.368,.156),(.076,.526,.135)],skin)
for s in (-1,1): band(chest,(0,.367,.157),(s*.078,.53,.139),.009,gold)
band(chest,(0,.344,.157),(0,.377,.157),.016,gold)
# Portrait's red diamond monogram, registered on the left breast.
p=[(.099,.34,.151),(.181,.344,.132),(.181,.43,.132),(.099,.426,.151)]
uv=[(779/1254,1146/1254),(939/1254,1146/1254),(939/1254,968/1254),(779/1254,968/1254)]
for ii in [(0,1,2),(0,2,3)]: tri(chest,[p[i] for i in ii],'ffffff',[uv[i] for i in ii])

# The back repeats the jacket's red diamond so the motif is readable while racing.
crest = [(0,.409,-.148),(.084,.325,-.151),(0,.243,-.153),(-.084,.325,-.151)]
for a,b in zip(crest, crest[1:]+crest[:1]):
    band(chest,a,b,.011,'d32d3c')
for x,y0,y1 in [(-.026,.287,.362),(0,.270,.380),(.026,.287,.362)]:
    band(chest,(x,y0,-.153),(x,y1,-.153),.008,'d32d3c')

# A closed cranial volume. Trace the portrait silhouette and place relief landmarks at
# the brows, nose, lips and chin. UVs stay registered even from a three-quarter view.
outline=[(502,20),(613,38),(655,90),(737,112),(770,232),(797,273),(780,378),
 (792,390),(802,451),(790,496),(746,521),(738,630),(724,746),(708,773),(608,817),
 (553,798),(475,709),(436,624),(407,625),(371,610),(340,540),(359,496),
 (276,453),(233,376),(260,303),(235,253),(274,139),(349,96),(367,54)]
depths=[-.015,-.015,.006,.003,-.015,.003,-.008,.004,.015,.005,.014,.033,.053,.079,.107,
 .100,.068,.042,.003,-.002,.002,-.011,-.005,.004,-.008,.012,.007,-.015,-.025]
landmarks=[(435,203,.115),(562,136,.088),(319,251,.060),(635,235,.063),(385,331,.108),
 (476,315,.142),(608,275,.115),(344,397,.094),(461,374,.154),(511,350,.156),
 (646,320,.108),(392,461,.104),(480,431,.135),(548,402,.135),(643,368,.104),
 (491,448,.166),(507,564,.212),(577,586,.211),(614,536,.188),(426,531,.118),
 (684,457,.105),(689,513,.113),(682,547,.120),(652,593,.128),(528,643,.143),
 (489,630,.128),(550,665,.151),(694,685,.102),(579,763,.147),(380,172,.093),
 (495,67,.057),(690,153,.052),(736,277,.078),(294,385,.060),(757,428,.039)]
# Ear clip the outline, then split the containing triangle for each internal landmark.
# Rotate unconstrained internal edges toward a Delaunay triangulation for cleaner facets.
def orient(a,b,c): return (b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0])
verts=outline.copy(); face=[]; remaining=list(range(len(verts)))
def inside(t,p): return min(orient(verts[t[k]],verts[t[(k+1)%3]],p) for k in range(3))>=0
while len(remaining)>3:
    for k,j in enumerate(remaining):
        t=(remaining[k-1],j,remaining[(k+1)%len(remaining)])
        if orient(*(verts[i] for i in t))>0 and not any(inside(t,verts[i]) for i in remaining if i not in t):
            face.append(t); remaining.pop(k); break
    else: raise ValueError('Invalid head outline')
face.append(tuple(remaining))
for u,v,z in landmarks:
    t=next(t for t in face if inside(t,(u,v)))
    face.remove(t); i=len(verts); verts.append((u,v)); depths.append(z)
    face.extend((t[k],t[(k+1)%3],i) for k in range(3))
def angle(i,j,k):
    a,b,c=(complex(*verts[q]) for q in (i,j,k)); r=(a-b)/(c-b)
    return abs(math.atan2(r.imag,r.real))
while True:
    edges={}; flipped=False
    for t in face:
        for a,b,c in (t,t[1:]+t[:1],t[2:]+t[:2]):
            if (b,a) in edges:
                d,other=edges[b,a]
                if angle(a,c,b)+angle(b,d,a)>math.pi+1e-8:
                    face.remove(t); face.remove(other); face.extend([(c,d,b),(d,c,a)])
                    flipped=True; break
            edges[a,b]=c,t
        if flipped: break
    if not flipped: break

def skull(u,v,z):
    dx,dy=u-620,v-795
    return (.00083*(dx-.24*dy),.00083*(-dy-.24*dx),z)
points=[skull(u,v,z) for (u,v),z in zip(verts,depths)]
for t in face:
    t=t[::-1]; tri(head,[points[i] for i in t],'ffffff',[(verts[i][0]/1254,verts[i][1]/1254) for i in t])
# Receding temples, strong jaw, swept-back silver crown and tapered nape.
rim=points[:len(outline)]; rear=[]; crown=[]
for x,y,z in rim:
    rear.append((x*.91,.31+(y-.31)*.86,-.092 if y<.20 else -.137))
    crown.append((x*.63,.34+(y-.34)*.69,-.169 if y<.22 else -.195))
hair=['a6a0a6','bbb3b5','918b96','b3aeb4','8c858e']
for i in range(len(rim)):
    j=(i+1)%len(rim); is_hair=i<6 or i>=21
    poly(head,[rim[i],rim[j],rear[j],rear[i]],hair[i%5] if is_hair else skin)
    col=hair[(i+2)%5] if is_hair or rear[i][1]>.18 else 'b9744d'
    poly(head,[rear[i],rear[j],crown[j],crown[i]],col)

# Follow the occiput with horizontal sections instead of fanning every facet into
# a single point. A clipped nape and staggered ridges suggest combed-back waves.
rear_rows=[]
for y in sorted({p[1] for p in crown}):
    cuts=[p for p in crown if p[1]==y]
    for a,b in zip(crown,crown[1:]+crown[:1]):
        if min(a[1],b[1])<y<max(a[1],b[1]):
            t=(y-a[1])/(b[1]-a[1]); cuts.append(tuple(u+t*(v-u) for u,v in zip(a,b)))
    left,right=min(cuts),max(cuts)
    row=[]
    for j,f in enumerate((0,.24,.53,.79,1)):
        x=left[0]+f*(right[0]-left[0]); z=left[2]+f*(right[2]-left[2]); width=right[0]-left[0]
        row.append((x,y,z-width*.16*math.sin(math.pi*f)))
    rear_rows.append(row)
for low,high in zip(rear_rows,rear_rows[1:]):
    for j in range(4):
        y=(low[j][1]+high[j][1])/2
        color='af795b' if y<.19 else ['908993','aaa3a8','a69fa4','908993'][j]
        poly(head,[low[j],high[j],high[j+1],low[j+1]],color)

arms=[]; elbows=[]; thighs=[]; knees=[]
for s,label in [(-1,'R'),(1,'L')]:
    arm=node('Shoulder'+label,chest,(s*.259,.45,0)); arms.append(arm)
    lathe(arm,[(-.245,.078,.081,0,s*.043),(-.17,.092,.098,0,s*.04),
               (-.037,.113,.113,0,s*.025),(.042,.085,.092,0,0)],navy)
    elbow=node('Elbow'+label,arm,(s*.046,-.231,.004)); elbows.append(elbow)
    lathe(elbow,[(-.205,.065,.070,.025,s*.009),(-.16,.082,.086,.025,s*.009),
                 (-.041,.091,.088,.002,0),(.038,.079,.078,0,0)],navy)
    lathe(elbow,[(-.211,.066,.073,.025,s*.009),(-.177,.069,.075,.024,s*.009)],piping)
    lathe(elbow,[(-.208,.067,.074,.025,s*.009),(-.199,.068,.075,.024,s*.009)],gold)
    lathe(elbow,[(-.327,.051,.057,.052,0),(-.292,.076,.082,.05,0),
                 (-.236,.077,.077,.04,0),(-.194,.053,.054,.027,0)],skin)
    lathe(elbow,[(-.295,.029,.036,.093,-s*.033),(-.264,.039,.040,.094,-s*.043),
                 (-.239,.025,.030,.073,-s*.04)],'e09561')
    leg=node('Hip'+label,hips,(s*.104,-.012,0)); thighs.append(leg)
    lathe(leg,[(-.298,.086,.089,0,0),(-.17,.103,.107,-.004,0),(.028,.108,.117,0,0)],pants)
    knee=node('Knee'+label,leg,(0,-.278,0)); knees.append(knee)
    lathe(knee,[(-.272,.070,.074,0,0),(-.203,.077,.081,-.012,0),
                (-.075,.092,.097,-.014,0),(.014,.088,.09,.003,0)],pants)
    lathe(knee,[(-.38,.1,.15,.055,0),(-.355,.104,.16,.055,0),
                (-.318,.101,.157,.05,0),(-.28,.079,.105,.005,0),(-.25,.072,.08,0,0)],'352f39')
    lathe(knee,[(-.38,.101,.151,.055,0),(-.361,.105,.162,.055,0)],'68606a')

# One mesh per moving rigid part, one primitive per material on that part.
atlas=subprocess.check_output(['magick',str(portrait),'-background','#252434','-alpha','remove',*PS1_TEXTURE])
g['images']=[dict(name='Portrait atlas',mimeType='image/png',bufferView=view(atlas))]
g['samplers']=[dict(magFilter=9728,minFilter=9728,wrapS=33071,wrapT=33071)]
g['textures']=[dict(source=0,sampler=0)]
for name,texture in [('Facets',False),('Portrait',True)]:
    pbr=dict(metallicFactor=0,roughnessFactor=1)
    if texture: pbr['baseColorTexture']=dict(index=0)
    g['materials'].append(dict(name=name,doubleSided=True,pbrMetallicRoughness=pbr))
for (n,m),vs in sorted(geometry.items()):
    if 'mesh' not in g['nodes'][n]:
        g['nodes'][n]['mesh']=len(g['meshes']); g['meshes'].append(dict(primitives=[]))
    if not m:
        vs=[(p,normal,rgb,uv) for (p,normal,_,uv),rgb in zip(vs,gouraud([v[:3] for v in vs]))]
    # Deduplicate within each material; only corners with one position, normal and colour are shared.
    unique=list(dict.fromkeys(vs)); lookup={v:i for i,v in enumerate(unique)}
    attrs={key:accessor([v[k] for v in unique],size,True) for k,(key,size) in
           enumerate([('POSITION',3),('NORMAL',3),('COLOR_0',3)]+([('TEXCOORD_0',2)] if m else []))}
    indices=[lookup[v] for v in vs]; idx=len(g['accessors'])
    g['accessors'].append(dict(bufferView=view(struct.pack('<'+'H'*len(indices),*indices),34963),
        componentType=5123,type='SCALAR',count=len(indices)))
    g['meshes'][g['nodes'][n]['mesh']]['primitives'].append(dict(attributes=attrs,indices=idx,material=m))


def quat(x=0,y=0,z=0):
    x,y,z=[math.radians(a)/2 for a in (x,y,z)]
    a,b,c=map(math.cos,(x,y,z)); d,e,f=map(math.sin,(x,y,z))
    return (d*b*c+a*e*f,a*e*c-d*b*f,a*b*f+d*e*c,a*b*c-d*e*f)


def clip(name,times,poses):
    anim=dict(name=name,channels=[],samplers=[]); g['animations'].append(anim)
    time=accessor([(t,) for t in times],1)
    for n,values in poses.items():
        if n == 'lift':
            target, path, values = hips, 'translation', [(0,.67+v,0) for v in values]
        elif n == crate_grip:
            target, path = n, 'translation'
        else:
            target, path, values = n, 'rotation', [quat(*r) for r in values]
        assert len(values)==len(times)
        anim['channels'].append(dict(sampler=len(anim['samplers']),target=dict(node=target,path=path)))
        anim['samplers'].append(dict(input=time,output=accessor(values,len(values[0])),interpolation='LINEAR'))


def rotated(point, angles):
    x,y,z,w = quat(*angles)
    a,b,c = point
    u,v,k = 2*(y*c-z*b), 2*(z*a-x*c), 2*(x*b-y*a)
    return (a+w*u+y*k-z*v, b+w*v+z*u-x*k, c+w*k+x*v-y*u)


def crate_clip(name, times, pose):
    # Derive the crate pivot from the centers of the palms, in jacket space.
    # The base of the box lies below the grip, with its near face at the hands.
    pivots = []
    for frame in range(len(times)):
        palms = []
        for arm, elbow in zip(arms, elbows):
            palm = rotated((0,-.272,.045),pose[elbow][frame])
            offset = g['nodes'][elbow]['translation']
            wrist = rotated(tuple(a+b for a,b in zip(palm,offset)),pose[arm][frame])
            palms.append(tuple(a+b for a,b in zip(wrist,g['nodes'][arm]['translation'])))
        pivots.append(tuple((a+b)/2+offset for a,b,offset in zip(*palms,(0,-.29,.39))))
    if name == 'carry':
        g['nodes'][crate_grip]['translation'] = pivots[0]
    clip(name, times, {**pose, crate_grip:pivots})


geometry_views = len(g['bufferViews'])
geometry_accessors = len(g['accessors'])
crate_grip = node('CrateGrip',chest)
Z=(0,0,0)
clip('idle',[0,.65,1.3,1.95,2.6],{chest:[Z,(-2,0,1),Z,(1,0,-1),Z],head:[(0,-4,3),(0,0,3),(-2,5,2),(0,0,2),(0,-4,3)],
    elbows[0]:[(-12,0,0),(-15,0,0),(-12,0,0),(-9,0,0),(-12,0,0)]})
run={'lift':[0,.033,0,.033,0],chest:[(10,-7,1),(13,0,0),(10,7,-1),(13,0,0),(10,-7,1)]}
for i in range(2):
    def stride(j,angles): run[j]=[(angles[(k+2*i)%4],0,0) for k in range(5)]
    stride(thighs[i],[-38,0,31,-6]); stride(knees[i],[12,8,53,70]); stride(arms[i],[35,0,-39,0]); stride(elbows[i],[-36,-52,-62,-48])
clip('run',[0,.14,.28,.42,.56],run)
clip('action',[0,.16,.28,.44,.67],{chest:[Z,(3,-24,5),(11,27,-8),(9,19,-5),Z],
 arms[0]:[Z,(-41,-18,-22),(-94,-4,-8),(-88,0,-9),Z],elbows[0]:[Z,(-86,0,0),(-5,0,0),(-10,0,0),Z],
 arms[1]:[Z,(-25,0,9),(29,0,13),(22,0,11),Z]})
# A hit knocks him flat on his back and he sits up again, as Cortex's group 0 does in 26 frames.
clip('hit',[f/30 for f in (0,4,9,15,20,25)],{
 hips:[Z,(-14,0,3),(-52,0,-4),(-80,0,2),(-34,0,0),Z], 'lift':[0,.05,-.12,-.52,-.36,0],
 chest:[Z,(-28,9,-12),(-12,4,-6),(-6,0,0),(26,0,0),Z], head:[Z,(-24,-12,10),(-10,-6,4),(18,8,0),(12,0,0),Z],
 arms[0]:[Z,(-70,0,-62),(-40,0,-84),(14,0,-48),(-18,0,-22),Z], arms[1]:[Z,(-64,0,66),(-36,0,88),(12,0,44),(-16,0,20),Z],
 elbows[0]:[Z,(-30,0,0),(-12,0,0),(-8,0,0),(-24,0,0),Z], elbows[1]:[Z,(-30,0,0),(-12,0,0),(-8,0,0),(-24,0,0),Z],
 thighs[0]:[Z,(-12,0,0),(-48,0,-6),(-4,0,-8),(-92,0,-6),Z], thighs[1]:[Z,(-20,0,0),(-36,0,6),(-10,0,8),(-88,0,6),Z],
 knees[0]:[Z,(18,0,0),(52,0,0),(10,0,0),(98,0,0),Z], knees[1]:[Z,(24,0,0),(40,0,0),(16,0,0),(92,0,0),Z]})
clip('win',[0,.27,.48,.72,1.05,1.45],{arms[1]:[Z,(-25,0,64),(-17,0,150),(-19,0,128),(-17,0,151),Z],
 elbows[1]:[Z,(-79,0,0),(-15,0,0),(-45,0,0),(-14,0,0),Z],head:[Z,(-8,9,-5),(-14,15,-9),(-9,13,-6),(-14,15,-9),Z],
 chest:[Z,(1,7,0),(-5,8,7),(-2,6,4),(-5,8,7),Z]})
# Defeat: his shoulders drop, his knees give way and he kneels with his head bowed, held like the end of Cortex's
# group 11 collapse (21 frames). The last key holds the pose for a looped role.
kneel = {hips:(12,0,0), 'lift':-.36, chest:(30,0,2), head:(34,0,-4), arms[0]:(-12,0,-6), arms[1]:(-10,0,6),
 elbows[0]:(-16,0,0), elbows[1]:(-14,0,0), thighs[0]:(-14,0,-4), thighs[1]:(-10,0,4), knees[0]:(100,0,0), knees[1]:(96,0,0)}
clip('lose',[f/30 for f in (0,6,12,20,90)],{
 hips:[Z,(4,0,0),(20,0,0),kneel[hips],kneel[hips]], 'lift':[0,-.02,-.22,-.36,-.36],
 chest:[Z,(18,0,0),(34,0,3),kneel[chest],kneel[chest]], head:[Z,(16,6,-3),(30,-4,-4),kneel[head],kneel[head]],
 arms[0]:[Z,(-6,0,-8),(-24,0,-12),kneel[arms[0]],kneel[arms[0]]], arms[1]:[Z,(-6,0,8),(-22,0,12),kneel[arms[1]],kneel[arms[1]]],
 elbows[0]:[Z,(-20,0,0),(-30,0,0),kneel[elbows[0]],kneel[elbows[0]]], elbows[1]:[Z,(-20,0,0),(-28,0,0),kneel[elbows[1]],kneel[elbows[1]]],
 thighs[0]:[Z,(-6,0,0),(-48,0,-4),kneel[thighs[0]],kneel[thighs[0]]], thighs[1]:[Z,(-4,0,0),(-44,0,4),kneel[thighs[1]],kneel[thighs[1]]],
 knees[0]:[Z,(10,0,0),(84,0,0),kneel[knees[0]],kneel[knees[0]]], knees[1]:[Z,(8,0,0),(80,0,0),kneel[knees[1]],kneel[knees[1]]]})
# Crate Crush holds the box in front of the chest. Keep that grip through each stride.
grip = {arms[i]: [(-62, 0, (1 if i else -1)*12)]*5 for i in range(2)}
grip.update({elbows[i]: [(-45, 0, 0)]*5 for i in range(2)})
crate_clip('carry', [0,.25,.5,.75,1], {**grip, chest:[Z,(-2,0,0),Z,(-2,0,0),Z]})
crate_clip('carryRun', [0,.15,.3,.45,.6], {**run, **grip,
    chest:[(4,-3,0),(6,0,0),(4,3,0),(6,0,0),(4,-3,0)]})
# Crate Crush samples the Cortex-family pickup (8 ticks), throw (13 ticks,
# release at tick 2) and spin (19 ticks) on the simulation counters.
for name, frames, reach, bend, lean, lift in [
    ('lift', [0,2,4,7], [-5,-25,-51,-62], [-7,-15,-34,-45], [16,42,21,0], [-.08,-.23,-.1,0]),
    ('throw', [0,1,2,6,12], [-62,-72,-96,-50,0], [-45,-51,-14,-16,-12], [0,-6,12,11,0], [0,-.03,.04,.02,0]),
]:
    pose = {chest: [(x,0,0) for x in lean], 'lift':lift}
    for i in range(2):
        pose[arms[i]] = [(x,0,(1 if i else -1)*12) for x in reach]
        pose[elbows[i]] = [(x,0,0) for x in bend]
        pose[thighs[i]] = [(v*152,0,0) for v in lift]
        pose[knees[i]] = [(-v*245,0,0) for v in lift]
    crate_clip(name, [f/30 for f in frames], pose)
jump_times = [0,.15,.4,.65]
jump = {chest:[Z,(7,0,0),(5,0,0),Z],
    thighs[0]:[Z,(-42,0,0),(-31,0,0),Z], thighs[1]:[Z,(-29,0,0),(-37,0,0),Z],
    knees[0]:[Z,(58,0,0),(48,0,0),Z], knees[1]:[Z,(50,0,0),(54,0,0),Z]}
clip('jump', jump_times, jump)
clip('spin', [f/30 for f in (0,3,6,10,15,18)], {
    'lift': [0,-.08,.055,.02,-.055,0],
    chest: [Z,(12,24,-6),(9,-10,9),(6,-16,7),(16,-8,-3),Z],
    head: [Z,(4,16,-3),(-5,-12,0),(-4,-8,1),(6,-8,1),Z],
    arms[0]: [Z,(-32,0,-23),(-30,0,-70),(-12,0,-53),(-9,0,-16),Z],
    arms[1]: [Z,(-20,0,13),(8,0,46),(19,0,57),(-13,0,20),Z],
    elbows[0]: [Z,(-65,0,0),(-10,0,0),(-25,0,0),(-39,0,0),Z],
    elbows[1]: [Z,(-50,0,0),(-24,0,0),(-38,0,0),(-33,0,0),Z],
    thighs[0]: [Z,(-18,0,0),(-14,-5,-25),(-16,-5,-19),(-12,0,-8),Z],
    thighs[1]: [Z,(-18,0,0),(-42,9,48),(-28,15,36),(-13,3,6),Z],
    knees[0]: [Z,(33,0,0),(14,0,0),(16,0,0),(23,0,0),Z],
    knees[1]: [Z,(33,0,0),(9,0,0),(23,0,0),(23,0,0),Z],
})
crate_clip('carryJump', jump_times, {**jump, **{part: angles[:4] for part, angles in grip.items()}})
# Triangle on foot lasts 40 ticks in Stein's movement family. He taps his
# temple twice, then lowers his arm. Entering another action cancels the clip.
clip('taunt', [f/30 for f in (0,5,11,15,20,24,31,39)], {
    chest: [Z,(3,-4,2),(-3,-13,4),(-4,-14,4),(-2,-11,3),(-4,-14,4),(-2,-6,2),Z],
    head: [Z,(-3,6,-2),(-7,18,-8),(-5,16,-4),(-7,19,-9),(-5,16,-4),(0,9,-3),Z],
    arms[1]: [Z,(-28,4,-16),(-66,3,-30),(-63,3,-31),(-70,2,-32),(-64,3,-31),(-35,3,-17),Z],
    elbows[1]: [Z,(-41,0,2),(-108,-6,0),(-122,-5,0),(-105,-6,1),(-122,-5,0),(-64,0,1),Z],
    arms[0]: [Z,(2,0,5),(7,0,9),(8,0,9),(7,0,9),(8,0,9),(3,0,4),Z],
})
add_group_clips(g, blob, accessor)
g['buffers']=[dict(uri='9001.bin',byteLength=len(blob))]
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'9001.bin').write_bytes(blob)
(OUT/'9001.gltf').write_text(json.dumps(g,separators=(',',':'),allow_nan=False)+'\n')

# The podium has its own performance on Stein's hinged rig. Reuse his mesh
# buffer so his jacket, face and proportions stay identical to the lobby model.
g['nodes'][chest]['children'].remove(crate_grip)
g['nodes'].pop()
del g['bufferViews'][geometry_views:]
del g['accessors'][geometry_accessors:]
g['animations'] = []
blob = bytearray()

def podium_clip(name, frames, poses):
    clip(name, [frame/30 for frame in frames], poses)

# The podium VM plays 0..31, loops back to 9, then reverses 9..0.
# Match the raised-fist poses at both ends of that cut.
salute = (-24, 2, 127)
podium_clip('Victory salute', [0, 4, 9, 14, 20, 25, 30, 31], {
    chest: [Z,(5,-8,-3),(-5,8,4),(-7,13,5),(-3,4,2),(-7,10,4),(-5,8,4),(-5,8,4)],
    head: [Z,(5,-9,-2),(-8,7,-5),(-12,14,-6),(0,1,-3),(-9,8,-5),(-8,7,-5),(-8,7,-5)],
    arms[1]: [Z,(-31,0,32),salute,(-27,4,151),(-24,0,109),(-28,3,148),salute,salute],
    elbows[1]: [Z,(-74,0,0),(-34,0,0),(-14,0,0),(-53,0,0),(-19,0,0),(-34,0,0),(-34,0,0)],
    arms[0]: [Z,(-8,0,-12),(-12,0,-20),(-16,0,-21),(-10,0,-18),(-14,0,-21),(-12,0,-20),(-12,0,-20)],
})
# On defeat he lifts his open arms, looks toward the winner, and lets
# them drop. Frames 15 and 46 meet at the held shrug in the native script.
podium_clip('Disbelieving shrug', [0, 7, 15, 24, 34, 45, 46, 53], {
    chest: [Z,(-5,0,0),(7,-6,0),(10,-9,-2),(9,6,1),(7,-6,0),(7,-6,0),Z],
    head: [Z,(-12,4,-3),(8,-14,5),(3,-25,7),(10,17,-5),(8,-14,5),(8,-14,5),Z],
    arms[0]: [Z,(3,0,-12),(-9,8,-60),(-14,6,-69),(-8,4,-54),(-9,8,-60),(-9,8,-60),Z],
    arms[1]: [Z,(3,0,10),(-8,-6,57),(-9,-6,61),(-12,-5,67),(-8,-6,57),(-8,-6,57),Z],
    elbows[0]: [Z,(-18,0,0),(-78,0,-14),(-91,0,-10),(-70,0,-12),(-78,0,-14),(-78,0,-14),Z],
    elbows[1]: [Z,(-18,0,0),(-74,0,14),(-80,0,12),(-89,0,10),(-74,0,14),(-74,0,14),Z],
})
podium_clip('Podium idle', [0, 8, 16, 24, 31], {
    chest: [Z,(-1,0,0),(-2,0,0),(-1,0,0),Z],
    head: [Z,(-1,-3,1),(-2,-5,1),(-1,-2,0),Z],
    elbows[0]: [Z,(-3,0,0),(-5,0,0),(-3,0,0),Z],
})
g['buffers'].append(dict(uri='9012.bin',byteLength=len(blob)))
(OUT/'9012.bin').write_bytes(blob)
(OUT/'9012.gltf').write_text(json.dumps(g,separators=(',',':'),allow_nan=False)+'\n')
