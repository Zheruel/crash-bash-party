/** Opening and validating a Crash Bash (USA) disc, and reading CRASHBSH.DAT entries from it. */
import { DiscError, Reader } from './bytes';
import { DiscImage } from './image';
import { sha256Hex } from './sha256';
import { extractImageFromZip, isZip } from './zip';

/** SCUS_945.70 as shipped on the retail USA disc. */
export const EXE_NAME = 'SCUS_945.70';
export const EXE_SIZE = 432128;
export const EXE_SHA256 = 'fd5727a18feb2a2d5a6359a55966f0266284d1e50f64ee9b8a127a97091bd516';
/** File table in the exe: 992 x {u32 sector, u32 size}, sectors are 2048-byte units inside CRASHBSH.DAT. */
export const FILE_TABLE_OFFSET = 0x3e910;
export const FILE_COUNT = 992;
const DAT_SECTOR = 2048;

export interface DatEntry {
  sector: number;
  size: number;
}

export interface DiscInfo {
  /** Stable id of this disc (exe hash); part of the cache key. */
  id: string;
  exeSha256: string;
  fileCount: number;
}

export class Disc {
  private constructor(
    private readonly image: DiscImage,
    readonly info: DiscInfo,
    readonly files: readonly DatEntry[],
    private readonly datLba: number,
    private readonly datSize: number,
  ) {}

  /** Accepts a .bin/.iso image or a .zip containing one. Throws DiscError with a player-facing message. */
  static async open(file: Blob, onProgress?: (msg: string, done: number, total: number) => void): Promise<Disc> {
    let blob = file;
    if (await isZip(blob)) blob = await extractImageFromZip(blob, (d, t) => onProgress?.('Unpacking zip', d, t));
    const image = await DiscImage.open(blob);
    const entries = await image.walk();
    const find = (name: string) => entries.find((e) => e.path.toUpperCase().endsWith('/' + name));

    const cnf = find('SYSTEM.CNF');
    if (!cnf || cnf.size > 4096) throw new DiscError('wrong-game', 'This disc has no SYSTEM.CNF, so it is not a PlayStation game disc.');
    const cnfText = new TextDecoder('ascii').decode(await image.read(cnf.lba, cnf.size));
    const boot = /BOOT\s*=\s*cdrom:\\?([^;\s]+)/i.exec(cnfText)?.[1]?.toUpperCase();
    if (boot !== EXE_NAME) {
      throw new DiscError('wrong-game', `This disc boots ${boot ?? 'an unknown executable'}, not ${EXE_NAME}. Only the North American release of Crash Bash is supported.`);
    }
    const exeEntry = find(EXE_NAME);
    if (!exeEntry) throw new DiscError('wrong-game', `${EXE_NAME} was not found on the disc.`);
    if (exeEntry.size !== EXE_SIZE) {
      throw new DiscError('wrong-game', `${EXE_NAME} has an unexpected size (${exeEntry.size}); this is not the supported Crash Bash (USA) disc.`);
    }
    const exe = await image.read(exeEntry.lba, exeEntry.size);
    const exeSha256 = sha256Hex(exe);
    if (exeSha256 !== EXE_SHA256) {
      throw new DiscError('wrong-game', `${EXE_NAME} does not match the known Crash Bash (USA) executable. A modified or different release cannot be used.`);
    }
    const dat = find('CRASHBSH.DAT');
    if (!dat) throw new DiscError('corrupt', 'CRASHBSH.DAT is missing from the disc.');

    // file table; every entry must be strictly increasing and inside the DAT
    const r = new Reader(exe);
    const files: DatEntry[] = [];
    let prev = -1;
    for (let i = 0; i < FILE_COUNT; i++) {
      const sector = r.u32(FILE_TABLE_OFFSET + i * 8);
      const size = r.u32(FILE_TABLE_OFFSET + i * 8 + 4);
      if (sector <= prev || size === 0 || sector * DAT_SECTOR + size > dat.size) {
        throw new DiscError('corrupt', `File table entry ${i} is invalid; the executable or CRASHBSH.DAT is damaged.`);
      }
      prev = sector;
      files.push({ sector, size });
    }
    return new Disc(image, { id: exeSha256.slice(0, 16), exeSha256, fileCount: FILE_COUNT }, files, dat.lba, dat.size);
  }

  /** Read one CRASHBSH.DAT entry (a few KB to a few MB; the disc itself is never fully loaded). */
  async readFile(index: number): Promise<Uint8Array> {
    const e = this.files[index];
    if (!e) throw new RangeError(`file index ${index} out of range 0..${this.files.length - 1}`);
    return this.image.read(this.datLba + e.sector, e.size); // DAT sectors are 2048-byte units, so DAT-relative sector == lba offset
  }

  /** First u16 of a file: the type id (8 = textures, 0x29 = model, 0xc/0x10/0x14 = sound bank, ...). */
  async fileType(index: number): Promise<number> {
    const e = this.files[index];
    if (!e) throw new RangeError('file index out of range');
    const b = await this.image.read(this.datLba + e.sector, Math.min(e.size, 2));
    return b.length >= 2 ? new Reader(b).u16(0) : 0;
  }
}
