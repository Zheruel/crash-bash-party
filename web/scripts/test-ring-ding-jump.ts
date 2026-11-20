// Run with npx tsx scripts/test-ring-ding-jump.ts from web/.
import assert from 'node:assert/strict';
import { DD_S, ringDing, type RingDingData } from '../shared/games/ringDing';
import { addBody } from '../shared/physics';
import { createWorld, stepWorld } from '../shared/sim';
import { IDLE, type InputState } from '../shared/types';

// Heights above y = -16 in PCSX ReARMed (US disc, L27). Frame 0 is takeoff.
const cpu = {
  fall: 12, heights: [125, 239, 342, 434, 515, 585, 644, 692, 729, 755, 770, 774, 774,
    765, 747, 720, 684, 639, 585, 522, 450, 369, 279, 180, 72, -45, 0],
};
const light = {
  fall: 11, heights: [117, 223, 318, 402, 475, 537, 588, 628, 657, 675, 682, 682,
    676, 664, 646, 622, 592, 556, 514, 466, 412, 352, 286, 214, 136, 52, -38, 0],
};
const heavy = {
  fall: 9, heights: [115, 217, 306, 382, 445, 495, 532, 556, 567, 567,
    559, 543, 519, 487, 447, 399, 343, 279, 207, 127, 39, -57, 0],
};
const tap = {
  fall: 5, heights: [115, 190, 225, 247, 256, 256, 248, 232, 208, 176, 136, 88, 32, -32, 0],
};
const hit = {
  fall: 7, heights: [115, 217, 306, 355, 391, 414, 424, 424, 416, 400, 376,
    344, 304, 256, 200, 136, 64, -16, 0],
};
const cross = { ...IDLE, a: true };

function room(slot: number, char: number, bot = false) {
  const seats = [0, 1, 2, 3].map(s => ({ slot: s, char: s === slot ? char : 1, name: String(s), bot: s === slot && bot }));
  const w = createWorld(ringDing, seats, [], 432);
  const d = w.data as RingDingData;
  d.B = [];
  w.bodies = w.bodies.filter(b => b.kind === 'player');
  d.tb = d.tc = d.tk = 10000;
  d.rs = 13;
  const positions = [[1350, 0], [-1400, 0], [0, 1400], [0, -1400]];
  d.P.forEach((p, s) => { [p!.x, p!.z] = positions[(s - slot + 4) % 4]; });
  const p = d.P[slot]!;
  const tick = (pad: InputState | null = IDLE) => {
    const inputs: (InputState | null)[] = Array(4).fill(IDLE);
    inputs[slot] = pad;
    stepWorld(w, ringDing, inputs);
  };
  function balloon(x: number, z: number, owner: number, height: number, state = 1) {
    const bid = addBody(w, 'balloon', owner, 0, 0, 1, 1).id;
    const o = { bid, x, z, hy: height, ty: [11, 8, 9, 10][owner], ow: owner,
      angle: 0, dr: 0, da: 0, po: 0, pa: 0, st: state, tf: false, tc: slot, ot: 0 };
    d.B.push(o);
    return o;
  }
  return { w, d, p, tick, balloon };
}

type Profile = typeof cpu;
function sample({ w, d, p }: ReturnType<typeof room>, slot: number, profile: Profile, frame: number, hurt = false) {
  const touchdown = frame === profile.heights.length - 1;
  const ph = touchdown ? 0 : frame < profile.fall ? 1 : 2;
  assert.deepEqual([p.h, p.ph, d.ph[slot]], [profile.heights[frame], ph, ph], `seat ${slot} frame ${frame}`);
  assert.ok(Math.abs(w.bodies.find(b => b.id === p.bid)!.y - p.h * DD_S) < 1e-10);
  const cues = w.ev.filter(e => e.t === w.tick - 1 && e.s === slot && (e.k === 'jump' || e.k === 'land'));
  assert.deepEqual(cues.map(e => e.k), frame === 0 ? ['jump'] : touchdown && !hurt ? ['land'] : []);
  if (!hurt) assert.equal(!!p.landing, touchdown);
  assert.equal(p.jumpAt, w.tick - frame);
}

for (const [slot, char] of [0, 6, 8, 9].entries()) {
  const run = room(slot, char);
  const boots = room(slot, char);
  boots.p.pu = 0x13; boots.p.put = 240;
  const profile = char === 6 ? heavy : light;
  const start = [boots.p.x, boots.p.z];
  let takeoff: number[] = [];
  for (let frame = 0; frame < profile.heights.length; frame++) {
    const pad = frame < 13 ? cross : IDLE;
    run.tick(pad); boots.tick(pad);
    sample(run, slot, profile, frame); sample(boots, slot, profile, frame);
    assert.deepEqual([boots.p.x, boots.p.z], start);
    if (frame === 0) {
      assert.notEqual(run.p.z, 0); // carried on takeoff
      takeoff = [run.p.x, run.p.z];
    } else if (frame < profile.heights.length - 1) {
      assert.deepEqual([run.p.x, run.p.z], takeoff);
    }
  }
  assert.ok(Math.hypot(run.p.x - start[0], run.p.z) > 40); // resumes carry on touchdown
  run.tick(cross);
  assert.equal(run.p.ph, 1); // Cross interrupts script 8 on the update after touchdown
  assert.equal(run.p.landing, 0);
}

for (let slot = 0; slot < 4; slot++) {
  const run = room(slot, [6, 8, 9, 1][slot], true);
  const { d, p, tick, balloon } = run;
  p.x = p.z = 0; // isolate the CPU pad sequence on the hub
  d.P[(slot + 1) % 4]!.x = -1800;
  d.cpuRng = [944, 170];
  p.cpu!.cooldown = 55;
  const o = balloon(800, 35, slot, 1600);
  for (let attempts = 0; attempts < 20 && !p.ph; attempts++) tick(null);
  assert.equal(p.ph, 1, `CPU takeoff in seat ${slot}`);
  for (let frame = 0; frame < cpu.heights.length; frame++) {
    if (frame > 0) {
      if (slot === 3 && frame === 2) d.B.length = 0; // losing the target releases Cross without shortening the CPU arc
      Object.assign(o, { x: 800, z: 35, hy: 1600 }); // keep the real CPU target beyond pop height
      tick(null);
    }
    sample(run, slot, cpu, frame);
  }
}

{
  const run = room(0, 6);
  for (let frame = 0; frame < tap.heights.length; frame++) {
    run.tick(frame === 0 ? cross : IDLE);
    sample(run, 0, tap, frame);
  }
  for (let frame = 1; frame <= 6; frame++) {
    run.tick();
    assert.equal(run.p.landing, 6 - frame); // Koala's six visible landing updates
  }
}

{
  const run = room(0, 6);
  const { p, d, tick } = run;
  for (let frame = 0; frame < heavy.heights.length; frame++) {
    if (frame === 19) {
      const rival = d.P[1]!;
      rival.x = p.x + 75; rival.z = p.z + 50;
    }
    const x = p.x;
    tick(frame < 13 ? cross : IDLE);
    sample(run, 0, heavy, frame);
    if (frame === 19) assert.ok(p.x < x - 50, 'body contact separates the falling player');
  }
}

{
  const run = room(0, 6);
  const { p, tick, balloon } = run;
  p.pu = 0x13; p.put = 240;
  for (let frame = 0; frame < hit.heights.length; frame++) {
    if (frame === 2) balloon(p.x, p.z, 1, 800, 9);
    tick(cross);
    sample(run, 0, hit, frame, frame >= 2);
    if (frame >= 2) assert.deepEqual([p.st, p.landing, p.pu], [2, 0, 0]);
  }
}

{
  const run = room(0, 6);
  const { p, d, tick, balloon } = run;
  // A contact on the last falling update sees the height before integration.
  Object.assign(p, { ph: 2, h: 39, vv: 88 });
  const o = balloon(1350, 0, 0, 750);
  tick();
  assert.deepEqual([p.h, p.ph, o.st, d.score[0]], [-57, 2, 9, 0]);
  tick({ ...cross, b: true });
  assert.deepEqual([p.h, p.ph, d.score[0]], [0, 0, 1]);
  tick({ ...cross, b: true });
  assert.deepEqual([p.ph, p.st], [0, 0]); // touchdown did not buffer either press
}

{
  const { p, tick } = room(0, 6);
  Object.assign(p, { ph: 2, h: 0, vv: 80 }); // L27 floor probe also hits at exact height
  tick();
  assert.deepEqual([p.h, p.ph, p.landing], [0, 0, 6]);
}

{
  const { p, tick } = room(0, 6);
  Object.assign(p, { ph: 1, h: 382, vv: 13 });
  tick(cross);
  assert.deepEqual([p.h, p.vv, p.ph], [382, 0, 1]);
  tick(cross);
  assert.deepEqual([p.h, p.vv, p.ph], [382, 0, 2]);
}

console.log('PASS Ring Ding L27 takeoff, rise/fall, touchdown, cues, hover and contacts');
