/** Lazy CD image access (raw MODE1/MODE2 2352-byte sectors or cooked 2048-byte .iso) + ISO9660 walking. */
import { DiscError } from './bytes';

const DATA = 2048;
const RAW = 2352;
const MAX_READ = 128 * 1024 * 1024;

export interface IsoEntry {
  path: string;
  lba: number;
  size: number;
}

export class DiscImage {
  readonly sectors: number;
  private constructor(readonly blob: Blob, readonly stride: number, readonly headerSize: number) {
    this.sectors = Math.floor(blob.size / stride);
  }

  /** Detect the sector layout from the primary volume descriptor at sector 16. */
  static async open(blob: Blob): Promise<DiscImage> {
    const probe = async (stride: number, hdr: number): Promise<boolean> => {
      const o = 16 * stride + hdr;
      if (o + 8 > blob.size) return false;
      const b = new Uint8Array(await blob.slice(o, o + 8).arrayBuffer());
      return b[0] === 1 && String.fromCharCode(...b.subarray(1, 6)) === 'CD001';
    };
    if (await probe(DATA, 0)) return new DiscImage(blob, DATA, 0);
    if (await probe(RAW, 24)) return new DiscImage(blob, RAW, 24); // MODE2 form 1
    if (await probe(RAW, 16)) return new DiscImage(blob, RAW, 16); // MODE1
    throw new DiscError('not-a-disc', 'This file is not a readable CD image (no ISO9660 volume found). Pick the .bin, .iso or a .zip containing the .bin.');
  }

  /** Read `size` bytes of logical file data starting at sector `lba`. */
  async read(lba: number, size: number): Promise<Uint8Array> {
    const n = Math.ceil(size / DATA);
    if (!(size >= 0) || size > MAX_READ || lba < 0 || lba + n > this.sectors) throw new DiscError('corrupt', 'Disc image is truncated or damaged (read past end).');
    if (this.stride === DATA) {
      return new Uint8Array(await this.blob.slice(lba * DATA, lba * DATA + size).arrayBuffer());
    }
    const raw = new Uint8Array(await this.blob.slice(lba * RAW, (lba + n) * RAW).arrayBuffer());
    const out = new Uint8Array(size);
    for (let i = 0; i < n; i++) {
      const len = Math.min(DATA, size - i * DATA);
      out.set(raw.subarray(i * RAW + this.headerSize, i * RAW + this.headerSize + len), i * DATA);
    }
    return out;
  }

  /** All files on the volume (directories are walked, bounded in depth and count). */
  async walk(): Promise<IsoEntry[]> {
    const pvd = await this.read(16, DATA);
    const dv = new DataView(pvd.buffer, pvd.byteOffset, pvd.byteLength);
    const out: IsoEntry[] = [];
    const seen = new Set<number>();
    const rec = async (lba: number, size: number, path: string, depth: number): Promise<void> => {
      if (depth > 8 || seen.has(lba) || out.length > 20000 || size > 16 * 1024 * 1024) return;
      seen.add(lba);
      const data = await this.read(lba, Math.ceil(size / DATA) * DATA);
      const ddv = new DataView(data.buffer, data.byteOffset, data.byteLength);
      let i = 0;
      while (i < size) {
        const l = data[i];
        if (l === 0) { i = (Math.floor(i / DATA) + 1) * DATA; continue; }
        if (l < 34 || i + l > data.length) break;
        const elba = ddv.getUint32(i + 2, true);
        const esize = ddv.getUint32(i + 10, true);
        const flags = data[i + 25];
        const nlen = data[i + 32];
        if (33 + nlen > l) break;
        let name = '';
        for (let k = 0; k < nlen; k++) name += String.fromCharCode(data[i + 33 + k]);
        i += l;
        if (name === '\0' || name === '\x01') continue;
        name = name.split(';')[0].replace(/\.$/, '');
        const p = `${path}/${name}`;
        if (flags & 2) await rec(elba, esize, p, depth + 1);
        else out.push({ path: p, lba: elba, size: esize });
      }
    };
    await rec(dv.getUint32(156 + 2, true), dv.getUint32(156 + 10, true), '', 0);
    return out;
  }
}
