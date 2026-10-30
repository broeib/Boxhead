import './style.css';
import { mountFullscreen } from './fullscreen';
import { OriginalInput, renderControls } from './input';
import { OriginalRuffleHost, fetchOnlineSWF } from './ruffle';
import { loadOriginalMenu } from './launch';
import { OriginalBridge } from './bridge';
import { OriginalSession } from './session';
import { ClientError, makeInvitation, parseInvitation, parseServerMessage, publicError,
  type ConnectionIntent, type JoinSyncMessage, type NetworkStatusMessage, type OpenRoom, type Slot } from './protocol';
import type { NativeMenuEvent, NativeMenuUpdate } from './menu';
import { mountPlayerIdentity } from './player-identity';

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error('Missing original-web element');
  return value as T;
}

type RoomDetails = { name?: string; mode?: string; map?: string };

/** The SWF owns every menu and local mode; JavaScript connects its network actions. */
export class OriginalApp {
  private readonly stage = element<HTMLDivElement>('stage');
  private readonly status = element<HTMLParagraphElement>('status');
  private readonly controls = element<HTMLElement>('controls');
  private readonly synchronization = element<HTMLElement>('join-sync');
  private readonly synchronizationTitle = element<HTMLElement>('join-sync-title');
  private readonly synchronizationMessage = element<HTMLParagraphElement>('join-sync-message');
  private readonly synchronizationDetail = element<HTMLParagraphElement>('join-sync-detail');
  private readonly synchronizationHint = element<HTMLParagraphElement>('join-sync-hint');
  private readonly synchronizationProgress = element<HTMLProgressElement>('join-sync-progress');
  private readonly host = new OriginalRuffleHost(this.stage);
  private readonly playerIdentity = mountPlayerIdentity();
  private epoch = 0;
  private connectionEpoch = 0;
  private abort = new AbortController();
  private bridge: OriginalBridge | null = null;
  private swfHash = '';
  private menuSeq = 0;
  private menuTimer: ReturnType<typeof setTimeout> | undefined;
  private input: OriginalInput | null = null;
  private session: OriginalSession | null = null;
  private socket: WebSocket | null = null;
  private watchdog: ReturnType<typeof setInterval> | undefined;
  private browsing = false;
  private rooms: OpenRoom[] = [];
  private room: RoomDetails = {};
  private slot: Slot | null = null;
  private worldStarted = false;
  private replaying = false;
  private lastReplayStatus = 0;
  private synchronizationKind: 'guest' | 'host' | 'start' | 'network' | null = null;
  private synchronizationPhase: 'loading' | 'replaying' | 'paused' = 'loading';
  private synchronizationVerified = 0;
  private synchronizationTarget: number | null = null;
  private synchronizationTimeoutMs = 0;

  constructor() {
    mountFullscreen(element('game-display'), this.stage, element<HTMLButtonElement>('fullscreen'), element('fullscreen-message'));
    window.addEventListener('pagehide', () => { this.dispose(); });
    window.addEventListener('pageshow', (event) => {
      if (event.persisted) void this.boot(false);
    });
  }

  async boot(useInvitation = true): Promise<void> {
    const invitation = useInvitation ? location.href : '';
    const epoch = this.dispose();
    this.clearFragment();
    this.show('Loading Boxhead 2Play…', 'loading');
    this.controls.textContent = 'Choose ONLINE to play with a friend, or a local mode to play on this computer.';
    try {
      const asset = await fetchOnlineSWF(this.abort.signal);
      if (epoch !== this.epoch) return;
      const runtime = await loadOriginalMenu(this.host, asset.bytes, this.abort.signal);
      if (epoch !== this.epoch) return;
      this.bridge = runtime.bridge;
      this.stage.dataset.renderCheck = 'supported';
      this.stage.dataset.rendererPreference = runtime.renderer;
      this.swfHash = asset.hash;
      this.show('Choose a game mode. Select ONLINE for multiplayer.', 'menu');
      this.startMenuPolling();
      if (invitation && new URL(invitation).hash) {
        const parsed = parseInvitation(invitation, location.href);
        this.update({ state: 'rooms', payload: { rooms: [], message: 'Joining your invitation…' } });
        this.connect({ type: 'join', invitation: parsed, character: this.bridge.controls().online?.character ?? 0 });
      }
    } catch (error) {
      if (epoch === this.epoch) this.fail(publicError(error));
    }
  }

  private startMenuPolling(): void {
    this.stopMenuPolling();
    const epoch = this.epoch;
    const poll = (): void => {
      this.menuTimer = undefined;
      if (epoch !== this.epoch || !this.bridge) return;
      try {
        const event = this.bridge.menuPoll();
        if (event && event.seq > this.menuSeq) {
          this.menuSeq = event.seq;
          this.menuAction(event);
        }
      } catch (error) { this.fail(publicError(error)); return; }
      if (epoch === this.epoch && this.bridge &&
          !['preparing', 'ready', 'replaying', 'running', 'completing'].includes(this.session?.phase ?? '')) {
        this.menuTimer = setTimeout(poll, 100);
      }
    };
    this.menuTimer = setTimeout(poll, 100);
  }

  private stopMenuPolling(): void {
    if (this.menuTimer !== undefined) clearTimeout(this.menuTimer);
    this.menuTimer = undefined;
  }

  private menuAction(event: NativeMenuEvent): void {
    if (event.event === 'nickname') { this.playerIdentity.edit(); return; }
    if (event.event === 'reset') { void this.boot(false); return; }
    if (event.event === 'leave') {
      if (this.worldStarted) { void this.boot(false); return; }
      this.closeNetwork();
      this.clearFragment();
      this.update({ state: 'closed', payload: {} });
      this.show('Create a room or open ROOM LIST to join a game.', 'menu');
      return;
    }
    if (event.event === 'start') { this.session?.start(); return; }
    if (this.worldStarted || this.session) return;
    if (event.event === 'list') { this.browse(); return; }
    if (event.event === 'create') {
      const { name, mode, map, characters, settings } = event.payload;
      this.connect({ type: 'create', setup: { mode, map, characters, settings }, name, listed: true, dropIn: true });
    } else if (event.event === 'join') this.connect({ type: 'join_open', room: event.payload.room,
      character: event.payload.character ?? this.bridge?.controls().online?.character ?? 0 });
  }

  private browse(): void {
    if (!this.bridge || !this.swfHash) return;
    if (this.browsing && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'list', swfHash: this.swfHash }));
      return;
    }
    this.closeNetwork();
    this.browsing = true;
    this.openSocket();
    this.show('Finding open rooms…', 'browsing');
  }

  private connect(intent: ConnectionIntent): void {
    if (!this.bridge || !this.swfHash || this.session || this.worldStarted) return;
    if (!this.bridge.info().canPrepare) throw new ClientError('Return to the main menu first.');
    // The online profile belongs to this browser, independent of the assigned slot.
    const bindings = this.bridge.controls();
    const selected = intent.type === 'join_open' ? this.rooms.find((row) => row.room === intent.room) : undefined;
    const reuse = intent.type === 'join_open' && this.browsing && this.socket?.readyState === WebSocket.OPEN;
    if (!reuse) this.closeNetwork();
    this.browsing = false;
    this.room = intent.type === 'create'
      ? { name: intent.name, mode: intent.setup.mode, map: intent.setup.map }
      : selected ? { name: selected.name, mode: selected.mode, map: selected.map } : {};
    const socket = reuse ? this.socket! : this.openSocket();
    const epoch = this.connectionEpoch;
    this.input = new OriginalInput(this.stage, (mask, clear) => { this.session?.input(mask, clear); }, bindings);
    const current = (): boolean => this.socket === socket && this.connectionEpoch === epoch && this.session === session;
    const session = new OriginalSession(intent, this.swfHash, this.bridge, {
      send: (message) => {
        if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) throw new ClientError('The connection is unavailable.');
        socket.send(JSON.stringify(message));
      },
      close: () => { socket.close(1000); },
    }, {
      joined: (message) => {
        if (!current()) return;
        this.slot = message.slot;
        this.input?.setSlot(message.slot);
        history.replaceState(null, '', makeInvitation(location.href, message));
        renderControls(this.controls, message.slot, bindings);
        if (intent.type === 'create' && intent.dropIn) {
          this.show('Room created. Loading the map…', 'loading');
        } else if (intent.type === 'create') this.updateLobby(false);
        else this.show('Joining the game…', 'loading');
      },
      peer: (connected) => {
        if (!current()) return;
        if (this.synchronizationKind) return;
        if (this.worldStarted) this.show(connected ? 'Player 2 joined.' : 'Your game continues. A friend can join from ROOM LIST.', 'online');
        else if (!(intent.type === 'create' && intent.dropIn)) this.updateLobby(connected);
      },
      preparing: (message) => {
        if (!current()) return;
        // Native menu actions are unavailable once world preparation begins.
        // Keep their polling stopped throughout loading and historical replay;
        // terminal/failure paths explicitly restart it for the return menu.
        this.stopMenuPolling();
        this.worldStarted = true;
        this.replaying = message.replay === true;
        this.stage.dataset.networkPreparation = 'true';
        this.input?.setEnabled(false);
        if (this.replaying) {
          this.beginSynchronization('guest', 'loading');
          this.host.setReplayMuted(true);
        } else this.beginSynchronization('start', 'loading');
        this.room = { ...this.room, mode: message.mode, map: message.map };
        this.update({ state: 'loading', payload: { message: 'Loading the map…' } });
        this.show(this.replaying ? 'Loading the map to join the game…' : 'Loading the map…', 'loading');
      },
      prepared: (slot) => {
        if (!current()) return;
        this.input?.setSlot(slot);
        if (this.replaying) {
          this.synchronizationPhase = 'replaying';
          this.renderSynchronization();
        } else this.show('Map ready. Starting the game…', 'ready');
      },
      replaying: (tick) => {
        if (!current()) return;
        this.synchronizationVerified = tick;
        const now = performance.now();
        if (tick === 0 || now - this.lastReplayStatus >= 500) {
          this.lastReplayStatus = now;
          this.renderSynchronization();
        }
      },
      joinSync: (message, slot) => { if (current()) this.joinSync(message, slot); },
      networkStatus: (message) => { if (current()) this.networkStatus(message); },
      running: () => {
        if (!current()) return;
        this.stopMenuPolling();
        this.replaying = false;
        // Guest visibility/audio/input change only after the real join frame.
        this.clearSynchronization();
        delete this.stage.dataset.networkPreparation;
        this.update({ state: 'playing', payload: {} });
        this.input?.setEnabled(true);
        this.stage.focus();
        this.show(this.slot === 1 && intent.type === 'create' && intent.dropIn
          ? 'Game started. A friend can join from ROOM LIST.' : 'You’re playing online.', 'online');
      },
      stepped: () => { /* The original world owns its HUD. */ },
      finishing: () => {
        if (!current()) return;
        this.input?.setEnabled(false);
        this.show('Round finished. Waiting for the result…', 'online');
      },
      completed: (_tick, complete) => {
        if (!current()) return;
        this.input?.destroy();
        this.input = null;
        this.clearSynchronization();
        delete this.stage.dataset.networkPreparation;
        this.clearFragment();
        const message = complete === 'player1 wins' ? 'Player 1 wins!' :
          complete === 'player2 wins' ? 'Player 2 wins!' : 'Round finished.';
        this.update({ state: 'completed', payload: { message } });
        this.show(message + ' Return to the main menu to play again.', 'completed');
        this.startMenuPolling();
      },
      joinFailed: (message) => {
        if (!current()) return;
        // Preserve this subscribed socket after a normal room-claim race.
        this.session = null;
        this.input?.destroy();
        this.input = null;
        this.browsing = true;
        const explanation = message.code === 'swf_mismatch'
          ? 'This room uses a different game version. Choose another room.'
          : 'This room is full or closed. Choose another room.';
        this.update({ state: 'rooms', payload: { rooms: this.rooms.filter((row) => row.room !== message.room), message: explanation } });
        this.show(explanation, 'browsing');
      },
      failed: (message) => { if (current()) this.fail(message); },
    });
    this.session = session;
    if (socket.readyState === WebSocket.OPEN) session.opened();
    this.show('Joining the room…', 'joining');
  }

  private openSocket(): WebSocket {
    const url = new URL('/original-ws', location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.search = ''; url.hash = '';
    const socket = new WebSocket(url.href);
    this.socket = socket;
    this.playerIdentity.setConnected(true);
    const epoch = this.connectionEpoch;
    const current = (): boolean => this.socket === socket && this.connectionEpoch === epoch;
    const started = Date.now();
    socket.addEventListener('open', () => {
      if (!current()) return;
      const identity = this.playerIdentity.message();
      if (identity) socket.send(JSON.stringify(identity));
      if (this.session) this.session.opened();
      else if (this.browsing) socket.send(JSON.stringify({ type: 'list', swfHash: this.swfHash }));
    });
    socket.addEventListener('message', (event) => {
      if (!current()) return;
      try {
        const message = parseServerMessage(event.data);
        if (message.type === 'rooms') {
          // Stale discovery updates cannot paint over a joined lobby or world.
          if (this.browsing && !this.session) {
            this.rooms = message.rooms;
            this.update({ state: 'rooms', payload: { rooms: message.rooms } });
            this.show(message.rooms.length ? 'Choose a room in the game.' : 'No open rooms yet. Create one to start playing.', 'browsing');
          }
          return;
        }
        if (this.session) { void this.session.receive(event.data); return; }
        throw new ClientError('Room list unavailable. Return to ONLINE and try again.');
      } catch (error) { this.fail(publicError(error)); }
    });
    socket.addEventListener('close', () => {
      if (!current()) return;
      if (this.session) this.session.disconnected();
      else this.fail('Room list disconnected. Open ROOM LIST again.');
    });
    socket.addEventListener('error', () => {
      if (current()) this.fail('Could not connect to the game server. Return to ONLINE and try again.');
    });
    this.watchdog = setInterval(() => {
      if (!current()) return;
      if (socket.readyState === WebSocket.CONNECTING && Date.now() - started > 10_000) {
        this.fail('The game server did not respond. Return to ONLINE and try again.');
      } else this.session?.checkTimeout();
    }, 200);
    return socket;
  }

  private updateLobby(peerConnected: boolean): void {
    if (!this.slot) return;
    this.update({ state: 'lobby', payload: { slot: this.slot, peerConnected, ...this.room } });
    this.show(this.slot === 1
      ? peerConnected ? 'Player 2 joined. Select START GAME.' : 'Waiting for Player 2. Your room is listed in ROOM LIST.'
      : 'Waiting for the host to start.', 'waiting');
  }

  private update(update: NativeMenuUpdate): void {
    if (!this.bridge) throw new ClientError('The game menu is not ready yet.');
    this.bridge.menuUpdate(update);
  }

  private joinSync(message: JoinSyncMessage, slot: Slot): void {
    if (message.state === 'resumed') {
      // A guest still waits for its native player spawn, even after caught_up.
      if (slot !== 1) return;
      this.clearSynchronization();
      const playable = this.session?.phase === 'running';
      this.input?.setEnabled(playable);
      if (playable) this.stage.focus();
      this.show(this.session?.phase === 'completing' ? 'Round finished. Waiting for the result…'
        : message.joined ? 'Player 2 joined. The game continues.'
          : 'The guest could not join. Your game continues.', 'online');
      return;
    }
    if (message.state === 'paused') {
      if (slot === 1) {
        this.input?.setEnabled(false);
        this.beginSynchronization('host', 'paused');
        this.stage.dataset.networkPaused = 'true';
      }
      this.synchronizationPhase = 'paused';
      this.synchronizationTimeoutMs = message.timeoutMs;
    }
    this.synchronizationTarget = message.tick;
    this.synchronizationVerified = Math.max(this.synchronizationVerified, message.verified);
    this.renderSynchronization();
  }

  private networkStatus(message: NetworkStatusMessage | null): void {
    if (message?.state === 'waiting') {
      this.input?.setEnabled(false);
      this.beginSynchronization('network', 'paused');
      this.stage.dataset.networkPaused = 'true';
      this.synchronizationTitle.textContent = 'Waiting for connection';
      this.synchronizationMessage.textContent = message.slots.length === 2
        ? 'Waiting for both players to reconnect.'
        : `Waiting for Player ${message.slots[0]} to reconnect.`;
      this.synchronizationDetail.textContent = 'Your game is paused. It will continue when the connection recovers.';
      this.synchronizationHint.textContent = 'Controls are temporarily paused. Please keep this page open.';
      this.show('Game paused. Waiting for the connection to recover…', 'network-waiting');
      return;
    }
    if (this.synchronizationKind === 'network') this.clearSynchronization();
    if (!message) return;
    const playable = this.session?.phase === 'running';
    // Keep the initial loading cover until a real first native frame runs.
    if (this.session?.phase === 'ready') this.beginSynchronization('start', 'loading');
    this.input?.setEnabled(playable);
    if (playable) this.stage.focus();
    this.show(this.session?.phase === 'completing' ? 'Round finished. Waiting for the result…'
      : playable ? 'Connection restored. Your game continues.' : 'Connection restored. Starting the game…',
    playable || this.session?.phase === 'completing' ? 'online' : 'ready');
  }

  private beginSynchronization(kind: 'guest' | 'host' | 'start' | 'network', phase: 'loading' | 'paused'): void {
    this.clearSynchronization();
    this.synchronizationKind = kind;
    this.synchronizationPhase = phase;
    this.synchronization.hidden = false;
    this.stage.setAttribute('aria-busy', 'true');
    this.renderSynchronization();
  }

  private renderSynchronization(): void {
    const kind = this.synchronizationKind;
    if (!kind) return;
    const loading = this.synchronizationPhase === 'loading';
    const starting = kind === 'start';
    const target = this.synchronizationTarget;
    const verified = this.synchronizationVerified;
    this.synchronization.dataset.kind = kind;
    this.synchronization.dataset.phase = this.synchronizationPhase;
    this.synchronization.dataset.verified = String(verified);
    if (kind === 'network') return;
    this.synchronizationTitle.textContent = starting ? 'Loading the map' : kind === 'host' ? 'Game paused' : 'Joining the game';
    this.synchronizationMessage.textContent = starting ? 'Preparing your selected map.' : kind === 'host' ? 'Player 2 is joining.'
      : loading ? 'Loading the map.' : 'Catching up with the game.';
    if (target === null) {
      delete this.synchronization.dataset.target;
      this.synchronizationProgress.removeAttribute('value');
      this.synchronizationProgress.max = 1;
      this.synchronizationDetail.textContent = loading ? 'Preparing the game…' : 'Preparing your connection…';
    } else {
      this.synchronization.dataset.target = String(target);
      this.synchronizationProgress.max = Math.max(1, target);
      this.synchronizationProgress.value = target === 0 ? 1 : Math.min(verified, target);
      const percent = target === 0 ? 100 : Math.min(100, Math.floor(verified / target * 100));
      this.synchronizationDetail.textContent = percent === 100
        ? 'All caught up. Waiting for the game to resume…' : `Catching up: ${percent}%.`;
    }
    const budget = this.synchronizationTimeoutMs > 0
      ? ` Joining may take up to ${Math.ceil(this.synchronizationTimeoutMs / 1000)} seconds.` : '';
    this.synchronizationHint.textContent = starting ? 'The game will start when the map is ready.' : kind === 'guest'
      ? 'Controls will unlock when your character appears.' + budget
      : 'Controls are temporarily paused.' + budget;
    this.show(starting ? 'Loading the map…' : kind === 'host' ? 'Game paused while Player 2 joins.'
      : loading ? 'Loading the map to join the game…' : this.synchronizationDetail.textContent, loading ? 'loading' : 'synchronizing');
  }

  private clearSynchronization(): void {
    this.synchronization.hidden = true;
    delete this.synchronization.dataset.kind;
    delete this.synchronization.dataset.phase;
    delete this.synchronization.dataset.verified;
    delete this.synchronization.dataset.target;
    this.synchronizationKind = null;
    this.synchronizationPhase = 'loading';
    this.synchronizationVerified = 0;
    this.synchronizationTarget = null;
    this.synchronizationTimeoutMs = 0;
    this.synchronizationProgress.removeAttribute('value');
    this.synchronizationProgress.max = 1;
    this.synchronizationMessage.textContent = '';
    this.synchronizationDetail.textContent = '';
    this.synchronizationHint.textContent = '';
    this.stage.removeAttribute('aria-busy');
    delete this.stage.dataset.networkPaused;
    this.host.setReplayMuted(false);
  }

  private closeNetwork(): void {
    this.playerIdentity.setConnected(false);
    this.input?.destroy();
    this.input = null;
    const session = this.session;
    this.session = null;
    const socket = this.socket;
    this.socket = null;
    ++this.connectionEpoch;
    session?.close();
    try { socket?.close(1000); } catch { /* already closed */ }
    if (this.watchdog !== undefined) clearInterval(this.watchdog);
    this.watchdog = undefined;
    this.browsing = false;
    this.rooms = [];
    this.room = {};
    this.slot = null;
  }

  private dispose(): number {
    ++this.epoch;
    this.stopMenuPolling();
    this.abort.abort();
    this.abort = new AbortController();
    this.closeNetwork();
    this.bridge = null;
    this.swfHash = '';
    this.menuSeq = 0;
    this.worldStarted = false;
    this.replaying = false;
    this.lastReplayStatus = 0;
    this.clearSynchronization();
    this.host.destroy();
    delete this.stage.dataset.networkPreparation;
    delete this.stage.dataset.renderCheck;
    delete this.stage.dataset.rendererPreference;
    return this.epoch;
  }

  private fail(message: string): void {
    this.closeNetwork();
    this.clearSynchronization();
    delete this.stage.dataset.networkPreparation;
    this.clearFragment();
    this.show(message, 'error');
    if (this.bridge) {
      try {
        this.update({ state: 'error', payload: { message } });
        this.startMenuPolling();
      } catch { this.stopMenuPolling(); }
    } else this.host.destroy();
  }

  private show(message: string, state: string): void {
    this.status.textContent = message;
    this.status.dataset.state = state;
  }

  private clearFragment(): void {
    if (!location.hash) return;
    const url = new URL(location.href);
    url.hash = '';
    history.replaceState(null, '', url.href);
  }
}

void new OriginalApp().boot();

