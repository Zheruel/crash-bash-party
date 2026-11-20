const directions: Record<string, number> = { ArrowLeft: 1, ArrowRight: 2, ArrowUp: 3, ArrowDown: 4 };
const primary = '.lobby:not(.hidden) .primary,.title:not(.hidden) .primary,#rematch';

/** Navigate the visible party controls with a keyboard or PS-style pad. */
export class MenuPad {
  private held = 0;
  private nextRepeat = 0;
  private enabled = false;

  constructor(private readonly confirmScene: () => boolean) {
    window.addEventListener('keydown', e => {
      if (!this.enabled || e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('input:not([type=checkbox]),select,textarea,[contenteditable]:not([contenteditable=false])')) return;
      const key = directions[e.key];
      if (key) { e.preventDefault(); this.navigate(key, true); return; }
      // Focused controls already handle activation or form submission in the browser.
      if (!e.repeat && (e.key === 'Enter' || e.key === ' ') && !target?.closest('button,input,summary,a[href]')) {
        if (this.navigate(5, true)) e.preventDefault();
      }
    });
  }

  update(now: number, enabled: boolean, menuShortcut = false) {
    if (!enabled && !this.enabled && !menuShortcut) return;
    this.enabled = enabled;
    let pad: Gamepad | null | undefined;
    try { pad = navigator.getGamepads?.().find(p => p?.connected); } catch { return; }
    if (!pad) { this.held = 0; return; }
    const pressed = (n: number) => pad.buttons[n]?.pressed;
    const x = pad.axes[0] ?? 0, y = pad.axes[1] ?? 0;
    const key = pressed(9) ? 7 : pressed(0) ? 5 : pressed(1) ? 6 :
      pressed(14) || x < -.55 ? 1 : pressed(15) || x > .55 ? 2 :
      pressed(12) || y < -.55 ? 3 : pressed(13) || y > .55 ? 4 : 0;
    const fresh = key !== this.held;
    this.held = key;
    if (menuShortcut && key === 7 && fresh && !document.querySelector('dialog[open],.modal:not(.hidden)')) {
      const toggle = document.getElementById('mute');
      toggle?.click();
      return;
    }
    if (!enabled || !key || (!fresh && (key > 4 || now < this.nextRepeat))) return;
    this.nextRepeat = now + (fresh ? 360 : 145);
    this.navigate(key);
  }

  private navigate(key: number, keyboard = false) {
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    const modal = dialog ?? document.querySelector<HTMLElement>('.modal:not(.hidden)');
    const sound = document.querySelector<HTMLElement>('.soundpanel:not(.hidden)');
    const root = modal ?? sound ?? document.getElementById('ui');
    if (!root) return;
    if (key === 5 && !modal && !sound && this.confirmScene()) return true;
    if (key === 6) {
      if (dialog) {
        if (dialog.matches('.notice')) dialog.querySelector<HTMLButtonElement>('button')?.click();
        else dialog.close();
      }
      else if (sound) document.getElementById('mute')?.click();
      else modal?.querySelector<HTMLButtonElement>('button')?.click();
      return;
    }
    const buttons = [...root.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')]
      .filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden'
        && (!keyboard || !el.matches('[role="radio"][tabindex="-1"]')));
    const current = document.activeElement as HTMLElement;
    if (key === 7 && dialog?.matches('.title-dialog')) { dialog.querySelector('form')?.requestSubmit(); return; }
    if (key === 7 && !modal && !sound) {
      const button = root.querySelector<HTMLButtonElement>(primary);
      if (button?.getClientRects().length && !button.disabled) button.click();
      return;
    }
    if (!buttons.includes(current)) {
      const preferred = keyboard && !modal && !sound ? buttons.find(el => el.matches(primary)) : undefined;
      if (keyboard && key === 5) {
        // During transitions there may be no menu action yet.
        if (!preferred) return;
        preferred.focus();
        preferred.click();
        return true;
      }
      const start = buttons.find(el => el.matches('[aria-checked="true"],[data-act="ready"],#rematch')) ?? buttons[0];
      (preferred ?? start)?.focus();
      return;
    }
    if (current instanceof HTMLSelectElement && (key === 5 || key <= 2)) {
      const count = current.options.length;
      if (count) {
        current.selectedIndex = (current.selectedIndex + (key === 1 ? -1 : 1) + count) % count;
        current.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if (key === 5) { current.click(); return; }
    if (current instanceof HTMLInputElement && current.type === 'range' && key <= 2) {
      current.valueAsNumber += key === 1 ? -5 : 5;
      current.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    // Include the picker or checkbox label when finding its next keyboard neighbor.
    const bounds = (el: HTMLElement) => (keyboard ? el.closest('[role="radiogroup"],label') ?? el : el).getBoundingClientRect();
    const rect = bounds(current);
    const horizontal = key < 3, sign = key === 1 || key === 3 ? -1 : 1;
    let next: HTMLElement | undefined, closest = Infinity;
    for (const el of buttons) {
      const r = bounds(el);
      const dx = r.x + r.width / 2 - rect.x - rect.width / 2;
      const dy = r.y + r.height / 2 - rect.y - rect.height / 2;
      const ahead = sign * (horizontal ? dx : dy), across = Math.abs(horizontal ? dy : dx);
      if (ahead <= 2 || across > ahead * 1.6) continue;
      const cost = ahead + across * 3;
      if (cost < closest) { closest = cost; next = el; }
    }
    if (!keyboard && next?.matches('[role="radio"]')) next.click();
    else next?.focus();
  }
}
