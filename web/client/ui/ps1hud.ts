// The real game's 2D HUD: sprites from the disc's HUD atlas (t08 0731, decoded to assets/textures/0731), placed in the
// PS1's native 512x240 screen space over the centred 4:3 area, so the layout is the original's at any window size.
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
  return character?.id === 'big-stein' ? ASSET_BASE + 'hud/big-stein.png?v=2' : hudTex(HUD.face[character?.id] ?? 3);
}

/** the picture starts 8 lines down on screen (see PS1_OFY): HUD sprites move with it */
const PIC_Y = 8;

export class Ps1Hud {
  readonly el: HTMLDivElement;
  /** additive sprites: a sibling layer whose own blend mode adds it onto the canvas (a child of .ps1hud would only blend inside it) */
  private addEl: HTMLDivElement;
  private pool: HTMLImageElement[] = [];
  private addPool: HTMLImageElement[] = [];

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.className = 'ps1hud hidden';
    this.addEl = document.createElement('div');
    this.addEl.className = 'ps1hud ps1hud-add hidden';
    parent.append(this.addEl, this.el);
  }

  show(on: boolean) { this.el.classList.toggle('hidden', !on); this.addEl.classList.toggle('hidden', !on); }

  /** Draw this frame's sprites (pooled <img>, positions in % of the 512x240 frame). */
  draw(list: HudSprite[]) {
    this.fill(this.el, this.pool, list.filter((s) => !s.add));
    this.fill(this.addEl, this.addPool, list.filter((s) => s.add));
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
export function bigClock(sec: number, blink: boolean): HudSprite[] {
  const s = Math.max(0, Math.ceil(sec));
  const m = Math.min(9, Math.floor(s / 60)), ss = s % 60;
  const g = (c: string, x: number): HudSprite => ({ tex: `${ASSET_BASE}hud/big${c}.png`, x, y: 16, w: 30, h: 27 });
  const out = [g(String(m), 205), g(String(Math.floor(ss / 10)), 238), g(String(ss % 10), 261)];
  if (!blink) out.push(g('c', 226));
  return out;
}

/** Face of the player in a HUD slot (the in-play size: 64x40 at y 10, measured on native frames). */
export function faceSprite(seats: ({ look: { char: number } } | null | undefined)[], slot: number): HudSprite | null {
  const seat = seats[slot];
  if (!seat) return null;
  return { tex: hudFace(seat.look.char), x: SLOT_X[slot], y: 10, w: 64, h: 40 };
}

/**
 * The score HUD shared by Pogo Painter, Dragon Drop, Ring Ding, Mallet Mash and Keg Kaboom: face, three big digits under
 * it (orange rows 46-53, glyphs 19 apart from face x + 5) and the clock.
 */
export function scoreHud(seats: ({ look: { char: number } } | null | undefined)[], score: (slot: number) => number, left: number, time: number): HudSprite[] {
  const out: HudSprite[] = [];
  for (let slot = 0; slot < 4; slot++) {
    const f = faceSprite(seats, slot);
    if (!f) continue;
    out.push(f, ...bigNumber(score(slot), SLOT_X[slot] + 4, 36, 3, 19, 21));
  }
  out.push(...bigClock(left, Math.floor(time * 2) % 2 === 1));
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
