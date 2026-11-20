const AT = new Int16Array(2049);
for (let i = 0; i <= 2048; i++) AT[i] = Math.round((Math.atan(i / 2048) * 4096) / (2 * Math.PI));

/** FUN_8001463c */
export function atan2g(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  const q = (n: number, m: number) => Math.trunc(n / m);
  if (a < 0) {
    const n = -a;
    if (b >= 0) return n < b ? 0x1000 - AT[q(n * 0x800, b)] : AT[q(b * 0x800, n)] + 0xc00;
    const m = -b;
    return n < m ? AT[q(n * 0x800, m)] + 0x800 : 0xc00 - AT[q(m * 0x800, n)];
  }
  if (b < 0) {
    const m = -b;
    return a < m ? 0x800 - AT[q(a * 0x800, m)] : AT[q(m * 0x800, a)] + 0x400;
  }
  return b <= a ? 0x400 - AT[q(b * 0x800, a)] : AT[q(a * 0x800, b)];
}
