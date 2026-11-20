// Parity test for client/disc against the Python reference decoders (assets/textures, assets/models, tools/unpack.py).
//   npm run test:disc                 sample (>=10 textures, >=10 models, 3 sound banks) + zip + raw-file parity
//   npm run test:disc -- --full       every texture set / model, all 992 files byte-compared with disc/dat
// Disc: ../disc/Crash Bash (USA).bin (override: CRASHBASH_DISC=/path/to.bin|.zip|.iso). Skips (exit 0) if absent.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Disc } from '../client/disc/disc';
import { decodeAsset } from '../client/disc/core';
import { DiscError } from '../client/disc/bytes';
import { parseT08, renderRgba, type TextureSetData } from '../client/disc/t08';
import { decodeAdpcm, type SoundBankData } from '../client/disc/sound';
import type { ModelData } from '../client/disc/t29';
import { loadDisc } from '../client/disc';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const full = process.argv.includes('--full');
const discPath = process.env.CRASHBASH_DISC ?? path.join(root, 'disc/Crash Bash (USA).bin');
if (!fs.existsSync(discPath)) { console.log(`SKIP: no disc image at ${discPath}`); process.exit(0); }

let fails = 0, checks = 0;
const ok = (name: string, cond: boolean, extra = '') => { checks++; if (!cond) { fails++; console.error(`FAIL ${name} ${extra}`); } };
const blobOf = (p: string) => fs.openAsBlob(p) as Promise<Blob>; // lazy, file-backed

function readPng(p: string): { w: number; h: number; rgba: Buffer } {
  const b = fs.readFileSync(p);
  let o = 8, w = 0, h = 0;
  const idat: Buffer[] = [];
  while (o < b.length) {
    const len = b.readUInt32BE(o), type = b.toString('ascii', o + 4, o + 8);
    if (type === 'IHDR') { w = b.readUInt32BE(o + 8); h = b.readUInt32BE(o + 12); }
    if (type === 'IDAT') idat.push(b.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    if (raw[y * (w * 4 + 1)] !== 0) throw new Error('unexpected PNG filter');
    raw.copy(out, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1));
  }
  return { w, h, rgba: out };
}

const t0 = performance.now();
const disc = await Disc.open(await blobOf(discPath));
console.log(`opened ${path.basename(discPath)} id=${disc.info.id} in ${(performance.now() - t0).toFixed(0)} ms`);

// ---- 1. raw file bytes vs extracted disc/dat (all files with --full, else a sample)
const datDir = path.join(root, 'disc/dat');
if (fs.existsSync(datDir)) {
  const names = new Map(fs.readdirSync(datDir).map((n) => [Number(n.slice(0, 4)), n]));
  const idxs = full ? [...names.keys()] : [0, 1, 2, 3, 151, 167, 293, 294, 775, 776, 901, 902, 991];
  let bad = 0;
  for (const i of idxs) {
    const exp = fs.readFileSync(path.join(datDir, names.get(i)!));
    const got = await disc.readFile(i);
    if (exp.length !== got.length || Buffer.compare(exp, got) !== 0) bad++;
  }
  ok(`raw file bytes (${idxs.length} files)`, bad === 0, `${bad} differ`);
}

// ---- 2. textures
const texIdx = full
  ? fs.readdirSync(path.join(root, 'assets/textures')).map(Number)
  : [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 30, 90, 308, 450, 775, 901];
let texCount = 0, pxTotal = 0;
for (const i of texIdx) {
  const dir = path.join(root, 'assets/textures', String(i).padStart(4, '0'));
  if (!fs.existsSync(dir)) continue;
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  const set = (await decodeAsset(disc, 'textures', i)) as TextureSetData;
  ok(`tex ${i} count`, set.textures.length === meta.textures.length && set.cluts.length === meta.cluts.length);
  for (const [k, t] of set.textures.entries()) {
    const m = meta.textures[k];
    ok(`tex ${i}/${k} meta`, t.width === m.width && t.height === m.height && t.bpp === m.bpp && t.clut === m.clut && t.frames === m.frames && t.flags === m.flags);
    if (m.png) {
      const png = readPng(path.join(dir, m.png));
      const rgba = renderRgba(t, set.cluts[t.clut]);
      ok(`tex ${i}/${k} pixels`, png.w === t.width && png.h === t.height && Buffer.compare(png.rgba, rgba) === 0);
      pxTotal += rgba.length / 4;
    }
    texCount++;
  }
}
console.log(`textures: ${texIdx.length} sets, ${texCount} textures, ${pxTotal} px compared`);

// ---- 3. models vs glTF
const modelIdx = full
  ? fs.readdirSync(path.join(root, 'assets/models')).filter((f) => f.endsWith('.gltf')).map((f) => Number(f.slice(0, 4))).filter(i => i < disc.files.length)
  : [1, 3, 5, 77, 90, 309, 772, 776, 778, 902, 904, 135, 627]; // 776/902 = characters (textures 775/901); 1 = arena
const f32 = (b: Buffer, off: number, n: number) => new Float32Array(b.buffer.slice(b.byteOffset + off, b.byteOffset + off + n * 4));
let modelCount = 0, triTotal = 0;
for (const i of modelIdx) {
  const stem = String(i).padStart(4, '0');
  const gp = path.join(root, 'assets/models', stem + '.gltf');
  let model: ModelData | null = null;
  try { model = (await decodeAsset(disc, 'model', i)) as ModelData; } catch { model = null; }
  if (!fs.existsSync(gp)) { ok(`model ${i} (no reference) not decoded`, model === null); continue; }
  if (!model) { ok(`model ${i} decoded`, false); continue; }
  const g = JSON.parse(fs.readFileSync(gp, 'utf8'));
  const bin = fs.readFileSync(path.join(root, 'assets/models', stem + '.bin'));
  const acc = (ai: number) => { const a = g.accessors[ai], v = g.bufferViews[a.bufferView]; return { a, off: v.byteOffset + (a.byteOffset ?? 0) }; };
  ok(`model ${i} part count`, g.meshes.length === model.parts.length, `${g.meshes.length} vs ${model.parts.length}`);
  ok(`model ${i} material count`, g.materials.length === model.materials.length);
  g.materials.forEach((gm: { extras: { texture_index: number; textured: boolean; texture_table: number; semi_transparent: boolean } }, k: number) => {
    const m = model!.materials[k];
    ok(`model ${i} mat ${k}`, !!m && gm.extras.textured === m.textured && gm.extras.texture_index === m.textureIndex && gm.extras.texture_table === m.textureTable && gm.extras.semi_transparent === m.semiTransparent);
  });
  for (const [pi, gm] of g.meshes.entries()) {
    const p = model.parts[pi];
    if (!p) break;
    ok(`model ${i} part ${pi} name`, gm.name === p.name);
    ok(`model ${i} part ${pi} prim count`, gm.primitives.length === p.groups.length);
    let triSum = 0;
    for (const [qi, prim] of gm.primitives.entries()) {
      const gr = p.groups[qi];
      if (!gr) break;
      const pos = acc(prim.attributes.POSITION), col = acc(prim.attributes.COLOR_0), uv = acc(prim.attributes.TEXCOORD_0);
      const n = pos.a.count;
      ok(`model ${i}/${pi}/${qi} verts/material`, n === gr.count && prim.material === gr.material);
      triSum += n / 3;
      const rp = f32(bin, pos.off, n * 3);
      let bad = 0;
      for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) if (rp[v * 3 + k] !== p.basePos[p.vertexSource[gr.start + v] * 3 + k]) bad++;
      ok(`model ${i}/${pi}/${qi} positions`, bad === 0, `${bad} differ`);
      ok(`model ${i}/${pi}/${qi} colours`, Buffer.compare(bin.subarray(col.off, col.off + n * 4), Buffer.from(p.colors.buffer, p.colors.byteOffset + gr.start * 4, n * 4)) === 0);
      const ru = f32(bin, uv.off, n * 2);
      let ub = 0;
      for (let v = 0; v < n * 2; v++) if (ru[v] !== p.uvs[gr.start * 2 + v]) ub++;
      ok(`model ${i}/${pi}/${qi} uvs`, ub === 0, `${ub} differ`);
      const tg: { POSITION: number }[] = prim.targets ?? [];
      ok(`model ${i}/${pi}/${qi} morph count`, tg.length === p.keyframes.length);
      for (const [ti, t] of tg.entries()) {
        if (!p.keyframes[ti]) continue; // a missing target was reported by the count check
        const ta = acc(t.POSITION);
        const rd = f32(bin, ta.off, n * 3);
        let mb = 0;
        for (let v = 0; v < n; v++) for (let k = 0; k < 3; k++) {
          const s = p.vertexSource[gr.start + v] * 3 + k;
          if (rd[v * 3 + k] !== p.keyframes[ti][s] - p.basePos[s]) mb++;
        }
        if (mb) { ok(`model ${i}/${pi}/${qi} morph ${ti}`, false, `${mb} differ`); break; }
      }
    }
    ok(`model ${i} part ${pi} triangles`, triSum === p.triangles && gm.extras.triangles === p.triangles && gm.extras.vertices === p.vertices);
    triTotal += triSum;
  }
  const ga = g.animations ?? [];
  ok(`model ${i} anim count`, ga.length === model.anims.length);
  for (const [ai, a] of ga.entries()) {
    const m = model.anims[ai];
    if (!m) break;
    const s = a.samplers[0];
    const ti = acc(s.input), wi = acc(s.output);
    const rt = f32(bin, ti.off, ti.a.count), rw = f32(bin, wi.off, wi.a.count);
    let wb = 0;
    for (let k = 0; k < rt.length; k++) if (rt[k] !== m.times[k]) wb++;
    ok(`model ${i} anim ${ai} name/len`, a.name === m.name && rt.length === m.times.length && rw.length === m.weights.length);
    for (let k = 0; k < rw.length; k++) if (Math.abs(rw[k] - m.weights[k]) > 1e-6) wb++;
    ok(`model ${i} anim ${ai} keys`, wb === 0, `${wb} differ`);
  }
  modelCount++;
}
console.log(`models: ${modelCount} compared, ${triTotal} triangles`);

// ---- 4. sound banks vs tools/unpack.py
const banks = full ? [167, 168, 169, 170, 272, 288, 293, 294, 303] : [167, 293, 294];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-disc-'));
try {
  for (const i of banks) {
    const names = fs.readdirSync(datDir).filter((n) => n.startsWith(String(i).padStart(4, '0')));
    const out = path.join(tmp, String(i));
    execFileSync('python3', ['-I', path.join(root, 'tools/unpack.py'), 'split', path.join(datDir, names[0]), out, '--wav'], { stdio: 'pipe' });
    const info = JSON.parse(fs.readFileSync(path.join(out, 'info.json'), 'utf8'));
    const b = (await decodeAsset(disc, 'sound', i)) as SoundBankData;
    ok(`bank ${i} counts`, b.samples.length === info.vags && b.vab.nPrograms === info.programs && b.vab.tones.length === info.tones.length);
    ok(`bank ${i} tones`, info.tones.every((t: Record<string, number>, k: number) => {
      const m = b.vab.tones[k] as unknown as Record<string, number>;
      return ['program', 'tone', 'vag', 'vol', 'pan', 'center', 'fine', 'min', 'max', 'adsr1', 'adsr2', 'mode'].every((f) => t[f] === m[f]);
    }));
    ok(`bank ${i} programs`, info.program_list.every((p: { tones: number; vol: number; pan: number }, k: number) => p.tones === b.vab.programs[k].tones && p.vol === b.vab.programs[k].vol && p.pan === b.vab.programs[k].pan));
    let adp = 0, pcm = 0, samplesN = 0;
    for (const s of b.samples) {
      const nn = String(s.index).padStart(2, '0');
      const vag = fs.readFileSync(path.join(out, `vag${nn}.vag`));
      if (Buffer.compare(vag, s.adpcm) !== 0) adp++;
      const wav = fs.readFileSync(path.join(out, `vag${nn}.wav`)).subarray(44);
      const mine = decodeAdpcm(s.adpcm);
      if (wav.length !== mine.length * 2 || Buffer.compare(wav, Buffer.from(mine.buffer, mine.byteOffset, mine.byteLength)) !== 0) pcm++;
      samplesN += mine.length;
    }
    ok(`bank ${i} adpcm bytes`, adp === 0, `${adp} differ`);
    ok(`bank ${i} pcm`, pcm === 0, `${pcm} differ`);
    const seqFiles = fs.readdirSync(out).filter((n) => n.endsWith('.seq')).sort();
    ok(`bank ${i} seq count`, seqFiles.length === b.seqs.length);
    seqFiles.forEach((n, k) => ok(`bank ${i} seq ${k}`, !!b.seqs[k] && Buffer.compare(fs.readFileSync(path.join(out, n)), b.seqs[k].raw) === 0 && b.seqs[k].events.length > 0));
    console.log(`bank ${i}: kind 0x${b.kind.toString(16)}, ${b.samples.length} samples (${samplesN} PCM frames), ${b.seqs.length} seqs`);
  }
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

// ---- 5. zip + rejection of non-matching input
const zipPath = path.join(root, 'rom/crash-bash.zip');
if (fs.existsSync(zipPath)) {
  const tz = performance.now();
  const dz = await Disc.open(await blobOf(zipPath));
  ok('zip: same disc id', dz.info.id === disc.info.id);
  const a = await dz.readFile(776), b = await disc.readFile(776);
  ok('zip: file bytes', Buffer.compare(a, b) === 0);
  console.log(`zip opened in ${(performance.now() - tz).toFixed(0)} ms`);
}
for (const [name, bytes] of [['garbage', new Uint8Array(5000)], ['empty', new Uint8Array(0)]] as const) {
  try { await Disc.open(new Blob([bytes])); ok(`reject ${name}`, false); } catch (e) { ok(`reject ${name} with DiscError`, e instanceof DiscError && e.message.length > 10); }
}
{ // a disc whose SYSTEM.CNF points elsewhere is a "wrong-game" error: patch a copy of the first sectors
  const head = new Uint8Array(await (await blobOf(discPath)).slice(0, 300 * 2352).arrayBuffer());
  const txt = new TextEncoder().encode('SCUS_945.70');
  for (let i = 0; i < head.length - txt.length; i++) if (txt.every((c, k) => head[i + k] === c) && head[i - 1] === 0x5c /* backslash */) head.set(new TextEncoder().encode('SLUS_000.00'), i);
  try { await Disc.open(new Blob([head, (await blobOf(discPath)).slice(head.length)])); ok('reject wrong game', false); } catch (e) { ok('reject wrong game', e instanceof DiscError && e.code === 'wrong-game', String(e)); }
}

// ---- 6. public API, full decode timing
const assets = await loadDisc(await blobOf(discPath), { host: 'inline', cache: false });
const st = await assets.decodeAll();
console.log(`decodeAll (inline, no cache): ${st.textures} texture sets, ${st.models} models, ${st.soundBanks} sound banks, ${st.skipped} skipped in ${(st.ms / 1000).toFixed(1)} s`);
ok('decodeAll counts', st.textures > 390 && st.models > 370 && st.soundBanks > 150);
const m = await assets.getModel(776);
const grp = m.instantiate({ textures: await assets.getTextures(775) });
ok('three: model instantiates', grp.children.length === m.data.parts.length);
ok('levels metadata', assets.levels.length === 45 && assets.levels[20].name === 'MELT PANIC');

console.log(fails ? `\n${fails} of ${checks} checks FAILED` : `\nall ${checks} checks passed`);
process.exit(fails ? 1 : 0);
