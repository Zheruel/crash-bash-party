import { COLORS } from '../../shared/look';
import type { ResultsMsg, RoundMsg, WheelMsg } from '../../shared/protocol';
import { avatarHtml } from '../shell/avatar';
import { sfx } from '../shell/sound';
import { div, esc, icon, pop } from './dom';
import type { SeatView } from './hud';

const WHEEL_COLORS = ['#ff8a00', '#ffd21f', '#ff5a2a', '#ffc04d', '#e8650a', '#fff0a0'];

/** The mini-game roulette. */
export class WheelOverlay {
  readonly el = div('overlay wheelov hidden');
  private raf = 0;
  private token = 0;

  hide() { this.token++; cancelAnimationFrame(this.raf); this.el.classList.add('hidden'); this.el.innerHTML = ''; }

  run(m: WheelMsg, turnLabel: string) {
    const token = ++this.token;
    cancelAnimationFrame(this.raf);
    const n = m.options.length;
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="wheel-head crate"><small>${esc(turnLabel)}</small><b>${m.showdown ? 'LAST ROUND!' : 'NEXT MINI-GAME'}</b>${m.showdown ? '<em>DOUBLE POINTS</em>' : ''}</div>
      <div class="wheel-box"><canvas class="wheel-cv"></canvas><div class="wheel-ptr"></div><div class="wheel-hub"></div></div>
      <div class="wheel-pick hidden"></div><div class="wheel-mod hidden"></div>`;
    const cv = this.el.querySelector('canvas') as HTMLCanvasElement;
    const size = Math.min(440, Math.min(innerWidth * 0.86, innerHeight * 0.58));
    const d = Math.min(devicePixelRatio, 2);
    cv.style.width = cv.style.height = `${size}px`;
    cv.width = cv.height = Math.round(size * d);
    const g = cv.getContext('2d')!;
    g.scale(d, d);
    const R = size / 2, seg = (Math.PI * 2) / n;
    g.translate(R, R);
    for (let i = 0; i < n; i++) {
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R - 6, i * seg, (i + 1) * seg); g.closePath();
      g.fillStyle = WHEEL_COLORS[i % WHEEL_COLORS.length]; g.fill();
      g.lineWidth = 4; g.strokeStyle = '#1a0f05'; g.stroke();
      g.save();
      g.rotate((i + 0.5) * seg);
      g.textAlign = 'right'; g.textBaseline = 'middle';
      const fs = Math.max(13, Math.min(26, size / 17));
      g.font = `${fs}px "Luckiest Guy", "Arial Rounded MT Bold", Impact, sans-serif`;
      g.fillStyle = '#1a0f05';
      g.fillText(m.options[i].name.toUpperCase(), R - 24, 2, R * 0.62);
      g.restore();
    }
    g.beginPath(); g.arc(0, 0, R - 5, 0, Math.PI * 2); g.lineWidth = 9; g.strokeStyle = '#1a0f05'; g.stroke();
    for (let i = 0; i < n * 2; i++) { // bulbs
      g.beginPath(); g.arc(Math.cos((i / (n * 2)) * Math.PI * 2) * (R - 5), Math.sin((i / (n * 2)) * Math.PI * 2) * (R - 5), 4.5, 0, Math.PI * 2);
      g.fillStyle = i % 2 ? '#fff6b0' : '#ff4a2a'; g.fill();
    }
    // spin so that segment `pick` ends under the pointer (top)
    const centre = (m.pick + 0.5) * seg;
    const norm = (a: number) => ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    const total = Math.PI * 2 * 6 + norm(-Math.PI / 2 - centre);
    const spinMs = Math.max(500, m.ms * 0.72);
    const start = performance.now();
    let lastIdx = -1;
    const frame = (now: number) => {
      if (token !== this.token) return;
      const k = Math.min(1, (now - start) / spinMs);
      const e = 1 - Math.pow(1 - k, 4);
      const r = total * e;
      cv.style.transform = `rotate(${r}rad)`;
      const idx = Math.floor(norm(-Math.PI / 2 - r) / seg);
      if (idx !== lastIdx) { lastIdx = idx; sfx.play('tick', 0.8 + 0.4 * (1 - k)); }
      if (k < 1) { this.raf = requestAnimationFrame(frame); return; }
      // landed
      sfx.play('reveal');
      const pick = this.el.querySelector('.wheel-pick') as HTMLElement;
      pick.innerHTML = `${esc(m.options[m.pick].name.toUpperCase())}${m.variant ? `<small class="wheel-level">${esc(m.variant.name.toUpperCase())}</small>` : ''}`;
      pick.classList.remove('hidden');
      pop(pick, 'pop');
      this.el.querySelector('.wheel-box')!.classList.add('landed');
      if (m.modifier) {
        const mod = this.el.querySelector('.wheel-mod') as HTMLElement;
        mod.innerHTML = `<small>TWIST!</small><b>${esc(m.modifier.name)}</b><span>${esc(m.modifier.desc)}</span>`;
        setTimeout(() => { if (token === this.token) { mod.classList.remove('hidden'); pop(mod, 'pop'); sfx.play('lucky'); } }, Math.min(500, m.ms * 0.12));
      }
    };
    this.raf = requestAnimationFrame(frame);
  }
}

/** Mini-game intro card. */
export class IntroOverlay {
  readonly el = div('overlay introov hidden');
  show(m: RoundMsg, variant: string | null, mySlot: number | null, seats: SeatView[], touch: boolean) {
    this.el.classList.remove('hidden');
    const me = mySlot != null ? seats[mySlot] : null;
    this.el.innerHTML = `
      <div class="intro crate">
        <small>${m.showdown ? 'LAST ROUND' : `ROUND ${m.round}/${m.total}`}</small>
        <h1>${esc(m.gameName.toUpperCase())}</h1>
        ${variant ? `<div class="variant">${esc(variant.toUpperCase())}</div>` : ''}
        <p>${esc(m.desc)}</p>
        <div class="controls"><label>CONTROLS</label><span>${esc(m.controls)}</span>${touch ? '<span class="tc">Touch: stick + A / B buttons</span>' : ''}</div>
        ${m.modifier ? `<div class="modchip"><b>${esc(m.modifier.name)}</b> ${esc(m.modifier.desc)}</div>` : ''}
        ${m.showdown ? '<div class="modchip dbl">DOUBLE POINTS for everyone!</div>' : ''}
        <div class="youare">${me ? `${avatarHtml(me.look)}<span>You are <b style="color:${COLORS[me.look.color % COLORS.length].hex}">${esc(me.name)}</b></span>` : '<span>You are watching</span>'}</div>
      </div>`;
  }
  hide() { this.el.classList.add('hidden'); this.el.innerHTML = ''; }
}

export class CountOverlay {
  readonly el = div('count hidden');
  private last = '';
  set(text: string) {
    if (text === this.last) return;
    this.last = text;
    this.el.classList.toggle('hidden', !text);
    this.el.textContent = text;
    if (text) { pop(this.el, 'cpop'); this.el.classList.toggle('go', text === 'GO!'); }
  }
}

const CROWN = '<svg class="crown" viewBox="0 0 32 24"><path d="M2 20L0 5l9 7 7-11 7 11 9-7-2 15z" fill="#ffd21f" stroke="#1a0f05" stroke-width="2.4" stroke-linejoin="round"/><rect x="2" y="20" width="28" height="3.5" rx="1" fill="#ff8a00" stroke="#1a0f05" stroke-width="2"/></svg>';

/** Between-rounds leaderboard: placement pops, counting points, re-sorting rows, crown, streak flames. */
export class ResultsOverlay {
  readonly el = div('overlay resultsov hidden');
  private timers: number[] = [];
  private raf = 0;

  hide() { cancelAnimationFrame(this.raf); this.timers.forEach(clearTimeout); this.timers = []; this.el.classList.add('hidden'); this.el.innerHTML = ''; }

  private later(ms: number, fn: () => void) { this.timers.push(window.setTimeout(fn, ms)); }

  show(m: ResultsMsg, seats: SeatView[], mySlot: number | null, streaks: number[]) {
    this.hide();
    this.el.classList.remove('hidden');
    const order = (pts: number[], tr: number[]) => [0, 1, 2, 3].sort((a, b) => pts[b] - pts[a] || tr[b] - tr[a] || a - b);
    const prevTrophies = m.stars.map((s, i) => s - (m.placements[0] === i ? 1 : 0));
    const before = order(m.prev, prevTrophies);
    const after = order(m.scores, m.stars);
    const winner = m.placements[0];
    const lastNext = !m.final && m.round + 1 === m.total;
    const rows = [0, 1, 2, 3].map((slot) => {
      const s = seats[slot];
      if (!s) return '';
      const col = COLORS[s.look.color % COLORS.length].hex;
      return `<div class="lrow ${slot === mySlot ? 'me' : ''}" data-slot="${slot}" style="--c:${col}">
        <div class="lk">1</div>
        <div class="la">${avatarHtml(s.look)}${CROWN}</div>
        <div class="ln">${esc(s.name)}${slot === mySlot ? ' <i>(you)</i>' : ''}<span class="streak hidden"></span></div>
        <div class="lg hidden"><b>+${m.gained[slot] + (m.bonus[slot] || 0)}</b>${m.bonus[slot] ? '<em>COMEBACK</em>' : ''}</div>
        <div class="lt">${icon('wumpa')}<b>${m.prev[slot]}</b></div>
        <div class="ls">${icon('crystal')}<b>${prevTrophies[slot]}</b></div>
      </div>`;
    }).join('');
    this.el.innerHTML = `<div class="results crate">
      <h2>${m.final ? 'FINAL ROUND' : `ROUND ${m.round}`}<small>${esc(seats[winner]?.name ?? '')} wins${m.showdown ? ' - DOUBLE POINTS' : ''}!</small></h2>
      <div class="lboard">${rows}</div>
      ${lastNext ? '<div class="lastround">LAST ROUND - DOUBLE POINTS!</div>' : m.final ? '' : `<div class="hint">Next: round ${m.round + 1} of ${m.total}</div>`}
    </div>`;
    const q = (slot: number) => this.el.querySelector<HTMLElement>(`.lrow[data-slot="${slot}"]`)!;
    const place = (ord: number[]) => ord.forEach((slot, i) => { const r = q(slot); r.style.setProperty('--i', String(i)); r.querySelector('.lk')!.textContent = String(i + 1); });
    place(before);
    const crownTo = (slot: number | null, ord: number[], pts: number[]) => {
      const lead = Math.max(...pts);
      [0, 1, 2, 3].forEach((i) => q(i).classList.toggle('lead', lead > 0 && pts[i] === lead));
      void slot; void ord;
    };
    crownTo(null, before, m.prev);
    sfx.play('whoosh');
    // +N pops, last place first
    const rev = [...m.placements].reverse();
    rev.forEach((slot, k) => this.later(250 + k * 180, () => {
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
        for (let i = 0; i < 4; i++) {
          const b = q(i).querySelector('.lt b');
          if (b) b.textContent = String(Math.round(m.prev[i] + (m.scores[i] - m.prev[i]) * e));
        }
        if (k < 1) this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
      sfx.play('coin');
    });
    // re-sort + crown + trophy + streaks
    this.later(t0 + dur + 100, () => {
      place(after);
      crownTo(null, after, m.scores);
      const t = q(winner).querySelector('.ls b') as HTMLElement;
      t.textContent = String(m.stars[winner]);
      pop(t.parentElement!, 'bump');
      const leadSlot = after[0];
      if (after[0] !== before[0]) { sfx.play('crystal'); pop(q(leadSlot).querySelector('.crown') as HTMLElement, 'crownpop'); }
      for (let i = 0; i < 4; i++) {
        const st = q(i).querySelector('.streak') as HTMLElement;
        if ((streaks[i] ?? 0) >= 2) { st.textContent = `${streaks[i]} IN A ROW!`; st.classList.remove('hidden'); pop(st, 'pop'); }
      }
      if (lastNext) sfx.play('chaos');
    });
  }
}
