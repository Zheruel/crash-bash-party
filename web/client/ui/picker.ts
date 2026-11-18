import { CHARACTERS, COLORS, type Look } from '../../shared/look';
import { avatarHtml } from '../shell/avatar';
import { sfx } from '../shell/sound';
import { esc } from './dom';

/** Hero grid + colour swatches. Re-renders itself; calls onChange when the player picks. */
/** Roster entries offered in the picker. */
export const PICKABLE = CHARACTERS.map((_, i) => i);

export class LookPicker {
  readonly el = document.createElement('div');
  constructor(public look: Look, private onChange: (l: Look) => void, private taken: () => Set<number> = () => new Set()) {
    this.el.className = 'picker';
    this.el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-char],[data-color]');
      if (!t) return;
      if (t.dataset.char != null) this.look = { ...this.look, char: Number(t.dataset.char) };
      else if (t.dataset.color != null) {
        if (t.classList.contains('taken')) return;
        this.look = { ...this.look, color: Number(t.dataset.color) };
      }
      sfx.play('click');
      this.render();
      this.onChange(this.look);
    });
    this.render();
  }
  setLook(l: Look) { this.look = l; this.render(); }
  render() {
    const taken = this.taken();
    this.el.innerHTML = `
      <div class="chars">${PICKABLE.map((i) => `<button class="chr ${i === this.look.char ? 'sel' : ''}" data-char="${i}" style="--c:${COLORS[this.look.color].hex}">${avatarHtml({ char: i, color: this.look.color })}<span>${esc(CHARACTERS[i].name)}</span></button>`).join('')}</div>
      <div class="blurb">${esc(CHARACTERS[this.look.char].blurb)}</div>
      <div class="swatches">${COLORS.map((c, i) => `<button class="sw ${i === this.look.color ? 'sel' : ''} ${taken.has(i) && i !== this.look.color ? 'taken' : ''}" data-color="${i}" style="--c:${c.hex}" title="${c.name}"></button>`).join('')}</div>`;
  }
}
