import sys
sys.path.insert(0,'/private/tmp/claude-501/-Users-tinzeljar-Documents-crash-bash/0b16b027-8169-4540-9159-32d3215a93f5/scratchpad/pylib')
from PIL import Image, ImageDraw
# usage: mont.py out.png cols name1 name2 ...
out,cols=sys.argv[1],int(sys.argv[2]); names=sys.argv[3:]
ims=[Image.open(n if n.endswith('.png') else n+'.png').convert('RGB') for n in names]
w,h=480,360
rows=(len(ims)+cols-1)//cols
M=Image.new('RGB',(cols*w,rows*h))
for i,im in enumerate(ims):
    im=im.resize((w,h)); d=ImageDraw.Draw(im); d.rectangle([0,h-18,120,h],fill=(0,0,0)); d.text((4,h-15),names[i].split('/')[-1],fill=(255,255,0))
    M.paste(im,((i%cols)*w,(i//cols)*h))
M.save(out)
