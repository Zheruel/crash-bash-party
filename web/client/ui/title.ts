import { type Look } from '../../shared/look';
import { sfx } from '../shell/sound';
import { $, esc } from './dom';
import { LookPicker, PICKABLE } from './picker';
import LOGO from './img/logo.png';

export interface Profile { name: string; look: Look }
export interface TitleHandlers {
  create(p: Profile): void;
  join(p: Profile, code: string): void;
  look(l: Look): void;
  solo?(p: Profile): void;
}

const store = {
  get(): Profile {
    try {
      const o = JSON.parse(localStorage.getItem('cbp-profile') ?? '{}');
      const ch = Number(o.look?.char) || 0;
      return { name: String(o.name ?? ''), look: { char: PICKABLE.includes(ch) ? ch : 0, color: Number(o.look?.color) || 0 } };
    } catch { return { name: '', look: { char: PICKABLE[Math.floor(Math.random() * PICKABLE.length)], color: Math.floor(Math.random() * 8) } }; }
  },
  set(p: Profile) { try { localStorage.setItem('cbp-profile', JSON.stringify(p)); } catch { /* ignore */ } },
};

export class TitleScreen {
  readonly el = document.createElement('div');
  private picker: LookPicker;
  profile: Profile;
  private room = '';
  private lan = false;

  constructor(private h: TitleHandlers) {
    this.el.className = 'screen title hidden';
    this.profile = store.get();
    if (!this.profile.name) this.profile.name = '';
    this.picker = new LookPicker(this.profile.look, (l) => { this.profile.look = l; store.set(this.profile); this.h.look(l); });
  }

  /** (Re)build and show the screen. */
  show(opts: { room?: string; lan?: boolean; error?: string; busy?: string; solo?: boolean } = {}) {
    this.room = (opts.room ?? this.room).toUpperCase();
    this.lan = opts.lan ?? this.lan;
    const joining = !!this.room;
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="brand"><img class="logo" src="${LOGO}" alt="Crash Bash"><div class="party gt pink">PARTY</div></div>
      <section class="pnl setup" aria-label="${joining ? 'Join party' : 'New party'}">
        <div class="band"><h1 class="gt or">${joining ? 'JOIN PARTY' : 'CHARACTER SELECT'}</h1></div>
        <div class="pbody">
          <div id="pickerhost"></div>
          <div class="field"><label for="name" class="sm">YOUR NAME</label>
          <input id="name" type="text" maxlength="16" autocomplete="off" placeholder="PLAYER" value="${esc(this.profile.name)}" /></div>
          <div class="menu actions">
            ${joining ? `
              <div class="joining sm">ROOM <b class="gt wh">${esc(this.room)}</b></div>
              <button class="mi big" id="join">JOIN PARTY</button>
              <button class="mi small" id="mine">CREATE MY OWN PARTY</button>`
            : `
              <button class="mi big" id="create">${this.lan ? 'CREATE LAN PARTY' : 'CREATE PARTY'}</button>
              <div class="joinrow"><label for="code" class="sm">JOIN A FRIEND</label><input id="code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE" /><button class="mi" id="join">JOIN</button></div>`}
          </div>
          <div class="err" id="err" role="alert">${esc(opts.error ?? '')}</div>
          ${opts.solo ? '<button class="mi small" id="solo">PLAY SOLO VS BOTS</button>' : ''}
        </div>
        ${opts.busy ? `<div class="busy" role="status"><i class="spin"></i><span class="gt or">${esc(opts.busy)}</span></div>` : ''}
      </section>
      <div class="foot sm">UP TO 4 PLAYERS &middot; EMPTY SEATS ARE BOTS &middot; SHARE A LINK, NO SIGN-UP</div>`;
    $('#pickerhost', this.el).appendChild(this.picker.el);
    this.picker.render();
    const busy = !!opts.busy;
    const grab = (): Profile => {
      const name = ($('#name', this.el) as HTMLInputElement).value.trim() || 'Player';
      this.profile.name = name;
      store.set(this.profile);
      return { name, look: this.profile.look };
    };
    const code = $('#code', this.el) as HTMLInputElement | null;
    code?.addEventListener('input', () => { code.value = code.value.toUpperCase().replace(/[^A-Z]/g, ''); });
    const doJoin = () => {
      if (busy) return;
      const c = (joining ? this.room : code?.value ?? '').toUpperCase();
      if (!/^[A-Z]{4}$/.test(c) && !this.lan) { $('#err', this.el).textContent = 'Enter the 4-letter room code'; code?.focus(); return; }
      sfx.play('click');
      this.h.join(grab(), c);
    };
    $('#join', this.el).onclick = doJoin;
    code?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doJoin(); });
    const create = $('#create', this.el);
    if (create) create.onclick = () => { if (!busy) { sfx.play('click'); this.h.create(grab()); } };
    const solo = $('#solo', this.el);
    if (solo) solo.onclick = () => this.h.solo?.(grab());
    const mine = $('#mine', this.el);
    if (mine) mine.onclick = () => { this.room = ''; this.show({ lan: this.lan }); };
    this.el.querySelectorAll('button, input').forEach((b) => { if (busy) (b as HTMLButtonElement).disabled = true; });
  }

  hide() { this.el.classList.add('hidden'); }
}
