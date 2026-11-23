import { CHARACTERS, type Look } from '../../shared/look';
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
    this.picker = new LookPicker(this.profile.look, (l) => { this.profile.look = l; store.set(this.profile); this.h.look(l); this.previewName(); });
  }

  private previewName() {
    const label = this.el.querySelector('.hero-caption strong');
    const name = CHARACTERS[this.profile.look.char].name;
    if (label) label.textContent = name;
  }

  /** (Re)build and show the screen. */
  show(opts: { room?: string; lan?: boolean; error?: string; busy?: string; solo?: boolean } = {}) {
    this.room = (opts.room ?? this.room).toUpperCase();
    this.lan = opts.lan ?? this.lan;
    const joining = !!this.room;
    this.el.querySelector<HTMLDialogElement>('dialog[open]')?.close();
    this.el.classList.remove('hidden');
    this.el.innerHTML = `
      <div class="brand"><img class="logo" src="${LOGO}" alt="Crash Bash"></div>
      <div class="hero-caption" aria-hidden="true"><strong class="gt wh"></strong></div>
      <section class="setup" aria-label="Party setup">
        <div id="pickerhost"></div>
        <div class="menu actions">
          ${joining ? `<button class="mi primary" id="join">Join room ${esc(this.room)}</button>
            <button class="mi" id="mine">Create a party</button>` :
            `<button class="mi primary" id="create">${this.lan ? 'Create LAN party' : 'Create party'}</button>
            <button class="mi" id="join">Join party</button>`}
          <button class="mi" id="rename">Player name</button>
          ${opts.solo ? '<button class="mi" id="solo">Play solo</button>' : ''}
        </div>
        <div class="err" role="alert">${esc(opts.error ?? '')}</div>
        ${opts.busy ? `<div class="busy" role="status"><i class="spin"></i><span>${esc(opts.busy)}</span></div>` : ''}
      </section>
      <dialog class="party-dialog title-dialog" aria-labelledby="entry-label">
        <form><label id="entry-label" class="gt or"></label>
          <input type="text" required>
          <div id="err" class="err" role="alert"></div>
          <div class="entry-actions"><button type="submit" class="mi primary"></button><button type="button" class="mi" id="back">Back</button></div>
        </form>
      </dialog>`;
    this.previewName();
    $('#pickerhost', this.el).appendChild(this.picker.el);
    this.picker.render();
    const busy = !!opts.busy;
    const grab = (): Profile => {
      store.set(this.profile);
      return { name: this.profile.name.trim() || CHARACTERS[this.profile.look.char].name, look: this.profile.look };
    };
    const join = (code: string) => { sfx.play('select'); this.h.join(grab(), code); };
    const dialog = this.el.querySelector('dialog')!;
    const form = this.el.querySelector('form')!;
    form.noValidate = true;
    const input = form.querySelector('input')!;
    const entry = (kind: 'code' | 'name') => {
      const isCode = kind === 'code';
      const label = form.querySelector('label')!;
      input.id = kind;
      label.htmlFor = kind;
      label.textContent = isCode ? 'Room code' : 'Player name';
      input.maxLength = isCode ? 4 : 16;
      input.setAttribute('autocomplete', isCode ? 'off' : 'nickname');
      input.autocapitalize = isCode ? 'characters' : 'words';
      input.spellcheck = false;
      input.required = isCode;
      input.placeholder = isCode ? 'ABCD' : CHARACTERS[this.profile.look.char].name;
      input.value = isCode ? '' : this.profile.name;
      const err = $('#err', form);
      const clearError = () => { err.textContent = ''; input.removeAttribute('aria-invalid'); input.removeAttribute('aria-describedby'); };
      clearError();
      form.querySelector('button[type=submit]')!.textContent = isCode ? 'Join party' : 'Done';
      input.oninput = () => { if (isCode) input.value = input.value.toUpperCase().replace(/[^A-Z]/g, ''); clearError(); };
      form.onsubmit = e => {
        e.preventDefault();
        if (isCode && !/^[A-Z]{4}$/.test(input.value)) {
          err.textContent = 'Enter the four-letter room code';
          input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', 'err'); input.focus();
          return;
        }
        dialog.close();
        if (isCode) join(input.value);
        else { this.profile.name = input.value.trim(); store.set(this.profile); sfx.play('select'); }
      };
      sfx.play('select'); dialog.showModal(); input.focus(); input.select();
    };
    $('#back', form).onclick = () => dialog.close();
    $('#rename', this.el).onclick = () => entry('name');
    $('#join', this.el).onclick = () => { if (!busy) { if (joining) join(this.room); else entry('code'); } };
    const create = $('#create', this.el);
    if (create) create.onclick = () => { if (!busy) { sfx.play('select'); this.h.create(grab()); } };
    const solo = $('#solo', this.el);
    if (solo) solo.onclick = () => this.h.solo?.(grab());
    const mine = $('#mine', this.el);
    if (mine) mine.onclick = () => { this.room = ''; this.show({ lan: this.lan }); };
    this.el.querySelectorAll('button, input').forEach((b) => { if (busy) (b as HTMLButtonElement).disabled = true; });
  }

  hide() { this.el.querySelector<HTMLDialogElement>('dialog[open]')?.close(); this.el.classList.add('hidden'); }
}
