import assert from 'node:assert/strict';
import { malletMash, type MMData } from '../shared/games/malletMash';
import { createWorld, stepWorld } from '../shared/sim';
import { ps1SqrtQ6 } from '../shared/ps1Sqrt';

// FUN_800b7b48: a running player slides around rather than through a standing mushroom (shape radius 181 + probe 0x78) or crate (128 + 0x78).
for (const [kind, r] of [['mushroom', 181 + 0x78], ['crate', 128 + 0x78]] as const) {
  const w = createWorld(malletMash, [{ char: 0, slot: 0, name: 'P1', bot: false }], [], 5);
  const d = w.data as MMData;
  d.mu.fill(null);
  d.n = 0;
  d.spawnCd = 1e9;
  d.cr.forEach((c) => { if (c) { c.st = 2; c.c = 1e9; } });
  const P = d.p[0];
  P.x = 0; P.z = -800; P.yaw = P.hd = 2048;
  if (kind === 'mushroom') d.mu[0] = { st: 0xc, c: 1e9, x: 0, z: 0, ys: 0xc00, gold: false, bd: 0, id: 99, up: true };
  else d.cr[0] = { st: 0xc, c: 0, x: 0, z: 0, s: 0x1000, bd: 0, yaw: 0 };
  d.n = kind === 'mushroom' ? 1 : 0;
  let closest = Infinity;
  for (let t = 0; t < 60; t++) {
    stepWorld(w, malletMash, [{ x: 0, y: -1, a: false, b: false }]);
    closest = Math.min(closest, ps1SqrtQ6(P.x * P.x + P.z * P.z) >> 6);
  }
  // The push runs in the run handler, before FUN_80085d2c moves the player another 0x2d.
  assert.ok(closest >= r - 0x2d - 1 && closest < r, `${kind}: player reached ${closest} of ${r}`);
}

// A sunk mushroom (not up) is not solid.
{
  const w = createWorld(malletMash, [{ char: 0, slot: 0, name: 'P1', bot: false }], [], 5);
  const d = w.data as MMData;
  d.mu.fill(null);
  d.spawnCd = 1e9;
  d.cr.forEach((c) => { if (c) { c.st = 2; c.c = 1e9; } });
  d.mu[0] = { st: 2, c: 1e9, x: 0, z: 0, ys: 0, gold: false, bd: 0, id: 99, up: false };
  d.n = 1;
  const P = d.p[0];
  P.x = 0; P.z = -800; P.yaw = P.hd = 2048;
  for (let t = 0; t < 40; t++) stepWorld(w, malletMash, [{ x: 0, y: -1, a: false, b: false }]);
  assert.ok(P.z > 0, 'player walks over a sunk mushroom');
}

// A full CPU round still runs to a result.
{
  const w = createWorld(malletMash, [0, 1, 2, 3].map((slot) => ({ char: slot * 2, slot, name: String(slot), bot: true, level: 2 })), [], 11);
  let guard = 0;
  while (!malletMash.isOver(w) && guard++ < 4000) stepWorld(w, malletMash, []);
  assert.ok(malletMash.isOver(w));
  const d = w.data as MMData;
  assert.ok(d.p.some((p) => p.score > 0));
}
console.log('Mallet Mash solid mushrooms and crates passed.');
