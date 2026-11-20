import { at2 } from './dragonDrop';

// L7 route table 800c9b94. Both statues circle the same route from different entries.
const ROUTE = [
  [1024, 1024], [384, 1792], [1280, 2816], [768, 3584],
  [512, 2560], [2304, 3584], [3328, 2304], [3584, 3328],
  [2816, 1792], [2816, 512], [3840, 1792], [2304, 1024],
  [3072, 384], [3328, 1792], [2048, 512], [768, 2048],
] as const;

type Phase = 'perched' | 'bounce' | 'rest' | 'start' | 'travel' | 'brake' | 'slam';
export interface JungleStatue {
  x: number; y: number; z: number; yaw: number; pose: number;
  vx: number; vy: number; vz: number; turn: number;
  route: number; phase: Phase; frame: number; rest: number;
}
export interface JungleStatues { actors: JungleStatue[]; released: number; timer: number }
interface TankPoint { x: number; z: number }
export interface StatueEvents {
  sound: (id: number, x: number, z: number) => void;
  slam: (x: number, z: number) => void;
  crushPickup: (x: number, y: number, z: number) => void;
}

export function initialJungleStatues(countdown: number): JungleStatues {
  const actors = [0, 13].map((route, i): JungleStatue => ({
    x: 2048, y: i === 0 ? -660 : -330, z: 2048, yaw: 0, pose: 0x4180,
    vx: 0, vy: 0, vz: 0, turn: 0, route, phase: 'perched', frame: 0, rest: 0,
  }));
  // The controller has already run once on arena frame zero.
  return { actors, released: 0, timer: 899 - countdown };
}

const signedAngle = (a: number) => (a << 20) >> 20;
const wrapShort = (n: number) => (n << 16) >> 16;

function startRoute(a: JungleStatue) {
  a.route = (a.route + 1) % ROUTE.length;
  const [x, z] = ROUTE[a.route];
  a.vx = Math.trunc((x - a.x) / 31);
  a.vz = Math.trunc((z - a.z) / 31);
  a.turn = Math.trunc(signedAngle(at2(a.vx, a.vz) + 2048 - a.yaw) / 12);
  a.phase = 'start';
  a.frame = 0;
}

function impact(a: JungleStatue, events: StatueEvents) {
  events.slam(a.x, a.z);
  events.sound(0x505, a.x, a.z);
}

function stepStatue(a: JungleStatue, tanks: readonly TankPoint[], over: boolean, events: StatueEvents) {
  let dx = 0, dz = 0;
  const frame = a.frame;
  switch (a.phase) {
    case 'perched': break;
    case 'bounce':
      a.vy += 12;
      a.y += a.vy;
      dx = a.vx;
      dz = a.vz;
      if (a.y >= 0) {
        a.y = 0;
        if (a.vy >= 37) impact(a, events);
        else events.sound(0x506, a.x, a.z);
        if (a.vy < 13) {
          a.phase = 'rest';
          a.rest = 90;
        } else {
          a.vy = Math.trunc(a.vy * -2 / 3);
          a.vx = Math.trunc(a.vx * 2 / 3);
          a.vz = Math.trunc(a.vz * 2 / 3);
        }
      }
      break;
    case 'rest':
      if (--a.rest <= 0) {
        startRoute(a);
        events.sound(0x507, a.x, a.z);
      }
      break;
    case 'start':
      if (frame === 28) { a.phase = 'travel'; a.frame = 0; break; }
      a.pose = 0x4180 + frame;
      a.frame++;
      if (frame > 16) {
        a.yaw = wrapShort(a.yaw + a.turn);
        dx = Math.trunc(a.vx * (frame - 16) / 12);
        dz = Math.trunc(a.vz * (frame - 16) / 12);
      }
      break;
    case 'travel':
      if (frame === 19) {
        a.phase = 'brake'; a.frame = 0;
        a.turn = Math.trunc(signedAngle(-a.yaw) / 12);
        break;
      }
      a.pose = 0x4080 + frame;
      a.frame++;
      dx = a.vx;
      dz = a.vz;
      break;
    case 'brake':
      if (frame === 21) {
        a.frame = 0;
        if (over) { a.phase = 'rest'; a.rest = 2970; a.pose = 0x2004; }
        else { a.phase = 'slam'; events.sound(0x504, a.x, a.z); }
        break;
      }
      a.pose = 0x4200 + Math.min(frame, 13);
      a.frame++;
      if (frame < 12) {
        a.yaw = wrapShort(a.yaw + a.turn);
        dx = Math.trunc(a.vx * (12 - frame) / 12);
        dz = Math.trunc(a.vz * (12 - frame) / 12);
      }
      break;
    case 'slam':
      if (frame === 28) {
        a.phase = 'rest'; a.rest = 150; a.pose = 0x2004;
        break;
      }
      if (frame === 17) impact(a, events);
      a.pose = 0x4000 + frame;
      a.frame++;
      break;
  }
  const x = a.x + dx, z = a.z + dz;
  if (!tanks.some(t => Math.abs(t.x - x) <= 384 && Math.abs(t.z - z) < 384)) {
    a.x = Math.max(256, Math.min(3840, x));
    a.z = Math.max(256, Math.min(3840, z));
  }
  events.crushPickup(a.x, a.y, a.z);
}

export function stepJungleStatues(state: JungleStatues, tanks: readonly TankPoint[], over: boolean, events: StatueEvents) {
  let launched = -1;
  if (state.released < 2 && --state.timer <= 0) {
    const first = state.released === 0;
    const x = first ? 1424 : 2624, z = first ? 1024 : 1088;
    if (tanks.some(t => Math.abs(t.x - x) <= 512 && Math.abs(t.z - z) < 512)) state.timer = 1;
    else {
      launched = state.released++;
      state.timer = first ? 300 : 0;
    }
  }
  for (const [index, actor] of state.actors.entries()) {
    if (index === launched) {
      actor.phase = 'bounce';
      actor.vx = index === 0 ? -30 : 30; actor.vz = -45; actor.vy = -90;
      events.sound(0x504, actor.x, actor.z);
      events.crushPickup(actor.x, actor.y, actor.z);
    } else stepStatue(actor, tanks, over, events);
  }
}

export function statueStopsShot(state: JungleStatues | undefined, x: number, z: number): boolean {
  return state?.actors.some(a => Math.abs(x - a.x) <= 224 && Math.abs(z - a.z) <= 224) ?? false;
}
