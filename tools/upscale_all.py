#!/usr/bin/env python3
"""Remaster many texture sets fast: dedupe identical PNGs, run tools/upscale.sh on unique ones in parallel,
then copy each result to all identical duplicates.   JOBS=24 python3 tools/upscale_all.py 0616 0618 ..."""
import hashlib, os, subprocess, sys, shutil, struct
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def dims(p):
    with open(p, 'rb') as f: h = f.read(24)
    return struct.unpack('>II', h[16:24])
groups = {}
for s in sys.argv[1:]:
    d = os.path.join(ROOT, 'assets/textures', s)
    for n in sorted(os.listdir(d)) if os.path.isdir(d) else []:
        if not (n.startswith('tex') and n.endswith('.png')): continue
        p = os.path.join(d, n); w, h = dims(p)
        if w < 16 or h < 16 or max(w, h) / min(w, h) > 3: continue
        groups.setdefault(hashlib.md5(open(p, 'rb').read()).hexdigest(), []).append((p, s, n))
todo = [g[0] for g in groups.values() if not os.path.exists(os.path.join(ROOT, 'assets/hd-raw', g[0][1], g[0][2]))]
print(f'{sum(len(g) for g in groups.values())} textures, {len(groups)} unique, {len(todo)} to do', flush=True)
subprocess.run([os.path.join(ROOT, 'tools/upscale.sh')], input=''.join(f'{p} {s} {n}\n' for p, s, n in todo), text=True)
copied = 0
for g in groups.values():
    src = next((os.path.join(ROOT, 'assets/hd-raw', s, n) for _, s, n in g if os.path.exists(os.path.join(ROOT, 'assets/hd-raw', s, n))), None)
    if not src: continue
    for _, s, n in g:
        dst = os.path.join(ROOT, 'assets/hd-raw', s, n)
        if not os.path.exists(dst):
            os.makedirs(os.path.dirname(dst), exist_ok=True); shutil.copyfile(src, dst); copied += 1
print(f'fanned out {copied} duplicates', flush=True)
