/** FUN_80032490: fixed-point square root, returned in Q6. */
export function ps1SqrtQ6(value: number): number {
  const word = value | 0;
  if (word === 0) return 0;
  // The GTE counts leading sign bits when a squared velocity overflows a signed word.
  const shift = (8 - Math.clz32(word < 0 ? ~word : word)) >> 1;
  const n = shift < 0 ? word << (-2 * (shift + 1)) : word >> (shift * 2);
  let x = n + 0x5d50ad, y = n - 0x5d50ad;
  for (const i of [1, 2, 3, 4, 4, 5, 6]) {
    const sign = y < 0 ? -1 : 1;
    const next = x - sign * (y >> i);
    y -= sign * (x >> i);
    x = next;
  }
  const outShift = shift + (shift < 0 ? 1 : 0) - 6;
  return outShift < 0 ? x >> -outShift : x << outShift;
}
