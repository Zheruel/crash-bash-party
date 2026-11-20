// The real game's 2D HUD: sprites from the disc's HUD atlas (t08 0731, decoded to assets/textures/0731), placed in the
// PS1's native 512x240 screen space over the centred 4:3 area, so the layout is the original's at any window size.
import type { World } from '../../shared/types';
import { KK_CLOCK_START } from '../../shared/games/kegKaboom';
import { TANK_TIMEOUT_TICK } from '../../shared/games/tankArena';
import { versusClock } from '../../shared/games/common';
import { CHARACTERS } from '../../shared/look';
import { ASSET_BASE } from '../crash';

/** One sprite in native screen units (x, y = top-left; w, h = drawn size). */
export interface HudSprite { tex: string; x: number; y: number; w: number; h: number; flip?: boolean; alpha?: number; /** PS1 additive semi-transparency (its own layer, blended onto the scene) */ add?: boolean }

/** HUD atlas (0731) indices. */
export const HUD = {
  /** face per CHARACTERS id (shared/look order: crash coco tiny dingodile cortex brio koala rilla) */
  face: { crash: 3, coco: 2, tiny: 7, dingodile: 5, cortex: 4, brio: 6, koala: 22, rilla: 8 } as Record<string, number>,
  /** big orange digits 0-9 (32x32, glyph top-left), then ':' and '%' */
  digit: (n: number) => 9 + n,
  /** small digits 0-9 (32x16) */
  small: (n: number) => 23 + n,
};

export const hudTex = (i: number) => `${ASSET_BASE}textures/0731/tex${String(i).padStart(3, '0')}.png`;

export function hudFace(char: number): string {
  const character = CHARACTERS[char % CHARACTERS.length];
  return character && 'hud' in character ? ASSET_BASE + character.hud : hudTex(HUD.face[character?.id] ?? 3);
}

/** the picture starts 8 lines down on screen (see PS1_OFY): HUD sprites move with it */
const PIC_Y = 8;

export class Ps1Hud {
  readonly el: HTMLDivElement;
  /** additive sprites: a sibling layer whose own blend mode adds it onto the canvas (a child of .ps1hud would only blend inside it) */
  private addEl: HTMLDivElement;
  readonly forceVictory = document.createElement('button');
  private forceSlide = 0;
  private forceKey = document.createElement('kbd');
  private forceLabel = document.createElement('span');
  private pool: HTMLImageElement[] = [];
  private addPool: HTMLImageElement[] = [];
  private textures = new Map<string, HTMLImageElement>();

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'ps1hud hidden';
    this.addEl = document.createElement('div');
    this.addEl.className = 'ps1hud ps1hud-add hidden';
    this.forceVictory.className = 'force-victory';
    this.forceVictory.type = 'button';
    this.forceVictory.hidden = true;
    this.forceLabel.append('Press ', this.forceKey, ' to force victory');
    this.forceVictory.append(this.forceLabel);
    this.el.append(this.forceVictory);
    parent.append(this.addEl, this.el);
  }

  show(on: boolean) { this.el.classList.toggle('hidden', !on); this.addEl.classList.toggle('hidden', !on); }

  setForceVictory(age: number, closing: number, key: string, touch: boolean) {
    const button = this.forceVictory;
    button.hidden = age < 0 || closing >= 8;
    if (button.hidden) return;
    button.disabled = closing >= 0;
    if (this.forceKey.textContent !== key) this.forceKey.textContent = key;
    if (touch !== button.classList.contains('touch')) {
      button.classList.toggle('touch', touch);
      if (touch) this.forceLabel.replaceChildren('Force victory');
      else this.forceLabel.replaceChildren('Press ', this.forceKey, ' to force victory');
    }
    // Native HUD object 5 enters from y=500, settles at 380, and exits at twice its entry speed.
    const offset = closing < 0 ? Math.max(0, 120 - 16 * age) : 32 * closing;
    this.forceSlide = Math.round(offset * 0.9);
    button.style.top = `${(196 + this.forceSlide) * 100 / 240}%`;
  }

  preloadRound(chars: number[]) {
    const glyphs = [...'0123456789c'].map(c => `${ASSET_BASE}hud/big${c}.png`);
    for (const url of [...glyphs, ...chars.map(hudFace)]) {
      if (this.textures.has(url)) continue;
      const image = new Image();
      this.textures.set(url, image);
      image.src = url;
      void image.decode().catch(() => this.textures.delete(url));
    }
  }

  /** Draw this frame's sprites (pooled <img>, positions in % of the 512x240 frame). */
  draw(list: HudSprite[]) {
    this.fill(this.el, this.pool, list.filter((s) => !s.add));
    const add = list.filter(s => s.add);
    if (!this.forceVictory.hidden) {
      const tex = ASSET_BASE + 'hud/stripEdge.png', y = 188 + this.forceSlide;
      add.push(
        { tex, x: 54, y, w: 404, h: 2 }, { tex, x: 54, y: y + 22, w: 404, h: 2 },
        { tex, x: 54, y: y + 2, w: 3, h: 20 }, { tex, x: 455, y: y + 2, w: 3, h: 20 },
      );
    }
    this.fill(this.addEl, this.addPool, add);
  }

  private fill(el: HTMLDivElement, pool: HTMLImageElement[], list: HudSprite[]) {
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      let img = pool[i];
      if (!img) { img = document.createElement('img'); img.draggable = false; el.appendChild(img); pool[i] = img; }
      if (img.dataset.src !== s.tex) { img.src = s.tex; img.dataset.src = s.tex; }
      const st = img.style;
      st.display = '';
      st.left = `${(s.x / 512) * 100}%`;
      st.top = `${((s.y + PIC_Y) / 240) * 100}%`;
      st.width = `${(s.w / 512) * 100}%`;
      st.height = `${(s.h / 240) * 100}%`;
      st.transform = s.flip ? 'scaleX(-1)' : '';
      st.opacity = s.alpha == null ? '' : String(s.alpha);
    }
    for (let i = list.length; i < pool.length; i++) pool[i].style.display = 'none';
  }
}

/**
 * Number in the big orange digits as the game draws them: 24x25 glyphs scaled to ~14x10, 17 apart, with the game's
 * orange gouraud tint baked in (tools/hud_digits.sh -> assets/hud/bigN.png). Left edge at x, top at y.
 */
export function bigNumber(n: number, x: number, y: number, digits = 2, adv = 17, w = 18.7): HudSprite[] {
  const s = String(Math.max(0, Math.min(10 ** digits - 1, Math.floor(n)))).padStart(digits, '0');
  return [...s].map((c, i) => ({ tex: `${ASSET_BASE}hud/big${c}.png`, x: x + i * adv, y, w, h: 12.8 }));
}

/** The four player slots of the real HUDs (face top-left x; faces 64x32 at y 20). */
export const SLOT_X = [32, 128, 320, 416];

/**
 * Match clock as the in-game HUD draws it (M:SS in the big orange glyphs, ~21 lines tall, colon blinking), measured on
 * native Crate Crush frames: glyph lefts at 205 / 226 (colon) / 238 / 261.
 */
export function bigClock(sec: number, hideColon = false): HudSprite[] {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.min(9, Math.floor(s / 60)), ss = s % 60;
  const g = (c: string, x: number): HudSprite => ({ tex: `${ASSET_BASE}hud/big${c}.png`, x, y: 16, w: 30, h: 27 });
  const out = [g(String(m), 205), g(String(Math.floor(ss / 10)), 238), g(String(ss % 10), 261)];
  if (!hideColon) out.push(g('c', 226));
  return out;
}

/** Face of the player in a HUD slot (the in-play size: 64x40 at y 10, measured on native frames). */
export function faceSprite(seats: ({ look: { char: number } } | null | undefined)[], slot: number): HudSprite | null {
  const seat = seats[slot];
  if (!seat) return null;
  return { tex: hudFace(seat.look.char), x: SLOT_X[slot], y: 10, w: 64, h: 40 };
}

/** The timer draws its three BCD digits before subtracting two of 60 subframes. */
export function arenaClock(game: string, world: World) {
  if (game === 'tankArena') {
    const tick = Math.min(world.tick, world.data.result?.rankedAt ?? Infinity);
    return tick >= TANK_TIMEOUT_TICK ? 0 : versusClock(tick + 1);
  }
  if (game === 'dashRace' && world.data.openingTicks !== undefined) return versusClock(world.tick);
  if (game === 'pushOff' || game === 'tilePainter' || game === 'dragonDrop' || game === 'crateToss' || game === 'ringDing') return versusClock(world.tick);
  if (game !== 'malletMash' && game !== 'kegKaboom') return Math.max(0, Math.ceil(90 - world.time));
  const ticks = game === 'malletMash' ? world.data.clock ?? 0 : (world.data.g ?? KK_CLOCK_START) - KK_CLOCK_START;
  return Math.max(0, 90 - Math.ceil(Math.max(0, ticks - 1) / 30));
}

/** FUN_8007b8d4. Only HUDs initialized with flag 0x10 flash the separator. */
export function arenaClockSprites(game: string, world: World): HudSprite[] {
  const left = arenaClock(game, world);
  const flashes = game === 'crateToss' || game === 'tilePainter' || game === 'ringDing' || game === 'malletMash';
  const ticks = game === 'malletMash' ? world.data.clock ?? 0 : Math.max(0, world.tick - 27);
  const subframes = (60 - 2 * (ticks % 30)) % 60;
  return bigClock(left, flashes && left > 0 && subframes >= 20);
}

/**
 * The score HUD shared by Pogo Painter, Dragon Drop, Ring Ding, Mallet Mash and Keg Kaboom: face, three big digits under
 * it (orange rows 46-53, glyphs 19 apart from face x + 5) and the clock.
 */
export function scoreHud(seats: ({ look: { char: number } } | null | undefined)[], score: (slot: number) => number, clock: HudSprite[]): HudSprite[] {
  const out: HudSprite[] = [];
  for (let slot = 0; slot < 4; slot++) {
    const f = faceSprite(seats, slot);
    if (!f) continue;
    out.push(f, ...bigNumber(score(slot), SLOT_X[slot] + 4, 36, 3, 19, 21));
  }
  out.push(...clock);
  return out;
}

/** Icon + health / fuel bar under a face (Crate Crush, Polar Push, Tank Wars, Crash Dash): 52 px wide at y 47. */
export function barRow(slot: number, frac: number, icon: string, iw = 26, ih = 20, ix = -8, iy = 33, bx = 16): HudSprite[] {
  const x = SLOT_X[slot], g = Math.round(52 * Math.max(0, Math.min(1, frac)));
  const out: HudSprite[] = [{ tex: `${ASSET_BASE}hud/barR.png`, x: x + bx, y: 39, w: 52, h: 6 }];
  if (g > 0) out.push({ tex: `${ASSET_BASE}hud/barG.png`, x: x + bx, y: 39, w: g, h: 6 });
  out.push({ tex: icon, x: x + ix, y: iy, w: iw, h: ih });
  return out;
}
export const FRUIT_ICON = `${ASSET_BASE}textures/0735/tex000.png`;
