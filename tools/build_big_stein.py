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

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'assets/models'
portrait = ROOT / 'assets/portraits/big-stein.png'
blob = bytearray()
g = dict(asset={'version': '2.0', 'generator': 'tools/build_big_stein.py'}, scene=0,
         scenes=[{'nodes': [0]}], nodes=[], meshes=[], materials=[], animations=[],
         accessors=[], bufferViews=[])
geometry = defaultdict(list)


def view(data, target=None):
    blob.extend(b'\0' * (-len(blob) % 4))
    d = dict(buffer=0, byteOffset=len(blob), byteLength=len(data))
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
    shade = .78 + .22*sum(k*l for k,l in zip(normal,(-.4,.75,.52))) if uv is None else 1
    rgb = tuple((int(color[i:i+2],16)/255)*shade for i in (0,2,4))
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
atlas=subprocess.check_output(['magick',str(portrait),'-background','#252434','-alpha','remove',
    '-resize','512x512!','-strip','-sampling-factor','4:4:4','-quality','92','jpeg:-'])
g['images']=[dict(name='Portrait atlas',mimeType='image/jpeg',bufferView=view(atlas))]
g['samplers']=[dict(magFilter=9728,minFilter=9728,wrapS=33071,wrapT=33071)]
g['textures']=[dict(source=0,sampler=0)]
for name,texture in [('Facets',False),('Portrait',True)]:
    pbr=dict(metallicFactor=0,roughnessFactor=1)
    if texture: pbr['baseColorTexture']=dict(index=0)
    g['materials'].append(dict(name=name,doubleSided=True,pbrMetallicRoughness=pbr))
for (n,m),vs in sorted(geometry.items()):
    if 'mesh' not in g['nodes'][n]:
        g['nodes'][n]['mesh']=len(g['meshes']); g['meshes'].append(dict(primitives=[]))
    # Deduplicate within each material; only coplanar, same-colour corners are shared.
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
        pos=n=='lift'; values=[(0,.67+v,0) for v in values] if pos else [quat(*r) for r in values]
        assert len(values)==len(times)
        anim['channels'].append(dict(sampler=len(anim['samplers']),target=dict(node=hips if pos else n,path='translation' if pos else 'rotation')))
        anim['samplers'].append(dict(input=time,output=accessor(values,3 if pos else 4),interpolation='LINEAR'))
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
clip('hit',[0,.09,.21,.46],{chest:[Z,(-24,9,-14),(-16,6,-8),Z],head:[Z,(-19,-12,11),(-9,-3,5),Z],
 arms[0]:[Z,(-27,0,-32),(-20,0,-15),Z],arms[1]:[Z,(-31,0,26),(-18,0,13),Z]})
clip('win',[0,.27,.48,.72,1.05,1.45],{arms[1]:[Z,(-25,0,64),(-17,0,150),(-19,0,128),(-17,0,151),Z],
 elbows[1]:[Z,(-79,0,0),(-15,0,0),(-45,0,0),(-14,0,0),Z],head:[Z,(-8,9,-5),(-14,15,-9),(-9,13,-6),(-14,15,-9),Z],
 chest:[Z,(1,7,0),(-5,8,7),(-2,6,4),(-5,8,7),Z]})
clip('lose',[0,.38,.77,1.25,1.8],{chest:[Z,(15,0,0),(21,0,3),(19,0,2),Z],head:[Z,(13,0,-2),(20,9,-5),(18,-9,-4),Z],
 arms[0]:[Z,(-7,0,-8),(-15,0,-7),(-14,0,-7),Z],elbows[0]:[Z,(-44,0,0),(-101,-29,-21),(-95,-28,-18),Z]})
# Crate Crush holds the box in front of the chest. Keep that grip through each stride.
grip = {arms[i]: [(-62, 0, (1 if i else -1)*12)]*5 for i in range(2)}
grip.update({elbows[i]: [(-45, 0, 0)]*5 for i in range(2)})
clip('carry', [0,.25,.5,.75,1], {**grip, chest:[Z,(-2,0,0),Z,(-2,0,0),Z]})
clip('carryRun', [0,.15,.3,.45,.6], {**run, **grip})
for name, times, reach, bend, lean in [
    ('lift', [0,.10,.20,.32], [0,-26,-52,-62], [-12,-17,-34,-45], [0,26,18,0]),
    ('throw', [0,.12,.29,.48], [-62,-91,-108,-12], [-45,-72,-6,-12], [0,-14,17,0]),
]:
    pose = {chest: [(x,0,0) for x in lean]}
    for i in range(2):
        pose[arms[i]] = [(x,0,(1 if i else -1)*12) for x in reach]
        pose[elbows[i]] = [(x,0,0) for x in bend]
    clip(name, times, pose)
clip('jump', [0,.15,.4,.65], {chest:[Z,(7,0,0),(5,0,0),Z],
    thighs[0]:[Z,(-42,0,0),(-31,0,0),Z], thighs[1]:[Z,(-29,0,0),(-37,0,0),Z],
    knees[0]:[Z,(58,0,0),(48,0,0),Z], knees[1]:[Z,(50,0,0),(54,0,0),Z]})
g['buffers']=[dict(uri='9001.bin',byteLength=len(blob))]
OUT.mkdir(parents=True,exist_ok=True)
(OUT/'9001.bin').write_bytes(blob)
(OUT/'9001.gltf').write_text(json.dumps(g,separators=(',',':'),allow_nan=False)+'\n')
