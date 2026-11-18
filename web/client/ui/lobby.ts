import { COLORS, EMOTES, type Look } from '../../shared/look';
import type { RoomState } from '../../shared/protocol';
import { sfx } from '../shell/sound';
import { $, esc, face, icon, pop } from './dom';
import { LookPicker } from './picker';

export interface LobbyHandlers {
  ready(r: boolean): void;
  seat(take: boolean): void;
  config(c: { rounds?: number; botLevel?: number }): void;
  look(l: Look): void;
  emote(id: number): void;
  leave(): void;
  copy(): void;
}

const LEVELS = ['Easy', 'Normal', 'Hard'];

export class LobbyScreen {
  readonly el = document.createElement('div');
  private tags: HTMLElement[] = [];
  private room: RoomState | null = null;
  private me = 0;
  private link = '';
  private modal: HTMLElement | null = null;

  constructor(private h: LobbyHandlers) {
    this.el.className = 'screen lobby hidden';
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  show(on: boolean) { this.el.classList.toggle('hidden', !on); if (!on) this.closeModal(); }

  update(room: RoomState, me: number, link: string) {
    this.room = room;
    this.me = me;
    this.link = link;
    const mySeat = room.seats.findIndex((s) => s.clientId === me);
    const isHost = room.hostId === me;
    const humans = room.seats.filter((s) => s.clientId != null);
    const readyN = humans.filter((s) => s.ready).length;
    const freeSeat = room.seats.some((s) => s.clientId == null);
    const my = mySeat >= 0 ? room.seats[mySeat] : null;
    const stepper = (act: string, label: string, val: string, ic = '') => `
      <div class="opt"><span class="sm">${label}</span>
        <div class="stepper"><button class="arr" data-act="${act}" data-d="-1" aria-label="Fewer ${label.toLowerCase()}">&#9664;</button><b class="gt or" id="${act}">${val}${ic}</b><button class="arr" data-act="${act}" data-d="1" aria-label="More ${label.toLowerCase()}">&#9654;</button></div></div>`;
    const settings = isHost
      ? `${stepper('rounds', 'ROUNDS', String(room.totalRounds), icon('cup'))}${stepper('bot', 'BOTS', LEVELS[room.botLevel]?.toUpperCase() ?? '')}`
      : `<div class="opt"><span class="sm">ROUNDS</span><b class="gt or">${room.totalRounds}${icon('cup')}</b></div><div class="opt"><span class="sm">BOTS</span><b class="gt or">${(LEVELS[room.botLevel] ?? '').toUpperCase()}</b></div>`;
    const main = my
      ? `<button class="mi big ${my.ready ? 'on' : ''}" data-act="ready" aria-pressed="${my.ready}">${my.ready ? 'READY!' : 'READY UP'}</button>`
      : `<button class="mi big" data-act="sit" ${freeSeat ? '' : 'disabled'}>${freeSeat ? 'TAKE A SEAT' : 'PARTY IS FULL'}</button>`;
    const specs = room.spectators.length ? ` &middot; WATCHING: ${room.spectators.map((s) => esc(s.name)).join(', ')}` : '';
    this.el.innerHTML = `
      <div class="lb-top">
        <div class="roomcode pnl"><span class="sm">ROOM CODE</span><b class="gt wh">${esc(room.code)}</b></div>
        <button class="mi small" data-act="copy"><span id="copylbl">COPY INVITE LINK</span></button>
      </div>
      <div class="tags">${room.seats.map((s, i) => `
        <div class="seat-tag ${s.ready ? 'ready' : ''} ${s.clientId == null ? 'bot' : ''} ${s.clientId === me ? 'me' : ''} ${s.connected ? '' : 'lost'}" style="--c:${COLORS[s.look.color % COLORS.length].hex}">
          <div class="emo" aria-hidden="true"></div>
          ${face(s.look.char)}
          <div class="st-txt"><div class="nm">${esc(s.name)}</div>
          <div class="stt">${s.clientId === room.hostId ? '<i class="badge">HOST</i> ' : ''}${s.clientId == null ? 'BOT' : !s.connected ? 'LOST' : s.ready ? 'READY' : 'WAITING'}</div></div>
        </div>`).join('')}</div>
      <div class="lb-bottom pnl">
        <div class="band"><h2 class="gt or">GAME OPTIONS</h2></div>
        <div class="pbody">
          <div class="lb-settings">${settings}</div>
          <div class="lb-main menu">${main}</div>
          <div class="lb-row">
            ${my ? `<button class="mi small" data-act="look">CHANGE HERO</button><button class="mi small" data-act="sit-out">SIT OUT</button>` : ''}
            <div class="emotes">${EMOTES.map((e, i) => `<button class="emo-btn" data-act="emote" data-i="${i}" aria-label="Emote ${i + 1}">${e}</button>`).join('')}</div>
            <button class="mi small" data-act="leave">LEAVE</button>
          </div>
          <div class="lb-hint sm" aria-live="polite">${humans.length > 1 ? `${readyN}/${humans.length} READY` : 'SHARE THE CODE OR LINK &middot; EMPTY SEATS BECOME BOTS'}${specs}</div>
        </div>
      </div>`;
    this.tags = [...this.el.querySelectorAll<HTMLElement>('.seat-tag')];
    // keep the modal across re-renders
    if (this.modal) this.el.appendChild(this.modal);
  }

  /** Position the name tags under the 3D characters (CSS px). */
  placeTags(pts: { x: number; y: number }[]) {
    this.tags.forEach((t, i) => {
      const p = pts[i];
      if (!p) return;
      t.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, 0)`;
    });
  }

  emote(slot: number, id: number) {
    const t = this.tags[slot];
    if (!t) return;
    const e = $('.emo', t);
    e.textContent = EMOTES[id] ?? '';
    pop(e, 'emo-pop');
  }

  flashCopied(ok: boolean) {
    const l = $('#copylbl', this.el);
    if (!l) return;
    l.textContent = ok ? 'LINK COPIED!' : 'COPY FAILED';
    setTimeout(() => { const x = $('#copylbl', this.el); if (x) x.textContent = 'COPY INVITE LINK'; }, 1800);
  }

  private closeModal() { this.modal?.remove(); this.modal = null; }

  private onClick(e: MouseEvent) {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!t || !this.room) return;
    const room = this.room;
    const mySeat = room.seats.findIndex((s) => s.clientId === this.me);
    sfx.play('click');
    switch (t.dataset.act) {
      case 'ready': this.h.ready(!room.seats[mySeat]?.ready); break;
      case 'sit': this.h.seat(true); break;
      case 'sit-out': this.h.seat(false); break;
      case 'rounds': this.h.config({ rounds: Math.max(3, Math.min(20, room.totalRounds + Number(t.dataset.d))) }); break;
      case 'bot': this.h.config({ botLevel: Math.max(0, Math.min(LEVELS.length - 1, room.botLevel + Number(t.dataset.d))) }); break;
      case 'copy': this.h.copy(); break;
      case 'emote': this.h.emote(Number(t.dataset.i)); break;
      case 'leave': this.h.leave(); break;
      case 'look': this.openPicker(room.seats[mySeat].look); break;
      case 'close': this.closeModal(); break;
    }
  }

  private openPicker(look: Look) {
    const m = document.createElement('div');
    m.className = 'modal';
    m.innerHTML = '<div class="pnl card" role="dialog" aria-modal="true" aria-label="Pick your hero"><div class="band"><h2 class="gt or">CHARACTER SELECT</h2></div><div class="pbody"><div class="host"></div><div class="menu"><button class="mi big" data-act="close">DONE</button></div></div></div>';
    const taken = () => new Set((this.room?.seats ?? []).filter((s) => s.clientId != null && s.clientId !== this.me).map((s) => s.look.color));
    const picker = new LookPicker(look, (l) => this.h.look(l), taken);
    $('.host', m).appendChild(picker.el);
    this.modal = m;
    this.el.appendChild(m);
  }
}
