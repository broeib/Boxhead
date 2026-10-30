import { ClientError, integer, isRecord, readRoomName, readSetup, type OpenRoom, type Setup, type Slot } from './protocol';

export type NativeMenuEvent = { version: 1; seq: number } & (
  | { event: 'create'; payload: Setup & { name: string; character?: number; dropIn?: true } }
  | { event: 'join'; payload: { room: string; character?: number } }
  | { event: 'list' | 'start' | 'leave' | 'reset' | 'nickname'; payload: Record<string, never> }
);
export type NativeMenuUpdate =
  | { state: 'rooms'; payload: { rooms: OpenRoom[]; message?: string } }
  | { state: 'lobby'; payload: { slot: Slot; peerConnected: boolean; name?: string; mode?: string; map?: string } }
  | { state: 'loading' | 'error' | 'completed'; payload: { message: string } }
  | { state: 'closed' | 'playing'; payload: Record<string, never> };
export interface OnlineProfile { bindings: number[]; character: number }
export interface NativeControls { p1: number[]; p2: number[]; online?: OnlineProfile }

// Same physical key range offered by the original key picker, with number-row
// digits reserved for their independent weapon-selection bits.
export function isOnlineBindingKey(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && (
    (value >= 65 && value <= 90 && value !== 80) ||
    (value >= 96 && value <= 107) || (value >= 109 && value <= 111) ||
    [32, 33, 34, 35, 36, 37, 38, 39, 40, 45, 46, 187, 188, 189, 190, 191, 220].includes(value)
  );
}
export function readOnlineProfile(value: unknown): OnlineProfile {
  if (!isRecord(value) || !integer(value.character, 0, 3) || !Array.isArray(value.bindings) ||
      value.bindings.length !== 7 || !value.bindings.every(isOnlineBindingKey) || new Set(value.bindings).size !== 7) {
    throw new ClientError('Invalid personal online player settings.');
  }
  return { character: value.character, bindings: [...value.bindings] as number[] };
}
export interface NativeRenderCheck { supported: boolean; pixel: number; expected: number }

export function readMenuEvent(value: unknown): NativeMenuEvent | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || value.version !== 1 || !integer(value.seq, 1, 0x7fffffff) || !isRecord(value.payload)) {
    throw new ClientError('The original menu returned an invalid action.');
  }
  const common = { version: 1 as const, seq: value.seq };
  if (value.event === 'create') {
    const setup = readSetup(value.payload);
    const character = value.payload.character;
    if (value.payload.dropIn !== undefined && value.payload.dropIn !== true) throw new ClientError('Invalid room join mode.');
    if (character !== undefined && (!integer(character, 0, 3) || character !== setup.characters[0])) {
      throw new ClientError('The host character differs from their personal selection.');
    }
    return { ...common, event: 'create', payload: { ...setup, name: readRoomName(value.payload.name),
      ...(character !== undefined ? { character } : {}),
      ...(value.payload.dropIn === true ? { dropIn: true as const } : {}) } };
  }
  if (value.event === 'join') {
    if (typeof value.payload.room !== 'string' || !/^[A-Za-z0-9_-]{12}$/.test(value.payload.room)) {
      throw new ClientError('The original menu selected an invalid room.');
    }
    const character = value.payload.character;
    if (character !== undefined && !integer(character, 0, 3)) throw new ClientError('Invalid guest character.');
    return { ...common, event: 'join', payload: { room: value.payload.room,
      ...(character !== undefined ? { character } : {}) } };
  }
  if (value.event === 'list' || value.event === 'start' || value.event === 'leave' || value.event === 'reset' || value.event === 'nickname') {
    return { ...common, event: value.event, payload: {} };
  }
  throw new ClientError('The original menu returned an unknown action.');
}

export function readControls(value: unknown): NativeControls {
  if (!isRecord(value) || !Array.isArray(value.p1) || !Array.isArray(value.p2) ||
      value.p1.length !== 7 || value.p2.length !== 7 ||
      !value.p1.every((key) => integer(key, 0, 255)) || !value.p2.every((key) => integer(key, 0, 255))) {
    throw new ClientError('Could not read the selected original game controls.');
  }
  return { p1: [...value.p1] as number[], p2: [...value.p2] as number[],
    ...(value.online !== undefined ? { online: readOnlineProfile(value.online) } : {}) };
}

export function readRenderCheck(value: unknown): NativeRenderCheck {
  if (!isRecord(value) || typeof value.supported !== 'boolean' || !integer(value.pixel, -1, 0xffffff) ||
      value.expected !== 0x24ba6c || value.supported !== (value.pixel === value.expected)) {
    throw new ClientError('Could not verify original game rendering.');
  }
  return { supported: value.supported, pixel: value.pixel, expected: value.expected };
}
