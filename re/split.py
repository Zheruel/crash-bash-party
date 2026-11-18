import re,sys
name,lo,hi=sys.argv[1],int(sys.argv[2],16),int(sys.argv[3],16)
src=open(f'out_{name}/all.c').read()
parts=re.split(r'^// ==== ',src,flags=re.M)[1:]
keep=[]
for p in parts:
    a=int(p.split()[0],16)
    if lo<=a<hi: keep.append('// ==== '+p)
open(f'out_{name}/ovl.c','w').write(''.join(keep))
for p in keep:
    h=p.split('\n',1)[0]; print(h, len(p.splitlines()))
