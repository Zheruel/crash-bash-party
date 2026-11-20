/** three.js / WebAudio views over decoded payloads. */
import * as THREE from 'three';
import { renderRgba, type TextureData, type TextureSetData } from './t08';
import type { AnimData, MaterialData, ModelData, PartData } from './t29';
import { decodeAdpcm, type SampleData, type SeqData, type SoundBankData, type VabData } from './sound';

// ------------------------------------------------------------------ textures
export class DiscTexture {
  private rgbaCache = new Map<number, Uint8Array>();
  private texCache = new Map<number, THREE.DataTexture>();
  constructor(readonly data: TextureData, private readonly cluts: Uint16Array[]) {}
  get index() { return this.data.index; }
  get width() { return this.data.width; }
  get height() { return this.data.height; }
  /** RGBA8, row-major, top row first; palette colour 0 has alpha 0. `clut` overrides the texture's own palette. */
  rgba(clut: number = this.data.clut): Uint8Array {
    let r = this.rgbaCache.get(clut);
    if (!r) {
      const pal = this.cluts[clut];
      if (!pal || pal.length !== (this.data.bpp === 8 ? 256 : 16)) throw new RangeError(`CLUT ${clut} is not compatible with texture ${this.index}`);
      r = renderRgba(this.data, pal);
      this.rgbaCache.set(clut, r);
    }
    return r;
  }
  /** Nearest-filtered DataTexture (cached per CLUT); null for empty textures. Uv v=0 is the top row. */
  texture(clut: number = this.data.clut): THREE.DataTexture | null {
    if (!this.width || !this.height) return null;
    let t = this.texCache.get(clut);
    if (!t) {
      t = new THREE.DataTexture(this.rgba(clut) as Uint8Array<ArrayBuffer>, this.width, this.height, THREE.RGBAFormat, THREE.UnsignedByteType);
      t.magFilter = t.minFilter = THREE.NearestFilter;
      t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      t.generateMipmaps = false;
      t.colorSpace = THREE.SRGBColorSpace;
      t.name = `tex${this.index}`;
      t.needsUpdate = true;
      this.texCache.set(clut, t);
    }
    return t;
  }
  dispose() { for (const t of this.texCache.values()) t.dispose(); this.texCache.clear(); }
}

export class TextureSet {
  readonly textures: DiscTexture[];
  constructor(readonly fileIndex: number, readonly data: TextureSetData) {
    this.textures = data.textures.map((t) => new DiscTexture(t, data.cluts));
  }
  get length() { return this.textures.length; }
  get(i: number): DiscTexture | undefined { return this.textures[i]; }
  dispose() { for (const t of this.textures) t.dispose(); }
}

// -------------------------------------------------------------------- models
export interface InstantiateOptions {
  /** paired texture set; if omitted, textured materials render with vertex colours only */
  textures?: TextureSet;
  /** shared material overrides, e.g. unlit/lit; default MeshBasicMaterial with vertexColors */
  materialFactory?: (m: MaterialData, map: THREE.Texture | null) => THREE.Material;
}

export class DiscModel {
  readonly clips: THREE.AnimationClip[];
  private geoms: THREE.BufferGeometry[];
  constructor(readonly fileIndex: number, readonly data: ModelData) {
    this.geoms = data.parts.map(partGeometry);
    this.clips = data.anims.map((a) => animClip(a, data.parts[a.part]));
  }
  get geometries(): readonly THREE.BufferGeometry[] { return this.geoms; }
  /** Index of the paired t08 texture set (the preceding file). */
  get textureSetIndex() { return this.fileIndex - 1; }

  /**
   * A new Group: one Mesh per part (named like the part), geometry shared, in PS1 units under a root that
   * scales by 1/1024 and flips Y/Z to Y-up. Play `clips` with an AnimationMixer on the returned Group.
   */
  instantiate(opts: InstantiateOptions = {}): THREE.Group {
    const mats = this.data.materials.map((m) => {
      const tex = m.textured && !m.textureTable ? opts.textures?.get(m.textureIndex)?.texture() ?? null : null;
      if (opts.materialFactory) return opts.materialFactory(m, tex);
      return new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, map: tex, alphaTest: tex ? 0.5 : 0, transparent: m.semiTransparent, name: m.textured ? `tex${m.textureIndex}` : 'untextured',
      });
    });
    const root = new THREE.Group();
    root.name = `model${this.fileIndex}`;
    const s = this.data.scale;
    root.scale.set(s, -s, -s);
    this.geoms.forEach((g, i) => {
      const mesh = new THREE.Mesh(g, mats);
      mesh.name = this.data.parts[i].name;
      root.add(mesh);
    });
    root.userData.materials = mats;
    return root;
  }
  dispose() { for (const g of this.geoms) g.dispose(); }
}

function partGeometry(p: PartData): THREE.BufferGeometry {
  const n = p.vertexSource.length;
  const expand = (src: Int16Array, base?: Int16Array): Float32Array => {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const s = p.vertexSource[i] * 3;
      for (let k = 0; k < 3; k++) out[i * 3 + k] = src[s + k] - (base ? base[s + k] : 0);
    }
    return out;
  };
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(expand(p.basePos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(p.colors, 4, true));
  g.setAttribute('uv', new THREE.BufferAttribute(p.uvs, 2));
  for (const gr of p.groups) g.addGroup(gr.start, gr.count, gr.material);
  if (p.keyframes.length) {
    g.morphAttributes.position = p.keyframes.map((kf) => new THREE.BufferAttribute(expand(kf, p.basePos), 3));
    g.morphTargetsRelative = true;
  }
  g.name = p.name;
  g.userData = { triangles: p.triangles, bbox: p.bbox };
  return g;
}

function animClip(a: AnimData, part: PartData): THREE.AnimationClip {
  const track = new THREE.NumberKeyframeTrack(`${part.name}.morphTargetInfluences`, Array.from(a.times), Array.from(a.weights));
  return new THREE.AnimationClip(a.name, -1, [track]);
}

// --------------------------------------------------------------------- sound
export class SoundSample {
  private pcmCache: Int16Array | null = null;
  constructor(readonly data: SampleData) {}
  get index() { return this.data.index; }
  get loopStart() { return this.data.loopStart; }
  get loops() { return this.data.loops; }
  /** 16-bit mono PCM (decoded lazily, then cached). */
  pcm(): Int16Array { return (this.pcmCache ??= decodeAdpcm(this.data.adpcm)); }
  /**
   * The sample rate is not stored per sample (it comes from the tone's pitch); 22050 Hz matches the
   * Python tooling. Returns null for empty samples.
   */
  audioBuffer(ctx: BaseAudioContext, sampleRate = 22050): AudioBuffer | null {
    const pcm = this.pcm();
    if (!pcm.length) return null;
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    const ch = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    buf.copyToChannel(ch, 0);
    return buf;
  }
}

export class SoundBank {
  readonly samples: SoundSample[];
  constructor(readonly fileIndex: number, readonly data: SoundBankData) {
    this.samples = data.samples.map((s) => new SoundSample(s));
  }
  get kind() { return this.data.kind; }
  /** parsed Sony VAB: programs, tones (tone -> sample, note range, ADSR) */
  get vab(): VabData { return this.data.vab; }
  /** parsed Sony SEQ sequences (music banks only) */
  get seqs(): SeqData[] { return this.data.seqs; }
  audioBuffer(ctx: BaseAudioContext, sample: number, sampleRate?: number): AudioBuffer | null {
    return this.samples[sample]?.audioBuffer(ctx, sampleRate) ?? null;
  }
  /** all samples as AudioBuffers (null entries for empty samples) */
  audioBuffers(ctx: BaseAudioContext, sampleRate?: number): (AudioBuffer | null)[] {
    return this.samples.map((s) => s.audioBuffer(ctx, sampleRate));
  }
}
