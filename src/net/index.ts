/**
 * System F — co-op networking (PLAN §9): host-authoritative over a WebSocket relay.
 * See INTEGRATION.md for wiring into main.ts.
 */
export { createNetSession, defaultRelayUrl, describeNetError, NET_NAME_KEY, LEGACY_NET_NAME_KEY } from './session';
export type { NetSession, NetSessionOptions, NetRole, NetStatus, SocketFactory, SocketLike } from './session';
export { mountLobby } from './ui';
export type { Lobby, LobbyOptions } from './ui';
export { HostRuntime } from './host';
export { ClientRuntime } from './client';
export { RemotePlayer } from './remotePlayer';
export { Avatar } from './avatar';
export { MirrorEnemy, MirrorEnemyRegistry } from './enemyMirror';
export { LootMirror } from './lootMirror';
export * as netProtocol from './protocol';
