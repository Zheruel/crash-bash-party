/** Bounds-checked little-endian reads over untrusted bytes. */

export type DiscErrorCode =
  | 'not-a-disc' // not an image we can read at all
  | 'wrong-game' // a valid disc, but not Crash Bash (USA)
  | 'corrupt' // truncated / inconsistent data
  | 'unsupported'; // e.g. unreadable archive layout

/** Error with a message suitable for showing to the player. */
export class DiscError extends Error {
  constructor(readonly code: DiscErrorCode, message: string) {
    super(message);
    this.name = 'DiscError';
  }
}

/** A malformed asset file (decoders throw this; callers may skip the file). */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

export class Reader {
  readonly dv: DataView;
  constructor(readonly d: Uint8Array) {
    this.dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  }
  get length(): number {
    return this.d.length;
  }
  private chk(o: number, n: number): void {
    if (!Number.isInteger(o) || o < 0 || o + n > this.d.length) throw new FormatError(`read of ${n} at ${o} past end (${this.d.length})`);
  }
  u8(o: number): number { this.chk(o, 1); return this.d[o]; }
  u16(o: number): number { this.chk(o, 2); return this.dv.getUint16(o, true); }
  i16(o: number): number { this.chk(o, 2); return this.dv.getInt16(o, true); }
  u32(o: number): number { this.chk(o, 4); return this.dv.getUint32(o, true); }
  i32(o: number): number { this.chk(o, 4); return this.dv.getInt32(o, true); }
  /** Like u32 but returns 0 when out of range (Python `u32` helper semantics). */
  u32z(o: number): number { return o >= 0 && o + 4 <= this.d.length ? this.dv.getUint32(o, true) : 0; }
  /** Self-relative pointer: target = address of the field + value (0 = null / invalid). */
  rel(o: number): number {
    const v = this.u32z(o);
    const t = o + v;
    return v && t >= 0 && t <= this.d.length ? t : 0;
  }
  bytes(o: number, n: number): Uint8Array { this.chk(o, n); return this.d.subarray(o, o + n); }
  ascii(o: number, n: number): string {
    let s = '';
    for (const b of this.bytes(o, n)) s += String.fromCharCode(b);
    return s;
  }
}
