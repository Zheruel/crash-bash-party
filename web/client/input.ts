import type { InputState } from '../shared/types';

const GAME_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyE']);

/**
 * Keyboard (WASD/arrows, Space = A, Shift = B), Gamepad (stick/dpad, A/B) and an optional touch source.
 * `consumeAction()` reports a fresh press of Space / Enter / gamepad A.
 */
export class InputManager {
  private keys = new Set<string>();
  private action = false;
  private padA = false;
  /** When true, game keys are swallowed (prevents page scroll / button activation during play). */
  capture = false;
  touch: (() => InputState | null) | null = null;

  constructor() {
    addEventListener('keydown', (e) => {
      if (this.typing(e)) return;
      if ((e.code === 'Space' || e.code === 'Enter') && !e.repeat) this.action = true;
      if (GAME_KEYS.has(e.code)) {
        this.keys.add(e.code);
        if (this.capture) e.preventDefault();
      }
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  private typing(e: Event) {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
  }

  /** True once per fresh action press since the last call. */
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
    const k = this.keys;
    let x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    let y = (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0) - (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0);
    let a = k.has('Space');
    let b = k.has('ShiftLeft') || k.has('ShiftRight');
    let c = k.has('KeyE');
    const l = Math.hypot(x, y);
    if (l > 1) { x /= l; y /= l; }

    const pad = this.pad();
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.18 ? 0 : v);
      let px = dz(pad.axes[0] ?? 0), py = dz(pad.axes[1] ?? 0);
      const bt = (i: number) => !!pad.buttons[i]?.pressed;
      if (bt(14)) px -= 1;
      if (bt(15)) px += 1;
      if (bt(12)) py -= 1;
      if (bt(13)) py += 1;
      if (Math.hypot(px, py) > Math.hypot(x, y)) { x = px; y = py; }
      a = a || bt(0);
      b = b || bt(1) || bt(2) || bt(5) || bt(7);
      c = c || bt(3);
    }
    const t = this.touch?.();
    if (t) {
      if (Math.hypot(t.x, t.y) > Math.hypot(x, y)) { x = t.x; y = t.y; }
      a = a || t.a;
      b = b || t.b;
      c = c || !!t.c;
    }
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }
    return c ? { x, y, a, b, c } : { x, y, a, b };
  }
}
