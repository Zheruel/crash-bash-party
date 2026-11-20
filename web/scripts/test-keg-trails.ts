import assert from 'node:assert/strict';
import { kegKaboom, stepKegResultObjects, type KKData } from '../shared/games/kegKaboom';
import { cloneWorld, createWorld, stepWorld } from '../shared/sim';
import { IDLE } from '../shared/types';
import { discStereo } from '../client/shell/discStereo';

const seats = [8, 9, 0, 2].map((char, slot) => ({ char, slot, bot: false, name: String(slot) }));
for (const slot of [0, 1]) {
  const w = createWorld(kegKaboom, seats, [], 9);
  const d = w.data as KKData;
  const pads = seats.map(s => s.slot === slot ? { ...IDLE, x: 1, b: true } : IDLE);
  stepWorld(w, kegKaboom, pads);
  const n = d.o.find(o => o.t === 2 && o.own === slot);
  assert.ok(n?.t === 2);
  assert.equal(n.yaw, d.p[slot]!.yaw);
  assert.equal(n.vy, 0);
  assert.equal(n.y, -200);
  const terminal = cloneWorld(w);
  for (let i = 0; i < 6; i++) stepWorld(w, kegKaboom, []);
  assert.equal(n.y, 0);
  assert.equal(n.vy, 0);
  assert.equal(n.yaw, terminal.data.o.find((o: { id: number }) => o.id === n.id).yaw);
}

// At verdict a spark advances into a keg. The arena shows the late two points
// and counts the digits up, while the authoritative result retains a draw.
const end = createWorld(kegKaboom, seats, [], 71);
const data = end.data as KKData;
Object.assign(data, { over: true, winner: -1, kt: 999, pt: 999, g: 2800 });
end.tick = 2699;
data.o = [
  { t: 1, x: 0, z: 0, id: 71, sc: 6000, gr: 0, hit: 0, kind: 0, claim: -23, sl: 0, born: 12 },
  { t: 5, x: -310, z: 0, id: 72, tx: 20, tz: 0, st: 0, life: 15, own: 0, born: 40 },
];
const copy = cloneWorld(end);
const d = copy.data as KKData;
stepKegResultObjects(copy, false);
assert.equal(d.p[0]!.score, 2);
assert.equal(d.p[0]!.fuse, 10);
assert.equal(d.p[0]!.fuseP, 0);
assert.equal(d.o[0].t, 1);
assert.equal(copy.ev.filter(e => e.k === 'pop').length, 1);
stepKegResultObjects(copy, false);
assert.equal(d.o.some(o => o.t === 1), false);
assert.equal(copy.ev.filter(e => e.k === 'boom').length, 1);
assert.equal(d.p[0]!.fuseStart, 2801);
const resumed = cloneWorld(copy);
for (let i = 0; i < 50; i++) {
  stepKegResultObjects(copy, false);
  stepKegResultObjects(resumed, false);
}
assert.deepEqual(copy, resumed);
assert.equal(d.p[0]!.fuseP, 0);
assert.equal(d.shown![0], 2);
assert.equal(data.p[0]!.score, 0);
assert.equal(data.shown![0], 0);
assert.equal(data.winner, -1);
assert.equal(data.o.length, 2);

// A draw keeps the keg spawner working. Winner entry locks it on that tick.
for (const won of [false, true]) {
  const w = cloneWorld(end), d = w.data as KKData;
  d.o = []; d.kt = 0;
  stepKegResultObjects(w, won);
  assert.equal(d.o.some(o => o.t === 1), !won);
}
// FUN_800b928c includes the two X edges and excludes the two Z edges.
for (const dx of [-257, -256, 0, 256, 257]) {
  for (const dz of [-256, -255, 0, 255, 256]) {
    const w = cloneWorld(end), d = w.data as KKData;
    const p = d.p[0]!;
    d.o = [{ t: 4, id: 1, x: p.x + dx, z: p.z + dz, y: -41, vy: -40, ch: 1, born: 0 }];
    stepKegResultObjects(w, false);
    const claimed = Math.abs(dx) <= 256 && Math.abs(dz) < 256;
    assert.equal(p.shock, Number(claimed));
    assert.equal(d.o.length, claimed ? 0 : 1);
  }
}
// L30: seat 0's spark finds seat 1's 16-tick powder. The new owner already has a four-point combo.
const crossed = createWorld(kegKaboom, seats, [], 19);
const cross = crossed.data as KKData;
cross.p[1]!.combo = 4;
cross.p[1]!.lay = 15;
cross.o = [
  { t: 5, id: 50, x: 0, z: 0, tx: 0, tz: 0, st: -7, life: 15, own: 0, born: 0 },
  { t: 2, id: 51, x: 128, y: 0, z: 0, vy: 0, own: 1, life: 16, born: 0 },
  { t: 1, id: 52, x: 200, z: 0, sc: 6000, gr: 0, hit: 0, kind: 0, claim: -23, sl: 0, born: 0 },
];
const spark = cross.o[0];
assert.ok(spark.t === 5);
const nativePath = [0, 20, 40, 60, 80, 128, 128, 128, 128, 128, 128, 128];
for (const [tick, x] of nativePath.entries()) {
  stepWorld(crossed, kegKaboom, []);
  assert.deepEqual([spark.own, spark.sc, spark.x, spark.z], [1, 2116, x, 0]);
  assert.deepEqual(cross.p[1]!.fuseOrigin, [x, 0]);
  if (tick) assert.deepEqual(cross.p[1]!.fuseMixOrigin, [nativePath[tick - 1], 0]);
  assert.deepEqual([cross.p[0]!.score, cross.p[0]!.fuse, cross.p[1]!.score, cross.p[1]!.fuse], [0, 0, 6, 10]);
}
// Settled left/right SPU voice registers, divided by their 129-unit register step.
const camera = { x: 0, y: 0, z: 3736, ty: -272, tz: -1904, pitch: 424, H: 512 };
for (const [x, z, left, right] of [[-2048, 0, 82, 30], [0, 0, 91, 91], [2048, 0, 30, 82], [0, -1536, 95, 95], [0, 2048, 60, 60], [8192, 0, 0, 0]]) {
  assert.deepEqual(discStereo(camera, x, 0, z).map(g => Math.round(g * 127)), [left, right]);
}
console.log('Keg powder, terminal chains, crossed trails, stereo levels and snapshot replay passed.');
