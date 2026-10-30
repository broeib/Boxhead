import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

/** Normalize transport or explicitly trusted forwarding addresses. */
export function normalizeRemoteAddress(address) {
  if (typeof address !== 'string') return null;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  const ip = mapped ? mapped[1] : address;
  return isIP(ip) ? ip.toLowerCase() : null;
}

/** Forwarding headers are ignored unless the immediate peer is explicitly trusted. */
export function createRemoteAddressResolver(trustedProxyIPs = []) {
  if (!Array.isArray(trustedProxyIPs) || trustedProxyIPs.length > 32
    || trustedProxyIPs.some(ip => !normalizeRemoteAddress(ip))) {
    throw new TypeError('trustedProxyIPs must contain at most 32 literal IP addresses');
  }
  const trusted = new Set(trustedProxyIPs.map(normalizeRemoteAddress));
  return request => {
    const peer = normalizeRemoteAddress(request.socket.remoteAddress);
    const forwarded = request.headers['x-forwarded-for'];
    if (!trusted.has(peer) || typeof forwarded !== 'string') return peer;
    const hops = forwarded.split(',');
    let address = peer;
    // Walk from our trusted proxy toward the first untrusted peer. A visitor's
    // forged prefix is never used after the actual visitor address is found.
    for (let i = hops.length - 1, depth = 0; i >= 0 && trusted.has(address); i--, depth++) {
      if (depth >= 32) return peer;
      address = normalizeRemoteAddress(hops[i].trim());
      if (!address) return peer;
    }
    return address;
  };
}

const PLAYER_ID = /^bh_[a-f0-9]{32}$/;
const PLAYER_NAME = /^[\p{L}\p{N} _.-]{1,32}$/u;
const MAX_SAMPLES = 128;

/**
 * A bounded FIFO for a Node writable console stream. A false write result means
 * that Node accepted the line but needs drain before another write. Failed or
 * excess lines are counted once; logging never throws into the game loop.
 */
export function createConsoleSink(stream, { onDrop = () => {},
  maxBytes = 256 * 1024, maxLines = 1024 } = {}) {
  if (!stream || typeof stream.write !== 'function' || typeof stream.on !== 'function'
    || typeof stream.off !== 'function') throw new TypeError('Invalid console stream');
  if (typeof onDrop !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1
    || !Number.isSafeInteger(maxLines) || maxLines < 1) throw new TypeError('Invalid console sink limits');
  const queue = [];
  const pending = new Set();
  let bufferedBytes = 0;
  let blocked = Boolean(stream.writableNeedDrain);
  let failed = Boolean(stream.destroyed || stream.writableEnded);
  let closing = false;
  let pumping = false;
  let cleanupScheduled = false;

  function dropped(count) {
    if (!count) return;
    try { onDrop(count); } catch { /* Console diagnostics cannot break gameplay. */ }
  }

  function cleanup() {
    if (!closing || queue.length || pending.size || cleanupScheduled) return;
    cleanupScheduled = true;
    // Node calls a failed write callback before emitting the stream error. Keep
    // the listener through that turn, including during graceful server stop.
    setImmediate(() => {
      stream.off('error', onError);
      stream.off('drain', onDrain);
      stream.off('close', onClose);
    }).unref();
  }

  function fail() {
    failed = true;
    const count = queue.length + pending.size;
    queue.length = 0;
    pending.clear();
    bufferedBytes = 0;
    dropped(count);
    cleanup();
  }

  function onError() { fail(); }
  function onClose() { fail(); }
  function onDrain() {
    blocked = false;
    pump();
  }

  function pump() {
    if (pumping || failed || blocked) return;
    pumping = true;
    try {
      while (queue.length && !blocked && !failed) {
        const entry = queue.shift();
        pending.add(entry);
        try {
          const writable = stream.write(entry.text, (error) => {
            // An error event can have counted this and all other lines already.
            if (!pending.has(entry)) return;
            if (error) { fail(); return; }
            pending.delete(entry);
            bufferedBytes -= entry.bytes;
            cleanup();
          });
          if (!writable) blocked = true;
        } catch {
          fail();
        }
      }
    } finally {
      pumping = false;
      cleanup();
    }
  }

  stream.on('error', onError);
  stream.on('drain', onDrain);
  stream.on('close', onClose);
  return {
    write(line) {
      if (closing || failed) { dropped(1); return false; }
      const text = `${line}\n`;
      const bytes = Buffer.byteLength(text);
      if (queue.length + pending.size >= maxLines || bufferedBytes + bytes > maxBytes) {
        dropped(1);
        return false;
      }
      queue.push({ text, bytes });
      bufferedBytes += bytes;
      pump();
      return !failed;
    },
    close() {
      closing = true;
      cleanup();
    },
  };
}

/** Browser identities are labels for analytics, never authentication. */
export function readPlayerIdentity(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)
    || Object.keys(message).length !== 3 || message.type !== 'identify'
    || typeof message.id !== 'string' || !PLAYER_ID.test(message.id)
    || typeof message.name !== 'string' || message.name !== message.name.trim()
    || !PLAYER_NAME.test(message.name)) return null;
  return { id: message.id, name: message.name };
}

function rounded(value, digits = 2) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function sample(values, value) {
  if (!Number.isFinite(value) || value < 0) return;
  if (values.length === MAX_SAMPLES) values.shift();
  values.push(value);
}

function distribution(values) {
  if (!values.length) return { samples: 0, last_ms: null, p50_ms: null, p95_ms: null, max_ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: values.length,
    last_ms: rounded(values.at(-1)),
    p50_ms: rounded(sorted[Math.ceil(sorted.length * 0.5) - 1]),
    p95_ms: rounded(sorted[Math.ceil(sorted.length * 0.95) - 1]),
    max_ms: rounded(sorted.at(-1)),
  };
}

// Only known server-side reason codes are rendered; never echo arbitrary input.
const REASONS = {
  peer_disconnected: 'игрок отключился', server_shutdown: 'сервер остановлен',
  room_completed: 'матч завершён', ack_timeout: 'истекло время подтверждения кадра',
  digest_mismatch: 'состояния игры разошлись', completion_mismatch: 'результаты матча разошлись',
  ready_timeout: 'игроки не успели подготовиться', heartbeat_timeout: 'соединение перестало отвечать',
  catchup_timeout: 'истекло время синхронизации гостя', catchup_deadline: 'истекло время синхронизации гостя',
  catchup_barrier_timeout: 'истекло время ожидания синхронизации',
  host_ack_delayed: 'подключение отложено: хост восстанавливает соединение',
  replay_digest_mismatch: 'состояния при синхронизации разошлись',
  history_corrupt: 'ошибка истории кадров', history_limit: 'превышен лимит истории кадров',
  tick_limit: 'достигнут лимит кадров', lobby_timeout: 'истекло время ожидания в комнате',
  room_expired: 'срок жизни комнаты истёк', protocol_error: 'ошибка протокола',
  send_failed: 'не удалось отправить данные', ping_failed: 'не удалось проверить соединение',
  join_denied: 'доступ к комнате не подтверждён', room_full: 'комната заполнена',
  room_capacity: 'достигнут лимит комнат', swf_mismatch: 'версии игры не совпадают',
  rate_limited: 'слишком много сообщений', invalid_identity: 'недопустимое имя или профиль',
  identity_locked: 'профиль уже выбран', invalid_message: 'некорректное сообщение',
  invalid_json: 'некорректный формат сообщения', message_too_large: 'сообщение слишком большое',
  authentication_timeout: 'истекло время подключения',
};

function humanEvent(name, fields) {
  const reason = () => Object.hasOwn(REASONS, fields.reason) ? REASONS[fields.reason] : 'подробности в JSON-событии';
  const player = () => fields.player_id.startsWith('guest_') ? 'Гость' : fields.player_name;
  // Names reach this function only after the existing strict identity validation.
  switch (name) {
    case 'server_ready': return `Сервер готов, порт ${fields.port}.`;
    case 'server_stopped': return 'Сервер остановлен.';
    case 'client_connected': return 'Клиент подключился к онлайн-службе.';
    case 'client_identified': return `Игрок представился: ${player()}.`;
    case 'client_disconnected': return `Клиент отключился: ${player()}.`;
    case 'room_created': return 'Комната создана.';
    case 'room_player_joined': return `${player()} занял слот ${fields.slot}${fields.catching_up ? ' и синхронизируется' : ''}.`;
    case 'room_started': return 'Матч запущен; ожидание подтверждённых кадров.';
    case 'player_started': return `${player()} начал игру: первый кадр подтверждён.`;
    case 'player_session_ended': return `${player()}: ${fields.played ? 'игра закончена' : 'вход завершён до начала игры'} (${reason()}).`;
    case 'catchup_failed': return `Не удалось синхронизировать гостя (${reason()}).`;
    case 'client_rejected': return `Клиент отклонён (${reason()}).`;
    case 'room_completed': return 'Матч завершён.';
    case 'room_ended': return `Комната остановлена (${reason()}).`;
    case 'network_wait_started': return `Игра ждёт подтверждения кадров от игрока ${fields.missing_slots.join(', ')}; соединение может восстановиться.`;
    case 'network_wait_finished': return `Соединение восстановлено; игра продолжается (ожидание ${fields.duration_ms} мс).`;
    case 'network_wait_expired': return `Время восстановления соединения истекло; нет подтверждения от игрока ${fields.missing_slots.join(', ')}.`;
    case 'console_unknown_command': return 'Неизвестная команда. Доступны: status, players, rooms, help.';
    case 'server_status': return `Состояние: комнат ${fields.rooms}, соединений ${fields.connections}, игроков в игре ${fields.unique_playing_users}, игровых сессий ${fields.playing_sessions}; CPU ${fields.process_cpu_percent}%, память ${fields.rss_mib} МиБ; потеряно строк журнала ${fields.dropped_logs}.`;
    case 'player_count': return `Соединений: ${fields.connections}; игроков в игре: ${fields.unique_playing_users}.`;
    case 'room_count': return `Комнат: ${fields.rooms}.`;
    default: return null;
  }
}

/**
 * Bounded operational output for the GenericModule console. The game remains
 * client-executed lockstep: ACK timings and verified ticks are not render FPS.
 */
export function createTelemetry({ rooms, peers, intervalMs = 30_000, write } = {}) {
  if (write !== undefined && typeof write !== 'function') throw new TypeError('Invalid log writer');
  if (!Number.isInteger(intervalMs) || intervalMs < 1000 || intervalMs > 3_600_000) {
    throw new TypeError('Invalid metricsIntervalMs');
  }
  const states = new WeakMap();
  const roomStates = new WeakMap();
  const activeUsers = new Map();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  let timer;
  let startedAt = performance.now();
  let sampleAt = startedAt;
  let cpuAt = process.cpuUsage();
  let droppedLogs = 0;
  let running = false;
  const consoleSink = write === undefined
    ? createConsoleSink(process.stdout, { onDrop: (count) => { droppedLogs += count; } }) : null;
  const writer = write ?? consoleSink.write;

  function line(value) {
    // An unavailable console must not break a native frame or player cleanup.
    try { writer(value); } catch { droppedLogs += 1; }
  }

  function event(eventName, fields = {}, level = 'info') {
    line(JSON.stringify({ time: new Date().toISOString(), level, event: eventName, ...fields }));
    const message = humanEvent(eventName, fields);
    if (message) line(`BOXHEAD: ${message}`);
  }

  function state(peer) {
    let value = states.get(peer);
    if (!value) {
      const id = `guest_${randomBytes(16).toString('hex')}`;
      value = {
        id, name: `Guest-${id.slice(-8)}`, identified: false,
        connection: randomBytes(8).toString('hex'), connectedAt: performance.now(),
        closed: false, membership: null, ping: null, rtt: [], ack: [],
      };
      states.set(peer, value);
    }
    return value;
  }

  function roomState(room) {
    let value = roomStates.get(room);
    if (!value) {
      value = {
        // Invitation IDs/tokens and private room names never enter the console.
        ref: `room-${createHash('sha256').update(room.id).digest('hex').slice(0, 12)}`,
        sampleAt: performance.now(), verifiedTick: room.verifiedTick ?? 0,
      };
      roomStates.set(room, value);
    }
    return value;
  }

  function identityFields(peer) {
    const value = state(peer);
    return { connection: value.connection, player_id: value.id, player_name: value.name };
  }

  function displayName(value) {
    // Different browsers can choose the same nickname. Keep their roster rows
    // recognisable, while retaining the stable full id for Analytics.
    return `${value.name} [${value.id.slice(-8)}]`;
  }

  function connected(peer) {
    event('client_connected', identityFields(peer));
  }

  function identify(peer, identity) {
    const value = state(peer);
    if (value.identified || value.membership) return false;
    value.id = identity.id;
    value.name = identity.name;
    value.identified = true;
    event('client_identified', identityFields(peer));
    return true;
  }

  function joined(peer, room) {
    const value = state(peer);
    value.membership = {
      room: roomState(room).ref, slot: peer.slot, joinedAt: performance.now(),
      playedAt: null, firstTick: null, lastTick: null,
    };
    event('room_player_joined', { ...identityFields(peer), room: value.membership.room,
      slot: peer.slot, map: room.map, mode: room.mode, catching_up: Boolean(peer.catchingUp) });
  }

  function played(peer, room, tick) {
    const value = state(peer);
    const membership = value.membership;
    if (!membership || membership.room !== roomState(room).ref) return;
    membership.lastTick = tick;
    if (membership.playedAt !== null) return;
    membership.playedAt = performance.now();
    membership.firstTick = tick;
    let active = activeUsers.get(value.id);
    if (!active) {
      active = { count: 0, name: displayName(value) };
      activeUsers.set(value.id, active);
      const ip = normalizeRemoteAddress(peer.remoteAddress);
      line(`BOXHEAD PLAYER_JOIN userid=${value.id}${ip ? ` endpoint=${ip}` : ''} username=${active.name}`);
    }
    active.count += 1;
    event('player_started', { ...identityFields(peer), room: membership.room,
      slot: membership.slot, first_verified_tick: tick,
      waiting_ms: rounded(membership.playedAt - membership.joinedAt) });
  }

  function left(peer, reason) {
    const value = state(peer);
    const membership = value.membership;
    if (!membership) return;
    value.membership = null;
    const now = performance.now();
    const played = membership.playedAt !== null;
    event('player_session_ended', {
      ...identityFields(peer), room: membership.room, slot: membership.slot, reason,
      played, room_ms: rounded(now - membership.joinedAt),
      played_ms: played ? rounded(now - membership.playedAt) : 0,
      first_verified_tick: membership.firstTick, last_verified_tick: membership.lastTick,
      websocket_rtt: distribution(value.rtt), native_ack_latency: distribution(value.ack),
    });
    if (played) {
      const active = activeUsers.get(value.id);
      if (active && --active.count === 0) {
        line(`BOXHEAD PLAYER_LEAVE userid=${value.id} username=${active.name}`);
        activeUsers.delete(value.id);
      }
    }
  }

  function closed(peer, code) {
    const value = state(peer);
    if (value.closed) return;
    value.closed = true;
    left(peer, 'peer_disconnected');
    event('client_disconnected', { ...identityFields(peer), close_code: code,
      connected_ms: rounded(performance.now() - value.connectedAt) });
  }

  function ping(peer) {
    const value = state(peer);
    const nonce = randomBytes(8);
    value.ping = { nonce, at: performance.now() };
    return nonce;
  }

  function pong(peer, data) {
    const value = state(peer);
    if (!value.ping || !Buffer.isBuffer(data) || !data.equals(value.ping.nonce)) return;
    sample(value.rtt, performance.now() - value.ping.at);
    value.ping = null;
  }

  function acknowledge(peer, sentAt, now) {
    sample(state(peer).ack, now - sentAt);
  }

  function playerStatus(peer) {
    const value = state(peer);
    const membership = value.membership;
    return {
      ...identityFields(peer), room: membership?.room ?? null, slot: membership?.slot ?? null,
      phase: !membership ? 'browsing' : membership.playedAt === null ? 'joining' : 'playing',
      connected_ms: rounded(performance.now() - value.connectedAt),
      websocket_rtt: distribution(value.rtt), native_ack_latency: distribution(value.ack),
    };
  }

  function roomStatus(room, now, update = false) {
    const value = roomState(room);
    const elapsed = now - value.sampleAt;
    const result = {
      room: value.ref, map: room.map, mode: room.mode, phase: room.phase,
      players: room.players.filter(Boolean).length, active_players: room.activePlayers,
      tick: room.tick, verified_tick: room.verifiedTick, pending_frames: room.pending.size,
      target_ticks_per_second: rounded(1000 / room.frameMs),
      verified_ticks_per_second: elapsed > 0 ? rounded((room.verifiedTick - value.verifiedTick) * 1000 / elapsed) : null,
      joining: Boolean(room.players[1]?.catchingUp),
      join_barrier: room.joinBarrierAt !== null,
    };
    if (update) { value.sampleAt = now; value.verifiedTick = room.verifiedTick; }
    return result;
  }

  function report(command = 'status') {
    if (command === 'players') {
      for (const peer of peers) event('player_status', playerStatus(peer));
      event('player_count', { connections: peers.size, unique_playing_users: activeUsers.size });
      return;
    }
    const now = performance.now();
    if (command === 'rooms') {
      for (const room of rooms.values()) event('room_status', roomStatus(room, now));
      event('room_count', { rooms: rooms.size });
      return;
    }
    if (command === 'help') {
      line('BOXHEAD CONSOLE commands: status, players, rooms, help');
      line('BOXHEAD: Доступные команды: status, players, rooms, help.');
      return;
    }
    if (command !== 'status') {
      // Never echo arbitrary console text, which can contain a pasted secret.
      event('console_unknown_command', { commands: ['status', 'players', 'rooms', 'help'] }, 'warn');
      return;
    }
    const cpu = process.cpuUsage();
    const elapsed = now - sampleAt;
    const cpuPercent = elapsed > 0 ? rounded((cpu.user + cpu.system - cpuAt.user - cpuAt.system) / (elapsed * 10)) : 0;
    const memory = process.memoryUsage();
    const roomRows = [...rooms.values()].map((room) => roomStatus(room, now, true));
    const maxPending = roomRows.reduce((max, room) => Math.max(max, room.pending_frames), 0);
    const loopP95 = eventLoop.count ? rounded(eventLoop.percentile(95) / 1e6) : null;
    const summary = {
      uptime_s: rounded((now - startedAt) / 1000), sample_ms: rounded(elapsed),
      rooms: rooms.size, connections: peers.size, unique_playing_users: activeUsers.size,
      playing_sessions: [...activeUsers.values()].reduce((count, user) => count + user.count, 0),
      process_cpu_percent: cpuPercent, rss_mib: rounded(memory.rss / 1048576),
      heap_used_mib: rounded(memory.heapUsed / 1048576),
      event_loop_p95_ms: loopP95, event_loop_max_ms: eventLoop.count ? rounded(eventLoop.max / 1e6) : null,
      event_loop_samples: eventLoop.count, pending_frames_max: maxPending, dropped_logs: droppedLogs,
    };
    event('server_status', summary);
    line(`BOXHEAD METRICS rooms=${summary.rooms} players=${summary.unique_playing_users} connections=${summary.connections} cpu_pct=${summary.process_cpu_percent ?? 0} rss_mib=${summary.rss_mib ?? 0} event_loop_p95_ms=${loopP95 ?? 0} event_loop_samples=${eventLoop.count} pending_frames=${maxPending}`);
    for (const room of roomRows) event('room_status', room);
    for (const peer of peers) if (state(peer).membership) event('player_status', playerStatus(peer));
    cpuAt = cpu;
    sampleAt = now;
    eventLoop.reset();
  }

  function start(address) {
    if (running) return;
    running = true;
    startedAt = sampleAt = performance.now();
    cpuAt = process.cpuUsage();
    eventLoop.enable();
    event('server_ready', { mode: 'server-coordinated-lockstep', port: address.port,
      metrics_interval_ms: intervalMs, identity: 'self-declared-browser-profile' });
    line(`BOXHEAD READY port=${address.port} mode=original-lockstep`);
    timer = setInterval(report, intervalMs);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
    eventLoop.disable();
    if (running) event('server_stopped', { uptime_s: rounded((performance.now() - startedAt) / 1000) });
    running = false;
    consoleSink?.close();
  }

  return {
    connected, identify, joined, played, left, closed, ping, pong, acknowledge,
    report, start, stop,
    rejected: (peer, reason) => event('client_rejected', { ...identityFields(peer), reason }, 'warn'),
    roomEvent: (name, room, reason, fields = {}) => event(name, { room: roomState(room).ref,
      map: room.map, mode: room.mode, tick: room.tick, ...(reason ? { reason } : {}), ...fields }),
  };
}
