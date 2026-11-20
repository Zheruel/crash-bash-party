/**
 * Type-0x29 models: static meshes + vertex-morph animation. Port of tools/t29.py (+ its glTF builder, but
 * producing typed arrays); spec in docs/formats/t29.md. Geometry stays in raw PS1 units (Y down); consumers
 * apply scale (1/1024, -1/1024, -1/1024). Input is untrusted: bad meshes are skipped, never thrown.
 */
import { FormatError, Reader } from './bytes';

const MAX_MESH_TRIS = 20000;

interface Tri {
  v: [number, number, number];
  textured: boolean;
  tex: number;
  tsel: number;
  semi: boolean;
  abr: number;
  col: number[] | null; // 9 bytes r,g,b x3
  uv: number[] | null; // 6 bytes u,v x3
}

interface Mesh {
  index: number;
  extra: boolean;
  entry: number;
  flags: number;
  vertsOff: number;
  uviOff: number;
  ntri: number;
  nvert: number;
  hdr: number[]; // 10 x int16
  pos: Int16Array; // nvert*3
  tris: Tri[];
}

interface Anim {
  group: number;
  mesh: Mesh;
  keys: Int16Array[]; // per keyframe: nvert*3
  seq: [number, number, number][]; // (keyA, keyB or -1, weight)
  rate: number;
  nrec: number;
}

// ------------------------------------------------------------------ parsing
function parseMesh(r: Reader, e: number, colours: [number, number] | null, uvs: [number, number] | null, idx: number): Mesh | null {
  const d = r.d;
  const flags = r.u32z(e);
  const verts = r.rel(e + 8), strips = r.rel(e + 0xc), uvi = r.rel(e + 0x10), texr = r.rel(e + 0x14), col = r.rel(e + 0x18);
  if (!(verts && strips && uvi && texr && col)) return null;
  const s: [number, number][] = [];
  for (let o = strips; o + 1 < d.length && d[o + 1] !== 0xff && s.length < 4096; o += 2) s.push([d[o], d[o + 1]]);
  if (!s.length) return null;
  let ntri = 0, nvert = 0;
  for (const [, c] of s) { ntri += c; nvert += c + 2; }
  if (ntri === 0 || ntri > MAX_MESH_TRIS) return null;
  const vbase = verts + 0x14; // 20-byte header: bbox min/max, centre, radius
  if (vbase + 8 * nvert > d.length || uvi + 2 * ntri > d.length || col + 2 * ntri > d.length) return null;
  const hdr: number[] = [];
  for (let i = 0; i < 10; i++) hdr.push(r.i16(verts + 2 * i));
  const pos = new Int16Array(nvert * 3);
  for (let i = 0; i < nvert; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] = r.i16(vbase + 8 * i + 2 * k);

  const tris: Tri[] = [];
  let vi = 0, t = 0, runLeft = -1, runTex = 0, texp = texr;
  for (const [flag, cnt] of s) {
    for (let k = 0; k < cnt; k++) {
      let a = vi + k, b = vi + k + 1;
      const c = vi + k + 2;
      if (k & 1) { const x = a; a = b; b = x; } // alternate winding
      // texture run list: u16 {bits0-8 tex id, 9-14 run-1, 15 table select}
      runLeft--;
      if (runLeft < 0) {
        const w = texp + 2 <= d.length ? r.u16(texp) : 0;
        texp += 2;
        runTex = w;
        runLeft = (w >> 9) & 0x3f;
      }
      const ci = r.u16(col + 2 * t);
      const ui = r.u16(uvi + 2 * t);
      const textured = !(flag & 1);
      let cs: number[] | null = null;
      const c0 = ci & 0x1fff;
      if (colours && c0 + 3 <= colours[1]) {
        cs = [];
        for (const corner of (k & 1 ? [1, 0, 2] : [0, 1, 2])) {
          const start = colours[0] + 4 * (c0 + corner);
          cs.push(d[start], d[start + 1], d[start + 2]);
        }
      }
      let uv: number[] | null = null;
      if (textured && uvs && ui + 3 <= uvs[1]) {
        uv = [];
        for (const corner of (k & 1 ? [1, 0, 2] : [0, 1, 2])) { const w = r.u16(uvs[0] + 2 * (ui + corner)); uv.push(w & 0xff, w >> 8); }
      }
      tris.push({ v: [a, b, c], textured, tex: runTex & 0x1ff, tsel: (runTex >> 15) & 1, semi: !!(ci & 0x8000), abr: (ci >> 13) & 3, col: cs, uv });
      t++;
    }
    vi += cnt + 2;
  }
  return { index: idx, extra: false, entry: e, flags, vertsOff: verts, uviOff: uvi, ntri, nvert, hdr, pos, tris };
}

function tryMesh(r: Reader, e: number, colours: [number, number] | null, uvs: [number, number] | null, idx: number): Mesh | null {
  try { return parseMesh(r, e, colours, uvs, idx); } catch { return null; }
}

export interface ParsedModel {
  meshes: Mesh[];
  anims: Anim[];
}

export function parseT29(d: Uint8Array): ParsedModel {
  const r = new Reader(d);
  const out: ParsedModel = { meshes: [], anims: [] };
  if (d.length < 0x60 || r.u16(0) !== 0x29) throw new FormatError('not a type-0x29 file');
  let colours: [number, number] | null = null;
  let uvs: [number, number] | null = null;
  const p = r.rel(0x20);
  if (p && p + 0x20 <= d.length) {
    const q = r.rel(0x24);
    const end = q > p ? q : d.length;
    colours = [p, Math.floor((end - p) / 4)];
  }
  const q = r.rel(0x24);
  if (q) {
    const nxt = [r.rel(0x28), r.rel(0x2c), r.rel(0x1c), r.rel(0x3c), r.rel(0x4c)].filter((x) => x > q);
    const end = nxt.length ? Math.min(...nxt) : d.length;
    uvs = [q, Math.floor((end - q) / 2)];
  }
  const n = Math.min(r.u32z(0x54), Math.floor((d.length - 0x60) / 0x34) + 1, 4096);
  for (let k = 0; k < n; k++) {
    const e = 0x60 + 0x34 * k;
    if (e + 0x2c > d.length) break;
    const m = tryMesh(r, e, colours, uvs, k);
    if (m) out.meshes.push(m);
  }
  // meshes outside the part table (reached through the 0x1c table at run time): strict scan
  const have = new Set(out.meshes.map((m) => m.entry));
  for (let e = 0x60; e < d.length - 0x30; e += 4) {
    if (have.has(e)) continue;
    const top = r.u32z(e) >>> 12;
    if (top !== 0x40 && top !== 0x50 && top !== 0x60 && top !== 0x70) continue;
    const m = tryMesh(r, e, colours, uvs, n + out.meshes.length);
    if (!m) continue;
    const end = m.vertsOff + 0x14 + 8 * m.nvert;
    if ((end === m.uviOff || (end < m.uviOff && m.ntri >= 4)) && m.ntri === (m.flags & 0xfff)) {
      m.extra = true;
      out.meshes.push(m);
    }
  }
  try { out.anims = parseAnims(r, out.meshes); } catch { out.anims = []; }
  return out;
}

function parseAnims(r: Reader, meshes: Mesh[]): Anim[] {
  const d = r.d;
  const out: Anim[] = [];
  const ng = r.u32z(0x40);
  const g0 = r.rel(0x44);
  if (!g0 || ng === 0 || ng > 64) return out;
  for (let g = 0; g < ng; g++) {
    const ge = g0 - 4 + 24 * g; // 24-byte descriptors: ?, tail, pool_end, nframes, ?, rate
    if (ge < 0 || ge + 24 > d.length) break;
    const T = r.u32(ge + 4), nfr = r.u32(ge + 12);
    if (T === 0 || T + 16 > d.length || nfr === 0 || nfr > 4096 || T + 16 * nfr > d.length) continue;
    const pool = r.rel(T) || r.rel(0x28); // per-group pool, else the model-level pool
    const recs: [number, number, number][] = [];
    let ok = true;
    for (let i = 0; i < nfr; i++) {
      const o = T + 16 * i;
      const a = r.rel(o + 4), b = r.rel(o + 8), w = r.i32(o + 12);
      if (!a || a >= d.length) { ok = false; break; }
      recs.push([a, b, w]);
    }
    // The descriptor's signed relative pointer addresses the target part entry minus eight.
    const mesh = meshes.find(m => m.entry === ge + 24 + r.i32(ge + 16));
    if (!ok || !pool || !mesh) continue;
    const nv = mesh.nvert, size = 20 + nv * 2;
    const keySet = new Set<number>();
    for (const [a, b] of recs) { keySet.add(a); if (b) keySet.add(b); }
    const keys = [...keySet].sort((x, y) => x - y);
    if (keys.some((k) => k + size > d.length) || keys.length > 512) continue;
    const frames: Int16Array[] = [];
    for (const k of keys) {
      const pts = new Int16Array(nv * 3);
      for (let i = 0; i < nv; i++) {
        const po = pool + 6 * (r.u16(k + 20 + 2 * i) >> 2);
        if (po + 6 > d.length) { ok = false; break; }
        pts[i * 3] = r.i16(po); pts[i * 3 + 1] = r.i16(po + 2); pts[i * 3 + 2] = r.i16(po + 4);
      }
      if (!ok) break;
      frames.push(pts);
    }
    if (!ok) continue;
    const seq: [number, number, number][] = recs.map(([a, b, w]) => [keys.indexOf(a), b ? keys.indexOf(b) : -1, w]);
    out.push({ group: g, mesh, keys: frames, seq, rate: r.u32(ge + 20), nrec: nfr });
  }
  return out;
}

// ------------------------------------------------------------------ output model
export interface MaterialData {
  textured: boolean;
  /** texture block index in the paired t08 (file index - 1); -1 if untextured */
  textureIndex: number;
  /** High bit of the texture run word; ids still resolve in the paired t08 */
  textureTable: number;
  semiTransparent: boolean;
  abr: number;
}

export interface PartData {
  name: string;
  /** part table index, or >= part count for extra meshes found by scanning */
  index: number;
  extra: boolean;
  fileOffset: number;
  flags: number;
  triangles: number;
  vertices: number;
  bbox: number[];
  bboxCentreRadius: number[];
  /** per output vertex (3 per triangle, grouped by material): source vertex in the mesh */
  vertexSource: Uint16Array;
  /** static pose, int16 x,y,z per source vertex */
  basePos: Int16Array;
  /** RGBA8 per output vertex (raw PS1 colour, 128 is neutral for textured polygons) */
  colors: Uint8Array;
  /** normalised by the paired texture size; v=0 is the top row */
  uvs: Float32Array;
  /** draw ranges (in output vertices) per material */
  groups: { material: number; start: number; count: number }[];
  /** morph keyframe absolute positions (int16 x,y,z per source vertex) */
  keyframes: Int16Array[];
}

export interface AnimData {
  name: string;
  group: number;
  /** index into `parts` */
  part: number;
  /** first keyframe of this clip inside the part's `keyframes` */
  keyOffset: number;
  frames: number;
  assumedFps: number;
  rateField: number;
  times: Float32Array;
  /** times.length * part.keyframes.length weights */
  weights: Float32Array;
}

export interface ModelData {
  /** scale to apply to the root: x/1024, -y/1024, -z/1024 */
  scale: number;
  parts: PartData[];
  materials: MaterialData[];
  anims: AnimData[];
}

const partName = (m: Mesh) => (m.extra ? `extra_${m.entry.toString(16)}` : `part${m.index}`);

/**
 * texSizes[i] = [w,h] of texture block i of the paired t08 (null if unavailable); used to normalise UVs
 * (256x256 is assumed when a texture is missing, as in the Python exporter).
 */
export function decodeT29(d: Uint8Array, texSizes: ([number, number] | null)[] = []): ModelData | null {
  const info = parseT29(d);
  if (!info.meshes.length) return null;
  const materials: MaterialData[] = [];
  const matTex: ([number, number] | undefined)[] = [];
  const matIdx = new Map<string, number>();
  const material = (t: Tri): number => {
    const key = `${t.textured ? 1 : 0}|${t.textured ? t.tex : -1}|${t.textured ? t.tsel : 0}|${t.semi ? 1 : 0}|${t.semi ? t.abr : 0}`;
    let i = matIdx.get(key);
    if (i === undefined) {
      i = materials.length;
      matIdx.set(key, i);
      materials.push({ textured: t.textured, textureIndex: t.textured ? t.tex : -1, textureTable: t.textured ? t.tsel : 0, semiTransparent: t.semi, abr: t.semi ? t.abr : 0 });
      matTex[i] = t.textured ? (texSizes[t.tex] ?? undefined) : undefined;
    }
    return i;
  };

  const animsByMesh = new Map<number, Anim[]>();
  for (const a of info.anims) { const l = animsByMesh.get(a.mesh.index) ?? []; l.push(a); animsByMesh.set(a.mesh.index, l); }

  const parts: PartData[] = [];
  const animOut: AnimData[] = [];
  for (const m of info.meshes) {
    const byMat = new Map<number, Tri[]>();
    for (const t of m.tris) { const mi = material(t); const l = byMat.get(mi) ?? []; l.push(t); byMat.set(mi, l); }
    const total = m.tris.length * 3;
    const vertexSource = new Uint16Array(total);
    const colors = new Uint8Array(total * 4);
    const uvs = new Float32Array(total * 2);
    const groups: PartData['groups'] = [];
    let o = 0;
    for (const mi of [...byMat.keys()].sort((a, b) => a - b)) {
      const start = o;
      const [tw, th] = matTex[mi] ?? [256, 256];
      for (const t of byMat.get(mi)!) {
        for (let j = 0; j < 3; j++, o++) {
          vertexSource[o] = t.v[j];
          if (t.col) {
            for (let q = 0; q < 3; q++) colors[o * 4 + q] = t.col[j * 3 + q];
          } else colors[o * 4] = colors[o * 4 + 1] = colors[o * 4 + 2] = 255;
          colors[o * 4 + 3] = 255;
          if (t.textured && t.uv) { uvs[o * 2] = t.uv[j * 2] / tw; uvs[o * 2 + 1] = t.uv[j * 2 + 1] / th; }
        }
      }
      groups.push({ material: mi, start, count: o - start });
    }
    const ans = animsByMesh.get(m.index);
    const keyframes = ans ? ans.flatMap((a) => a.keys) : [];
    const pi = parts.length;
    parts.push({
      name: partName(m), index: m.index, extra: m.extra, fileOffset: m.entry, flags: m.flags, triangles: m.ntri, vertices: m.nvert,
      bbox: m.hdr.slice(0, 6), bboxCentreRadius: m.hdr.slice(6, 10), vertexSource, basePos: m.pos, colors, uvs, groups, keyframes,
    });
    if (ans) {
      const K = keyframes.length;
      let off = 0;
      for (const an of ans) {
        const times = new Float32Array(an.seq.length);
        const weights = new Float32Array(an.seq.length * K);
        an.seq.forEach(([a, b, w], i) => {
          const f = b >= 0 ? Math.max(0, Math.min(1, w / 4096)) : 0;
          weights[i * K + off + a] += 1 - f;
          if (b >= 0) weights[i * K + off + b] += f;
          times[i] = i / 30;
        });
        animOut.push({ name: `group${an.group}_${partName(m)}`, group: an.group, part: pi, keyOffset: off, frames: an.nrec, assumedFps: 30, rateField: an.rate, times, weights });
        off += an.keys.length;
      }
    }
  }
  return { scale: 1 / 1024, parts, materials, anims: animOut };
}
