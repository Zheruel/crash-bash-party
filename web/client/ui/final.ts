import type { Award, ResultsMsg } from '../../shared/protocol';
import { PodiumScene, preloadPodium } from '../scene/podium';
import { Confetti } from '../shell/confetti';
import { sfx } from '../shell/sound';
import { div, esc, face, icon, MENU_PLAYERS, pop, sleep } from './dom';
import type { Hud, SeatView } from './hud';
import './round-screens.css';

export interface FinalDeps {
  podium: PodiumScene;
  hud: Hud;
  confetti: Confetti;
  showPodium(): void;
  canVote?: boolean;
  onRematch(): void;
  onLeave(): void;
}

/** Final ceremony: awards one by one, podium reveal, winner celebration. */
export class FinalOverlay {
  readonly el = div('overlay round-screen finalov hidden');
  private token = 0;
  private stars: number[] = [];
  private voted = false;
  private votes = 0;
  private humans = 1;
  private rematchBtn: HTMLButtonElement | null = null;

  hide() { this.token++; this.rematchBtn = null; this.el.classList.add('hidden'); this.el.innerHTML = ''; }

  /** Update the rematch vote counter. */
  setVotes(votes: number, humans: number) {
    this.votes = votes;
    this.humans = humans;
    if (!this.rematchBtn) return;
    this.rematchBtn.textContent = this.voted ? `WAITING... ${votes}/${humans}` : humans > 1 ? `REMATCH ${votes}/${humans}` : 'REMATCH';
    this.rematchBtn.classList.toggle('on', this.voted);
    this.rematchBtn.disabled = this.voted;
  }

  /** Stars shown on the cards while the ceremony runs. */
  get currentStars() { return this.stars; }

  async run(m: ResultsMsg, seats: SeatView[], ms: number, deps: FinalDeps, introMs: number, podiumAt = performance.now()) {
    this.rematchBtn = null;
    this.voted = false;
    const token = ++this.token;
    const alive = () => token === this.token;
    const scale = Math.max(0.25, Math.min(1, (ms - introMs) / 22000));
    const wait = async (t: number) => { await sleep(t * scale * 1000); return alive(); };

    this.stars = [...m.stars];
    const rank = [0, 1, 2, 3].sort((a, b) => m.scores[b] - m.scores[a] || m.stars[b] - m.stars[a] || a - b);
    this.el.classList.remove('hidden');
    this.el.innerHTML = '<div class="award-slot"></div><div class="winner-slot"></div><div class="final-actions hidden"></div>';
    const awardSlot = this.el.querySelector('.award-slot') as HTMLElement;
    const winSlot = this.el.querySelector('.winner-slot') as HTMLElement;
    const actions = this.el.querySelector('.final-actions') as HTMLElement;
    const podiumReady = !m.cupsToWin || await preloadPodium();
    if (!alive()) return;
    // equal points and trophies share a place on the podium, as tied scores do in the game
    deps.podium.setup(rank, seats.map((s) => s.look), seats.map((s) => s.name), m.scores.map((p, i) => p * 1000 + (m.stars[i] ?? 0)));
    deps.podium.setStrip(seats.map((s) => s.look), m.scores);
    deps.showPodium();
    if (m.cupsToWin) {
      deps.podium.playReal(Math.min(720, Math.max(0, Math.floor((performance.now() - podiumAt) * 30 / 1000))));
      const names = m.winners.map(i => seats[i].name).join(' & ');
      winSlot.innerHTML = `<span class="sr-only" role="status">${esc(names)} wins the cup battle.</span>`;
    } else {
      if (!(await wait(0.8))) return;

      // awards (bonus stars first)
      for (const a of m.awards) {
        awardSlot.innerHTML = this.awardHtml(a, seats);
        pop(awardSlot.firstElementChild as HTMLElement, 'award-in');
        sfx.play('reveal');
        if (!(await wait(2.1))) return;
        awardSlot.firstElementChild?.classList.add('award-out');
        if (!(await wait(0.35))) return;
      }
      awardSlot.innerHTML = '';

      // podium reveal, last place first
      sfx.play('drum');
      winSlot.innerHTML = '<div class="drum gt wh">AND THE WINNER IS...</div>';
      if (!(await wait(1.2))) return;
      for (let r = 3; r >= 0; r--) {
        deps.podium.reveal(r);
        sfx.play('reveal', 0.8 + (3 - r) * 0.12);
        if (!(await wait(r === 1 ? 1.5 : 1.0))) return;
      }

      // celebration
      const winners = m.winners.length ? m.winners : [rank[0]];
      const names = winners.map((slot) => seats[slot].name);
      deps.podium.celebrate(winners);
      winSlot.innerHTML = `<div class="winner">
        <small class="round-kicker">${winners.length > 1 ? 'Tie for first' : 'Party champion'}</small>
        <h2 class="gt or">${esc(names.join(' & '))}</h2></div>`;
      pop(winSlot.firstElementChild as HTMLElement, 'award-in');
      sfx.play('win'); // the scene brings the game's own fireworks, trophy and crowd (no confetti over them)
    }
    // the game's score strip comes up under the podium, holds 240 frames and slides away (a tap or key skips the
    // hold, as cross does); the buttons come in where it was
    const skip = () => deps.podium.skipStrip();
    addEventListener('pointerdown', skip); addEventListener('keydown', skip);
    const t0 = performance.now();
    while (podiumReady && !deps.podium.stripDone && performance.now() - t0 < (m.cupsToWin ? 24000 : 14000)) if (!(await sleep(100), alive())) break;
    removeEventListener('pointerdown', skip); removeEventListener('keydown', skip);
    if (!alive()) return;
    actions.classList.remove('hidden');
    pop(actions, 'award-in');
    actions.innerHTML = `<div class="menu">${deps.canVote !== false ? '<button class="mi big" id="rematch">REMATCH</button>' : ''}<button class="mi" id="leave-final">LEAVE PARTY</button></div>`;
    this.rematchBtn = actions.querySelector('#rematch');
    if (this.rematchBtn) {
      this.setVotes(this.votes, this.humans);
      this.rematchBtn.onclick = () => {
        this.voted = true;
        this.setVotes(this.votes, this.humans);
        sfx.play('click');
        deps.onRematch();
      };
    }
    (actions.querySelector('#leave-final') as HTMLElement).onclick = () => { sfx.play('click'); deps.onLeave(); };
  }

  private awardHtml(a: Award, seats: SeatView[]) {
    const s = seats[a.slot];
    return `<div class="award" style="--c:${MENU_PLAYERS[a.slot].color}">
      <div class="ai">${icon('cup')}</div>
      <div class="at"><b class="gt or">${esc(a.title.toUpperCase())}</b><span class="sm">${esc(a.desc)}</span></div>
      <div class="ap">${face(s.look.char, true)}<b>${esc(s.name)}</b></div></div>`;
  }
}
