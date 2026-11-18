import { EMOTES } from '../shared/look';
import { FAST_TIMING, NORMAL_TIMING, type Timing } from '../shared/party';
import type { Phase, ResultsMsg, RoomState, RoundMsg, WheelMsg } from '../shared/protocol';
import { getGame } from '../shared/registry';
import { DT, type World } from '../shared/types';
import { preloadBoardTextures } from './scene/tex';
import { PodiumScene } from './scene/podium';
import { ShowcaseScene } from './scene/showcase';
import { characterRefs, preloadCharacters } from './characters';
import { getCatalog, ready } from './crash';
import { VIEWS } from './games';
import type { RenderWorld } from './games/types';
import { InputManager } from './input';
import { createHostCore } from './net/hostCore';
import { LoopbackTransport } from './net/loopback';
import { PeerHost, PeerTransport, newRoomCode } from './net/peer';
import { TransportError, type ClientTransport, type HostCore } from './net/transport';
import { WsTransport } from './net/ws';
import { GameClient, type Status } from './session';
import { initPortraits, resetPortraits } from './shell/avatar';
import { Confetti } from './shell/confetti';
import { sfx } from './shell/sound';
import { TouchControls } from './shell/touch';
import { FinalOverlay } from './ui/final';
import { $, div, esc } from './ui/dom';
import { Hud, type SeatView } from './ui/hud';
import { LobbyScreen } from './ui/lobby';
import { CountOverlay, IntroOverlay, ResultsOverlay, WheelOverlay } from './ui/overlays';
import { TitleScreen, type Profile } from './ui/title';
import LOGO from './ui/img/logo.png';
import { Stage } from './view';

const FASTISH: Timing = { ...NORMAL_TIMING, intro: 1800, countdown: 1500, results: 4200, wheel: 3000, final: 18000, playCap: 5 };

interface HostHandle { core: HostCore; peer: PeerHost | null }

export class App {
  private params = new URLSearchParams(location.search);
  private lan = this.params.get('lan') === '1';
  private fast = this.params.get('fast');
  private nopeer = this.params.get('nopeer') === '1';
  private stage!: Stage;
  private input = new InputManager();
  private touch!: TouchControls;
  private confetti!: Confetti;
  private showcase = new ShowcaseScene();
  private podium = new PodiumScene();
  private title!: TitleScreen;
  private lobby!: LobbyScreen;
  private hud!: Hud;
  private wheel = new WheelOverlay();
  private intro = new IntroOverlay();
  private count = new CountOverlay();
  private results = new ResultsOverlay();
  private final = new FinalOverlay();
  private ui!: HTMLElement;
  private statusEl!: HTMLElement;
  private toastEl!: HTMLElement;
  private emoteBar!: HTMLElement;

  private client: GameClient | null = null;
  private host: HostHandle | null = null;
  private isHost = false;
  private phase: Phase | 'title' = 'title';
  private seats: SeatView[] = [];
  private pendingGame: RoundMsg | null = null;
  private gameName = '';
  private streaks = [0, 0, 0, 0];
  private trophies = [0, 0, 0, 0];
  private between = false;
  private resultsTimer = 0;
  private resultsAt = 0;
  private lastResults: ResultsMsg | null = null;
  private lastCount = '';
  private playAt = 0;
  private lastT = performance.now();
  private acc = 0;
  private finalTimer = 0;
  private wake: { release(): Promise<void> } | null = null;

  // ------------------------------------------------------------ boot
  async boot() {
    const root = document.getElementById('ui')!;
    this.ui = root;
    this.stage = new Stage(document.getElementById('c') as HTMLCanvasElement);
    this.confetti = new Confetti(document.getElementById('confetti') as HTMLCanvasElement);
    initPortraits(this.stage.renderer);
    this.buildUi(root);
    this.stage.onResize = () => this.layoutTitle();
    this.showSplash(true);

    const start = performance.now();
    try { await Promise.race([document.fonts.load('700 40px "Almendra SC"'), new Promise((r) => setTimeout(r, 3000))]); } catch { /* fallback serif */ }
    try {
      await Promise.race([this.preload(), new Promise((r) => setTimeout(r, 9000))]);
    } catch (e) { console.warn('preload failed', e); }
    resetPortraits();

    this.stage.register(this.showcase);
    this.stage.register(this.podium);
    void start;
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

  private async preload() {
    await preloadCharacters();
    const cat = getCatalog();
    const refs = [cat.props?.crystal, cat.props?.wumpa, cat.props?.podium, cat.arenas?.board, ...(cat.arenas?.board?.extra ?? [])];
    await Promise.all([ready(refs), preloadBoardTextures()]);
    void characterRefs;
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
      leave: () => this.leave(true),
      copy: () => void this.copyLink(),
    });
    this.hud = new Hud(root);
    this.touch = new TouchControls(root);
    this.touch.enabled = TouchControls.likely();
    this.input.touch = this.touch.sample;
    this.emoteBar = div('emotebar hidden', EMOTES.map((e, i) => `<button data-i="${i}">${e}</button>`).join(''));
    this.emoteBar.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('button');
      if (b) this.client?.emote(Number(b.dataset.i));
    });
    this.statusEl = div('statusbar hidden');
    this.toastEl = div('toast hidden');
    const top = div('topbar', `<button class="icon-btn" id="mute" title="Sound" aria-label="Sound settings"></button><button class="icon-btn hidden" id="leave" title="Leave" aria-label="Leave party">&times;</button>
      <div class="soundpanel pnl hidden"><div class="band"><h2 class="gt or">SOUND</h2></div><div class="pbody"><label class="chk sm"><input type="checkbox" id="mutechk"> MUTE ALL</label>
      <label class="sm" for="vmusic">MUSIC</label><input type="range" id="vmusic" min="0" max="100"><label class="sm" for="vsfx">EFFECTS</label><input type="range" id="vsfx" min="0" max="100"></div></div>`);
    root.append(this.title.el, this.lobby.el, this.hud.el, this.wheel.el, this.intro.el, this.count.el, this.results.el, this.final.el, this.emoteBar, top, this.statusEl, this.toastEl);
    const mute = $('#mute', top);
    const panel = $('.soundpanel', top);
    const chk = $('#mutechk', top) as HTMLInputElement, vm = $('#vmusic', top) as HTMLInputElement, vs = $('#vsfx', top) as HTMLInputElement;
    const paintMute = () => { chk.checked = sfx.muted; mute.innerHTML = sfx.muted ? '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2.5" fill="none"/></svg>' : '<svg viewBox="0 0 24 24"><path d="M3 9v6h4l5 4V5L7 9H3z"/><path d="M15.5 8.5a5 5 0 010 7M18 6a8.5 8.5 0 010 12" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>'; };
    vm.value = String(Math.round(sfx.vol.music * 100));
    vs.value = String(Math.round(sfx.vol.sfx * 100));
    paintMute();
    mute.onclick = () => { sfx.unlock(); panel.classList.toggle('hidden'); sfx.play('click'); };
    chk.onchange = () => { sfx.setMuted(chk.checked); paintMute(); };
    vm.oninput = () => sfx.setVolume('music', Number(vm.value) / 100);
    vs.oninput = () => sfx.setVolume('sfx', Number(vs.value) / 100);
    vs.onchange = () => sfx.play('coin');
    addEventListener('pointerdown', (e) => { if (!top.contains(e.target as Node)) panel.classList.add('hidden'); });
    $('#leave', top).onclick = () => this.leave(true);
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
    const wide = innerWidth > 860;
    this.showcase.setLayout('title', wide ? 0.25 : 0.5, wide ? 0.6 : 0.255);
  }

  /** Switch which top-level DOM layers are visible. */
  private setScreens(s: 'title' | 'lobby' | 'game') {
    this.title.el.classList.toggle('hidden', s !== 'title');
    this.lobby.show(s === 'lobby');
    this.hud.show(s === 'game');
    document.body.dataset.screen = s;
    $('#leave').classList.toggle('hidden', s === 'title');
    document.body.classList.remove('lb');
    if (s !== 'game') { this.wheel.hide(); this.intro.hide(); this.count.set(''); this.results.hide(); this.final.hide(); this.emoteBar.classList.add('hidden'); this.touch.show(false); this.input.capture = false; }
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
    try {
      let make: () => ClientTransport;
      let room = '';
      if (this.lan) {
        make = () => new WsTransport();
      } else {
        let code = newRoomCode();
        let core = createHostCore(code, 8, this.timing());
        let peer: PeerHost | null = null;
        if (!solo && !this.nopeer) {
          const proxy: HostCore = { open: (...a) => core.open(...a), message: (...a) => core.message(...a), close: (...a) => core.close(...a), destroy: () => core.destroy() };
          peer = new PeerHost(code, proxy);
          peer.onFatal = (m) => this.toast('Matchmaking connection problem: ' + m);
          try {
            const final = await peer.start();
            if (final !== code) { core.destroy(); code = final; core = createHostCore(code, 8, this.timing()); }
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
    const m = div('modal', `<div class="pnl card" role="alertdialog" aria-modal="true" aria-label="${esc(title)}"><div class="band"><h2 class="gt or">${esc(title)}</h2></div><div class="pbody"><p class="sm">${esc(text.toUpperCase())}</p><div class="menu">${buttons.map((b, i) => `<button class="mi ${i === 0 ? 'big' : ''}">${esc(b[0])}</button>`).join('')}</div></div></div>`);
    m.querySelectorAll('button').forEach((b, i) => { b.onclick = () => { m.remove(); buttons[i][1](); }; });
    this.ui.appendChild(m);
    m.querySelector('button')?.focus();
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
      this.lobby.update(r, this.client!.me, this.inviteLink(r.code));
      this.phase = 'lobby';
    } else if (this.between) {
      this.showcase.setLooks(r.seats.map((s) => s.look));
    }
    this.hud.setSeats(this.seats, this.mySlot());
    if (this.phase === 'final') {
      const humans = r.seats.filter((s) => s.clientId != null && s.connected).length;
      const me = this.mySlot();
      this.final.setVotes(r.rematch, humans, false);
      void me;
    }
  }

  private enterLobby() {
    this.phase = 'lobby';
    sfx.music('warp');
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
      this.emoteBar.classList.remove('hidden');
    }
    this.showcase.react(winner);
  }

  private onPhase(p: Phase, ms: number) {
    const prev = this.phase;
    this.phase = p;
    this.skipBtn?.classList.toggle('hidden', !(this.isHost && (p === 'wheel' || p === 'intro' || p === 'results')));
    switch (p) {
      case 'lobby': this.enterLobby(); if (this.client?.room) this.onRoom(this.client.room); break;
      case 'wheel':
        if (prev === 'final') { this.final.hide(); this.confetti.clear(); }
        break;
      case 'intro':
        this.between = false;
        document.body.classList.remove('lb');
        void this.levelMusic();
        this.results.hide();
        this.touch.show(false);
        this.showIntro();
        break;
      case 'countdown':
        this.intro.hide();
        break;
      case 'play':
        if (prev !== 'countdown') void this.levelMusic();
        this.intro.hide();
        this.count.set('GO!');
        sfx.play('go');
        this.playAt = performance.now();
        this.input.capture = true;
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
        sfx.music('podium');
        this.scheduleFinal(ms);
        break;
    }
  }

  private onEmote(slot: number, id: number) {
    sfx.play('emote');
    this.hud.emote(slot, id);
    this.lobby.emote(slot, id);
    this.showcase.bounce(slot);
  }

  // ------------------------------------------------------------ wheel / round / results
  private onWheel(m: WheelMsg) {
    this.phase = 'wheel';
    clearTimeout(this.resultsTimer);
    this.results.hide();
    document.body.classList.remove('lb');
    this.enterBetween();
    this.wheel.run(m, `ROUND ${m.round} OF ${m.total}`);
    this.hud.setRound(m.round, m.total);
  }

  private onRound(m: RoundMsg) {
    this.wheel.hide();
    this.pendingGame = m;
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
      if (ok) { this.setScreens('game'); this.hud.show(true); this.input.capture = true; this.emoteBar.classList.add('hidden'); }
    });
  }

  private variantName(): string | null {
    const c = this.client;
    const m = c?.round;
    const w = c?.snaps[c.snaps.length - 1]?.w as World | undefined;
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
      if (k) { sfx.music(k); return; }
    }
  }

  private showIntro() {
    const c = this.client;
    const m = c?.round;
    if (!c || !m) return;
    this.intro.show(m, this.variantName(), c.roundSlot, m.seats.map((s) => ({ name: s.name, look: s.look, bot: s.bot })), this.touch.enabled);
    sfx.play('whoosh');
    this.hud.setPillText(m.modifier ? m.modifier.name : 'MINI-GAME', m.gameName.toUpperCase());
  }

  private onResults(m: ResultsMsg) {
    this.lastResults = m;
    this.resultsAt = performance.now();
    this.count.set('');
    const w = m.placements[0];
    this.trophies = [...m.stars];
    this.streaks = this.streaks.map((v, i) => (i === w ? v + 1 : 0));
    this.emoteBar.classList.remove('hidden');
    if (m.final) return; // the final ceremony takes over
    const delay = this.stage.gameVisible ? 800 : 0;
    if (delay) { this.hud.banner('FINISH!', '', 'info', 700); sfx.play('whoosh'); }
    clearTimeout(this.resultsTimer);
    this.resultsTimer = window.setTimeout(() => {
      if (this.phase !== 'results') return;
      this.enterBetween(w);
      this.results.show(m, this.seats, this.mySlot(), this.streaks);
      document.body.classList.add('lb');
    }, delay);
  }

  private scheduleFinal(ms: number) {
    clearTimeout(this.finalTimer);
    const m = this.lastResults ?? this.client?.results;
    if (!m || !m.final) return;
    const introMs = Math.min(3600, ms * 0.14);
    this.finalTimer = window.setTimeout(() => {
      this.results.hide();
      this.stage.unloadGame();
      this.hud.setPillText('FINAL', 'RESULTS');
      void this.final.run(m, this.seats, ms, {
        podium: this.podium, hud: this.hud, confetti: this.confetti,
        showPodium: () => this.stage.show(this.podium),
        onRematch: () => this.client?.rematch(),
        onLobby: () => this.leaveToLobby(),
      }, introMs);
    }, introMs);
  }

  private leaveToLobby() {
    // Not a server concept: the party returns to the lobby on its own when the final ends. Just wait.
    this.toast('Heading back to the lobby...');
  }

  // ------------------------------------------------------------ frame
  private frame(t: number) {
    const dt = Math.min(0.1, (t - this.lastT) / 1000);
    this.lastT = t;
    const c = this.client;
    this.tryLoadGame();

    if (c && this.phase === 'play' && c.roundSlot != null) {
      this.acc += dt;
      for (let n = 0; this.acc >= DT && n < 5; n++, this.acc -= DT) c.sendInput(this.input.sample());
      if (this.acc > DT * 5) this.acc = 0;
    } else this.acc = 0;

    // lobby name tags
    if (this.phase === 'lobby' && this.stage.current === this.showcase) {
      const pts = [0, 1, 2, 3].map((i) => this.stage.project(this.showcase.footPos(i)));
      this.lobby.placeTags(pts);
    }

    // HUD cards: points + trophies (from the room's seats, updated on results)
    if (this.phase !== 'lobby' && this.phase !== 'title') {
      const r = this.lastResults;
      let coins = c?.room?.seats.map((x) => x.score) ?? [0, 0, 0, 0];
      let stars = this.trophies;
      if (r && this.phase === 'results' && performance.now() - this.resultsAt < 3400) { coins = r.prev; stars = r.stars.map((x, i) => x - (r.placements[0] === i ? 1 : 0)); }
      let extra: string[] | undefined;
      const world = this.phase === 'play' || this.phase === 'countdown' ? (c!.renderWorld(t) as RenderWorld | null) : null;
      const g = this.stage.activeGame;
      if (world && g?.hud) extra = [0, 1, 2, 3].map((i) => { try { return g.hud!(world, i); } catch { return ''; } });
      this.hud.update(dt, { coins, stars: this.phase === 'final' && this.final.currentStars.length ? this.final.currentStars : stars, extra });
      // in play: real-game style HUD (big faces + per-game status), clock in the middle like the original
      const playing = !!world;
      document.body.classList.toggle('playing', playing);
      if (world && c?.round) {
        const mg = getGame(c.round.gameId);
        if (mg) this.hud.setClock(Math.max(0, mg.maxTime - world.time));
      }
    }

    // countdown text
    if (c && this.phase === 'countdown') {
      const n = Math.max(1, Math.ceil((c.phaseEnds - t) / 1000));
      const txt = String(n);
      if (txt !== this.lastCount) { this.lastCount = txt; sfx.play('beep', 1); }
      this.count.set(txt);
    } else if (this.phase === 'play') {
      this.lastCount = '';
      if (t - this.playAt > 900) this.count.set('');
    }

    let world: RenderWorld | null = null;
    if (c && this.stage.gameVisible && (this.phase === 'play' || this.phase === 'countdown' || this.phase === 'intro' || this.phase === 'results' || this.phase === 'final')) world = c.renderWorld(t) as RenderWorld | null;
    this.stage.render(world, dt, t / 1000);
    requestAnimationFrame((tt) => this.frame(tt));
  }
}

