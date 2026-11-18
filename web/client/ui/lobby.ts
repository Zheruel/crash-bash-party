import { COLORS, EMOTES, type Look } from '../../shared/look';
import type { RoomState } from '../../shared/protocol';
import { sfx } from '../shell/sound';
import { avatarHtml } from '../shell/avatar';
import { $, esc, pop } from './dom';
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
    const settings = isHost
      ? `<div class="set"><label>Rounds</label><div class="stepper"><button class="btn sq" data-act="rounds" data-d="-1">&minus;</button><b id="rounds">${room.totalRounds}</b><button class="btn sq" data-act="rounds" data-d="1">+</button></div></div>
         <div class="set"><label>Bots</label><div class="seg">${LEVELS.map((l, i) => `<button class="${i === room.botLevel ? 'on' : ''}" data-act="bot" data-v="${i}">${l}</button>`).join('')}</div></div>`
      : `<div class="set ro"><label>Rounds</label><b>${room.totalRounds}</b></div><div class="set ro"><label>Bots</label><b>${LEVELS[room.botLevel] ?? ''}</b></div>`;
    const main = my
      ? `<button class="btn big ${my.ready ? 'on' : ''}" data-act="ready">${my.ready ? 'READY!  (tap to cancel)' : 'READY UP'}</button>`
      : `<button class="btn big" data-act="sit" ${freeSeat ? '' : 'disabled'}>${freeSeat ? 'TAKE A SEAT' : 'PARTY IS FULL'}</button>`;
    const specs = room.spectators.length ? `<div class="specs">Watching: ${room.spectators.map((s) => esc(s.name)).join(', ')}</div>` : '';
    this.el.innerHTML = `
      <div class="lb-top">
        <div class="roomcode crate"><small>ROOM CODE</small><b>${esc(room.code)}</b></div>
        <button class="btn" data-act="copy"><span id="copylbl">Copy invite link</span></button>
      </div>
      <div class="tags">${room.seats.map((s, i) => `
        <div class="seat-tag ${s.ready ? 'ready' : ''} ${s.clientId == null ? 'bot' : ''} ${s.clientId === me ? 'me' : ''} ${s.connected ? '' : 'lost'}" style="--c:${COLORS[s.look.color % COLORS.length].hex}">
          <div class="emo"></div>
          <div class="nm">${s.clientId === room.hostId ? '<i class="crown"></i>' : ''}${esc(s.name)}</div>
          <div class="stt">${s.clientId == null ? 'BOT' : !s.connected ? 'LOST' : s.ready ? 'READY' : '...'}</div>
        </div>`).join('')}</div>
      <div class="lb-bottom crate">
        <div class="lb-settings">${settings}</div>
        <div class="lb-main">${main}</div>
        <div class="lb-row">
          ${my ? `<button class="btn ghost small" data-act="look">Change hero</button><button class="btn ghost small" data-act="sit-out">Sit out</button>` : ''}
          <div class="emotes">${EMOTES.map((e, i) => `<button class="emo-btn" data-act="emote" data-i="${i}">${e}</button>`).join('')}</div>
          <button class="btn ghost small" data-act="leave">Leave</button>
        </div>
        <div class="lb-hint">${humans.length > 1 ? `${readyN}/${humans.length} ready` : 'Share the code or link. Empty seats become bots.'}${specs}</div>
      </div>`;
    this.tags = [...this.el.querySelectorAll<HTMLElement>('.seat-tag')];
    // keep the modal across re-renders
    if (this.modal) this.el.appendChild(this.modal);
    void avatarHtml;
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
    l.textContent = ok ? 'Link copied!' : 'Copy failed';
    setTimeout(() => { const x = $('#copylbl', this.el); if (x) x.textContent = 'Copy invite link'; }, 1800);
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
      case 'bot': this.h.config({ botLevel: Number(t.dataset.v) }); break;
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
    m.innerHTML = '<div class="crate card"><h2>Pick your hero</h2><div class="host"></div><button class="btn big" data-act="close">DONE</button></div>';
    const taken = () => new Set((this.room?.seats ?? []).filter((s) => s.clientId != null && s.clientId !== this.me).map((s) => s.look.color));
    const picker = new LookPicker(look, (l) => this.h.look(l), taken);
    $('.host', m).appendChild(picker.el);
    this.modal = m;
    this.el.appendChild(m);
  }
}
