# per-game decompile image: live RAM 0x80010000..0x80200000 with GTE command words (cop2 imm) replaced by nop
import sys
L,name=sys.argv[1],sys.argv[2]
ram=bytearray(open(f'dumps/L{L}.ram','rb').read())
img=ram[0x10000:0x200000]
n=0
for i in range(0,len(img),4):
    w=int.from_bytes(img[i:i+4],'little')
    if (w>>26)==0x12 and (w>>25)&1:  # COP2 command (RTPS, MVMVA, ...)
        img[i:i+4]=b'\0\0\0\0'; n+=1
open(f'img_{name}.bin','wb').write(img)
print(name,'gte cmds patched',n)
