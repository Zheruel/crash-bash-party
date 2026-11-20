import { padLayout, type Button } from './pad';
import type { InputState } from '../shared/types';

const MOVE_CODES = {
  left: ['KeyA', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'],
  up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
};

const ACTION_CODES = {
  a: ['KeyZ', 'Space', 'KeyJ'],
  b: ['KeyX', 'KeyK', 'ShiftLeft', 'ShiftRight'],
  c: ['KeyC', 'KeyL', 'KeyF'],
  d: ['KeyV', 'KeyH'],
  l: ['KeyQ', 'KeyI'],
  r: ['KeyE', 'KeyO'],
};

const GAME_KEYS = new Set([...Object.values(MOVE_CODES).flat(), ...Object.values(ACTION_CODES).flat()]);

const keyLegends = new Map<string, string>();
type KeyboardLayouts = EventTarget & { getLayoutMap(): Promise<ReadonlyMap<string, string>> };

/** Physical bindings keep chords together even when the printed key changes (e.g. QWERTZ). */
export function keyLabels(button: Button): string[] {
  return [...new Set(ACTION_CODES[button].map(code =>
    keyLegends.get(code) ?? (code.startsWith('Shift') ? 'Shift' : code.replace(/^Key/, ''))))];
}

export function watchKeyboardLayout(refresh: () => void) {
  const layouts = (navigator as Navigator & { keyboard?: KeyboardLayouts }).keyboard;
  const read = async () => {
    if (!layouts?.getLayoutMap) return;
    try {
      const map = await layouts.getLayoutMap();
      for (const code of GAME_KEYS) {
        const legend = map.get(code);
        if (code.startsWith('Key') && legend?.length === 1) keyLegends.set(code, legend.toLocaleUpperCase());
      }
      refresh();
    } catch { /* Embedded pages can restrict access to keyboard layouts. */ }
  };
  void read();
  layouts?.addEventListener?.('layoutchange', read);
  window.addEventListener('keydown', e => {
    if (!e.code.startsWith('Key') || !GAME_KEYS.has(e.code) || e.key.length !== 1 ||
        e.isComposing || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
    const label = e.key.toLocaleUpperCase();
    if (label === (keyLegends.get(e.code) ?? e.code.slice(3))) return;
    keyLegends.set(e.code, label);
    refresh();
  });
}

function isEditing(target: EventTarget | null) {
  return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, select, textarea'));
}

function activatesControl(target: EventTarget | null, code: string) {
  return target instanceof Element && !!target.closest(code === 'Enter' ? 'button, summary, a[href]' : 'button, summary');
}

export class InputManager {
  private keys = new Set<string>();
  private pressed = new Set<string>();
  private menuButtons = new Set<number>();
  game = '';
  variant?: string;
  watchingBallistix = false;
  pressButton(button: Button) { this.pressed.add(ACTION_CODES[button][0]); }
  clearPresses() { this.pressed.clear(); }
  releaseMenuInput() {
    this.releaseKeyboard();
    this.menuButtons.clear();
    this.pad()?.buttons.forEach((button, i) => { if (button.pressed) this.menuButtons.add(i); });
  }
  private suppressSplashHop = false;
  enterDashPlay() {
    this.clearPresses();
    this.suppressSplashHop = false;
    if (this.variant === 'splash') this.suppressSplashHop = this.sample().b;
  }
  private action = false;
  private padA = false;
  private capturing = false;
  /** While playing, gameplay keys are captured outside editable fields and native activation. */
  get capture() { return this.capturing; }
  set capture(value: boolean) {
    this.capturing = value;
    if (!value) this.releaseKeyboard();
  }
  touch: (() => InputState | null) | null = null;

  constructor() {
    addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) {
        this.releaseKeyboard();
        return;
      }
      if (e.defaultPrevented || e.isComposing || isEditing(e.target)) return;
      if (e.code === 'Space' || e.code === 'Enter') {
        if (activatesControl(e.target, e.code)) return;
        if (!e.repeat) this.action = true;
      }
      if (!this.capture || !GAME_KEYS.has(e.code)) return;
      e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      this.pressed.add(e.code);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.releaseKeyboard());
    addEventListener('focusin', (e) => {
      if (isEditing(e.target) || activatesControl(e.target, 'Enter')) this.releaseKeyboard();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.releaseKeyboard();
    });
  }

  private releaseKeyboard() {
    this.keys.clear();
    this.clearPresses();
    this.action = false;
    this.suppressSplashHop = false;
  }

  /** True once per fresh Space, Enter, or gamepad A press since the last call. */
  consumeAction(): boolean {
    const pad = this.pad();
    const a = !!pad?.buttons[0]?.pressed;
    if (a && !this.padA) this.action = true;
    this.padA = a;
    const r = this.action;
    this.action = false;
    return r;
  }

  private pad() {
    return (navigator.getGamepads?.() ?? []).find((g) => g && g.connected) ?? null;
  }

  sample(): InputState {
    const axis = (negative: string[], positive: string[]) => {
      const neg = negative.some(code => this.keys.has(code));
      const pos = positive.some(code => this.keys.has(code));
      if (neg || pos) return Number(pos) - Number(neg);
      return Number(positive.some(code => this.pressed.has(code))) - Number(negative.some(code => this.pressed.has(code)));
    };
    let x = axis(MOVE_CODES.left, MOVE_CODES.right);
    let y = axis(MOVE_CODES.up, MOVE_CODES.down);
    const down = (button: Button) => ACTION_CODES[button].some(code => this.keys.has(code) || this.pressed.has(code));
    let a = down('a'), b = down('b'), c = down('c'), d = down('d');
    let tl = down('l'), tr = down('r');
    this.pressed.clear();
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }

    const pad = this.pad();
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
      let px = dz(pad.axes[0] ?? 0), py = dz(pad.axes[1] ?? 0);
      for (const i of this.menuButtons) if (!pad.buttons[i]?.pressed) this.menuButtons.delete(i);
      const bt = (i: number) => !!pad.buttons[i]?.pressed && !this.menuButtons.has(i);
      if (bt(14)) px -= 1;
      if (bt(15)) px += 1;
      if (bt(12)) py -= 1;
      if (bt(13)) py += 1;
      if (Math.hypot(px, py) > Math.hypot(x, y)) { x = px; y = py; }
      const layout = padLayout(this.game, this.variant);
      const button = (key: Button) => layout[key] !== undefined && bt(layout[key]!);
      a ||= button('a'); b ||= button('b') || (this.watchingBallistix && bt(0)); c ||= button('c'); d ||= button('d');
      tl ||= button('l'); tr ||= button('r');
      if (this.game === 'ballDefence') tr ||= bt(4) || bt(5) || bt(6) || bt(7);
      if (this.game === 'tankArena') { tl ||= bt(6); tr ||= bt(7); }
      if (this.game === 'dashRace' && this.variant !== 'splash') b ||= bt(7);
    }
    const t = this.touch?.();
    if (t) {
      if (Math.hypot(t.x, t.y) > Math.hypot(x, y)) { x = t.x; y = t.y; }
      a = a || t.a;
      b = b || t.b;
      c ||= !!t.c; d ||= !!t.d; tl ||= !!t.l; tr ||= !!t.r;
    }
    if (!b || this.game !== 'dashRace') this.suppressSplashHop = false;
    if (this.suppressSplashHop) b = false;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return { x, y, a, b, ...(c ? { c } : {}), ...(d ? { d } : {}), ...(tl ? { l: true } : {}), ...(tr ? { r: true } : {}) };
  }
}
