// Every pose word the Polar Push view asks for resolves on every rider model (no bind pose, no hidden frame).
// Mounted, on foot and MELT models for the eight stock characters and both custom riders (engine character 3 tables).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CHARACTERS, DISC_CHARACTER } from '../shared/look';
import { playerPose, poseTicks } from '../client/games/playerPose';

const ROOT = new URL('../../assets/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('catalog.json', ROOT), 'utf8'));
/** web/client/games/pushOff.ts POLAR_RIDERS */
const RIDERS: Record<string, { melt: number; foot: number }> = {
  crash: { melt: 926, foot: 942 }, coco: { melt: 924, foot: 940 }, cortex: { melt: 922, foot: 938 },
  brio: { melt: 916, foot: 932 }, tiny: { melt: 920, foot: 936 }, rilla: { melt: 912, foot: 930 },
  dingodile: { melt: 918, foot: 934 }, koala: { melt: 914, foot: 928 },
};
const DAZED_WORD = [0, 0x4100, 0x4000, 0x4100, 0x4080, 0x4000, 0x4000, 0x4000, 0x4000];

interface Model { groups: Map<number, number>; parts: Set<string> }
const models = new Map<number, Model>();
function model(id: number): Model {
  let m = models.get(id);
  if (m) return m;
  const g = JSON.parse(readFileSync(new URL(`models/${String(id).padStart(4, '0')}.gltf`, ROOT), 'utf8'));
  const groups = new Map<number, number>();
  for (const a of g.animations ?? []) {
    const match = /^group(\d+)_part\d+/.exec(a.name);
    if (match) groups.set(Number(match[1]), a.extras?.frames ?? 1e9);
  }
  m = { groups, parts: new Set((g.nodes ?? []).map((n: { name?: string }) => n.name).filter(Boolean)) };
  models.set(id, m);
  return m;
}
/** ModelInstance.nativePose: true when the word shows geometry */
function shows(m: Model, word: number): boolean {
  if ((word & 0xe000) === 0x2000) return m.parts.has('part' + ((word & 0x1fff) - 1));
  if ((word & 0xe000) !== 0x4000) return false;
  const frames = m.groups.get((word & 0x1fff) >> 7);
  return frames !== undefined && (word & 127) < frames;
}

const problems: string[] = [];
function check(who: string, id: number, engine: number, scripts: number[], words: number[] = []) {
  const m = model(id);
  for (const script of scripts) {
    const ticks = poseTicks(script, engine);
    if (!ticks) { problems.push(`${who} ${id}: no script 0x${script.toString(16)} for engine ${engine}`); continue; }
    for (let t = 0; t < ticks + 8; t++) {
      const word = playerPose(script, engine, t);
      if (word === undefined || !shows(m, word)) {
        problems.push(`${who} ${id}: script 0x${script.toString(16)} tick ${t} word 0x${word?.toString(16)}`);
        break;
      }
    }
  }
  for (const word of words) if (!shows(m, word)) problems.push(`${who} ${id}: word 0x${word.toString(16)}`);
}

const MOUNTED = [0x3a, 0x3b, 0x3d, 0x3e, 0x41, 0x44, 0x46];
const FOOT = [0x42, 0x43, 0x45, 0x3f, 0x3c, 0x47];
CHARACTERS.forEach((c, look) => {
  const engine = DISC_CHARACTER[look] ?? 3;
  const entry = catalog.characters.find((e: { id: string }) => e.id === c.id);
  const v = entry?.variants ?? {};
  const rider = RIDERS[c.id];
  const bear = v.polarBear?.model, foot = v.polarFoot?.model ?? rider?.foot, melt = v.polarMelt?.model ?? rider?.melt;
  assert(bear && foot && melt, `${c.id} has all three Polar Push models`);
  // FUN_800cde8c's stun skin is a static part on the stock models; the custom riders darken instead (pushOff.ts stunSkin)
  const stock = !!rider;
  check(c.id, bear, engine, MOUNTED, [DAZED_WORD[engine], ...(stock ? [engine === 4 ? 0x2001 : 0x2002] : [])]);
  check(c.id, foot, engine, FOOT, stock ? [0x2002] : []);
  // MELT: no zap, so no stun; frozen riders show static 0x2002 (Dingodile 0x2003) when the model has no frozen clip
  check(c.id + ' melt', melt, engine, MOUNTED.filter((s) => s !== 0x44), entry?.variants?.polarMelt?.anims?.frozen != null ? [] : [engine === 7 ? 0x2003 : 0x2002]);
});
if (problems.length) console.log(problems.join('\n'));
assert.equal(problems.length, 0);
console.log(`Polar Push pose words resolve on all ${models.size} rider models.`);
