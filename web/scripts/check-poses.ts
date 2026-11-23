// Static T-pose checker. For every game it lists the pose sources that can reach a player model and resolves them against
// each character's real model, using the same rules as crash.ts ModelInstance (nativePose / play / parts):
//   - POSES / POLAR_REFLECTION_POSES script ids referenced by the game's files, every word of every track
//   - per-character word tables declared in the game's client files (POGO_HOP, WIN_POSES, LAND_POSE, ...)
//   - kit roles (idle/run/jump/hit/action/win/lose + per-game roles) against ref.anims
//   - model refs in assets/catalog.json + assets/stages/*.json (variants, riders, karts, carried models ...)
//
//   cd web && npx tsx scripts/check-poses.ts [--verbose]
//
// ERROR rows (exit 1): a word that no model of the game can resolve, a custom character missing a role the game asks for,
// a broken ref (missing file, clip index out of range, missing part). WARN rows are informational: words past the frame
// table (the disc draws nothing, the model hides) and stock characters lacking a role (the kit keeps the last pose).
// Custom characters (big-stein, top-g) use engine character 3 (Cortex) tables, but their models carry named clips only,
// so words never resolve on them and every state must fall back to a role.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARACTERS, DISC_CHARACTER } from '../shared/look';
import { POGO_HOP, POLAR_REFLECTION_POSES, POSES } from '../client/games/playerPoseData';

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = path.resolve(webDir, '../assets');
const verbose = process.argv.includes('--verbose');

// ---------------------------------------------------------------- catalog + models
interface Ref { model: number; anims?: Record<string, number>; parts?: string[]; variants?: Record<string, Ref>; id?: string; extra?: Ref[] }
const catalog = JSON.parse(fs.readFileSync(path.join(assets, 'catalog.json'), 'utf8')) as { characters: Ref[]; arenas: Record<string, Ref>; props: Record<string, Ref> };
const stageDir = path.join(assets, 'stages');
for (const f of fs.readdirSync(stageDir).filter((x) => x.endsWith('.json'))) {
  const j = JSON.parse(fs.readFileSync(path.join(stageDir, f), 'utf8'));
  Object.assign(catalog.arenas, j.arenas ?? {});
  Object.assign(catalog.props, j.props ?? {});
}

interface Info { clips: { name: string; frames?: number }[]; groups: Map<number, { clip: number; frames?: number }>; parts: Set<string> }
const infoCache = new Map<number, Info | null>();
function info(model: number): Info | null {
  if (infoCache.has(model)) return infoCache.get(model)!;
  const file = path.join(assets, 'models', String(model).padStart(4, '0') + '.gltf');
  let r: Info | null = null;
  if (fs.existsSync(file)) {
    const g = JSON.parse(fs.readFileSync(file, 'utf8'));
    const clips = (g.animations ?? []).map((a: any) => ({ name: a.name as string, frames: a.extras?.frames as number | undefined }));
    const groups = new Map<number, { clip: number; frames?: number }>();
    clips.forEach((c: { name: string; frames?: number }, i: number) => {
      const m = /^group(\d+)_(part\d+)/.exec(c.name);
      if (m) groups.set(Number(m[1]), { clip: i, frames: c.frames });
    });
    const parts = new Set<string>();
    for (const n of [...(g.nodes ?? []), ...(g.meshes ?? [])]) if (/^part\d+$/.test(n.name)) parts.add(n.name);
    r = { clips, groups, parts };
  }
  infoCache.set(model, r);
  return r;
}

type Verdict = 'ok' | 'hidden' | 'bad';
/** crash.ts ModelInstance.nativePose */
function resolveWord(ref: Ref, word: number): Verdict {
  const inf = info(ref.model);
  if (!inf) return 'bad';
  if ((word & 0xe000) === 0x2000) return ref.parts && inf.parts.has('part' + ((word & 0x1fff) - 1)) ? 'ok' : 'bad';
  const g = inf.groups.get((word & 0x1fff) >> 7);
  if (!g || (word & 0xe000) !== 0x4000) return 'bad';
  return typeof g.frames === 'number' && (word & 127) >= g.frames ? 'hidden' : 'ok';
}
const hasRole = (ref: Ref, role: string) => { const i = ref.anims?.[role]; const inf = info(ref.model); return i != null && !!inf && i < inf.clips.length; };

// ---------------------------------------------------------------- characters
const customIds = new Set(['big-stein', 'top-g']);
const chars = CHARACTERS.map((c, i) => ({ id: c.id, idx: i, engine: DISC_CHARACTER[i] ?? 1, custom: customIds.has(c.id), entry: catalog.characters.find((e) => e.id === c.id)! }));

// ---------------------------------------------------------------- per-game model sources and files
interface Source { label: string; ref(c: (typeof chars)[number]): Ref | undefined }
const base: Source = { label: 'base', ref: (c) => c.entry };
const variant = (v: string): Source => ({ label: v, ref: (c) => c.entry?.variants?.[v] });
const prop = (fmt: (id: string) => string): Source => ({ label: fmt('<id>'), ref: (c) => catalog.props[fmt(c.id)] });
const GAMES: Record<string, { files: string[]; sources: Source[] }> = {
  ballDefence: { files: ['ballDefence', 'ballDefenceResult', 'ballDefenceAudio'], sources: [prop((i) => `bdPilot.${i}`), base] },
  pushOff: { files: ['pushOff', 'polarReflection', 'polarFx', 'polarItemEmitter'], sources: [variant('polarBear'), variant('polarFoot'), variant('polarMelt'), base] },
  tilePainter: { files: ['tilePainter'], sources: [variant('pogo')] },
  tankArena: { files: ['tankArena', 'tankShell'], sources: [variant('tank')] },
  crateToss: { files: ['crateToss', 'crateTossResult'], sources: [base] },
  dashRace: { files: ['dashRace', 'dashRaceResult'], sources: [prop((i) => `dashRace.kart.${i}`), prop((i) => `dashRace.sea.${i}`), base] },
  ringDing: { files: ['ringDing'], sources: [prop((i) => `rdRider_${i}`), base] },
  dragonDrop: { files: ['dragonDrop'], sources: [prop((i) => `ddChar_${i}`), prop((i) => `rdRider_${i}`)] },
  malletMash: { files: ['malletMash'], sources: [prop((i) => `mmMallet_${i}`), base] },
  kegKaboom: { files: ['kegKaboom', 'kegKaboomResult'], sources: [prop((i) => `kkCarry_${i}`), base] },
};
const SHARED_FILE: Record<string, string> = { ballDefence: 'ballDefence', pushOff: 'pushOff', tilePainter: 'tilePainter', tankArena: 'tankArena', crateToss: 'crateToss', dashRace: 'dashRace', ringDing: 'ringDing', dragonDrop: 'dragonDrop', malletMash: 'malletMash', kegKaboom: 'kegKaboom' };

/** refs of a game that carry groupN clips, i.e. that nativePose words can address */
const wordSources = (sources: Source[], c: (typeof chars)[number]) => sources.map((x) => x.ref(c)).filter((r): r is Ref => !!r && (info(r.model)?.groups.size ?? 0) > 0);
const ROLES = new Set(['idle', 'run', 'jump', 'hit', 'action', 'win', 'lose', 'hop', 'taunt', 'spin', 'carry', 'carryRun', 'lift', 'throw', 'carryJump']);
const read = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');

let errors = 0, warns = 0;
const rows: string[][] = [];
const note = (level: 'ERROR' | 'WARN', game: string, what: string, who: string, why: string) => {
  rows.push([level, game, what, who, why]);
  if (level === 'ERROR') errors++; else warns++;
};
const charLabel = (c: (typeof chars)[number]) => c.id + (c.custom ? '*' : '');

for (const [game, def] of Object.entries(GAMES)) {
  const texts = [...def.files.map((f) => read(path.join(webDir, 'client/games', f + '.ts'))), read(path.join(webDir, 'shared/games', SHARED_FILE[game] + '.ts'))].join('\n');

  // ---- 1. script ids -> POSES tracks, every word
  // script ids only on lines that name a script / pose call / state constant, so unrelated small hex literals are ignored
  const ctxLines = texts.split('\n').map((l) => l.replace(/\/\/.*$/, '')).filter((l) => /script|playerPose|dashKartPose|poseTicks|\bS_[A-Z_]+\s*=|Pose\(/i.test(l));
  const hex = new Set(ctxLines.flatMap((l) => [...l.matchAll(/\b0x([0-9a-f]{1,2})\b/gi)].map((m) => parseInt(m[1], 16))));
  const scripts = [...hex].filter((s) => POSES[s] || POLAR_REFLECTION_POSES[s]).sort((a, b) => a - b);
  for (const s of scripts) for (const c of chars) {
    for (const table of [POSES[s], POLAR_REFLECTION_POSES[s]]) {
      const track = table?.[c.engine - 1];
      if (!track) continue;
      const srcs = wordSources(def.sources, c);
      if (!srcs.length) continue; // named-clip models (custom base rig): posed by role only, see roles below
      let bad = 0, hidden = 0, first = -1;
      for (let i = 2; i < track.length; i += 3) for (let k = 0; k < track[i + 1]; k++) {
        const w = track[i] + k * track[i + 2];
        const verdicts = srcs.map((r) => resolveWord(r, w));
        if (!verdicts.includes('ok')) { if (verdicts.includes('hidden')) hidden++; else { bad++; if (first < 0) first = w; } }
      }
      if (bad) note('ERROR', game, `script 0x${s.toString(16)}`, charLabel(c), `${bad} words unresolved on [${def.sources.map((x) => x.label).join('|')}] (first 0x${first.toString(16)})`);
      else if (hidden) note('WARN', game, `script 0x${s.toString(16)}`, charLabel(c), `${hidden} words past the frame table (model hides)`);
    }
  }

  // ---- 2. per-character word tables declared in the game's client files
  for (const m of texts.matchAll(/(?:export )?const ([A-Z_0-9]*(?:POSE|WORD|CHEER|HOP|LOOP|LAND)[A-Z_0-9]*)(?:: [^=]+)? = (\[[\s\S]*?\n?\])(?: as const)?;/g)) {
    let val: unknown;
    try { val = new Function(`return ${m[2]}`)(); } catch { continue; }
    if (!Array.isArray(val) || (val.length !== 8 && val.length !== 9)) continue;
    const off = val.length === 9 ? 0 : 1; // 9 entries: indexed by engine char, entry 0 unused
    val.forEach((entry, i) => {
      const engine = i + off;
      if (engine < 1 || engine > 8) return;
      const flat: number[] = Array.isArray(entry) ? entry.filter((n): n is number => typeof n === 'number') : [entry as number];
      const words = flat.filter((n) => n >= 0x2000 && n < 0x6000);
      if (!words.length) return;
      for (const c of chars.filter((x) => x.engine === engine && !x.custom)) {
        const srcs = wordSources(def.sources, c);
        if (!srcs.length) continue;
        const lenHint = Array.isArray(entry) && typeof entry[1] === 'number' && entry[1] < 128 ? entry[1] : 1; // [first, length, ...] rows
        const probe = lenHint > 1 ? [words[0], words[0] + lenHint - 1] : words;
        const badW = probe.filter((w) => !srcs.some((r) => resolveWord(r, w) !== 'bad'));
        if (badW.length) note('ERROR', game, `table ${m[1]}`, charLabel(c), `word 0x${badW[0].toString(16)} unresolved on [${def.sources.map((x) => x.label).join('|')}]`);
      }
    });
  }

  // ---- 3. roles the game asks for. kit.ts forces win/lose/idle once the round is over and 'hit' after Actor.hit();
  // everything else comes from the game's own role expressions. A ref that cannot play 'idle' stays in bind pose.
  const needed = new Set(['idle', 'win', 'lose']);
  if (/\.hit\(/.test(texts)) needed.add('hit');
  for (const l of texts.split('\n').filter((x) => /role|\.play\(/.test(x))) for (const m of l.matchAll(/'([A-Za-z]+)'/g)) if (ROLES.has(m[1])) needed.add(m[1]);
  for (const c of chars) for (const src of def.sources) {
    const ref = src.ref(c);
    if (!ref) continue;
    const inf = info(ref.model);
    if (inf?.clips.length && !hasRole(ref, 'idle')) { note('ERROR', game, `roles on ${src.label}`, charLabel(c), `no idle clip: createCharacter() leaves the model in BIND POSE (anims ${JSON.stringify(ref.anims ?? null)})`); continue; }
    const missing = [...needed].filter((r) => !hasRole(ref, r));
    if (!missing.length) continue;
    // stock models are posed by words; a missing role only matters when a state has no word (the kit keeps the last pose)
    note(c.custom ? 'ERROR' : 'WARN', game, `roles on ${src.label}`, charLabel(c), `missing ${missing.join(',')} (kit keeps the previous pose)`);
  }
  // sources with no ref for a character at all
  for (const c of chars) for (const src of def.sources) if (!src.ref(c) && src.label.includes('<id>')) {
    const others = def.sources.some((x) => x !== src && x.ref(c));
    if (!others) note('ERROR', game, `source ${src.label}`, charLabel(c), 'no model ref at all (procedural stand-in)');
  }
}

// ---------------------------------------------------------------- 4. model refs integrity
function checkRef(where: string, ref: Ref) {
  const inf = info(ref.model);
  if (!inf) { note('ERROR', 'catalog', where, `model ${ref.model}`, 'model file missing'); return; }
  for (const [role, idx] of Object.entries(ref.anims ?? {})) if (idx >= inf.clips.length) note('ERROR', 'catalog', where, `model ${ref.model}`, `anims.${role}=${idx} but only ${inf.clips.length} clips`);
  for (const p of ref.parts ?? []) if (/^part\d+$/.test(p) && !inf.parts.has(p)) note('WARN', 'catalog', where, `model ${ref.model}`, `part ${p} not found`);
}
for (const c of catalog.characters) {
  checkRef(`character ${c.id}`, c);
  for (const [v, r] of Object.entries(c.variants ?? {})) checkRef(`character ${c.id} variant ${v}`, r);
  if (Object.keys(c.anims ?? {}).length === 0) note('ERROR', 'catalog', `character ${c.id}`, `model ${c.model}`, 'no anims map');
}
for (const [k, r] of Object.entries(catalog.props)) checkRef(`prop ${k}`, r);
for (const [k, r] of Object.entries(catalog.arenas)) { checkRef(`arena ${k}`, r); for (const e of r.extra ?? []) checkRef(`arena ${k} extra`, e); }

// ---------------------------------------------------------------- output
const compact = new Map<string, { n: number; whos: string[] }>();
for (const [level, game, what, who, why] of rows) {
  const key = [level, game, what, why.replace(/\(first 0x[0-9a-f]+\)/, '')].join(' | ');
  const e = compact.get(key) ?? { n: 0, whos: [] };
  e.n++; e.whos.push(who); compact.set(key, e);
}
const printed = [...compact.entries()].sort();
console.log(`T-pose static check: ${GAMES ? Object.keys(GAMES).length : 0} games, ${chars.length} characters (* = custom, engine char 3 tables)\n`);
console.log('LEVEL | GAME | SOURCE | DETAIL | CHARACTERS');
for (const [key, e] of printed) {
  if (!verbose && key.startsWith('WARN')) continue;
  console.log(`${key} | ${e.whos.join(',')}`);
}
console.log(`\n${errors} errors, ${warns} warnings${verbose ? '' : ' (run with --verbose to list warnings)'}`);
process.exit(errors ? 1 : 0);
