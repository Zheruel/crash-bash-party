import { EMOTES, EMOTE_LABELS, type Look } from '../../shared/look';
import { DEFAULT_CUPS_TO_WIN, MAX_CUPS_TO_WIN, MIN_CUPS_TO_WIN, type MatchConfig, type RoomState } from '../../shared/protocol';
import { sfx } from '../shell/sound';
import { $, esc, icon, MENU_PLAYERS, selectFace, pop } from './dom';
import { thumb } from './overlays';
import { LookPicker } from './picker';

export interface LobbyHandlers {
  ready(r: boolean): void;
  seat(take: boolean): void;
  config(c: MatchConfig): void;
  look(l: Look): void;
  emote(id: number): void;
  copy(): void;
}

const LEVELS = ['Easy', 'Normal', 'Hard'];

export class LobbyScreen {
  readonly el = document.createElement('div');
  private content = document.createElement('div');
  private dialog = document.createElement('dialog');
  private room: RoomState | null = null;
  private me = 0;
  private openedBy = '';
  private copyTimer = 0;

  constructor(private h: LobbyHandlers) {
    this.el.className = 'screen lobby hidden';
    this.dialog.className = 'party-dialog';
    this.dialog.setAttribute('aria-labelledby', 'party-dialog-heading');
    this.el.append(this.content, this.dialog);
    this.el.addEventListener('click', e => this.onClick(e));
    this.dialog.addEventListener('change', (e) => {
      const select = e.target as HTMLSelectElement;
      if (select.id !== 'party-stage' || this.room?.hostId !== this.me) return;
      sfx.play('select');
      this.h.config({ stage: select.value || null });
    });
    this.dialog.addEventListener('close', () => {
      // The close event can arrive after another lobby dialog has already opened.
      if (this.dialog.open) return;
      const focus = document.activeElement;
      if (focus === document.body || this.dialog.contains(focus)) {
        this.content.querySelector<HTMLButtonElement>(`[data-act="${this.openedBy}"]`)?.focus({ preventScroll: true });
      }
      this.openedBy = '';
    });
  }

  show(on: boolean) {
    this.el.classList.toggle('hidden', !on);
    if (!on && this.dialog.open) this.dialog.close();
  }

  update(room: RoomState, me: number) {
    const before = this.room;
    const wasHost = before?.hostId === this.me;
    this.room = room;
    this.me = me;
    const focus = document.activeElement as HTMLElement | null;
    const my = room.seats.find(s => s.clientId === me);
    const humans = room.seats.filter(s => s.clientId != null);
    const canSit = humans.length < room.seats.length;
    const readyLabel = my?.ready ? 'Cancel ready' : room.hostId === me && humans.length === 1 ? 'Start party' : 'Ready up';
    const roster = room.seats.map((s, slot) => {
      const status = s.clientId == null ? 'CPU' : !s.connected ? 'Disconnected' :
        [s.clientId === me ? 'You' : '', s.clientId === room.hostId ? 'Host' : '', s.ready ? 'Ready' : ''].filter(Boolean).join(' · ') || 'Waiting';
      return `<li class="party-seat" style="--seat:${MENU_PLAYERS[slot].color}">
        <span class="emo" aria-hidden="true"></span>${selectFace(s.look.char)}<div><b>${esc(s.name)}</b><small>${status}</small></div></li>`;
    }).join('');
    this.content.innerHTML = `<header class="party-head"><h1 class="gt or">Party lobby</h1>
      <button class="invite" data-act="copy" aria-label="Copy invite link for room ${esc(room.code)}"><span>Room code</span><strong>${esc(room.code)}</strong><span id="copylbl" aria-live="polite">Copy invite</span></button></header>
      <div class="party-dock"><ul class="party-roster" aria-label="Party seats">${roster}</ul>
        <div class="party-bar"><button class="quiet" data-act="settings">Match settings</button>
        ${my ? '<button class="quiet" data-act="look">Change hero</button>' : ''}
        <button class="quiet" data-act="more" aria-label="More party options">•••</button>
        <span class="ready-count">${humans.length > 1 ? humans.filter(s => s.ready).length + '/' + humans.length + ' ready' : ''}</span>
        <button class="primary" data-act="${my ? 'ready' : 'sit'}" ${!my && !canSit ? 'disabled' : ''}>${my ? readyLabel : canSit ? 'Take a seat' : 'Party full'}</button></div>
        ${room.spectators.length ? `<p class="watching">Watching · ${room.spectators.map(s => esc(s.name)).join(', ')}</p>` : ''}</div>`;
    if (this.dialog.open && this.openedBy === 'settings' && (
      !before || before.code !== room.code || wasHost !== (room.hostId === me)
      || before.totalRounds !== room.totalRounds || before.botLevel !== room.botLevel
      || before.twists !== room.twists || before.stage !== room.stage
      || before.winCondition !== room.winCondition || before.cupsToWin !== room.cupsToWin
      || !!before.stages?.length !== !!room.stages?.length
    )) this.renderSettings();
    if (focus?.dataset.act && !focus.isConnected) {
      const root = this.dialog.open ? this.dialog : this.content;
      const action = `[data-act="${focus.dataset.act}"]:not(:disabled)`;
      const delta = focus.dataset.d ? `[data-d="${focus.dataset.d}"]` : '';
      // If a stepper reaches its limit, keep focus on its other button.
      const next = root.querySelector<HTMLElement>(action + delta) ?? root.querySelector<HTMLElement>(action);
      next?.focus({ preventScroll: true });
    }
  }

  emote(slot: number, id: number) {
    const e = this.content.querySelectorAll<HTMLElement>('.emo')[slot];
    if (e) { e.textContent = EMOTES[id] ?? ''; pop(e, 'emo-pop'); }
  }

  flashCopied(ok: boolean) {
    const label = $('#copylbl', this.content);
    if (!label) return;
    label.textContent = ok ? 'Copied!' : 'Copy failed';
    window.clearTimeout(this.copyTimer);
    this.copyTimer = window.setTimeout(() => { const l = $('#copylbl', this.content); if (l) l.textContent = 'Copy invite'; }, 1800);
  }

  private dialogBody(title: string, content: string) {
    this.dialog.innerHTML = `<header><h2 class="gt or" id="party-dialog-heading">${title}</h2><button class="quiet close-dialog" data-act="close" aria-label="Close">×</button></header>${content}`;
  }

  private renderSettings() {
    const r = this.room!;
    const host = r.hostId === this.me;
    // Hosts running older versions omit the stage catalog.
    const stages = r.stages ?? [];
    const stage = stages.find((s) => s.id === r.stage);
    const canChooseStage = host && stages.length > 0;
    const cups = r.winCondition === 'cups';
    const randomLabel = cups ? 'Random stage' : 'Shuffled';
    const stageRow = `<div class="option">${canChooseStage ? '<label for="party-stage">Stage</label>' : '<span>Stage</span>'}
      <div class="stage-value">${stage ? `<img src="${esc(thumb(stage.gameId, stage.variantId))}" alt="">` : ''}
      ${canChooseStage ? `<select id="party-stage" data-act="stage">
        <option value="">${randomLabel}</option>
        ${stages.map((s) => `<option value="${esc(s.id)}" ${s === stage ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
      </select>` : `<b>${esc(stage?.name ?? randomLabel)}</b>`}</div></div>`;
    const stepper = (label: string, act: string, value: string, index: number, min: number, max: number) =>
      `<div class="option"><span>${label}</span><div>${host ? `<button class="quiet" data-act="${act}" data-d="-1" aria-label="Decrease ${label}" ${index <= min ? 'disabled' : ''}>−</button>` : ''}<b>${value}</b>${host ? `<button class="quiet" data-act="${act}" data-d="1" aria-label="Increase ${label}" ${index >= max ? 'disabled' : ''}>+</button>` : ''}</div></div>`;
    const modeName = cups ? 'Cup battle' : 'Points party';
    const mode = r.winCondition === undefined ? '' : `<div class="option"><span>Mode</span>
      ${host ? `<button class="quiet" data-act="mode" aria-label="Change match mode, currently ${modeName}">${modeName}</button>` : `<b>${modeName}</b>`}</div>`;
    const cupTarget = r.cupsToWin ?? DEFAULT_CUPS_TO_WIN;
    const target = cups ? stepper('Cups to win', 'cups', `${cupTarget} ${icon('cup')}`, cupTarget, MIN_CUPS_TO_WIN, MAX_CUPS_TO_WIN)
      : stepper('Rounds', 'rounds', String(r.totalRounds), r.totalRounds, 1, 20);
    const twists = cups ? '' : `<div class="option"><span>Party twists</span>${host ? `<button class="quiet" data-act="twists" aria-pressed="${r.twists}">${r.twists ? 'On' : 'Off'}</button>` : `<b>${r.twists ? 'On' : 'Off'}</b>`}</div>`;
    this.dialogBody('Match settings', mode + stageRow + target + stepper('CPU difficulty', 'bot', LEVELS[r.botLevel], r.botLevel, 0, 2) + twists);
  }

  private onClick(e: MouseEvent) {
    if (e.target === this.dialog) {
      const box = this.dialog.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) this.dialog.close();
      return;
    }
    const t = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-act]');
    if (!t || !this.room) return;
    const room = this.room, my = room.seats.find(s => s.clientId === this.me);
    sfx.play('select');
    switch (t.dataset.act) {
      case 'ready': this.h.ready(!my?.ready); break;
      case 'sit': this.h.seat(true); break;
      case 'sit-out': this.dialog.close(); this.h.seat(false); break;
      case 'mode': this.h.config({ winCondition: room.winCondition === 'cups' ? 'rounds' : 'cups' }); break;
      case 'cups': this.h.config({ cupsToWin: (room.cupsToWin ?? DEFAULT_CUPS_TO_WIN) + Number(t.dataset.d) }); break;
      case 'rounds': this.h.config({ rounds: Math.max(1, Math.min(20, room.totalRounds + Number(t.dataset.d))) }); break;
      case 'twists': this.h.config({ twists: !room.twists }); break;
      case 'bot': this.h.config({ botLevel: Math.max(0, Math.min(2, room.botLevel + Number(t.dataset.d))) }); break;
      case 'copy': this.h.copy(); break;
      case 'emote': this.dialog.close(); this.h.emote(Number(t.dataset.i)); break;
      case 'close': this.dialog.close(); break;
      case 'settings': case 'look': case 'more':
        this.openedBy = t.dataset.act;
        if (this.openedBy === 'settings') this.renderSettings();
        else if (this.openedBy === 'look' && my) {
          this.dialogBody('Choose your hero', '<div class="hero-host"></div>');
          $('.hero-host', this.dialog).append(new LookPicker(my.look, l => this.h.look(l), room.seats.indexOf(my)).el);
        } else this.dialogBody('Party options', `<div class="react-row">${EMOTES.map((emo, i) => `<button class="quiet" data-act="emote" data-i="${i}" aria-label="${EMOTE_LABELS[i]}">${emo}</button>`).join('')}</div>${my ? '<button class="quiet" data-act="sit-out">Sit out</button>' : ''}`);
        this.dialog.showModal();
        if (this.openedBy === 'look') this.dialog.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
        break;
    }
  }
}
