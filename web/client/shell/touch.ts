// The virtual stick and stage-specific PlayStation buttons share the gamepad layout.
import type { InputState } from '../../shared/types';

import { padLayout, PAD_LABEL, type Button } from '../pad';

export class TouchControls {
  readonly el: HTMLElement;
  private stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
  private held = new Map<Button, Set<number>>();
  private taps = new Set<Button>();
  private knob: HTMLElement;
  private base: HTMLElement;
  enabled = false;

  constructor(parent: HTMLElement) {
    this.el = document.createElement('div');
    this.el.id = 'touch';
    this.el.className = 'hidden';
    this.el.innerHTML = `<div class="tstick"><div class="tbase"><div class="tknob"></div></div></div>
      <div class="tbtns">${(['a', 'b', 'c', 'd', 'l', 'r'] as Button[]).map(b =>
        `<button class="tbtn hidden" data-b="${b}" type="button"></button>`).join('')}</div>`;
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
      const key = btn.dataset.b as Button;
      const set = new Set<number>();
      this.held.set(key, set);
      btn.addEventListener('pointerdown', (e) => {
        set.add(e.pointerId); this.taps.add(key); btn.classList.add('down');
        btn.setPointerCapture(e.pointerId); e.preventDefault();
      });
      const up = (e: PointerEvent) => { set.delete(e.pointerId); if (!set.size) btn.classList.remove('down'); };
      btn.addEventListener('lostpointercapture', up);
      btn.addEventListener('pointerup', up);
      btn.addEventListener('pointercancel', up);
    }
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  configure(game: string, variant?: string) {
    const layout = padLayout(game, variant);
    for (const btn of this.el.querySelectorAll<HTMLButtonElement>('.tbtn')) {
      const index = layout[btn.dataset.b as Button];
      btn.classList.toggle('hidden', index === undefined);
      if (index === undefined) continue;
      btn.dataset.pad = String(index);
      btn.textContent = PAD_LABEL[index];
      btn.setAttribute('aria-label', ['Cross', 'Circle', 'Square', 'Triangle', 'Left shoulder', 'Right shoulder'][index]);
    }
  }

  show(on: boolean) {
    this.el.classList.toggle('hidden', !(on && this.enabled));
    if (!on) {
      this.stick.id = -1; this.stick.x = this.stick.y = 0;
      this.knob.style.transform = ''; this.base.style.opacity = '.45';
      this.taps.clear();
      this.held.forEach(set => set.clear());
      this.el.querySelectorAll('.down').forEach(btn => btn.classList.remove('down'));
    }
  }

  sample = (): InputState | null => {
    if (!this.enabled) return null;
    const down = (key: Button) => !!this.held.get(key)?.size || this.taps.has(key);
    const state = { x: this.stick.x, y: this.stick.y, a: down('a'), b: down('b'), c: down('c'), d: down('d'), l: down('l'), r: down('r') };
    this.taps.clear();
    return state;
  };

  static likely(): boolean {
    return matchMedia('(pointer: coarse) and (hover: none)').matches;
  }
}
