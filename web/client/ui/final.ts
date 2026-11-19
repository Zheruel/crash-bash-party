import { COLORS, CHARACTERS } from '../../shared/look';
import type { Award, ResultsMsg } from '../../shared/protocol';
import { PodiumScene } from '../scene/podium';
import { Confetti } from '../shell/confetti';
import { sfx } from '../shell/sound';
import { div, esc, face, icon, pop, sleep } from './dom';
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
    // equal points and trophies share a place on the podium, as tied scores do in the game
    deps.podium.setup(rank, seats.map((s) => s.look), seats.map((s) => s.name), m.scores.map((p, i) => p * 1000 + (m.stars[i] ?? 0)));
    deps.podium.setStrip(seats.map((s) => s.look), m.scores);
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
    winSlot.innerHTML = '<div class="drum gt wh">AND THE WINNER IS...</div>';
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
      <div class="gt or">${m.winners.length > 1 ? "IT'S A TIE!" : `${esc(CHARACTERS[w0.look.char % CHARACTERS.length].name.toUpperCase())} WINS!`}</div>
      <small class="gt wh">${esc(names.join(' & ').toUpperCase())}</small></div>`;
    pop(winSlot.firstElementChild as HTMLElement, 'award-in');
    sfx.play('win'); // the scene brings the game's own fireworks, trophy and crowd (no confetti over them)
    // the game's score strip comes up under the podium, holds 240 frames and slides away (a tap or key skips the
    // hold, as cross does); the buttons come in where it was
    const skip = () => deps.podium.skipStrip();
    addEventListener('pointerdown', skip); addEventListener('keydown', skip);
    const t0 = performance.now();
    while (!deps.podium.stripDone && performance.now() - t0 < 14000) if (!(await sleep(100), alive())) break;
    removeEventListener('pointerdown', skip); removeEventListener('keydown', skip);
    if (!alive()) return;
    actions.classList.remove('hidden');
    pop(actions, 'award-in');
    actions.innerHTML = '<div class="menu"><button class="mi big" id="rematch">REMATCH</button><button class="mi" id="tolobby">BACK TO LOBBY</button></div>';
    this.rematchBtn = actions.querySelector('#rematch');
    this.rematchBtn!.onclick = () => { sfx.play('click'); deps.onRematch(); };
    (actions.querySelector('#tolobby') as HTMLElement).onclick = () => { sfx.play('click'); deps.onLobby(); };
  }

  private awardHtml(a: Award, seats: SeatView[]) {
    const s = seats[a.slot];
    return `<div class="award pnl" style="--c:${COLORS[s.look.color % COLORS.length].hex}">
      <div class="ai">${icon('cup')}</div>
      <div class="at"><small class="sm">AWARD</small><b class="gt or">${esc(a.title.toUpperCase())}</b><span class="sm">${esc(a.desc)}</span></div>
      <div class="ap">${face(s.look.char)}<b class="sm">${esc(s.name)}</b></div></div>`;
  }
}
