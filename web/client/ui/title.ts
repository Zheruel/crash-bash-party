import { type Look } from '../../shared/look';
import { sfx } from '../shell/sound';
import { $, esc } from './dom';
import { LookPicker, PICKABLE } from './picker';

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
      <div class="logo" aria-label="Crash Bash Party"><span class="l1">CRASH BASH</span><span class="l2">PARTY</span></div>
      <div class="crate card setup">
        <label for="name">Your name</label>
        <input id="name" type="text" maxlength="16" autocomplete="off" placeholder="Player" value="${esc(this.profile.name)}" />
        <label>Pick your hero</label>
        <div id="pickerhost"></div>
        <div class="actions">
          ${joining ? `
            <div class="joining">Joining party <b>${esc(this.room)}</b></div>
            <button class="btn big" id="join">JOIN PARTY</button>
            <button class="btn ghost small" id="mine">Create my own party instead</button>`
          : `
            <button class="btn big" id="create">${this.lan ? 'CREATE LAN PARTY' : 'CREATE PARTY'}</button>
            <div class="or"><span>or join a friend</span></div>
            <div class="joinrow"><input id="code" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="CODE" /><button class="btn" id="join">JOIN</button></div>`}
        </div>
        <div class="err" id="err">${esc(opts.error ?? '')}</div>
        ${opts.solo ? '<button class="btn ghost small" id="solo">Play solo vs bots instead</button>' : ''}
        ${opts.busy ? `<div class="busy"><i class="spin"></i>${esc(opts.busy)}</div>` : ''}
      </div>
      <div class="foot">Up to 4 players &middot; empty seats are bots &middot; share a link, no sign-up</div>`;
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
