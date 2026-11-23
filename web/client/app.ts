import { EMOTE_LABELS, winnerCheerFrame } from '../shared/look';
import { FAST_TIMING, NORMAL_TIMING, STANDINGS_MIN_MS, type Timing } from '../shared/party';
import { COUNT_FRAMES, COUNT_LABELS, NUMBERED_COUNTDOWN_TICKS, readsCountdownPad, type Phase, type ResultsMsg, type RoomState, type RoundMsg, type WheelMsg } from '../shared/protocol';
import { SPECTATOR_WAIT, type BallistixData } from '../shared/games/ballDefence';
import { getGame } from '../shared/registry';
import { DT, IDLE, type World } from '../shared/types';
import { preloadBoardTextures } from './scene/tex';
import { PodiumScene, preloadPodium } from './scene/podium';
import { ShowcaseScene } from './scene/showcase';
import { preloadCharacters } from './characters';
import { getCatalog, ready } from './crash';
import { VIEWS } from './games';
import { POLAR_DRAW_TICKS, POLAR_WIN_TALLY_TICKS, S_WIN } from '../shared/games/pushOff';
import { ballistixCupDelay } from './games/ballDefenceResult';
import { CRATE_RESULT_HOLD_MS } from './games/crateTossResult';
import { dragonCupFrame, dragonResultFrames } from '../shared/games/dragonDrop';
import { malletMashResultHoldMs } from './games/malletMash';
import type { RenderWorld } from './games/types';
import { InputManager, keyLabels, watchKeyboardLayout } from './input';
import { createHostCore } from './net/hostCore';
import { LoopbackTransport } from './net/loopback';
import { PeerHost, PeerTransport, newRoomCode } from './net/peer';
import { TransportError, type ClientTransport, type HostCore } from './net/transport';
import { WsTransport } from './net/ws';
import { GameClient, type Status } from './session';
import { initPortraits, resetPortraits } from './shell/avatar';
import { Confetti } from './shell/confetti';
import { sfx } from './shell/sound';
import { announceHero, preloadRoundVoices } from './shell/voice';
import { TouchControls } from './shell/touch';
import { FinalOverlay } from './ui/final';
import { $, div, esc } from './ui/dom';
import { Hud, type SeatView } from './ui/hud';
import { Ps1Hud } from './ui/ps1hud';
import { LobbyScreen } from './ui/lobby';
import { MenuPad } from './ui/menuPad';
import { controlsHtml, thumb, CountOverlay, IntroOverlay, ResultsOverlay, WheelOverlay } from './ui/overlays';
import { LoadingScreen } from './ui/loading';
import { VortexBackdrop } from './ui/vortex';

/** shortest LOADING screen, so a fast load still reads as a beat rather than a flicker */
const LOADING_MIN_MS = 900;
import { TitleScreen, type Profile } from './ui/title';
import LOGO from './ui/img/logo.png';
import { Stage } from './view';

const FASTISH: Timing = { ...NORMAL_TIMING, intro: 1800, countdown: 1500, results: 4200, wheel: 3000, final: 32000, playCap: 5 };

function arenaResultHoldMs(gameId: string | undefined, draw: boolean, char?: number) {
  if (gameId === 'pushOff') return (draw ? POLAR_DRAW_TICKS + 1 : winnerCheerFrame(char ?? 0) + POLAR_WIN_TALLY_TICKS) * 1000 / 30;
  if (gameId === 'tankArena') return (draw ? 121 : 123) * 1000 / 30;
  if (gameId === 'crateToss') return CRATE_RESULT_HOLD_MS;
  if (gameId === 'dragonDrop') return dragonResultFrames(draw, char ?? 0) * DT * 1000;
  if (gameId === 'malletMash') return malletMashResultHoldMs(draw);
}

interface HostHandle { core: HostCore; peer: PeerHost | null }

export class App {
  private menuPad = new MenuPad(() => {
    if (this.phase !== 'final' || this.final.el.classList.contains('hidden') || !this.podium.stripShown || this.podium.stripDone) return false;
    this.podium.skipStrip();
    return true;
  });
  private params = new URLSearchParams(location.search);
  private lan = this.params.get('lan') === '1';
  private fast = this.params.get('fast');
  private nopeer = this.params.get('nopeer') === '1';
  /** ?game=ringDing,tankArena: only rotate through these mini-games */
  private games = this.params.get('game')?.split(',').filter(Boolean);
  private stage!: Stage;
  private input = new InputManager();
  private touch!: TouchControls;
  private confetti!: Confetti;
  private showcase = new ShowcaseScene();
  private podium = new PodiumScene();
  private title!: TitleScreen;
  private lobby!: LobbyScreen;
  private hud!: Hud;
  private ps1hud!: Ps1Hud;
  private wheel = new WheelOverlay();
  private intro = new IntroOverlay();
  /** the real LOADING vortex between the pick and the level, and before the podium */
  private loading = new LoadingScreen();
  private count = new CountOverlay();
  private results = new ResultsOverlay();
  private final = new FinalOverlay();
  private ui!: HTMLElement;
  private statusEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private optionsOpen = false;
  private notice: HTMLDialogElement | null = null;
  private showOptions!: (open: boolean) => void;

  private client: GameClient | null = null;
  private host: HostHandle | null = null;
  private isHost = false;
  private phase: Phase | 'title' = 'title';
  private seats: SeatView[] = [];
  private pendingGame: RoundMsg | null = null;
  private arenaReady = false;
  private gameName = '';
  private streaks = [0, 0, 0, 0];
  private trophies = [0, 0, 0, 0];
  private between = false;
  private resultsTimer = 0;
  private resultsAt = 0;
  private lastResults: ResultsMsg | null = null;
  private countMs = NORMAL_TIMING.countdown;
  private playAt = 0;
  private lastT = performance.now();
  private acc = 0;
  private finalTimer = 0;
  private wake: { release(): Promise<void> } | null = null;
  private backdrop: VortexBackdrop | null = null;

  // ------------------------------------------------------------ boot
  async boot() {
    const root = document.getElementById('ui')!;
    this.ui = root;
    const vx = document.getElementById('vortex');
    if (vx) this.backdrop = new VortexBackdrop(vx);
    this.stage = new Stage(document.getElementById('c') as HTMLCanvasElement);
    this.confetti = new Confetti(document.getElementById('confetti') as HTMLCanvasElement);
    initPortraits(this.stage.renderer);
    this.buildUi(root);
    watchKeyboardLayout(() => this.refreshControls());
    this.stage.onResize = () => this.layoutTitle();
    this.showSplash(true);

    try { await Promise.race([document.fonts.load('400 40px "Crash Bash Menu"'), new Promise((r) => setTimeout(r, 3000))]); } catch { /* fallback serif */ }
    let waitingForArt = true;
    const art = this.preload().then(() => {
      if (!waitingForArt) this.refreshMenuArt();
    }).catch(e => console.warn('preload failed', e));
    await Promise.race([art, new Promise(r => setTimeout(r, 9000))]);
    waitingForArt = false;
    resetPortraits();

    this.stage.register(this.showcase);
    this.stage.register(this.podium);
    this.showSplash(false);
    this.goTitle(this.params.get('room')?.toUpperCase() ?? '');
    addEventListener('pointerdown', () => sfx.unlock(), { once: false });
    addEventListener('keydown', () => sfx.unlock());
    addEventListener('beforeunload', (e) => {
      if (this.isHost && this.client && this.phase !== 'lobby' && this.phase !== 'title') { e.preventDefault(); e.returnValue = ''; }
    });
    (window as unknown as { __app: App }).__app = this;
    requestAnimationFrame((t) => this.frame(t));
  }

  private refreshMenuArt() {
    if (this.phase === 'title') this.showcase.setLooks([this.title.profile.look], true);
    else if (this.phase === 'lobby' && this.client?.room) this.showcase.setLooks(this.client.room.seats.map(s => s.look), true);
  }

  private async preload() {
    await Promise.all([this.count.preload(), preloadCharacters()]);
    const cat = getCatalog();
    const refs = [{ model: 131 }, cat.props?.podiumStripTrophy, cat.props?.crystal, cat.props?.wumpa, cat.props?.podium, cat.arenas?.board, ...(cat.arenas?.board?.extra ?? [])];
    await Promise.all([ready(refs), preloadBoardTextures()]);
    void preloadPodium(); // the final's stage streams in behind the title
  }

  private showSplash(on: boolean) {
    let s = document.getElementById('splash');
    if (!s) { s = div('splash', `<div class="splash-in" role="status"><img src="${LOGO}" alt="Crash Bash"><div class="loading gt or">LOADING</div></div>`); s.id = 'splash'; this.ui.appendChild(s); }
    s.classList.toggle('hidden', !on);
  }

  private buildUi(root: HTMLElement) {
    this.title = new TitleScreen({
      create: (p) => void this.createParty(p, false),
      join: (p, code) => void this.joinParty(p, code),
      look: (l) => this.showcase.setLooks([l]),
      solo: (p) => void this.createParty(p, true),
    });
    this.lobby = new LobbyScreen({
      ready: (r) => this.client?.ready(r),
      seat: (t) => this.client?.seat(t),
      config: (c) => this.client?.config(c),
      look: (l) => this.client?.setLook(l),
      emote: (i) => this.client?.emote(i),
      copy: () => void this.copyLink(),
    });
    this.hud = new Hud(root);
    this.ps1hud = new Ps1Hud(root);
    this.ps1hud.forceVictory.onclick = () => {
      if (!this.canCaptureArenaKeys()) return;
      this.stage.renderer.domElement.focus({ preventScroll: true });
      this.input.pressButton('b');
    };
    this.touch = new TouchControls(root);
    this.touch.enabled = TouchControls.likely();
    this.input.touch = this.touch.sample;
    const useTouch = (enabled: boolean) => {
      if (this.touch.enabled === enabled) return;
      this.touch.enabled = enabled;
      this.touch.show(enabled && this.phase === 'play' && this.mySlot() != null && !this.input.watchingBallistix);
      this.refreshControls();
    };
    window.addEventListener('pointerdown', e => {
      if (e.pointerType === 'touch' || e.pointerType === 'mouse') useTouch(e.pointerType === 'touch');
    }, true);
    window.addEventListener('keydown', e => { if (!e.isComposing) useTouch(false); }, true);
    this.statusEl = div('statusbar hidden');
    this.toastEl = div('toast hidden');
    const top = div('topbar', `<button class="icon-btn" id="mute" title="Sound" aria-label="Sound settings" aria-expanded="false" aria-controls="sound-settings"><span class="sound-symbol"></span><span class="game-menu-label gt">Menu</span></button><button class="icon-btn hidden" id="leave" title="Leave" aria-label="Leave party">&times;</button>
      <div id="sound-settings" class="soundpanel pnl hidden"><div class="band"><h2 class="gt or">SOUND</h2></div><div class="pbody"><details class="round-controls hidden"><summary>Controls</summary><ul class="ctl" aria-label="Stage controls"></ul></details>
      <label class="chk sm"><input type="checkbox" id="mutechk"> MUTE ALL</label>
      <label class="sm" for="vmusic">MUSIC</label><input type="range" id="vmusic" min="0" max="100"><label class="sm" for="vsfx">EFFECTS</label><input type="range" id="vsfx" min="0" max="100">
        <details class="round-reactions"><summary>React</summary><div class="reaction-choices">${EMOTE_LABELS.map((label, i) => `<button data-emote="${i}">${label}</button>`).join('')}</div></details>
      </div></div>`);
    root.append(this.title.el, this.lobby.el, this.hud.el, this.wheel.el, this.intro.el, this.count.el, this.results.el, this.final.el, top, this.statusEl, this.toastEl);
    const mute = $('#mute', top);
    const panel = $('.soundpanel', top);
    const chk = $('#mutechk', top) as HTMLInputElement, vm = $('#vmusic', top) as HTMLInputElement, vs = $('#vsfx', top) as HTMLInputElement;
    const paintMute = () => { chk.checked = sfx.muted; $('.sound-symbol', mute).innerHTML = sfx.muted ? '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.5" fill="none"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15.5 8.5a5 5 0 010 7M18 6a8.5 8.5 0 010 12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>'; };
    for (const [slider, kind] of [[vm, 'music'], [vs, 'sfx']] as const) {
      slider.value = String(Math.round(sfx.vol[kind] * 100));
      const paint = () => slider.style.setProperty('--volume', slider.value + '%');
      paint();
      slider.oninput = () => { paint(); sfx.setVolume(kind, slider.valueAsNumber / 100); };
    }
    paintMute();
    const reactions = $('.round-reactions', panel) as HTMLDetailsElement;
    const controls = $('.round-controls', panel) as HTMLDetailsElement;
    this.showOptions = open => {
      const closing = this.optionsOpen && !open;
      if (closing) this.input.releaseMenuInput();
      this.optionsOpen = open;
      panel.classList.toggle('hidden', !open);
      mute.setAttribute('aria-expanded', String(open));
      this.input.capture = this.canCaptureArenaKeys();
      this.input.clearPresses();
      if (open) {
        this.refreshControls();
        reactions.classList.toggle('hidden', this.mySlot() == null);
        (controls.classList.contains('hidden') ? chk : $('summary', controls)).focus();
      } else {
        controls.open = false;
        reactions.open = false;
        if (closing) (document.body.dataset.screen === 'game' ? this.stage.renderer.domElement : mute).focus({ preventScroll: true });
      }
    };
    mute.onclick = () => { sfx.unlock(); this.showOptions(!this.optionsOpen); sfx.play('click'); };
    reactions.addEventListener('click', e => {
      const button = (e.target as Element).closest<HTMLButtonElement>('button[data-emote]');
      if (button) { this.client?.emote(Number(button.dataset.emote)); this.showOptions(false); }
    });
    document.addEventListener('pointerdown', e => {
      if (this.optionsOpen && !top.contains(e.target as Node)) this.showOptions(false);
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape' || e.repeat || document.querySelector('dialog[open],.modal:not(.hidden)')) return;
      if (!this.optionsOpen && document.body.dataset.screen !== 'game') return;
      e.preventDefault();
      mute.click();
    });
    chk.onchange = () => { sfx.setMuted(chk.checked); paintMute(); };
    vs.onchange = () => sfx.play('coin');
    $('#leave', top).onclick = () => { this.showOptions(false); this.leave(true); };
    this.skipBtn = document.createElement('button');
    this.skipBtn.id = 'skip';
    this.skipBtn.className = 'mi small hidden';
    this.skipBtn.textContent = 'SKIP ▸';
    this.skipBtn.onclick = () => { this.client?.skip(); sfx.play('click'); };
    root.append(this.skipBtn);
  }
  private skipBtn!: HTMLButtonElement;

  // ------------------------------------------------------------ title
  private goTitle(room = '', error = '', solo = false) {
    this.phase = 'title';
    sfx.music('title');
    this.loading.cancel();
    this.stage.unloadGame();
    this.setScreens('title');
    this.showcase.setLooks([this.title.profile.look]);
    this.showcase.setSpin(true);
    this.layoutTitle();
    this.stage.show(this.showcase);
    this.title.show({ room, lan: this.lan, error, solo });
  }

  private layoutTitle() {
    if (this.phase !== 'title') return;
    const wide = innerWidth > 760 || innerWidth > innerHeight * 1.2;
    this.showcase.setLayout('title', wide ? 0.26 : 0.5, wide ? 0.55 : 0.23);
  }

  /** Switch which top-level DOM layers are visible. */
  /** Results with the winner's model: the menu vortex comes back behind it. */
  private setChamp(on: boolean) {
    document.body.classList.toggle('champ', on);
    if (this.backdrop) this.backdrop.active = on || document.body.dataset.screen !== 'game';
  }

  private setScreens(s: 'title' | 'lobby' | 'game') {
    this.title.el.classList.toggle('hidden', s !== 'title');
    this.lobby.show(s === 'lobby');
    this.hud.show(s === 'game');
    if (document.body.dataset.screen !== s) this.showOptions(false);
    document.body.dataset.screen = s;
    const toggle = $('#mute'), inGame = s === 'game';
    toggle.setAttribute('aria-label', inGame ? 'Game menu' : 'Sound settings');
    toggle.title = inGame ? 'Game menu (Esc)' : 'Sound';
    if (inGame) toggle.setAttribute('aria-keyshortcuts', 'Escape');
    else toggle.removeAttribute('aria-keyshortcuts');
    const panel = $('#sound-settings'), leave = $('#leave');
    const parent = inGame ? $('.pbody', panel) : toggle.parentElement!;
    if (leave.parentElement !== parent) parent.appendChild(leave);
    leave.textContent = inGame ? 'Leave party' : '×';
    document.body.classList.remove('champ');
    if (this.backdrop) this.backdrop.active = s !== 'game';
    $('#leave').classList.toggle('hidden', s === 'title');
    document.body.classList.remove('lb');
    if (s !== 'game') { this.wheel.hide(); this.intro.hide(); this.count.set(''); this.results.hide(); this.final.hide(); this.touch.show(false); this.input.capture = false; }
  }

  private toast(msg: string, ms = 3500) {
    this.toastEl.textContent = msg;
    this.toastEl.classList.remove('hidden');
    clearTimeout((this.toastEl as unknown as { _t: number })._t);
    (this.toastEl as unknown as { _t: number })._t = window.setTimeout(() => this.toastEl.classList.add('hidden'), ms);
  }

  // ------------------------------------------------------------ connect
  private timing(): Timing | undefined {
    if (!this.fast) return undefined;
    return this.fast === '2' ? FAST_TIMING : FASTISH;
  }

  private async createParty(p: Profile, solo: boolean) {
    this.title.show({ busy: this.lan ? 'Connecting to the LAN server...' : solo || this.nopeer ? 'Starting party...' : 'Opening your room...', lan: this.lan });
    sfx.unlock();
    announceHero(p.look.char);
    try {
      let make: () => ClientTransport;
      let room = '';
      if (this.lan) {
        make = () => new WsTransport();
      } else {
        let code = newRoomCode();
        let core = createHostCore(code, 8, this.timing(), this.games);
        let peer: PeerHost | null = null;
        if (!solo && !this.nopeer) {
          const proxy: HostCore = { open: (...a) => core.open(...a), message: (...a) => core.message(...a), close: (...a) => core.close(...a), destroy: () => core.destroy() };
          peer = new PeerHost(code, proxy);
          peer.onFatal = (m) => this.toast('Matchmaking connection problem: ' + m);
          try {
            const final = await peer.start();
            if (final !== code) { core.destroy(); code = final; core = createHostCore(code, 8, this.timing(), this.games); }
          } catch (e) {
            core.destroy();
            peer.stop();
            throw e;
          }
        }
        this.host = { core, peer };
        this.isHost = true;
        room = code;
        const c = core;
        make = () => new LoopbackTransport(c);
      }
      await this.connect(p, make, room);
    } catch (e) {
      this.cleanupHost();
      const err = e instanceof TransportError ? e : null;
      const unreachable = err?.code === 'unreachable' && !this.lan;
      this.goTitle('', unreachable ? "Couldn't reach the matchmaking server, so friends can't join this way. Check your connection and try again, or play solo." : (err?.message ?? String(e)), unreachable);
    }
  }

  private async joinParty(p: Profile, code: string) {
    this.title.show({ room: code, busy: this.lan ? 'Joining...' : `Looking for room ${code}...`, lan: this.lan });
    sfx.unlock();
    announceHero(p.look.char);
    try {
      await this.connect(p, this.lan ? () => new WsTransport() : () => new PeerTransport(code), code);
    } catch (e) {
      const err = e instanceof TransportError ? e : null;
      let msg = err?.message ?? String(e);
      if (err?.code === 'no-host') msg = `Room ${code} not found. Check the code, and make sure the host still has their tab open.`;
      else if (err?.code === 'unreachable') msg = "Can't reach the matchmaking server. Check your connection and try again.";
      this.goTitle(code, msg);
    }
  }

  private async connect(p: Profile, make: () => ClientTransport, room: string) {
    const client = new GameClient(make, { name: p.name, look: p.look, room });
    this.client = client;
    this.bind(client);
    try {
      await client.start();
    } catch (e) {
      this.client = null;
      throw e;
    }
    this.requestWake();
  }

  private requestWake() {
    const nav = navigator as unknown as { wakeLock?: { request(t: string): Promise<{ release(): Promise<void> }> } };
    nav.wakeLock?.request('screen').then((w) => (this.wake = w)).catch(() => {});
  }

  private cleanupHost() {
    this.host?.peer?.stop();
    this.host?.core.destroy();
    this.host = null;
    this.isHost = false;
  }

  leave(ask = false) {
    if (ask && this.isHost && (this.client?.room?.seats.filter((s) => s.clientId != null).length ?? 0) > 1) {
      this.modal('LEAVE PARTY?', 'You are the host. Leaving ends the party for everyone.', [['STAY', () => {}], ['LEAVE', () => this.leave(false)]]);
      return;
    }
    this.client?.leave();
    this.client = null;
    this.cleanupHost();
    this.wake?.release().catch(() => {});
    this.wake = null;
    this.statusEl.classList.add('hidden');
    this.final.hide();
    this.confetti.clear();
    clearTimeout(this.finalTimer);
    history.replaceState(null, '', location.pathname + (this.lan ? '?lan=1' : ''));
    this.goTitle('');
  }

  // ------------------------------------------------------------ session handlers
  private bind(c: GameClient) {
    c.h = {
      status: (s, d) => this.onStatus(s, d),
      joined: (code) => this.onJoined(code),
      room: (r) => this.onRoom(r),
      wheel: (m) => this.onWheel(m),
      round: (m) => this.onRound(m),
      phase: (p, ms) => this.onPhase(p, ms),
      results: (m) => this.onResults(m),
      emote: (slot, id) => this.onEmote(slot, id),
      event: (e) => this.stage.gameEvent(e),
      error: (m) => this.toast(m),
    };
  }

  private onStatus(s: Status, detail?: string) {
    const el = this.statusEl;
    if (s === 'reconnecting') { el.innerHTML = '<i class="spin"></i><span class="gt or">CONNECTION LOST - RECONNECTING...</span>'; el.classList.remove('hidden'); }
    else if (s === 'online') el.classList.add('hidden');
    else if (s === 'hostLeft') {
      el.classList.add('hidden');
      this.modal('THE HOST LEFT', 'The room is closed. Start a new one and send your friends the link.', [['BACK TO TITLE', () => this.leave()]]);
    } else if (s === 'failed') void detail;
  }

  /** Styled dialog (replaces confirm/alert). Buttons close it, then run. */
  private modal(title: string, text: string, buttons: [string, () => void][]) {
    const m = document.createElement('dialog');
    m.className = 'party-dialog notice';
    m.setAttribute('aria-label', title);
    m.setAttribute('role', 'alertdialog');
    m.innerHTML = `<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="notice-actions">${buttons.map(b => `<button class="quiet">${esc(b[0])}</button>`).join('')}</div>`;
    m.querySelectorAll('button').forEach((button, i) => {
      button.onclick = () => { m.close(); buttons[i][1](); };
    });
    this.notice = m;
    this.input.capture = false;
    m.addEventListener('close', () => {
      m.remove();
      if (this.notice !== m) return;
      this.notice = null;
      this.input.releaseMenuInput();
      this.input.capture = this.canCaptureArenaKeys();
      if (this.input.capture) this.stage.renderer.domElement.focus({ preventScroll: true });
    }, { once: true });
    if (buttons.length === 1) m.addEventListener('cancel', e => { e.preventDefault(); });
    this.ui.appendChild(m);
    m.showModal();
  }

  private inviteLink(code: string) {
    return `${location.origin}${location.pathname}?room=${code}${this.lan ? '&lan=1' : ''}`;
  }
  private async copyLink() {
    const code = this.client?.code;
    if (!code) return;
    const link = this.inviteLink(code);
    let ok = false;
    try { await navigator.clipboard.writeText(link); ok = true; } catch {
      const t = document.createElement('textarea');
      t.value = link; document.body.appendChild(t); t.select();
      try { ok = document.execCommand('copy'); } catch { /* ignore */ }
      t.remove();
    }
    if (!ok) window.prompt('Copy this link:', link);
    this.lobby.flashCopied(ok);
  }

  private onJoined(code: string) {
    void code;
    this.setScreens('lobby');
  }

  private mySlot() { return this.client?.mySlot() ?? null; }

  private onRoom(r: RoomState) {
    this.seats = r.seats.map((s) => ({ name: s.name, look: s.look, bot: s.clientId == null }));
    if (r.phase === 'lobby') {
      if (this.phase !== 'lobby') this.enterLobby();
      this.showcase.setLooks(r.seats.map((s) => s.look));
      this.lobby.update(r, this.client!.me);
      this.phase = 'lobby';
    } else if (this.between) {
      this.showcase.setLooks(r.seats.map((s) => s.look));
    }
    this.hud.setSeats(this.seats, this.mySlot());
    if (this.phase === 'final') {
      const humans = r.seats.filter((s) => s.clientId != null && s.connected).length;
      this.final.setVotes(r.rematch, humans);
    }
  }

  private enterLobby() {
    this.phase = 'lobby';
    sfx.music('warp');
    this.loading.cancel();
    void this.loading.preload();
    clearTimeout(this.finalTimer);
    this.stage.unloadGame();
    this.pendingGame = null;
    clearTimeout(this.resultsTimer);
    this.confetti.clear();
    this.between = false;
    this.streaks = [0, 0, 0, 0];
    this.trophies = [0, 0, 0, 0];
    this.lastResults = null;
    this.setScreens('lobby');
    this.showcase.setLayout('lobby');
    this.showcase.react(null);
    this.showcase.setSpin(false);
    this.stage.show(this.showcase);
  }

  /** Wheel / leaderboard stage: the Warp Room with everyone standing on their pads along the bottom. */
  private enterBetween(winner: number | null = null) {
    if (!this.between || !this.stage.current || this.stage.gameVisible) {
      sfx.music('warp');
      this.stage.unloadGame();
      this.pendingGame = null;
      this.between = true;
      this.setScreens('game');
      this.showcase.setLayout('between');
      this.showcase.setLooks(this.seats.map((x) => x.look));
      this.stage.show(this.showcase);
      this.hud.show(true);
    }
    this.showcase.react(winner);
  }

  private canCaptureArenaKeys() {
    if (this.optionsOpen || this.notice) return false;
    // Drivers can already be holding the accelerator while reading the rules or loading the track.
    const race = this.client?.round?.gameId === 'dashRace';
    return this.phase === 'play' || (this.phase === 'intro' && race) || (this.phase === 'countdown' && (race || this.arenaReady));
  }

  private onPhase(p: Phase, ms: number) {
    const prev = this.phase;
    this.phase = p;
    if (this.optionsOpen) this.refreshControls();
    this.skipBtn?.classList.toggle('hidden', !(this.isHost && (p === 'wheel' || p === 'intro' || p === 'results')));
    switch (p) {
      case 'lobby': this.enterLobby(); if (this.client?.room) this.onRoom(this.client.room); break;
      case 'wheel':
        if (prev === 'final') { this.final.hide(); this.confetti.clear(); }
        break;
      case 'intro':
        this.between = false;
        this.loading.cancel();
        this.setScreens('game');
        void this.levelMusic();
        this.results.hide();
        this.touch.show(false);
        this.showIntro(ms);
        this.input.capture = this.canCaptureArenaKeys();
        break;
      case 'countdown':
        this.intro.hide();
        this.input.capture = this.canCaptureArenaKeys();
        if (this.input.capture) this.stage.renderer.domElement.focus({ preventScroll: true });
        if (!this.arenaReady && !this.loading.visible) this.loading.show();
        this.countMs = Math.max(1, this.client!.phaseEnds - this.client!.phaseStartedAt);
        break;
      case 'play':
        if (!this.arenaReady && !this.loading.visible) this.loading.show();
        if (prev !== 'countdown') void this.levelMusic();
        this.intro.hide();
        this.count.set(prev === 'countdown' ? 'GO!' : '');
        this.playAt = this.client!.playStartedAt;
        this.input.capture = this.canCaptureArenaKeys();
        if (this.input.capture) this.stage.renderer.domElement.focus({ preventScroll: true });
        if (prev === 'countdown' && this.client?.round?.gameId === 'dashRace') this.input.enterDashPlay();
        else this.input.clearPresses();
        this.touch.show(this.mySlot() != null);
        {
          const m = this.client?.round;
          this.hud.setPillText(m?.modifier ? m.modifier.name : 'MINI-GAME', this.gameName.toUpperCase());
        }
        break;
      case 'results':
        this.touch.show(false);
        break;
      case 'final':
        this.touch.show(false);
        if (this.client?.results?.final) this.scheduleFinal(ms);
        break;
    }
  }

  private onEmote(slot: number, id: number) {
    sfx.play('emote');
    if (this.stage.gameVisible && this.seats[slot] && EMOTE_LABELS[id]) {
      this.toast(`${this.seats[slot].name} · ${EMOTE_LABELS[id]}`, 1500);
    }
    this.hud.emote(slot, id);
    this.lobby.emote(slot, id);
    this.showcase.bounce(slot);
  }

  // ------------------------------------------------------------ wheel / round / results
  private resetTournamentDisplay() {
    this.final.hide();
    this.confetti.clear();
    this.lastResults = null;
    this.streaks.fill(0);
    this.trophies.fill(0);
  }

  private onWheel(m: WheelMsg) {
    if (m.round === 1) this.resetTournamentDisplay();
    this.phase = 'wheel';
    clearTimeout(this.resultsTimer);
    this.results.hide();
    document.body.classList.remove('lb');
    this.enterBetween();
    this.setChamp(false);
    this.showcase.setLayout('between');
    this.wheel.run(m, m.cupsToWin ? 'CUP BATTLE' : `ROUND ${m.round} OF ${m.total}`);
    this.hud.setRound(m.round, m.total, m.cupsToWin);
  }

  private onRound(m: RoundMsg) {
    this.stage.ctx.resultReplayAt = undefined;
    if (m.round === 1 && (this.phase === 'final' || this.phase === 'lobby')) this.resetTournamentDisplay();
    clearTimeout(this.resultsTimer);
    this.setChamp(false);
    this.hud.setRound(m.round, m.total, m.cupsToWin);
    sfx.clearRoundResult();
    this.arenaReady = false;
    this.wheel.hide();
    this.pendingGame = m;
    const chars = m.seats.map(s => s.look.char);
    this.ps1hud.preloadRound(chars);
    this.count.preloadVoices();
    preloadRoundVoices(m.gameId, chars);
    this.input.game = m.gameId;
    this.input.variant = m.variant?.id ?? this.variantInfo()?.id;
    this.touch.configure(this.input.game, this.input.variant);
    this.gameName = m.gameName;
    this.seats = m.seats.map((s) => ({ name: s.name, look: s.look, bot: s.bot }));
    this.hud.setSeats(this.seats, this.mySlot());
  }

  /** Called every frame: loads the mini-game view once its first snapshot arrived. */
  private tryLoadGame() {
    const m = this.pendingGame, c = this.client;
    if (!m || !c || !c.snaps.length) return;
    this.pendingGame = null;
    const factory = VIEWS[m.gameId];
    if (!factory) { console.warn('no view for', m.gameId); return; }
    const w = c.snaps[c.snaps.length - 1].w as RenderWorld;
    const seats = m.seats.map((s) => ({ name: s.name, look: s.look, bot: s.bot }));
    void this.stage.loadGame(factory(), w, c.roundSlot, seats).then((ok) => {
      if (this.client !== c || c.round !== m || this.phase === 'lobby' || this.phase === 'title') return;
      if (ok) {
        this.arenaReady = true;
        this.setScreens('game');
        this.input.capture = this.canCaptureArenaKeys();
        if (this.lastResults && this.arenaCupHold(this.lastResults) !== undefined && this.results.el.querySelector('.intro-bg')) {
          this.showCupStandings(this.lastResults);
        }
      }
      if (this.phase === 'countdown' || this.phase === 'play') void this.loading.hide();
    });
  }

  private variantName(): string | null {
    const c = this.client;
    const m = c?.round;
    const w = c?.snaps[c.snaps.length - 1]?.w as World | undefined;
    if (m?.variant) return m.variant.name;
    if (!m || !w) return null;
    const v = (w.data as Record<string, unknown>)?.variant;
    if (v == null) return null;
    const game = getGame(m.gameId) as unknown as { variants?: ({ id?: string; name?: string } | string)[] } | undefined;
    const found = game?.variants?.find((x) => (typeof x === 'string' ? x === v : x.id === v));
    if (found) return typeof found === 'string' ? found : (found.name ?? String(v));
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && v && 'name' in v) return String((v as { name: unknown }).name);
    return null;
  }

  /** Per-level track (variant name, then game name, then the family's default). */
  private async levelMusic() {
    const c = this.client, m = c?.round;
    if (!m) return;
    const family: Record<string, string> = { ballDefence: 'crashball', pushOff: 'tiltPanic', tilePainter: 'pogoPainter', tankArena: 'swampFox', crateToss: 'snowBash', dashRace: 'dotDash' };
    const tries = [this.variantName(), m.gameName, family[m.gameId]].filter((x): x is string => !!x);
    const round = m.round;
    for (const t of tries) {
      const k = await sfx.musicKey(t);
      if (this.client?.round?.round !== round) return; // moved on
      if (k) { sfx.music(k, 'round'); return; }
    }
  }

  /** the level the host picked: {id, name} (id = the variant key the stage stills use) */
  private variantInfo(): { id: string; name: string } | null {
    if (this.client?.round?.variant) return this.client.round.variant;
    const name = this.variantName();
    const w = this.client?.snaps[this.client.snaps.length - 1]?.w as World | undefined;
    const v = (w?.data as Record<string, unknown> | undefined)?.variant;
    return name ? { id: typeof v === 'string' ? v : '', name } : null;
  }

  private refreshControls() {
    const round = this.client?.round;
    const controls = $('.round-controls');
    const show = !!round && document.body.dataset.screen === 'game' && this.phase !== 'wheel';
    controls.classList.toggle('hidden', !show);
    if (!show || !round) return;
    const html = controlsHtml(round.controls, this.touch.enabled, round.gameId, this.variantInfo()?.id, this.client?.roundSlot);
    $('.ctl', controls).innerHTML = html;
    const intro = this.intro.el.querySelector('.ctl');
    if (intro) intro.innerHTML = html;
  }

  private showIntro(ms = 4000) {
    const c = this.client;
    const m = c?.round;
    if (!c || !m) return;
    this.intro.show(m, this.variantInfo(), c.roundSlot, m.seats.map((s) => ({ name: s.name, look: s.look, bot: s.bot })), this.touch.enabled, ms, m.gameId);
    sfx.play('whoosh');
    this.hud.setPillText(m.modifier ? m.modifier.name : 'MINI-GAME', m.gameName.toUpperCase());
  }

  private onResults(m: ResultsMsg) {
    const replay = this.lastResults?.round === m.round;
    this.lastResults = m;
    const inResultPhase = this.client?.phase === 'results' || this.client?.phase === 'final';
    this.resultsAt = inResultPhase ? this.client!.phaseStartedAt : performance.now();
    this.stage.ctx.resultReplayAt = inResultPhase ? this.resultsAt / 1000 : undefined;
    const terminal = this.client?.snaps.at(-1);
    const playAt = inResultPhase && terminal ? this.resultsAt - terminal.tick * 1000 * DT : this.playAt;
    if (m.draw && (this.stage.gameVisible || inResultPhase)) this.count.showDraw(this.resultsAt, playAt, this.client?.round?.gameId ?? '');
    else this.count.set('');
    const w = m.draw ? null : m.placements[0];
    this.trophies = [...m.stars];
    if (!replay) this.streaks = this.streaks.map((v, i) => (i === w ? v + 1 : 0));
    if (m.final) {
      // On reconnect the phase precedes the results payload.
      if (this.phase === 'final') this.scheduleFinal(Math.max(0, this.client!.phaseEnds - performance.now()));
      return;
    }
    const remaining = this.phase === 'results' ? Math.max(0, this.client!.phaseEnds - performance.now()) : Infinity;
    const lastGame = this.client?.round?.gameId ?? '', lastLevel = this.variantInfo()?.id ?? null;
    const cupHold = this.arenaCupHold(m);
    const holdMs = cupHold ?? arenaResultHoldMs(lastGame, !!m.draw, w === null ? undefined : this.seats[w]?.look.char) ?? 3500;
    const delay = this.stage.gameVisible || cupHold !== undefined
      ? Math.max(0, Math.min(this.resultsAt + holdMs - performance.now(), remaining - STANDINGS_MIN_MS)) : 0;
    clearTimeout(this.resultsTimer);
    this.resultsTimer = window.setTimeout(() => {
      if (this.phase !== 'results') return;
      if (m.cupsToWin) { this.showCupStandings(m); return; }
      this.enterBetween(w);
      // wide screens: the winner's own model cheers beside the board (the showcase shows through)
      const champ = innerWidth / Math.max(1, innerHeight) > 1.25 && w != null && !!this.seats[w];
      if (champ) { this.showcase.setChamp(w); this.setChamp(true); }
      this.results.show(m, this.seats, this.mySlot(), this.streaks, lastGame ? thumb(lastGame, lastLevel) : undefined, champ);
      document.body.classList.add('lb');
    }, delay);
  }

  private showCupStandings(m: ResultsMsg) {
    this.count.set('');
    const game = this.client?.round?.gameId, variant = this.variantInfo()?.id;
    const background = !this.stage.gameVisible && game ? thumb(game, variant) : undefined;
    this.results.show(m, this.seats, this.mySlot(), this.streaks, background);
  }

  private arenaCupHold(m: ResultsMsg) {
    if (!m.cupsToWin || m.draw || !this.client) return;
    const terminal = this.client.snaps.at(-1)?.w;
    if (this.client.round?.gameId === 'tankArena' && terminal?.data.result?.poseAt !== undefined) return 3 * 1000 / 30;
    const slot = m.placements[0];
    const char = this.seats[slot]?.look.char;
    if (!terminal?.finished || char === undefined) return;
    if (this.client.round?.gameId === 'dragonDrop') return dragonCupFrame(char) * 1000 / 30;
    const cheer = winnerCheerFrame(char);
    if (this.client.round?.gameId === 'pushOff') {
      const rider = terminal.data.P?.[slot];
      return Math.max(0, cheer + 3 + (rider?.st === S_WIN ? -rider.k : 1)) * 1000 / 30;
    }
    if (this.client.round?.gameId === 'ballDefence') return ballistixCupDelay(terminal, slot, cheer);
  }

  private scheduleFinal(ms: number) {
    clearTimeout(this.finalTimer);
    const m = this.lastResults ?? this.client?.results;
    if (!m || !m.final) return;
    const now = performance.now();
    const elapsed = Math.max(0, now - (this.client?.phaseStartedAt ?? now));
    const duration = ms + elapsed;
    const defaultIntroMs = m.cupsToWin ? Math.min(7000, duration * 0.24) : Math.min(3600, duration * 0.14);
    const holdMs = arenaResultHoldMs(this.client?.round?.gameId, !!m.draw, this.seats[m.placements[0]]?.look.char);
    const introMs = holdMs !== undefined
      ? Math.max(defaultIntroMs, Math.min(holdMs + LOADING_MIN_MS, duration * 0.24))
      : defaultIntroMs;
    const podiumAt = now + introMs - elapsed;
    if (m.cupsToWin) {
      clearTimeout(this.resultsTimer);
      const tallyAt = this.arenaCupHold(m);
      if (podiumAt - now > LOADING_MIN_MS) this.resultsTimer = window.setTimeout(() => {
        if (this.phase === 'final') this.showCupStandings(m);
      }, Math.max(0, tallyAt === undefined ? podiumAt - now - LOADING_MIN_MS - 2500 : tallyAt - elapsed));
    }
    if (podiumAt <= now) { this.startFinal(m, duration, introMs, podiumAt); return; }
    // the podium is a level of its own: the LOADING vortex covers the switch, as in the game
    this.finalTimer = window.setTimeout(() => {
      this.loading.show();
      this.finalTimer = window.setTimeout(() => this.startFinal(m, duration, introMs, podiumAt), Math.max(0, podiumAt - performance.now()));
    }, Math.max(0, podiumAt - now - LOADING_MIN_MS));
  }

  private startFinal(m: ResultsMsg, ms: number, introMs: number, podiumAt: number) {
    if (this.phase !== 'final') { this.loading.cancel(); return; }
    void this.loading.hide();
    sfx.music('podium');
    this.setChamp(false);
    this.results.hide();
    this.pendingGame = null;
    this.stage.unloadGame();
    this.setScreens('game');
    this.hud.setPillText('FINAL', 'RESULTS');
    void this.final.run(m, this.seats, ms, {
      podium: this.podium, hud: this.hud, confetti: this.confetti,
      showPodium: () => this.stage.show(this.podium),
      canVote: this.mySlot() !== null,
      onRematch: () => this.client?.rematch(),
      onLeave: () => this.leave(true),
    }, introMs, podiumAt);
  }

  // ------------------------------------------------------------ frame
  private frame(t: number) {
    const dt = Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;
    const inMenus = this.phase === 'title' || this.phase === 'lobby' || this.phase === 'final';
    this.menuPad.update(t, !!this.notice || this.optionsOpen || inMenus, !inMenus || this.stage.gameVisible);
    const c = this.client;
    this.tryLoadGame();

    const openingPad = this.phase === 'countdown' && readsCountdownPad(c?.round?.gameId);
    if (c && (this.phase === 'play' || openingPad) && c.roundSlot != null) {
      if (openingPad) this.input.clearPresses();
      this.acc += dt;
      for (let n = 0; this.acc >= DT && n < 5; n++, this.acc -= DT) c.sendInput(this.optionsOpen || this.notice ? IDLE : this.input.sample());
      if (this.acc > DT * 5) this.acc = 0;
    } else this.acc = 0;

    const inArena = this.stage.gameVisible && (this.phase === 'intro' || this.phase === 'countdown'
      || this.phase === 'play' || this.phase === 'results' || this.phase === 'final');
    const arenaWorld = c && inArena ? c.renderWorld(t) as RenderWorld | null : null;

    const ballistix = this.phase === 'play' && c?.round?.gameId === 'ballDefence' ? arenaWorld?.data as BallistixData | undefined : undefined;
    const localShip = c?.roundSlot == null ? undefined : ballistix?.pl?.[c.roundSlot];
    const watching = !!localShip && localShip.score <= 0;
    if (this.input.watchingBallistix !== watching) {
      this.input.watchingBallistix = watching;
      if (this.phase === 'play') this.touch.show(c?.roundSlot != null && !watching);
    }
    if (ballistix && this.input.watchingBallistix && ballistix.spectatorSince !== undefined && this.canCaptureArenaKeys()) {
      const age = ballistix.f - ballistix.spectatorSince - SPECTATOR_WAIT;
      const closing = ballistix.pl.filter(p => p.score > 0).length > 1 ? -1
        : Math.max(0, ballistix.f - Math.max(...ballistix.pl.map(p => p.dead)));
      this.ps1hud.setForceVictory(age, closing, keyLabels('b')[0], this.touch.enabled);
    } else this.ps1hud.forceVictory.hidden = true;

    // HUD cards: points + trophies (from the room's seats, updated on results)
    if (this.phase !== 'lobby' && this.phase !== 'title') {
      const r = this.lastResults;
      let coins = c?.room?.seats.map((x) => x.score) ?? [0, 0, 0, 0];
      let stars = this.trophies;
      if (r && this.phase === 'results' && performance.now() - this.resultsAt < 3400) { coins = r.prev; stars = r.stars.map((x, i) => x - (!r.draw && r.placements[0] === i ? 1 : 0)); }
      let extra: string[] | undefined;
      const world = this.phase === 'intro' ? null : arenaWorld;
      const g = this.stage.activeGame;
      if (world && g?.hud) extra = [0, 1, 2, 3].map((i) => { try { return g.hud!(world, i); } catch { return ''; } });
      this.hud.update(dt, { coins, stars: this.phase === 'final' && this.final.currentStars.length ? this.final.currentStars : stars, extra });
      // in play: real-game style HUD (big faces + per-game status), clock in the middle like the original
      const playing = !!world;
      document.body.classList.toggle('playing', playing);
      // the real game's own HUD when the game has one (replaces the party cards and clock while playing)
      const real = !!(world && g?.ps1Hud);
      // the podium's own score strip (faces + points) replaces the party cards once it slides up
      const strip = !real && this.phase === 'final' ? this.podium.stripHud() : null;
      document.body.classList.toggle('realhud', real || (this.phase === 'final' && this.podium.stripShown));
      // once the strip has been up the winner line stays at the top and the cards stay away
      document.body.classList.toggle('podstrip', !real && this.phase === 'final' && this.podium.stripShown);
      this.ps1hud.show(real || !!strip);
      if (real) { try { this.ps1hud.draw(g!.ps1Hud!(world!, this.stage.ctx)); } catch { /* keep last frame */ } }
      else if (strip) this.ps1hud.draw(strip);
      if (world && c?.round) {
        const mg = getGame(c.round.gameId);
        if (mg && Number.isFinite(mg.maxTime)) this.hud.setClock(Math.max(0, mg.maxTime - world.time));
      }
    } else {
      this.ps1hud.show(false);
      document.body.classList.remove('realhud', 'podstrip');
    }

    // Keep the native sequence in sync with the room's phase deadline.
    const lead = c?.round?.countdownLeadTicks ?? 0;
    const frames = NUMBERED_COUNTDOWN_TICKS + lead;
    this.stage.ctx.countdownTicksLeft = undefined;
    if (c && this.phase === 'intro') {
      const rulesTicksLeft = Math.ceil(Math.max(0, c.phaseEnds - t) / (1000 * DT));
      this.stage.ctx.countdownTicksLeft = frames + rulesTicksLeft;
    }
    if (c && this.phase === 'countdown') {
      const frame = Math.max(0, Math.min(frames - 1, Math.floor(frames * (1 - (c.phaseEnds - t) / this.countMs))));
      this.stage.ctx.countdownTicksLeft = frames - frame;
      const numberedFrame = frame - lead;
      if (numberedFrame < 0) this.count.set('');
      else this.count.set(COUNT_LABELS[Math.floor(numberedFrame / COUNT_FRAMES)], numberedFrame % COUNT_FRAMES);
    } else if (this.phase === 'play') {
      this.count.advanceGo(Math.floor((t - this.playAt) / (1000 * DT)));
    }

    this.stage.render(arenaWorld, dt, t / 1000);
    this.count.draw(this.stage.gameVisible ? this.stage.renderer : null, t, this.phase === 'play' || this.phase === 'results' || this.phase === 'final');
    requestAnimationFrame((tt) => this.frame(tt));
  }
}

