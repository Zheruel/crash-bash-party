import { CHARACTERS, type Look } from '../../shared/look';
import { getCatalog } from '../crash';
import { sfx } from '../shell/sound';
import { esc, MENU_PLAYERS, menuTex, selectFace } from './dom';

export function pickable(): number[] {
  const cat = getCatalog().characters;
  // Keep the original two rows in their disc order; extend each row with custom fighters.
  const originals = ['crash', 'coco', 'tiny', 'dingodile', 'cortex', 'brio', 'rilla', 'koala'];
  const row = (ids: string[]) => ids.map(id => CHARACTERS.findIndex(c => c.id === id)).filter(i => i >= 0);
  const extra = PICKABLE.filter(i => !originals.includes(CHARACTERS[i].id));
  return [...row(originals.slice(0, 4)), ...extra.filter((_, i) => i % 2 === 0),
    ...row(originals.slice(4)), ...extra.filter((_, i) => i % 2 === 1)]
    .filter(i => !cat?.length || cat.some(c => c.id === CHARACTERS[i].id));
}
export const PICKABLE = CHARACTERS.map((_, i) => i);

/** One keyboard stop for the roster. Arrow keys preview and select a hero. */
export class LookPicker {
  readonly el = document.createElement('div');
  constructor(public look: Look, private onChange: (l: Look) => void, private slot = 0) {
    this.el.className = 'picker';
    this.el.addEventListener('click', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-char]');
      if (b) this.select(Number(b.dataset.char));
    });
    this.el.addEventListener('keydown', e => {
      const b = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-char]');
      if (!b) return;
      const ids = pickable(), index = ids.indexOf(Number(b.dataset.char));
      const cols = getComputedStyle(b.parentElement!).gridTemplateColumns.split(' ').length;
      let next = index;
      if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = ids.length - 1;
      else if (e.key === 'ArrowLeft') next = (index - 1 + ids.length) % ids.length;
      else if (e.key === 'ArrowRight') next = (index + 1) % ids.length;
      else if (e.key === 'ArrowUp' && index >= cols) next = index - cols;
      else if (e.key === 'ArrowDown' && index + cols < ids.length) next = index + cols;
      else return;
      e.preventDefault();
      this.select(ids[next]);
    });
    this.render();
  }
  private select(char: number) {
    this.look = { ...this.look, char };
    sfx.play('select');
    this.render();
    this.onChange(this.look);
    const selected = this.el.querySelector<HTMLButtonElement>('[aria-checked="true"]');
    selected?.focus({ preventScroll: true });
    const grid = selected?.parentElement;
    if (selected && grid && grid.scrollWidth > grid.clientWidth) {
      const cell = selected.getBoundingClientRect(), viewport = grid.getBoundingClientRect();
      if (cell.right > viewport.right) grid.scrollLeft += cell.right - viewport.right;
      else if (cell.left < viewport.left) grid.scrollLeft -= viewport.left - cell.left;
    }
  }
  setLook(l: Look) { this.look = l; this.render(); }
  render() {
    const cur = CHARACTERS[this.look.char];
    const ids = pickable(), cols = Math.ceil(ids.length / 2);
    const tab = menuTex(MENU_PLAYERS[this.slot].cursor);
    this.el.innerHTML = `<div class="hero-grid" style="--cols:${cols}" role="radiogroup" aria-label="Choose your hero">${ids.map((i, pos) =>
      `<button type="button" role="radio" aria-checked="${i === this.look.char}" tabindex="${i === this.look.char ? 0 : -1}" class="chr ${pos < cols ? 'blue' : 'red'}${i === this.look.char ? ' sel' : ''}" data-char="${i}" title="${esc(CHARACTERS[i].name)}" aria-label="${esc(CHARACTERS[i].name)}">${selectFace(i)}${i === this.look.char ? `<i class="player-tab" aria-hidden="true"><img src="${tab}" alt=""></i>` : ''}</button>`).join('')}</div>
      <div class="pk-name" aria-live="polite"><b class="gt wh">${esc(cur.name)}</b></div>`;
  }
}
