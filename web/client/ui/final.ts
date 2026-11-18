import { COLORS, CHARACTERS } from '../../shared/look';
import type { Award, ResultsMsg } from '../../shared/protocol';
import { PodiumScene } from '../scene/podium';
import { Confetti } from '../shell/confetti';
import { avatarHtml } from '../shell/avatar';
import { sfx } from '../shell/sound';
import { div, esc, pop, sleep } from './dom';
import type { Hud, SeatView } from './hud';

export interface FinalDeps {
  podium: PodiumScene;
  hud: Hud;
  confetti: Confetti;
  showPodium(): void;
  onRematch(): void;
  onLobby(): void;
}

/** Final ceremony: awards one by one, podium reveal, winner celebration. */
export class FinalOverlay {
  readonly el = div('overlay finalov hidden');
  private token = 0;
  private stars: number[] = [];
  private rematchBtn: HTMLButtonElement | null = null;

  hide() { this.token++; this.el.classList.add('hidden'); this.el.innerHTML = ''; }

  /** Update the rematch vote counter. */
  setVotes(votes: number, humans: number, voted: boolean) {
    if (!this.rematchBtn) return;
    this.rematchBtn.textContent = voted ? `WAITING... ${votes}/${humans}` : humans > 1 ? `REMATCH ${votes}/${humans}` : 'REMATCH';
    this.rematchBtn.classList.toggle('on', voted);
  }

  /** Stars shown on the cards while the ceremony runs. */
  get currentStars() { return this.stars; }

  async run(m: ResultsMsg, seats: SeatView[], ms: number, deps: FinalDeps, introMs: number) {
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
    deps.podium.setup(rank, seats.map((s) => s.look), seats.map((s) => s.name));
    deps.showPodium();
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
    winSlot.innerHTML = '<div class="drum">AND THE WINNER IS...</div>';
    if (!(await wait(1.2))) return;
    for (let r = 3; r >= 0; r--) {
      deps.podium.reveal(r);
      sfx.play('reveal', 0.8 + (3 - r) * 0.12);
      if (!(await wait(r === 1 ? 1.5 : 1.0))) return;
    }

    // celebration
    const names = m.winners.map((w) => seats[w].name);
    const w0 = seats[m.winners[0] ?? rank[0]];
    deps.podium.celebrate(m.winners.length ? m.winners : [rank[0]]);
    winSlot.innerHTML = `<div class="winner" style="--c:${COLORS[w0.look.color % COLORS.length].hex}">
      ${m.winners.length > 1 ? "IT'S A TIE!" : `${esc(CHARACTERS[w0.look.char % CHARACTERS.length].name.toUpperCase())} WINS!`}
      <small>${esc(names.join(' & '))}</small></div>`;
    pop(winSlot.firstElementChild as HTMLElement, 'award-in');
    sfx.play('win');
    deps.confetti.burst(innerWidth * 0.25, innerHeight * 0.5, 90);
    deps.confetti.burst(innerWidth * 0.75, innerHeight * 0.5, 90);
    deps.confetti.rain(8);
    actions.classList.remove('hidden');
    actions.innerHTML = '<button class="btn big" id="rematch">REMATCH</button><button class="btn ghost" id="tolobby">Back to lobby</button>';
    this.rematchBtn = actions.querySelector('#rematch');
    this.rematchBtn!.onclick = () => { sfx.play('click'); deps.onRematch(); };
    (actions.querySelector('#tolobby') as HTMLElement).onclick = () => { sfx.play('click'); deps.onLobby(); };
  }

  private awardHtml(a: Award, seats: SeatView[]) {
    const s = seats[a.slot];
    return `<div class="award crate" style="--c:${COLORS[s.look.color % COLORS.length].hex}">
      <div class="ai"><i class="medal"></i></div>
      <div class="at"><small>AWARD</small><b>${esc(a.title.toUpperCase())}</b><span>${esc(a.desc)}</span></div>
      <div class="ap">${avatarHtml(s.look)}<b>${esc(s.name)}</b></div></div>`;
  }
}
