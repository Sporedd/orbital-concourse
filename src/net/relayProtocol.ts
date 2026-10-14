/**
 * Relay envelope (transport layer). The relay (server/relay.ts) understands ONLY these
 * frames; game payloads ride inside `{ t: 'g', d }` and are opaque to it.
 * Pure TS, no DOM / three imports: shared by the browser and the Node relay.
 */

export const RELAY_DEFAULT_PORT = 8787;
/** Bump when the envelope or the game protocol changes incompatibly. */
export const PROTOCOL_VERSION = 1;
/** Join codes: 5 letters, no I/O to avoid confusion with 1/0. */
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
export const CODE_LENGTH = 5;
export const MAX_PEERS = 4;
export const MAX_NAME_LENGTH = 20;

export interface PeerInfo {
  /** Relay-assigned connection id, unique per relay process. */
  peer: string;
  name: string;
  /** The player id the peer uses locally (PlayerState.id). */
  pid: string;
  host: boolean;
}

/** Client → relay. */
export type RelayUp =
  | { t: 'host'; name: string; pid: string; v: number }
  | { t: 'join'; code: string; name: string; pid: string; v: number }
  | { t: 'leave' }
  | { t: 'ping'; c: number }
  /** Game payload. From the host: `to` = one peer, omitted = every client. From a client: always to the host. */
  | { t: 'g'; to?: string; d: unknown };

/** Relay → client. */
export type RelayDown =
  | { t: 'welcome'; code: string; peer: string; host: boolean; hostPeer: string; peers: PeerInfo[] }
  | { t: 'error'; reason: string }
  | { t: 'peer-join'; peer: PeerInfo }
  | { t: 'peer-leave'; peer: string }
  | { t: 'closed'; reason: string }
  | { t: 'pong'; c: number }
  | { t: 'g'; from: string; d: unknown };

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, CODE_LENGTH);
}

export function isValidCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

export function cleanName(name: unknown, fallback = 'Gladiator'): string {
  const s = typeof name === 'string' ? name.replace(/[\u0000-\u001f<>]/g, '').trim() : '';
  return (s || fallback).slice(0, MAX_NAME_LENGTH);
}
