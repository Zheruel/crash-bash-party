import { CHARACTERS, COLORS, type Look } from '../../shared/look';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { esc, face } from './dom';

/** Roster indices offered in the picker: only real Crash Bash characters that have a catalog model. */
export function pickable(): number[] {
  const cat = getCatalog().characters;
  return CHARACTERS.map((_, i) => i).filter((i) => {
    const c = CHARACTERS[i];
    return !cat?.length || cat.some((x) => x.id === c.id);
  });
}
export const PICKABLE = CHARACTERS.map((_, i) => i);

/** Character-select grid (two framed rows like the real game). Player colours are assigned by the party. */
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
      (this.el.querySelector(t.dataset.char != null ? `[data-char="${t.dataset.char}"]` : `[data-color="${t.dataset.color}"]`) as HTMLElement | null)?.focus({ preventScroll: true });
    });
    this.render();
  }
  setLook(l: Look) { this.look = l; this.render(); }
  render() {
    const ids = pickable();
    const rows = [ids.slice(0, Math.ceil(ids.length / 2)), ids.slice(Math.ceil(ids.length / 2))];
    const cur = CHARACTERS[this.look.char];
    this.el.innerHTML = `
      ${rows.map((r, k) => `<div class="chars row${k}" role="radiogroup" aria-label="Character">${r.map((i) => `<button type="button" role="radio" aria-checked="${i === this.look.char}" class="chr ${i === this.look.char ? 'sel' : ''}" data-char="${i}" title="${esc(CHARACTERS[i].name)}" aria-label="${esc(CHARACTERS[i].name)}">${face(i)}${i === this.look.char ? '<i class="p1">P1</i>' : ''}</button>`).join('')}</div>`).join('')}
      <div class="pk-name"><span class="gt wh">${esc(cur.name.toUpperCase())}</span><span class="blurb">${esc(cur.blurb)}</span></div>`;
  }
}
