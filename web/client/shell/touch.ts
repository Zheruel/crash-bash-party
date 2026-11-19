// On-screen controls for phones/tablets: a virtual stick (left half), two buttons (A, B) and a Triangle (Tank Wars taunt, Crate Crush jump) where a game uses one.
import type { InputState } from '../../shared/types';

export class TouchControls {
  readonly el: HTMLElement;
  private stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
  private a = new Set<number>();
  private b = new Set<number>();
  private c = new Set<number>();
  /** a quick tap is shorter than a 30 Hz sim tick: hold the press for a few ticks */
  private cAt = -1e9;
  private knob: HTMLElement;
  private base: HTMLElement;
  enabled = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'touch';
    this.el.className = 'hidden';
    this.el.innerHTML = `<div class="tstick"><div class="tbase"><div class="tknob"></div></div></div>
      <div class="tbtns"><button class="tbtn tc hidden" data-b="c" aria-label="Button C"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5.2L19 17.6H5z" fill="none" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg></button><button class="tbtn tb" data-b="b" aria-label="Button B"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="none" stroke="currentColor" stroke-width="3.4"/></svg></button><button class="tbtn ta" data-b="a" aria-label="Button A"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.500 5.500l13 13M18.500 5.500l-13 13" stroke="currentColor" stroke-width="3.600" stroke-linecap="round"/></svg></button></div>`;
    parent.appendChild(this.el);
    this.base = this.el.querySelector('.tbase')!;
    this.knob = this.el.querySelector('.tknob')!;
    const zone = this.el.querySelector('.tstick') as HTMLElement;
    const R = 56;
    zone.addEventListener('pointerdown', (e) => {
      if (this.stick.id >= 0) return;
      zone.setPointerCapture(e.pointerId);
      const r = zone.getBoundingClientRect();
      // the stick appears where the thumb lands (clamped inside the zone)
      const ox = Math.min(r.right - R, Math.max(r.left + R, e.clientX));
      const oy = Math.min(r.bottom - R, Math.max(r.top + R, e.clientY));
      this.stick = { id: e.pointerId, ox, oy, x: 0, y: 0 };
      this.base.style.cssText = `left:${ox - r.left - R}px;top:${oy - r.top - R}px;opacity:1`;
      this.knob.style.transform = 'translate(0,0)';
      e.preventDefault();
    });
    zone.addEventListener('pointermove', (e) => {
      if (e.pointerId !== this.stick.id) return;
      let dx = e.clientX - this.stick.ox, dy = e.clientY - this.stick.oy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = (dx / d) * R; dy = (dy / d) * R; }
      this.stick.x = dx / R;
      this.stick.y = dy / R;
      this.knob.style.transform = `translate(${dx}px,${dy}px)`;
    });
    const end = (e: PointerEvent) => {
      if (e.pointerId !== this.stick.id) return;
      this.stick.id = -1;
      this.stick.x = this.stick.y = 0;
      this.base.style.opacity = '.45';
    };
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    for (const btn of this.el.querySelectorAll<HTMLElement>('.tbtn')) {
      const set = btn.dataset.b === 'a' ? this.a : btn.dataset.b === 'c' ? this.c : this.b;
      btn.addEventListener('pointerdown', (e) => { set.add(e.pointerId); if (set === this.c) this.cAt = performance.now(); btn.classList.add('down'); btn.setPointerCapture(e.pointerId); e.preventDefault(); });
      const up = (e: PointerEvent) => { set.delete(e.pointerId); if (!set.size) btn.classList.remove('down'); };
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    }
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Show the Triangle button (Tank Wars taunt). */
  setTaunt(on: boolean) { this.el.querySelector('.tc')?.classList.toggle('hidden', !on); if (!on) this.c.clear(); }

  show(on: boolean) {
    this.el.classList.toggle('hidden', !(on && this.enabled));
    if (!on) { this.stick.id = -1; this.stick.x = this.stick.y = 0; this.a.clear(); this.b.clear(); this.c.clear(); }
  }

  sample = (): InputState | null => {
    if (!this.enabled) return null;
    return { x: this.stick.x, y: this.stick.y, a: this.a.size > 0, b: this.b.size > 0, ...(this.c.size || performance.now() - this.cAt < 120 ? { c: true } : {}) };
  };

  static likely(): boolean {
    return matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  }
}
