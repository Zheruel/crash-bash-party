import { COLORS, EMOTES, type Look } from '../../shared/look';
import { avatarHtml } from '../shell/avatar';
import { div, esc, icon, pop } from './dom';

export interface SeatView { name: string; look: Look; bot: boolean }

interface Card { el: HTMLElement; wumpa: HTMLElement; crystal: HTMLElement; extra: HTMLElement; emo: HTMLElement; disp: number; shown: number; stars: number }

/** Always-on-top gameplay UI: player cards (points + trophies), round pill, banners, floating numbers. */
export class Hud {
  readonly el = div('hud hidden');
  private cardsEl = div('cards', '', this.el);
  private pill = div('turnpill crate', '', this.el);
  private bannerEl = div('banner', '', this.el);
  private pops = div('floaters');
  private cards: Card[] = [];
  private key = '';
  private bannerTimer = 0;

  constructor(popParent: HTMLElement) {
    popParent.appendChild(this.pops);
  }

  show(on: boolean) { this.el.classList.toggle('hidden', !on); }

  setSeats(seats: SeatView[], me: number | null) {
    const key = seats.map((s) => `${s.name}|${s.look.char}.${s.look.color}`).join(',') + '#' + me;
    if (key === this.key) return;
    this.key = key;
    const old = this.cards;
    this.cardsEl.innerHTML = '';
    this.cards = seats.map((s, i) => {
      const el = div(`pcard ${i === me ? 'me' : ''} ${s.bot ? 'bot' : ''}`);
      el.style.setProperty('--c', COLORS[s.look.color % COLORS.length].hex);
      el.innerHTML = `<div class="pc-av">${avatarHtml(s.look)}</div>
        <div class="pc-info"><div class="pc-name">${esc(s.name)}</div>
        <div class="pc-stats"><span class="st crystal">${icon('crystal')}<b>0</b></span><span class="st wumpa">${icon('wumpa')}<b>0</b></span></div>
        <div class="pc-extra"></div></div><div class="pc-emote"></div>`;
      this.cardsEl.appendChild(el);
      const q = (c: string) => el.querySelector(c) as HTMLElement;
      const prev = old[i];
      return { el, wumpa: q('.wumpa b'), crystal: q('.crystal b'), extra: q('.pc-extra'), emo: q('.pc-emote'), disp: prev?.disp ?? -1, shown: -999, stars: prev?.stars ?? -1 };
    });
  }

  /** Per frame. coins/stars are the true values; displayed coins count towards them. */
  update(dt: number, st: { coins: number[]; stars: number[]; extra?: string[] }) {
    const lead = Math.max(0, ...st.coins);
    this.cards.forEach((c, i) => {
      const target = st.coins[i] ?? 0;
      if (c.disp < 0) c.disp = target;
      const diff = target - c.disp;
      if (Math.abs(diff) > 0.01) {
        c.disp += Math.sign(diff) * Math.min(Math.abs(diff), Math.max(10, Math.abs(diff) * 3) * dt);
      } else c.disp = target;
      const shown = Math.round(c.disp);
      if (shown !== c.shown) {
        if (c.shown !== -999) {
          c.wumpa.parentElement!.classList.remove('up', 'down');
          void c.wumpa.offsetWidth;
          c.wumpa.parentElement!.classList.add(target >= shown ? 'up' : 'down');
        }
        c.wumpa.textContent = String(shown);
        c.shown = shown;
      }
      const s = st.stars[i] ?? 0;
      if (s !== c.stars) {
        c.crystal.textContent = String(s);
        if (c.stars >= 0 && s > c.stars) pop(c.crystal.parentElement!, 'bump');
        c.stars = s;
      }
      c.el.classList.toggle('lead', lead > 0 && target === lead);
      const x = st.extra?.[i] ?? '';
      if (c.extra.textContent !== x) c.extra.textContent = x;
    });
  }

  /** Skip the coin counter animation (e.g. when a screen first appears). */
  snapCounters(coins: number[]) { this.cards.forEach((c, i) => { c.disp = coins[i] ?? 0; }); }

  setRound(round: number, total: number) {
    const last = round >= total;
    this.pill.innerHTML = `<small>ROUND</small><b>${round}<i>/${total}</i></b>${last ? '<em>DOUBLE POINTS!</em>' : ''}`;
    this.pill.classList.toggle('last', last);
  }
  setPillText(small: string, big: string) { this.pill.innerHTML = `<small>${esc(small)}</small><b>${esc(big)}</b>`; this.pill.classList.remove('last'); }

  banner(title: string, sub = '', kind = 'info', ms = 2200) {
    this.bannerEl.className = `banner ${kind}`;
    this.bannerEl.innerHTML = `<div class="bt">${esc(title)}</div>${sub ? `<div class="bs">${esc(sub)}</div>` : ''}`;
    pop(this.bannerEl, 'in');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = window.setTimeout(() => this.bannerEl.classList.add('out'), ms);
  }

  float(x: number, y: number, text: string, kind: 'plus' | 'minus' | 'star' | 'info' = 'info') {
    const f = div(`float ${kind}`, esc(text), this.pops);
    f.style.left = `${x}px`;
    f.style.top = `${y}px`;
    setTimeout(() => f.remove(), 1700);
  }

  emote(slot: number, id: number) {
    const c = this.cards[slot];
    if (!c) return;
    c.emo.textContent = EMOTES[id] ?? '';
    pop(c.emo, 'emo-pop');
  }
}
