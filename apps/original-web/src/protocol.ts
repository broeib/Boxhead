export class ClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientError';
  }
}

export type Slot = 1 | 2;
export type Mode = 'Coop' | 'DeathMatch';
export interface OriginalSettings {
  difficulty: number;
  speed: number;
  devils: number;
  collisions: number;
  damage: number;
  gameAmount: number;
}
export const DEFAULT_SETTINGS: Readonly<OriginalSettings> = {
  difficulty: 0, speed: 1, devils: 1, collisions: 1, damage: 1, gameAmount: 1,
};
export interface Setup {
  mode: Mode;
  map: string;
  characters: [number, number];
  settings?: OriginalSettings;
}
export interface PrepareMessage extends Setup {
  type: 'prepare';
  seed: number;
  swfHash: string;
  frameMs?: number;
  initialPlayers?: 1 | 2;
  replay?: boolean;
  replayBatchMax?: number;
  replayBatchExtendedMax?: number;
  personalProgression?: boolean;
  checkpointVersion?: 1;
  membershipVersion?: 1 | 2;
}
export interface PlayerJoin { slot: 2; character: number }
export interface PlayerLeave { slot: 2 }
export interface JoinedMessage {
  type: 'joined';
  room: string;
  slot: Slot;
  token: string;
}
export interface FrameMessage {
  type: 'frame';
  tick: number;
  p1: number;
  p2: number;
  join?: PlayerJoin;
  leave?: PlayerLeave;
}
export interface ReplayFramesMessage {
  type: 'replay_frames';
  frames: FrameMessage[];
}
export const MAX_REPLAY_BATCH_FRAMES = 64;
export const DEFAULT_REPLAY_BATCH_FRAMES = 64;
export const CHECKPOINT_CHUNK_BYTES = 32_768;
export const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
export const MAX_CHECKPOINT_RAW_BYTES = 16 * 1024 * 1024;
export interface CheckpointHeader {
  type: 'checkpoint_begin';
  id: string;
  version: 1;
  tick: number;
  digest: string;
  encoding: 'deflate' | 'plain';
  bytes: number;
  uncompressedBytes: number;
  sha256: string;
  chunks: number;
}
export type CheckpointMessage = CheckpointHeader |
  { type: 'checkpoint_request'; id: string; minimumTick: number } |
  { type: 'checkpoint_wait'; id: string; timeoutMs: number } |
  { type: 'checkpoint_credit'; id: string; index: number } |
  { type: 'checkpoint_cancel' | 'checkpoint_fallback' | 'checkpoint_end'; id: string } |
  { type: 'checkpoint_chunk'; id: string; index: number; data: string };
export interface OpenRoom {
  room: string;
  name: string;
  mode: Mode;
  map: string;
  players: 1;
  capacity: 2;
}
export interface RoomsMessage {
  type: 'rooms';
  rooms: OpenRoom[];
}
export interface JoinFailedMessage {
  type: 'join_failed';
  room: string;
  code: 'unavailable' | 'swf_mismatch';
}
export type JoinSyncMessage =
  | { type: 'join_sync'; state: 'paused'; tick: number; verified: number; timeoutMs: number }
  | { type: 'join_sync'; state: 'progress'; tick: number; verified: number }
  | { type: 'join_sync'; state: 'resumed'; tick: number; joined: boolean };
export type NetworkStatusMessage =
  | { type: 'network_status'; state: 'waiting'; tick: number; timeoutMs: number; slots: Slot[] }
  | { type: 'network_status'; state: 'resumed'; tick: number };
export type ServerMessage = JoinedMessage | PrepareMessage | FrameMessage | ReplayFramesMessage | CheckpointMessage |
  RoomsMessage | JoinFailedMessage | JoinSyncMessage | NetworkStatusMessage |
  { type: 'caught_up'; tick: number } |
  { type: 'completed'; tick: number; complete: string } |
  { type: 'peer'; slot: 2; connected: boolean } | { type: 'error' | 'paused' };
export interface Invitation { room: string; token: string }
export type ConnectionIntent =
  | { type: 'create'; setup: Setup; name?: string; listed?: boolean; dropIn?: boolean }
  | { type: 'join'; invitation: Invitation; character?: number }
  | { type: 'join_open'; room: string; character?: number };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function integer(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

export function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isMask(value: unknown): value is number {
  return integer(value, 0, 131071);
}

export function isHash(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

export function readPlayerJoin(value: unknown): PlayerJoin {
  if (!isRecord(value) || Object.keys(value).length !== 2 || value.slot !== 2 || !integer(value.character, 0, 3)) {
    throw new ClientError('Invalid second-player spawn event.');
  }
  return { slot: 2, character: value.character };
}

export function readPlayerLeave(value: unknown): PlayerLeave {
  if (!isRecord(value) || Object.keys(value).length !== 1 || value.slot !== 2) {
    throw new ClientError('Invalid second-player departure event.');
  }
  return { slot: 2 };
}

export function readSettings(value: unknown): OriginalSettings {
  if (value === undefined) return { ...DEFAULT_SETTINGS };
  if (!isRecord(value) || !integer(value.difficulty, 0, 3) || !integer(value.speed, 0, 2) ||
      !integer(value.devils, 0, 1) || !integer(value.collisions, 0, 1) ||
      !integer(value.damage, 0, 1) || !integer(value.gameAmount, 0, 3) ||
      Object.keys(value).some((key) => !Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, key))) {
    throw new ClientError('Invalid original game settings.');
  }
  return { difficulty: value.difficulty, speed: value.speed, devils: value.devils,
    collisions: value.collisions, damage: value.damage, gameAmount: value.gameAmount };
}

function roomId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
}

function roomToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);
}

export function readRoomName(value: unknown): string {
  if (!boundedText(value, 48) || value.trim() !== value) {
    throw new ClientError('Room names must contain 1–48 characters with no leading or trailing spaces.');
  }
  return value;
}

function readOpenRoom(value: unknown): OpenRoom {
  if (!isRecord(value) || !roomId(value.room) || value.room.length !== 12 ||
      (value.mode !== 'Coop' && value.mode !== 'DeathMatch') ||
      typeof value.map !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_ -]{0,63}$/.test(value.map) ||
      value.players !== 1 || value.capacity !== 2 || Object.keys(value).length !== 6 ||
      !['room', 'name', 'mode', 'map', 'players', 'capacity'].every((key) => Object.hasOwn(value, key))) {
    throw new ClientError('The server sent an invalid public room.');
  }
  return { room: value.room, name: readRoomName(value.name), mode: value.mode,
    map: value.map, players: 1, capacity: 2 };
}

export function readSetup(value: unknown): Setup {
  if (!isRecord(value) || (value.mode !== 'Coop' && value.mode !== 'DeathMatch') ||
      !boundedText(value.map, 128) || value.map.trim() !== value.map ||
      !Array.isArray(value.characters) || value.characters.length !== 2 ||
      !value.characters.every((character) => integer(character, 0, 3))) {
    throw new ClientError('Specify a mode, an exact mapLink and two original characters (0–3).');
  }
  return {
    mode: value.mode,
    map: value.map,
    characters: [value.characters[0] as number, value.characters[1] as number],
    settings: readSettings(value.settings),
  };
}

function readFrame(value: Record<string, unknown>): FrameMessage {
  if (!integer(value.tick, 1, 0x7fffffff) || !isMask(value.p1) || !isMask(value.p2) ||
      Object.keys(value).some(key => !['type', 'tick', 'p1', 'p2', 'join', 'leave'].includes(key)) ||
      (Object.hasOwn(value, 'join') && Object.hasOwn(value, 'leave'))) {
    throw new ClientError('Invalid server tick or input mask.');
  }
  return { type: 'frame', tick: value.tick, p1: value.p1, p2: value.p2,
    ...(Object.hasOwn(value, 'join') ? { join: readPlayerJoin(value.join) } : {}),
    ...(Object.hasOwn(value, 'leave') ? { leave: readPlayerLeave(value.leave) } : {}) };
}

export function parseServerMessage(raw: unknown): ServerMessage {
  if (typeof raw !== 'string' || raw.length > 65_536) {
    throw new ClientError('The server sent an unsupported or oversized message.');
  }
  let value: unknown;
  try { value = JSON.parse(raw); } catch {
    throw new ClientError('The server sent invalid JSON.');
  }
  if (!isRecord(value)) throw new ClientError('Invalid server message structure.');
  if (typeof value.type === 'string' && value.type.startsWith('checkpoint_')) {
    if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(value.id)) {
      throw new ClientError('Invalid world snapshot identifier.');
    }
    const keys = Object.keys(value);
    if (value.type === 'checkpoint_request' && keys.length === 3 && integer(value.minimumTick, 0, 0x7fffffff)) {
      return { type: value.type, id: value.id, minimumTick: value.minimumTick };
    }
    if (value.type === 'checkpoint_wait' && keys.length === 3 && integer(value.timeoutMs, 1, 30_000)) {
      return { type: value.type, id: value.id, timeoutMs: value.timeoutMs };
    }
    if (value.type === 'checkpoint_credit' && keys.length === 3 && integer(value.index, 0, 128)) {
      return { type: value.type, id: value.id, index: value.index };
    }
    if (['checkpoint_cancel', 'checkpoint_fallback', 'checkpoint_end'].includes(value.type) && keys.length === 2) {
      return { type: value.type as 'checkpoint_cancel' | 'checkpoint_fallback' | 'checkpoint_end', id: value.id };
    }
    if (value.type === 'checkpoint_chunk' && keys.length === 4 && integer(value.index, 0, 127)
      && typeof value.data === 'string' && value.data.length > 0 && value.data.length <= 43_692
      && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
      return { type: value.type, id: value.id, index: value.index, data: value.data };
    }
    if (value.type === 'checkpoint_begin' && keys.length === 10 && value.version === 1
      && integer(value.tick, 25, 0x7fffffff) && value.tick % 25 === 0
      && typeof value.digest === 'string' && /^[!-~]{1,256}$/.test(value.digest)
      && (value.encoding === 'deflate' || value.encoding === 'plain')
      && integer(value.bytes, 1, MAX_CHECKPOINT_BYTES)
      && integer(value.uncompressedBytes, 1, MAX_CHECKPOINT_RAW_BYTES)
      && (value.encoding !== 'plain' || value.bytes === value.uncompressedBytes)
      && isHash(value.sha256) && value.chunks === Math.ceil(value.bytes / CHECKPOINT_CHUNK_BYTES)) {
      return value as unknown as CheckpointHeader;
    }
    throw new ClientError('Invalid world state transfer message.');
  }
  if (value.type === 'rooms') {
    if (!Array.isArray(value.rooms) || value.rooms.length > 128 || Object.keys(value).length !== 2) {
      throw new ClientError('The server sent an invalid room list.');
    }
    const rooms = value.rooms.map(readOpenRoom);
    if (new Set(rooms.map((room) => room.room)).size !== rooms.length) {
      throw new ClientError('The server sent duplicate rooms.');
    }
    return { type: 'rooms', rooms };
  }
  if (value.type === 'join_failed') {
    if (!roomId(value.room) || value.room.length !== 12 || Object.keys(value).length !== 3 ||
        (value.code !== 'unavailable' && value.code !== 'swf_mismatch')) {
      throw new ClientError('The server sent an invalid room join result.');
    }
    return { type: 'join_failed', room: value.room, code: value.code };
  }
  if (value.type === 'joined') {
    if (!roomId(value.room) || !roomToken(value.token) || (value.slot !== 1 && value.slot !== 2)) {
      throw new ClientError('The server sent invalid room data.');
    }
    return { type: 'joined', room: value.room, token: value.token, slot: value.slot };
  }
  if (value.type === 'peer') {
    if (value.slot !== 2 || typeof value.connected !== 'boolean') throw new ClientError('Invalid second-player notification.');
    return { type: 'peer', slot: 2, connected: value.connected };
  }
  if (value.type === 'prepare') {
    const setup = readSetup(value);
    if (!integer(value.seed, 0, 0xffffffff) || !isHash(value.swfHash)) {
      throw new ClientError('Invalid seed or online SWF SHA256.');
    }
    const expectedFrameMs = [80, 40, 20][setup.settings?.speed ?? 1];
    if (value.frameMs !== undefined && value.frameMs !== expectedFrameMs) {
      throw new ClientError('The server sent a speed that differs from the original settings.');
    }
    if ((value.initialPlayers !== undefined && value.initialPlayers !== 1 && value.initialPlayers !== 2) ||
        (value.replay !== undefined && typeof value.replay !== 'boolean') ||
        (value.personalProgression !== undefined && typeof value.personalProgression !== 'boolean') ||
        (value.membershipVersion !== undefined && ((value.membershipVersion !== 1 && value.membershipVersion !== 2) ||
          (value.initialPlayers !== 1 && value.initialPlayers !== 2) || value.personalProgression !== true ||
          (value.membershipVersion === 1 && (value.initialPlayers !== 1 || value.mode !== 'Coop')))) ||
        (value.replay === true && ((value.initialPlayers !== 1 && value.membershipVersion !== 2) || value.personalProgression !== true)) ||
        (value.replayBatchMax !== undefined && (value.replay !== true || !integer(value.replayBatchMax, 1, 8))) ||
        (value.replayBatchExtendedMax !== undefined && (value.replay !== true || value.replayBatchMax !== 8 ||
          !integer(value.replayBatchExtendedMax, 9, MAX_REPLAY_BATCH_FRAMES))) ||
        (value.checkpointVersion !== undefined && (value.checkpointVersion !== 1 || value.replay !== true))) {
      throw new ClientError('Invalid late-join parameters.');
    }
    return { type: 'prepare', ...setup, seed: value.seed, swfHash: value.swfHash, frameMs: expectedFrameMs,
      ...(value.initialPlayers !== undefined ? { initialPlayers: value.initialPlayers as 1 | 2 } : {}),
      ...(value.replay !== undefined ? { replay: value.replay as boolean } : {}),
      ...(value.replayBatchMax !== undefined ? { replayBatchMax: value.replayBatchMax as number } : {}),
      ...(value.replayBatchExtendedMax !== undefined ? { replayBatchExtendedMax: value.replayBatchExtendedMax as number } : {}),
      ...(value.checkpointVersion !== undefined ? { checkpointVersion: 1 as const } : {}),
      ...(value.membershipVersion !== undefined ? { membershipVersion: value.membershipVersion as 1 | 2 } : {}),
      ...(value.personalProgression !== undefined ? { personalProgression: value.personalProgression as boolean } : {}) };
  }
  if (value.type === 'frame') {
    return readFrame(value);
  }
  if (value.type === 'replay_frames') {
    if (Object.keys(value).length !== 2 || !Array.isArray(value.frames) ||
        value.frames.length < 1 || value.frames.length > MAX_REPLAY_BATCH_FRAMES) {
      throw new ClientError('Invalid replay frame batch size.');
    }
    const frames = value.frames.map((entry: unknown) => {
      if (!isRecord(entry) || entry.type !== 'frame' ||
          !['type', 'tick', 'p1', 'p2'].every((key) => Object.hasOwn(entry, key))) {
        throw new ClientError('The replay batch contains an invalid frame.');
      }
      return readFrame(entry);
    });
    for (let index = 1; index < frames.length; index++) {
      if (frames[index].tick !== frames[index - 1].tick + 1) {
        throw new ClientError('The replay batch frames are out of order.');
      }
    }
    return { type: 'replay_frames', frames };
  }
  if (value.type === 'caught_up') {
    if (!integer(value.tick, 0, 0x7fffffff) || Object.keys(value).length !== 2) {
      throw new ClientError('Invalid guest synchronization confirmation.');
    }
    return { type: 'caught_up', tick: value.tick };
  }
  if (value.type === 'network_status') {
    if (!integer(value.tick, 0, 0x7fffffff)) throw new ClientError('Invalid network recovery tick.');
    if (value.state === 'resumed' && Object.keys(value).length === 3) {
      return { type: 'network_status', state: 'resumed', tick: value.tick };
    }
    if (value.state === 'waiting' && Object.keys(value).length === 5 &&
        integer(value.timeoutMs, 1, 60_000) && Array.isArray(value.slots) &&
        value.slots.length >= 1 && value.slots.length <= 2 &&
        value.slots.every(slot => slot === 1 || slot === 2) && new Set(value.slots).size === value.slots.length) {
      return { type: 'network_status', state: 'waiting', tick: value.tick,
        timeoutMs: value.timeoutMs, slots: value.slots as Slot[] };
    }
    throw new ClientError('Invalid network recovery notification.');
  }
  if (value.type === 'join_sync') {
    if (!integer(value.tick, 0, 0x7fffffff)) {
      throw new ClientError('Invalid second-player join point.');
    }
    if (value.state === 'resumed' && Object.keys(value).length === 4 && typeof value.joined === 'boolean') {
      return { type: 'join_sync', state: 'resumed', tick: value.tick, joined: value.joined };
    }
    if (!integer(value.verified, 0, value.tick)) {
      throw new ClientError('Invalid second-player join progress.');
    }
    if (value.state === 'paused' && Object.keys(value).length === 5 && integer(value.timeoutMs, 1, 180_000)) {
      return { type: 'join_sync', state: 'paused', tick: value.tick, verified: value.verified, timeoutMs: value.timeoutMs };
    }
    if (value.state === 'progress' && Object.keys(value).length === 4) {
      return { type: 'join_sync', state: 'progress', tick: value.tick, verified: value.verified };
    }
    throw new ClientError('Invalid second-player join notification.');
  }
  if (value.type === 'completed') {
    if (!integer(value.tick, 1, 0x7fffffff) || !boundedText(value.complete, 128)) {
      throw new ClientError('Invalid game completion.');
    }
    return { type: 'completed', tick: value.tick, complete: value.complete };
  }
  if (value.type === 'error' || value.type === 'paused') {
    for (const key of ['message', 'reason', 'code']) {
      if (value[key] !== undefined && !boundedText(value[key], 512)) {
        throw new ClientError('Invalid server stop message.');
      }
    }
    // Do not display arbitrary server text: it might contain credentials.
    return { type: value.type };
  }
  throw new ClientError('The server message type does not match the original-ws contract.');
}

export function parseInvitation(text: string, base: string): Invitation {
  if (text.length > 2048) throw new ClientError('The room link is too long.');
  let url: URL;
  let origin: URL;
  try { origin = new URL(base); url = new URL(text.trim(), origin); } catch {
    throw new ClientError('Invalid room link.');
  }
  if (url.origin !== origin.origin || url.pathname !== origin.pathname || url.search ||
      url.username || url.password || url.hash.length > 1024) {
    throw new ClientError('Use a link to this page with room and token only after #.');
  }
  const params = new URLSearchParams(url.hash.slice(1));
  const entries = [...params.entries()];
  const room = params.get('room');
  const token = params.get('token');
  if (entries.length !== 2 || params.getAll('room').length !== 1 || params.getAll('token').length !== 1 ||
      !roomId(room) || !roomToken(token)) {
    throw new ClientError('The link must contain room and token in a valid format.');
  }
  return { room, token };
}

export function makeInvitation(base: string, invitation: Invitation): string {
  if (!roomId(invitation.room) || !roomToken(invitation.token)) {
    throw new ClientError('Invalid invitation data.');
  }
  const url = new URL(base);
  url.search = '';
  url.hash = new URLSearchParams({ room: invitation.room, token: invitation.token }).toString();
  return url.href;
}

export function publicError(error: unknown): string {
  return error instanceof ClientError ? error.message : 'Could not start the original SWF or establish a connection.';
}

