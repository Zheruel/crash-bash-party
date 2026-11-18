import type { Modifier } from './types';

export const MODIFIERS: Modifier[] = [
  { id: 'lowGravity', name: 'Moon Bounce', desc: 'Low gravity: jumps go much higher and last longer.', appliesTo: ['pushOff', 'crateToss'], apply: (p) => { p.gravity = 0.35; } },
  { id: 'doubleSpeed', name: 'Double Time', desc: 'Everything moves much faster.', appliesTo: ['ballDefence', 'tilePainter', 'tankArena', 'crateToss', 'dashRace'], apply: (p) => { p.speed = 1.6; } },
  { id: 'giantBall', name: 'Giant Balls', desc: 'Balls are more than twice the size.', appliesTo: ['ballDefence'], apply: (p) => { p.ballScale = 2.2; } },
  { id: 'slippery', name: 'Ice Rink', desc: 'The floor is slippery. Good luck stopping.', appliesTo: ['pushOff', 'ballDefence', 'crateToss', 'dashRace'], apply: (p) => { p.friction = 0.18; } },
  { id: 'mirrored', name: 'Mirror Mode', desc: 'Controls are mirrored.', appliesTo: ['pushOff', 'ballDefence', 'tilePainter', 'tankArena', 'dashRace', 'crateToss'], apply: (p) => { p.mirror = true; } },
  { id: 'bigPlayers', name: 'Sumo Size', desc: 'Everyone is bigger and heavier.', appliesTo: ['pushOff', 'ballDefence', 'crateToss'], apply: (p) => { p.playerScale = 1.4; } },
  { id: 'ricochet', name: 'Super Bounce', desc: 'Shells ricochet off walls three times.', appliesTo: ['tankArena'], apply: (p) => { p.bounces = 5; } },
  { id: 'rapidFire', name: 'Rapid Fire', desc: 'Tanks reload twice as fast.', appliesTo: ['tankArena'], apply: (p) => { p.fireRate = 2; } },
  { id: 'bigBrush', name: 'Big Brush', desc: 'Every landing paints a 3x3 patch.', appliesTo: ['tilePainter'], apply: (p) => { p.brush = 1; } },
  { id: 'crateStorm', name: 'Crate Storm', desc: 'Crates rain down much faster.', appliesTo: ['crateToss'], apply: (p) => { p.spawnRate = 2.5; } },
  { id: 'boostFrenzy', name: 'Boost Frenzy', desc: 'Boost pads and turbo hit twice as hard.', appliesTo: ['dashRace'], apply: (p) => { p.boost = 2; } },
];

export function modifiersFor(gameId: string): Modifier[] {
  return MODIFIERS.filter((m) => !m.appliesTo || m.appliesTo.includes(gameId));
}
