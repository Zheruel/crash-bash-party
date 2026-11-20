// The seated pilot has a 28-pose steering cycle in addition to the ship's roll.
// USA 800c13ac, indexed by the physics character (also used by custom pilots).
const WORD_BASE = [0, 0x417f, 0x41ff, 0x41ff, 0x41ff, 0x407f, 0x417f, 0x41ff, 0x407f];
const ENTRY_SCRIPT: Record<number, number> = {
  0x1c: 0x19, 0x1d: 0x1a, 0x1e: 0x1c, 0x1f: 0x1d, 0x21: 0x1d, 0x24: 0x20,
};

export interface BallistixPilot {
  lean: number;
  script: number;
  frame: number;
  word?: number;
}

export function seatedPilot(frame: number): BallistixPilot {
  return { lean: 28, script: 0x19, frame };
}

function start(pilot: BallistixPilot, script: number) {
  pilot.script = script;
  pilot.frame = 0;
  delete pilot.word;
}

function advance(pilot: BallistixPilot) {
  pilot.frame++;
  delete pilot.word;
}

export function stepPilot(pilot: BallistixPilot, character: number, slot: number, steering: number,
  previous: number, next: number, idleGesture: boolean) {
  const reversed = slot === 1 || slot === 3;
  const direction = reversed ? -steering : steering;
  const shortTrack = character >= 5 && character <= 7;
  const neutral = shortTrack ? 14 : 15;
  const enter = () => {
    if (next === 0x22) return; // The winner holds the last pose until the next callback.
    if (next === 0x1c || next === 0x1d || next === 0x1f || next === 0x21) {
      // 800b62f4 snaps phases within one step of either neutral stop.
      const phase = pilot.lean;
      if (Math.abs(phase - neutral) <= 1 || Math.abs(phase - 28) <= 1 || phase === 1)
        pilot.lean = direction < 0 ? neutral : 28;
    }
    start(pilot, ENTRY_SCRIPT[next]);
  };
  const steer = () => {
    // 800b649c advances around the cycle, even when the direction reverses.
    const rest = pilot.lean > neutral ? 28 : neutral;
    if (!direction && pilot.lean === rest) { advance(pilot); return; }
    let target = rest;
    if (direction < 0) target = shortTrack ? 21 : 24;
    if (direction > 0) target = shortTrack ? 7 : 10;
    if (pilot.lean !== target) pilot.lean = pilot.lean % 28 + 1;
    pilot.word = WORD_BASE[character] + pilot.lean;
  };
  if (previous === 0x1c) {
    if (next !== 0x1e) {
      if (idleGesture && pilot.script !== 0x1b) start(pilot, 0x1b);
      steer();
    }
    if (previous !== next) enter();
    else if (!idleGesture && pilot.script === 0x1b) start(pilot, 0x19);
  } else if (previous === 0x1d || previous === 0x1f || previous === 0x21) {
    if (previous !== next) enter();
    if (next !== 0x22 && next !== 0x24) steer();
  } else if (previous === 0x1e) {
    if (previous !== next) enter();
    if (next !== 0x1c && next !== 0x22 && next !== 0x24) advance(pilot);
  } else if (previous === 0x24) advance(pilot);
}
