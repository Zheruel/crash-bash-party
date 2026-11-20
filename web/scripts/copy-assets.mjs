// Copies game assets into the static build: catalog, arenas.json, all models, textures (HD remaster
// from assets/hd/ when HD_TEXTURES=1) and audio.
// Portraits are only copied when a catalog character references them.
//   node scripts/copy-assets.mjs <assetsDir> <outDir>
import fs from 'node:fs';
import path from 'node:path';

const [src, out] = process.argv.slice(2);
if (!src || !out) { console.error('usage: copy-assets.mjs <assetsDir> <outDir>'); process.exit(1); }
const cp = (rel) => {
  const a = path.join(src, rel);
  if (!fs.existsSync(a)) return;
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.cpSync(a, path.join(out, rel), { recursive: true });
};
for (const f of ['catalog.json', 'arenas.json', 'stages', 'models', 'textures', 'audio', 'ui', 'hud']) cp(f);
let hd = 0;
const hdDir = path.join(src, 'hd');
if (process.env.HD_TEXTURES === '1' && fs.existsSync(hdDir)) {
  for (const set of fs.readdirSync(hdDir)) {
    for (const f of fs.readdirSync(path.join(hdDir, set))) {
      if (!f.endsWith('.png')) continue;
      const dst = path.join(out, 'textures', set, f);
      if (!fs.existsSync(dst)) continue;
      fs.copyFileSync(path.join(hdDir, set, f), dst);
      hd++;
    }
  }
}
const cat = fs.existsSync(path.join(src, 'catalog.json')) ? JSON.parse(fs.readFileSync(path.join(src, 'catalog.json'), 'utf8')) : {};
for (const c of cat.characters ?? []) if (typeof c.portrait === 'string') cp(c.portrait);
console.log(`assets copied (${hd} HD textures)`);
