import { COLORS } from '../../shared/look';
import type { ResultsMsg, RoundMsg, WheelMsg } from '../../shared/protocol';
import { sfx } from '../shell/sound';
import { ASSET_BASE } from '../crash';
import { div, esc, face, icon, pop } from './dom';
import type { SeatView } from './hud';
import { KEYS } from '../input';

const UKA = `${ASSET_BASE}ui/uka.png`;
/** the level each mini-game's reel card shows before the pick (its first real level) */
const FIRST: Record<string, string> = { ballDefence: 'crashball', pushOff: 'tilt', tilePainter: 'pogo', tankArena: 'swamp', crateToss: 'jungle', dashRace: 'dot' };
/** stage still of a mini-game level (assets/ui/thumbs, captured from the game itself) */
export const thumb = (game: string, variant?: string | null) => {
  const v = variant ?? FIRST[game];
  return `${ASSET_BASE}ui/thumbs/${game}${v ? '_' + v : ''}.jpg`;
};
const kbd = (k: string, alt?: string) => `<kbd${alt ? ` title="or ${alt}"` : ''}>${k}</kbd>`;
/** how-to-play key tokens: keyboard caps, or the touch stick / face buttons */
const KEY_HTML: Record<string, [string, string]> = {
  move: [`${kbd('W')}${kbd('A')}${kbd('S')}${kbd('D')}<i>/</i>${kbd('&larr;')}${kbd('&uarr;')}${kbd('&darr;')}${kbd('&rarr;')}`, '<kbd class="pad">STICK</kbd>'],
  lr: [`${kbd('A')}${kbd('D')}<i>/</i>${kbd('&larr;')}${kbd('&rarr;')}`, '<kbd class="pad">STICK &harr;</kbd>'],
  up: [`${kbd('W')}<i>/</i>${kbd('&uarr;')}`, '<kbd class="pad">STICK &uarr;</kbd>'],
  a: [kbd(KEYS.a[0], KEYS.a[1]), '<kbd class="pad x">&#x2715;</kbd>'],
  b: [kbd(KEYS.b[0], KEYS.b[1]), '<kbd class="pad o">&#x25CB;</kbd>'],
  c: [kbd(KEYS.c[0], KEYS.c[1]), '<kbd class="pad t">&#x25B3;</kbd>'],
  l: [kbd(KEYS.l[0]), ''],
  r: [kbd(KEYS.r[0]), ''],
};
/** a game's controls text ('{a} jump. Hold {b} to ...') as one line per sentence with key caps */
export function controlsHtml(text: string, touch: boolean): string {
  return text.split(/(?<=\.)\s+(?=[{A-Z])/).filter((s) => !(touch && /\{[lr]\}/.test(s))).map((s) =>
    `<li>${esc(s).replace(/\{(\w+)\}/g, (_, k: string) => `<span class="keys">${KEY_HTML[k]?.[touch ? 1 : 0] ?? k}</span>`)}</li>`).join('');
}
const MENU_MOVE = 'sfx/0272/7.mp3', MENU_SELECT = 'sfx/0272/9.mp3';

/**
 * The mini-game pick: a reel of stage cards (stills of every game) that races past a gold frame, slows down and lands;
 * the picked card flips to its real level with the level name stamped on. A twist is announced by Uka Uka.
 */
export class WheelOverlay {
  readonly el = div('overlay wheelov hidden');
  private raf = 0;
  private token = 0;
  private timers: number[] = [];

  hide() { this.token++; cancelAnimationFrame(this.raf); this.timers.forEach(clearTimeout); this.timers = []; this.el.classList.add('hidden'); this.el.classList.remove('twisted', 'landed', 'showdown'); this.el.innerHTML = ''; }

  run(m: WheelMsg, turnLabel: string) {
    this.hide();
    const token = this.token;
    const n = m.options.length;
    // a long strip: several laps, the pick lands on card LAND
    const LAPS = 5, LAND = LAPS * n + m.pick, total = LAND + 4;
    const cards = Array.from({ length: total }, (_, i) => m.options[i % n]);
    this.el.classList.remove('hidden');
    this.el.classList.toggle('showdown', !!m.showdown);
    if (m.showdown) sfx.play('drum');
    this.el.innerHTML = `
      <div class="wheel-head"><small class="sm">${esc(turnLabel)}</small><h2 class="gt or">${m.showdown ? 'LAST ROUND!' : 'NEXT MINI-GAME'}</h2>${m.showdown ? '<em class="gt red">DOUBLE POINTS</em>' : ''}</div>
      <div class="reel"><div class="reel-strip">${cards.map((o, i) => `<div class="rcard" data-i="${i}"><div class="rimg" style="background-image:url('${thumb(o.id)}')"></div><b class="gt or">${esc(o.name.toUpperCase())}</b></div>`).join('')}</div>
        <div class="reel-frame"><i class="ar t"></i><i class="ar b"></i></div></div>
      <div class="wheel-mod hidden"></div>`;
    const strip = this.el.querySelector('.reel-strip') as HTMLElement;
    const reel = this.el.querySelector('.reel') as HTMLElement;
    const first = strip.firstElementChild as HTMLElement;
    const step = first.offsetWidth + parseFloat(getComputedStyle(first).marginRight || '0') + parseFloat(getComputedStyle(first).marginLeft || '0');
    const centre = (i: number) => reel.clientWidth / 2 - (i + 0.5) * step;
    const x0 = centre(1.5), x1 = centre(LAND);
    const spinMs = Math.max(600, m.ms * 0.62);
    const start = performance.now();
    let last = -1;
    const frame = (now: number) => {
      if (token !== this.token) return;
      const k = Math.min(1, (now - start) / spinMs);
      const e = 1 - Math.pow(1 - k, 4);
      const x = x0 + (x1 - x0) * e;
      strip.style.transform = `translateX(${x}px)`;
      const under = Math.floor((reel.clientWidth / 2 - x) / step);
      if (under !== last) { last = under; if (!sfx.playFile(MENU_MOVE, 0.35 + 0.4 * (1 - k))) sfx.play('tick', 0.8 + 0.4 * (1 - k)); }
      if (k < 1) { this.raf = requestAnimationFrame(frame); return; }
      this.land(m, strip.querySelector(`.rcard[data-i="${LAND}"]`) as HTMLElement, token);
    };
    this.raf = requestAnimationFrame(frame);
  }

  private land(m: WheelMsg, card: HTMLElement, token: number) {
    if (!sfx.playFile(MENU_SELECT, 0.8)) sfx.play('reveal');
    this.el.classList.add('landed');
    card.classList.add('win');
    const img = card.querySelector('.rimg') as HTMLElement;
    const opt = m.options[m.pick];
    if (m.variant) {
      img.insertAdjacentHTML('afterend', `<div class="rimg flip" style="background-image:url('${thumb(opt.id, m.variant.id)}')"></div>`);
      card.insertAdjacentHTML('beforeend', `<span class="stamp"><span class="gt wh">${esc(m.variant.name.toUpperCase())}</span></span>`);
    }
    if (m.modifier) {
      const mod = this.el.querySelector('.wheel-mod') as HTMLElement;
      mod.innerHTML = `<img class="uka" src="${UKA}" alt="" draggable="false"><div class="bubble pnl"><small class="sm">UKA UKA'S TWIST!</small><b class="gt red">${esc(m.modifier.name.toUpperCase())}</b><span class="sm">${esc(m.modifier.desc)}</span></div>`;
      this.timers.push(window.setTimeout(() => {
        if (token !== this.token) return;
        mod.classList.remove('hidden');
        // Uka Uka barges in: red flash, the reel shakes, the picked card is shoved crooked
        this.el.classList.remove('twisted'); void this.el.offsetWidth; this.el.classList.add('twisted');
        sfx.play('chaos');
      }, Math.min(700, m.ms * 0.14)));
    }
  }
}

/**
 * Get-ready screen while the level loads: the stage still behind, the game name with its level stamp, the four
 * challengers with their real HUD faces, the rules, and a fuse that burns down until the countdown.
 */
export class IntroOverlay {
  readonly el = div('overlay introov hidden');
  show(m: RoundMsg, variant: { id: string; name: string } | null, mySlot: number | null, seats: SeatView[], touch: boolean, ms = 4000, gameId = '') {
    this.el.classList.remove('hidden');
    const players = [0, 1, 2, 3].map((slot) => {
      const s = seats[slot];
      if (!s) return '<div class="vsp empty"></div>';
      const col = COLORS[s.look.color % COLORS.length].hex;
      return `<div class="vsp ${slot === mySlot ? 'me' : ''}" style="--c:${col};--d:${slot * 90}ms">${face(s.look.char, true)}<b class="nm">${esc(s.name.toUpperCase())}</b>${slot === mySlot ? '<i class="badge">YOU</i>' : s.bot ? '<i class="badge bot">CPU</i>' : ''}</div>`;
    });
    this.el.innerHTML = `
      <div class="intro-bg" style="background-image:url('${thumb(gameId, variant?.id)}')"></div>
      <div class="intro" role="dialog" aria-label="Rules">
        <small class="sm">${m.showdown ? 'LAST ROUND - DOUBLE POINTS' : `ROUND ${m.round} OF ${m.total}`}</small>
        <h1 class="gt red">${esc(m.gameName.toUpperCase())}</h1>
        ${variant ? `<div class="variant"><span class="gt wh">${esc(variant.name.toUpperCase())}</span></div>` : ''}
        <div class="vs">${players.slice(0, 2).join('')}<span class="vsx gt or">VS</span>${players.slice(2).join('')}</div>
        <div class="rules pnl">
          <p><b class="gt wh">GOAL</b> <span class="sm">${esc(m.desc)}</span></p>
          <div class="ctl"><b class="gt wh">CONTROLS</b><ul class="sm">${controlsHtml(m.controls, touch)}</ul></div>
          ${m.modifier ? `<p class="twist"><img src="${UKA}" alt=""><b class="gt red">${esc(m.modifier.name.toUpperCase())}</b> <span class="sm">${esc(m.modifier.desc)}</span></p>` : ''}
        </div>
        <div class="fuse"><i style="animation-duration:${Math.max(500, ms)}ms"></i><span class="sm">GET READY!</span></div>
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

const CROWN = `<span class="crown">${icon('cup')}</span>`;

/** Between-rounds leaderboard: placement pops, counting points, re-sorting rows, crown, streak flames. */
export class ResultsOverlay {
  readonly el = div('overlay resultsov hidden');
  private timers: number[] = [];
  private raf = 0;

  hide() { cancelAnimationFrame(this.raf); this.timers.forEach(clearTimeout); this.timers = []; this.el.classList.add('hidden'); this.el.innerHTML = ''; }

  private later(ms: number, fn: () => void) { this.timers.push(window.setTimeout(fn, ms)); }

  show(m: ResultsMsg, seats: SeatView[], mySlot: number | null, streaks: number[], bg?: string, champ = false) {
    this.hide();
    this.el.classList.remove('hidden');
    this.el.classList.toggle('champ', champ);
    if (champ) bg = undefined;
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
        <div class="la">${face(s.look.char)}${CROWN}</div>
        <div class="ln">${esc(s.name)}${slot === mySlot ? ' <i class="badge">YOU</i>' : ''}<span class="streak hidden"></span></div>
        <div class="lg hidden"><b class="gt grn">+${m.gained[slot] + (m.bonus[slot] || 0)}</b>${m.bonus[slot] ? '<em class="sm">COMEBACK</em>' : ''}</div>
        <div class="lt gt or">${icon('wumpa')}<b>${m.prev[slot]}</b></div>
        <div class="ls gt wh">${icon('cup')}<b>${prevTrophies[slot]}</b></div>
      </div>`;
    }).join('');
    const ws = seats[winner];
    this.el.innerHTML = `${bg ? `<div class="intro-bg res-bg" style="background-image:url('${bg}')"></div>` : ''}
    ${ws ? `<div class="res-hero" style="--c:${COLORS[ws.look.color % COLORS.length].hex}">${champ ? '' : face(ws.look.char, true)}<div class="rh-txt"><b class="gt wh">${esc(ws.name.toUpperCase())}</b><span class="stamp2"><span class="gt or">WINS!</span></span></div></div>` : ''}
    <div class="results pnl">
      <div class="band"><h2 class="gt or">${m.final ? 'FINAL ROUND' : `ROUND ${m.round} OF ${m.total}`}</h2>${m.showdown ? '<div class="sm">DOUBLE POINTS</div>' : ''}</div>
      <div class="pbody"><div class="lboard">${rows}</div>
      ${lastNext ? '<div class="lastround gt wh">LAST ROUND - DOUBLE POINTS!</div>' : m.final ? '' : `<div class="hint sm">NEXT: ROUND ${m.round + 1} OF ${m.total}</div>`}</div>
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
      if (after[0] !== before[0] && m.scores[leadSlot] > 0) {
        // a new leader takes the crown: stinger + tag on the row
        sfx.play('crystal');
        pop(q(leadSlot).querySelector('.crown') as HTMLElement, 'crownpop');
        const tag = document.createElement('span');
        tag.className = 'newlead gt or';
        tag.textContent = 'NEW LEADER!';
        q(leadSlot).querySelector('.ln')!.appendChild(tag);
        pop(tag, 'stamped');
      }
      for (let i = 0; i < 4; i++) {
        const st = q(i).querySelector('.streak') as HTMLElement;
        if ((streaks[i] ?? 0) >= 2) { st.textContent = `${streaks[i]} IN A ROW!`; st.classList.remove('hidden'); pop(st, 'pop'); }
      }
      if (lastNext) sfx.play('chaos');
    });
  }
}
