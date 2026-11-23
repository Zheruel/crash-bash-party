import * as THREE from 'three';
import { ballistixSlidesHorizontally } from '../../shared/games/ballDefence';
import { COUNT_FRAMES, COUNT_LABELS, type ResultsMsg, type RoundMsg, type StageBallot, type StageOption, type WheelMsg } from '../../shared/protocol';
import { sfx, sfxRate } from '../shell/sound';
import { announceStage, preloadStageCall } from '../shell/voice';
import { ASSET_BASE, ModelInstance, ready } from '../crash';
import { div, esc, face, icon, MENU_PLAYERS, pop } from './dom';
import type { SeatView } from './hud';
import { padLayout, PAD_LABEL, type Button } from '../pad';
import { keyLabels } from '../input';
import './round-screens.css';

const UKA = `${ASSET_BASE}ui/uka.png`;
/** the level each mini-game's reel card shows before the pick (its first real level) */
const FIRST: Record<string, string> = { ballDefence: 'crashball', pushOff: 'tilt', tilePainter: 'pogo', tankArena: 'swamp', crateToss: 'jungle', dashRace: 'dot' };
/** stage still of a mini-game level (assets/ui/thumbs, captured from the game itself) */
export const thumb = (game: string, variant?: string | null) => {
  const v = variant ?? FIRST[game];
  return `${ASSET_BASE}ui/thumbs/${game}${v ? '_' + v : ''}.jpg`;
};
const kbd = (key: string, alt?: readonly string[]) =>
  `<kbd${alt?.length ? ` title="Also ${esc(alt.join(' / '))}"` : ''}>${esc(key)}</kbd>`;
const movement: Record<string, [string, string]> = {
  move: [kbd('←') + kbd('↑') + kbd('↓') + kbd('→'), 'STICK'],
  lr: [kbd('←') + kbd('→'), 'STICK ↔'],
  ud: [kbd('↑') + kbd('↓'), 'STICK ↕'],
  up: [kbd('↑'), 'STICK ↑'],
};

/** Render the current stage's actual bindings in the rules and the game menu. */
export function controlsHtml(text: string, touch: boolean, game = '', variant?: string, slot: number | null = null): string {
  const layout = padLayout(game, variant);
  const key = (token: string) => {
    const direction = token === 'move' && game === 'ballDefence' && slot !== null
      ? movement[ballistixSlidesHorizontally(slot) ? 'lr' : 'ud']
      : movement[token];
    if (direction) return touch ? `<kbd class="pad">${direction[1]}</kbd>` : direction[0];
    const button = token as Button;
    // Earlier Ballistix hosts label the standard boost as {b}. The touch shoulder drives the same action.
    const pad = layout[button] ?? (game === 'ballDefence' && button === 'b' ? layout.r : undefined);
    if (touch && pad !== undefined) return `<kbd class="pad">${PAD_LABEL[pad]}</kbd>`;
    if (!['a', 'b', 'c', 'd', 'l', 'r'].includes(token)) return esc(token);
    const keys = keyLabels(button);
    return kbd(keys[0], keys.slice(1));
  };
  return text.split(/(?<=\.)\s+(?=[{A-Z])/).map(s =>
    `<li>${esc(s).replace(/\{(\w+)\}/g, (_, token: string) => `<span class="keys">${key(token)}</span>`)}</li>`).join('');
}
const MENU_MOVE = 'sfx/0272/7.mp3', MENU_SELECT = 'sfx/0272/9.mp3';

function stageArt(stage: StageOption) {
  return `<img class="stage-art" src="${esc(thumb(stage.gameId, stage.variantId))}" alt="" draggable="false">`;
}

export class VoteOverlay {
  readonly el = div('overlay round-screen voteov hidden');
  private ballotId?: number;
  private buttons: HTMLButtonElement[] = [];
  private fuse?: HTMLElement;
  private status?: HTMLElement;

  hide() {
    this.ballotId = undefined;
    this.buttons = [];
    this.fuse = this.status = undefined;
    this.el.classList.add('hidden');
    this.el.replaceChildren();
  }

  update(ballot: StageBallot, turnLabel: string, me: number, eligible: boolean, vote: (stage: string) => void) {
    if (this.ballotId !== ballot.id) {
      this.ballotId = ballot.id;
      this.el.innerHTML = `
        <div class="vote-panel">
          <div class="wheel-head"><small class="sm">${esc(turnLabel)}</small><h2 class="gt or" id="vote-heading">STAGE VOTE</h2></div>
          <div class="vote-cards" role="group" aria-labelledby="vote-heading">${ballot.options.map((stage) => `
            <button type="button" class="vote-card" aria-pressed="false">
              ${stageArt(stage)}<span class="vote-name">${esc(stage.name)}</span><span class="vote-count" hidden></span>
            </button>`).join('')}</div>
          <p class="vote-status" role="status"></p>
          <div class="fuse" aria-hidden="true"><i></i></div>
        </div>`;
      this.buttons = [...this.el.querySelectorAll('button')];
      this.status = this.el.querySelector<HTMLElement>('.vote-status')!;
      this.fuse = this.el.querySelector<HTMLElement>('.fuse i')!;
      this.el.classList.remove('hidden');
      this.buttons.forEach((button, index) => {
        button.onclick = () => {
          if (button.getAttribute('aria-disabled') === 'true') return;
          vote(ballot.options[index].id);
        };
        button.onkeydown = (event) => {
          const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
          if (!direction) return;
          event.preventDefault();
          const next = this.buttons[(index + direction + this.buttons.length) % this.buttons.length];
          if (next.disabled) return;
          next.focus();
          if (!sfx.playFile(MENU_MOVE, .55)) sfx.play('tick');
        };
      });
      if (eligible) this.buttons[0]?.focus({ preventScroll: true });
    }
    const ownVote = ballot.votes.find((v) => v.playerId === me);
    this.buttons.forEach((button, index) => {
      const id = ballot.options[index].id;
      const count = ballot.votes.filter((v) => v.stageId === id).length;
      const tally = button.querySelector<HTMLElement>('.vote-count')!;
      tally.hidden = count === 0;
      tally.textContent = count === 1 ? '1 VOTE' : `${count} VOTES`;
      button.disabled = !eligible;
      button.setAttribute('aria-disabled', String(!eligible || !!ownVote));
      button.setAttribute('aria-pressed', String(ownVote?.stageId === id));
    });
    const status = ownVote ? 'VOTE LOCKED IN' : eligible ? 'VOTE TO BOOST A STAGE’S ODDS' : 'WATCHING THE VOTE';
    if (this.status!.textContent !== status) {
      if (ownVote && this.status!.textContent && !sfx.playFile(MENU_SELECT, .65)) sfx.play('click');
      this.status!.textContent = status;
    }
  }

  progress(remaining: number) {
    if (this.fuse) this.fuse.style.transform = `scaleX(${Math.max(0, Math.min(1, remaining))})`;
  }
}

/** A reel of individual stages slows to a stop on the host's pick. */
export class WheelOverlay {
  readonly el = div('overlay round-screen wheelov hidden');
  private raf = 0;
  private resize?: ResizeObserver;
  private token = 0;
  private timers: number[] = [];

  hide() { this.token++; this.resize?.disconnect(); this.resize = undefined; cancelAnimationFrame(this.raf); this.timers.forEach(clearTimeout); this.timers = []; this.el.classList.add('hidden'); this.el.classList.remove('twisted', 'landed', 'showdown'); this.el.innerHTML = ''; }

  run(m: WheelMsg, turnLabel: string) {
    this.hide();
    const token = this.token;
    const picked = m.options[m.pick];
    preloadStageCall(picked.gameId, picked.variantId);
    const n = m.options.length;
    // a long strip: several laps, the pick lands on card LAND
    const LAPS = 2, LAND = LAPS * n + m.pick, total = LAND + 4;
    const cards = Array.from({ length: total }, (_, i) => m.options[i % n]);
    this.el.classList.remove('hidden');
    this.el.classList.toggle('showdown', !!m.showdown);
    if (m.showdown) sfx.play('drum');
    this.el.innerHTML = `
      <div class="wheel-head"><small class="sm">${esc(turnLabel)}</small><h2 class="gt or">${m.showdown ? 'LAST ROUND!' : 'NEXT MINI-GAME'}</h2>${m.showdown ? '<em class="gt red">DOUBLE POINTS</em>' : ''}</div>
      <div class="reel" aria-hidden="true"><div class="reel-strip">${cards.map((o, i) => `<div class="rcard" data-i="${i}">${stageArt(o)}<b class="gt or">${esc(o.name.toUpperCase())}</b></div>`).join('')}</div>
        <div class="reel-frame"><i class="ar t"></i><i class="ar b"></i></div></div>
      <div class="wheel-mod hidden"></div><span class="wheel-announcement" role="status"></span>`;
    const strip = this.el.querySelector('.reel-strip') as HTMLElement;
    const reel = this.el.querySelector('.reel') as HTMLElement;
    const first = strip.firstElementChild as HTMLElement;
    const second = first.nextElementSibling as HTMLElement;
    const elapsed = m.elapsedMs ?? 0;
    const spinMs = Math.max(1, (m.ms + elapsed) * 0.52);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const announce = m.ms > 300 && elapsed < spinMs + 250;
    const start = performance.now() - elapsed;
    let last = -1;
    const frame = (now: number) => {
      if (token !== this.token) return;
      const k = reducedMotion ? 1 : Math.min(1, (now - start) / spinMs);
      const e = 1 - Math.pow(1 - k, 4);
      const firstBox = first.getBoundingClientRect();
      const step = second.getBoundingClientRect().left - firstBox.left;
      const x = reel.clientWidth / 2 - firstBox.width / 2 - (1.5 + (LAND - 1.5) * e) * step;
      strip.style.transform = `translateX(${x}px)`;
      const under = Math.floor((reel.clientWidth / 2 - x) / step);
      if (k < 1 && under !== last) { last = under; if (!sfx.playFile(MENU_MOVE, 0.35 + 0.4 * (1 - k))) sfx.play('tick', 0.8 + 0.4 * (1 - k)); }
      if (k < 1) { this.raf = requestAnimationFrame(frame); return; }
      this.land(m, strip.querySelector(`.rcard[data-i="${LAND}"]`) as HTMLElement, token, announce);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private land(m: WheelMsg, card: HTMLElement, token: number, announce: boolean) {
    if (!sfx.playFile(MENU_SELECT, 0.8)) sfx.play('reveal');
    this.el.classList.add('landed');
    const reel = card.closest<HTMLElement>('.reel')!;
    const strip = card.parentElement!;
    const align = () => {
      strip.style.transform = `translateX(${reel.clientWidth / 2 - card.offsetLeft - card.offsetWidth / 2}px)`;
    };
    align();
    this.resize = new ResizeObserver(align);
    this.resize.observe(reel);
    card.classList.add('win');
    const stage = m.options[m.pick];
    this.el.querySelector('.wheel-announcement')!.textContent = stage.name;
    if (announce) this.timers.push(window.setTimeout(() => announceStage(stage.gameId, stage.variantId), 70));
    if (m.modifier) {
      const mod = this.el.querySelector('.wheel-mod') as HTMLElement;
      mod.innerHTML = `<img class="uka" src="${UKA}" alt="" draggable="false"><div class="bubble"><b class="gt red">${esc(m.modifier.name.toUpperCase())}</b><span class="sm">${esc(m.modifier.desc)}</span></div>`;
      this.timers.push(window.setTimeout(() => {
        if (token !== this.token) return;
        mod.classList.remove('hidden');
        // Uka Uka barges in: red flash, the reel shakes, the picked card is shoved crooked
        this.el.classList.remove('twisted'); void this.el.offsetWidth; this.el.classList.add('twisted');
        sfx.play('chaos');
      }, Math.min(1350, m.ms * 0.45)));
    }
  }
}

/**
 * Get-ready screen while the level loads: the stage still behind, the game name with its level stamp, the four
 * challengers with their real HUD faces, the rules, and a fuse that burns down until the countdown.
 */
export class IntroOverlay {
  readonly el = div('overlay round-screen introov hidden');
  show(m: RoundMsg, variant: { id: string; name: string } | null, mySlot: number | null, seats: SeatView[], touch: boolean, ms = 4000, gameId = '') {
    this.el.classList.remove('hidden');
    const players = [0, 1, 2, 3].map((slot) => {
      const s = seats[slot];
      if (!s) return '';
      const col = MENU_PLAYERS[slot].color;
      return `<div class="vsp ${slot === mySlot ? 'me' : ''}" style="--c:${col};--d:${slot * 90}ms">${face(s.look.char, true)}<b class="nm">${esc(s.name.toUpperCase())}</b>${slot === mySlot ? '<i class="badge">YOU</i>' : s.bot ? '<i class="badge bot">CPU</i>' : ''}</div>`;
    });
    this.el.innerHTML = `
      <div class="intro-bg" style="background-image:url('${thumb(gameId || m.gameId, variant?.id)}')"></div>
      <div class="intro" role="region" aria-label="Minigame rules">
        <div class="vs">${players.join('')}</div>
        <div class="rules">
          <header class="intro-heading">
            <small class="round-kicker">${m.cupsToWin ? `First to ${m.cupsToWin} ${m.cupsToWin === 1 ? 'cup' : 'cups'}` : m.showdown ? 'Last round · Double points' : `Round ${m.round} of ${m.total}`}</small>
            <h1 class="gt or">${esc((variant?.name ?? m.gameName).toUpperCase())}</h1>
          </header>
          <p>${esc(m.desc)}</p>
          <ul class="ctl" aria-label="Controls">${controlsHtml(m.controls, touch, m.gameId, variant?.id, mySlot)}</ul>
          ${m.modifier ? `<div class="twist"><img src="${UKA}" alt=""><p><strong>${esc(m.modifier.name)}</strong> ${esc(m.modifier.desc)}</p></div>` : ''}
        </div>
        <div class="fuse"><i style="animation-duration:${Math.max(500, ms)}ms"></i></div>
      </div>`;
  }
  hide() { this.el.classList.add('hidden'); this.el.innerHTML = ''; }
}

type CountLabel = typeof COUNT_LABELS[number] | 'GO!' | '';
// The native countdown and TIE parts of 0732, packaged without the UI atlas.
const COUNT_MODEL = { model: 9090, parts: ['part1'] };
/** FUN_80082d90 selects these four parts and cues from the shared match assets. */
const COUNT_CUES = {
  '3': { mesh: 0x2004, file: 'sfx/0277/10.mp3' },
  '2': { mesh: 0x2003, file: 'sfx/0277/9.mp3' },
  '1': { mesh: 0x2002, file: 'sfx/0277/8.mp3' },
  'GO!': { mesh: 0x2005, file: 'sfx/0277/11.mp3' },
};
// FUN_80082ac4 selects TIE (0x2006) for versus when mode bits 0x1e0 are clear.
const DRAW_PART = 0x2006;
const DRAW_AUDIO = 'sfx/0278/13.mp3';
const GAME_DRAW_AUDIO = new Set(['tilePainter', 'ringDing', 'dragonDrop', 'kegKaboom']);

interface DrawResult {
  at: number;
  phaseTick: number;
  frame: number;
  scale: number;
  announced: boolean;
  playCue: boolean;
}

export class CountOverlay {
  readonly el = div('count');
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(2 * Math.atan(120 / 160) * 180 / Math.PI, 4 / 3, 0.1, 20);
  private readonly mesh = new ModelInstance(COUNT_MODEL);
  private loaded = false;
  private label: CountLabel = '';
  private voice: ReturnType<typeof sfx.startSample> = null;
  private frame = 0;
  private result?: DrawResult;

  constructor() {
    this.el.setAttribute('role', 'status');
    // The HUD camera (L0 RAM 0x8009f734) projects at depth 0x800 with vertical scale 0.5 and H = 320.
    // FUN_8007eb68 puts the pivot at (320, 180); the NTSC capture's active picture starts 16 display pixels down.
    this.camera.position.z = 2;
    this.camera.projectionMatrix.elements[0] = 320 * (3276 / 4096) / 256;
    this.camera.projectionMatrix.elements[9] = (180 + 16) / 240 - 1;
    this.scene.add(this.mesh.root);
  }

  async preload() {
    await ready([COUNT_MODEL]);
    this.loaded = this.mesh.build();
  }

  preloadVoices() {
    for (const cue of Object.values(COUNT_CUES)) sfx.preloadFile(cue.file);
  }

  set(label: CountLabel, frame = 0) {
    this.frame = frame;
    if (label === this.label && !this.result) return;
    this.label = label;
    this.result = undefined;
    this.el.textContent = label;
    this.voice?.stop();
    this.voice = label ? sfx.startSample(COUNT_CUES[label].file, null, 0.9, 1) : null;
  }

  showDraw(at: number, playAt: number, gameId: string) {
    // These overlays leave the TIE object in state 5 for two updates before its scale-in.
    const delayed = gameId === 'crateToss' || gameId === 'malletMash' || gameId === 'tankArena' || gameId === 'pushOff';
    const startsAt = at + (delayed ? 2 * 1000 / 30 : 0);
    const phaseTick = Math.floor((startsAt - playAt) * 30 / 1000);
    this.set('');
    this.result = { at: startsAt, phaseTick, frame: -1, scale: 0x100, announced: false, playCue: !GAME_DRAW_AUDIO.has(gameId) && performance.now() - at < 700 };
    this.el.textContent = 'DRAW!';
    sfx.preloadFile(DRAW_AUDIO);
  }

  advanceGo(frame: number) {
    if (this.label === 'GO!') this.set(frame >= COUNT_FRAMES ? '' : 'GO!', frame);
  }

  private poseDraw(draw: DrawResult, now: number) {
    const frame = Math.max(0, Math.floor((now - draw.at) * 30 / 1000 + 1e-7));
    // FUN_80082d90 advances the fixed-point ease a second time on the tick that fires 0x1af.
    while (draw.frame < frame && 0x1000 - draw.scale >= 8) {
      draw.frame++;
      const error = 0x1000 - draw.scale;
      draw.scale += error >> 3;
      if (!draw.announced && error < 0x100) {
        draw.announced = true;
        draw.scale += (0x1000 - draw.scale) >> 3;
        if (draw.playCue) sfx.playFile(DRAW_AUDIO, 0.9, true, sfxRate('0278', 0x1af));
      }
    }
    // The disc's running game tick indexes a 128-tick sine. Use the local play clock as its phase origin.
    const sin = Math.round(4096 * Math.sin(((draw.phaseTick + frame) & 127) * Math.PI / 64));
    const yaw = -Math.trunc((sin * 3 >> 9) * 4096 / 360) * Math.PI / 2048;
    this.mesh.nativePose(DRAW_PART);
    this.mesh.root.scale.setScalar(draw.scale / 4096);
    this.mesh.root.rotation.set(0, yaw, 0, 'XYZ');
  }

  draw(renderer: THREE.WebGLRenderer | null, now: number, arenaResult: boolean) {
    if (this.result) {
      if (!renderer || !arenaResult) { this.set(''); return; }
      if (now + 1e-6 < this.result.at) return;
      this.poseDraw(this.result, now);
    } else {
      if (!renderer || !this.loaded || !this.label || this.frame >= COUNT_FRAMES - 1) return;
      // FUN_80082c34 holds the new glyph three ticks, then shrinks it through 25 steps with pitch and yaw.
      const turn = Math.max(0, this.frame - 2);
      const remaining = 25 - Math.max(0, this.frame - 3);
      const pitch = (Math.floor(remaining * 1024 / 25) - 1024) * Math.PI / 2048;
      const yaw = (this.label === '2' || this.label === 'GO!' ? 1 : -1) * turn * Math.PI / 16;
      this.mesh.nativePose(COUNT_CUES[this.label].mesh);
      this.mesh.root.scale.setScalar(Math.floor(remaining * 4096 / 25) / 4096);
      this.mesh.root.rotation.set(pitch, yaw, 0, 'XYZ');
    }
    if (!this.loaded) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth();
    try { renderer.render(this.scene, this.camera); }
    finally { renderer.autoClear = autoClear; }
  }
}


/** Between-rounds leaderboard: placement pops, counting points, re-sorting rows, crown, streak flames. */
export class ResultsOverlay {
  readonly el = div('overlay round-screen resultsov hidden');
  private timers: number[] = [];
  private raf = 0;

  hide() { cancelAnimationFrame(this.raf); this.timers.forEach(clearTimeout); this.timers = []; this.el.classList.add('hidden'); this.el.innerHTML = ''; }

  private later(ms: number, fn: () => void) { this.timers.push(window.setTimeout(fn, ms)); }

  private showCups(m: ResultsMsg, seats: SeatView[], background?: string) {
    const cup = icon('cup');
    const rows = seats.map((s, i) => `<li>${face(s.look.char, true)}
      <span class="cup-name">${esc(s.name)}</span><strong class="gt or">${m.stars[i]}</strong>
      <span class="times" aria-hidden="true">×</span>${cup}</li>`).join('');
    this.el.innerHTML = `${background ? `<div class="intro-bg" style="background-image:url('${background}')"></div>` : ''}
      <section class="cup-board" aria-label="Cup standings">
        <h2 class="gt wh">First to ${m.cupsToWin} ${m.cupsToWin === 1 ? 'cup' : 'cups'}</h2>
        <ol>${rows}</ol></section>`;
  }

  show(m: ResultsMsg, seats: SeatView[], mySlot: number | null, streaks: number[], bg?: string, champ = false) {
    this.hide();
    this.el.classList.remove('hidden');
    this.el.classList.toggle('champ', champ);
    this.el.classList.toggle('cup-battle', !!m.cupsToWin);
    if (m.cupsToWin) { this.showCups(m, seats, bg); return; }
    if (champ) bg = undefined;
    const slots = [0, 1, 2, 3].filter((slot) => seats[slot]);
    const order = (pts: number[], tr: number[]) => [...slots].sort((a, b) => pts[b] - pts[a] || tr[b] - tr[a] || a - b);
    const prevTrophies = m.stars.map((s, i) => s - (!m.draw && m.placements[0] === i ? 1 : 0));
    const before = order(m.prev, prevTrophies);
    const after = order(m.scores, m.stars);
    const winner = m.placements[0];
    const lastNext = !m.final && m.round + 1 === m.total;
    const cup = icon('cup');
    const rows = slots.map((slot) => {
      const s = seats[slot];
      const col = MENU_PLAYERS[slot].color;
      return `<div class="lrow ${slot === mySlot ? 'me' : ''}" data-slot="${slot}" style="--c:${col}">
        <div class="lk">1</div>
        <div class="la">${face(s.look.char, true)}<span class="crown">${cup}</span></div>
        <div class="ln"><div class="row-name">${esc(s.name)}${slot === mySlot ? ' <i class="badge">YOU</i>' : ''}</div><div class="row-note"><span class="streak hidden"></span></div></div>
        <div class="lg hidden"><b class="gt grn">+${m.gained[slot] + (m.bonus[slot] || 0)}</b>${m.bonus[slot] ? '<em class="sm">COMEBACK</em>' : ''}</div>
        <div class="lt"><b>${m.prev[slot]}</b></div>
        <div class="ls"><b>${prevTrophies[slot]}</b></div>
      </div>`;
    }).join('');
    const ws = m.draw ? null : seats[winner];
    this.el.innerHTML = `${bg ? `<div class="intro-bg res-bg" style="background-image:url('${bg}')"></div>` : ''}
    <div class="results">
      <header class="res-hero"${ws ? ` style="--c:${MENU_PLAYERS[winner].color}"` : ''}>
        ${ws && !champ ? face(ws.look.char, true) : ''}
        <div class="rh-txt">
          <small class="round-kicker">${m.final ? 'Final round' : `Round ${m.round} of ${m.total}`}${m.showdown ? ' · Double points' : ''}</small>
          <h2 class="gt or">${m.draw ? 'Draw!' : ws ? `${esc(ws.name)} wins!` : 'Round results'}</h2>
        </div>
      </header>
      <div class="score-head round-kicker"><span>Player</span><span>${icon('wumpa')} Points</span><span>${cup} Wins</span></div>
      <div class="lboard" style="--rows:${slots.length}">${rows}</div>
      ${lastNext ? '<div class="lastround round-kicker">Next: Final round · Double points</div>' : m.final ? '' : `<div class="hint round-kicker">Next: Round ${m.round + 1} of ${m.total}</div>`}
    </div>`;
    const q = (slot: number) => this.el.querySelector<HTMLElement>(`.lrow[data-slot="${slot}"]`)!;
    const place = (ord: number[]) => ord.forEach((slot, i) => { const r = q(slot); r.style.setProperty('--i', String(i)); r.querySelector('.lk')!.textContent = String(i + 1); });
    place(before);
    const crownTo = (pts: number[]) => {
      const lead = Math.max(...slots.map((slot) => pts[slot]));
      slots.forEach((slot) => q(slot).classList.toggle('lead', lead > 0 && pts[slot] === lead));
    };
    crownTo(m.prev);
    sfx.play('whoosh');
    // +N pops, last place first
    const rev = m.placements.filter((slot) => seats[slot]).reverse();
    if (!m.draw) rev.forEach((slot, k) => this.later(250 + k * 180, () => {
      const g = q(slot).querySelector('.lg') as HTMLElement;
      g.classList.remove('hidden'); pop(g, 'pop');
      sfx.play(k === 3 ? 'lucky' : 'coin', 0.8 + k * 0.12);
    }));
    // count totals up
    const t0 = 250 + 4 * 180 + 150, dur = 600;
    this.later(t0, () => {
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / dur), e = 1 - Math.pow(1 - k, 3);
        for (const i of slots) {
          const b = q(i).querySelector('.lt b');
          if (b) b.textContent = String(Math.round(m.prev[i] + (m.scores[i] - m.prev[i]) * e));
        }
        if (k < 1) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
      if (!m.draw) sfx.play('coin');
    });
    // re-sort + crown + trophy + streaks
    this.later(t0 + dur + 100, () => {
      place(after);
      crownTo(m.scores);
      if (!m.draw && ws) {
        const t = q(winner).querySelector('.ls b') as HTMLElement;
        t.textContent = String(m.stars[winner]);
        pop(t.parentElement!, 'bump');
      }
      const leadSlot = after[0];
      if (after[0] !== before[0] && m.scores[leadSlot] > 0) {
        // a new leader takes the crown: stinger + tag on the row
        sfx.play('crystal');
        pop(q(leadSlot).querySelector('.crown') as HTMLElement, 'crownpop');
        const tag = document.createElement('span');
        tag.className = 'newlead gt or';
        tag.textContent = 'NEW LEADER!';
        q(leadSlot).querySelector('.row-note')!.appendChild(tag);
        pop(tag, 'stamped');
      }
      for (const i of slots) {
        const st = q(i).querySelector('.streak') as HTMLElement;
        if ((streaks[i] ?? 0) >= 2) { st.textContent = `${streaks[i]} IN A ROW!`; st.classList.remove('hidden'); pop(st, 'pop'); }
      }
      if (lastNext) sfx.play('chaos');
    });
  }
}
