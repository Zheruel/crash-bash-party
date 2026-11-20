/** Pull the disc image out of a .zip (bin+cue) by streaming inflate; the result is a Blob, not one big array. */
import { Unzip, UnzipInflate, UnzipPassThrough } from 'fflate';
import { DiscError } from './bytes';

const IMAGE_RE = /\.(bin|iso|img)$/i;
const PIECE = 4 * 1024 * 1024;

export async function isZip(blob: Blob): Promise<boolean> {
  if (blob.size < 4) return false;
  const b = new Uint8Array(await blob.slice(0, 4).arrayBuffer());
  return b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5);
}

export async function extractImageFromZip(zip: Blob, onProgress?: (done: number, total: number) => void): Promise<Blob> {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let found = false;
  let finished = false;
  let failure: Error | null = null;
  const uz = new Unzip((file) => {
    if (found || !IMAGE_RE.test(file.name)) return; // skips .cue and anything else
    found = true;
    file.ondata = (err, data, final) => {
      if (err) { failure = err; return; }
      if (data.length) chunks.push(data as Uint8Array<ArrayBuffer>);
      if (final) finished = true;
    };
    file.start();
  });
  uz.register(UnzipInflate);
  uz.register(UnzipPassThrough);
  try {
    for (let o = 0; o < zip.size && !failure && !finished; o += PIECE) {
      const end = Math.min(o + PIECE, zip.size);
      uz.push(new Uint8Array(await zip.slice(o, end).arrayBuffer()), end >= zip.size);
      onProgress?.(end, zip.size);
    }
  } catch (e) {
    failure = e as Error;
  }
  if (failure) throw new DiscError('corrupt', `The zip file could not be unpacked (${failure.message}).`);
  if (!found) throw new DiscError('unsupported', 'The zip contains no .bin/.iso disc image.');
  if (!finished) throw new DiscError('corrupt', 'The zip file is truncated.');
  return new Blob(chunks);
}
