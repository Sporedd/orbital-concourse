/**
 * Typed event bus. Systems communicate through these events rather than calling
 * each other directly wherever the call would cross a sim/presentation boundary.
 */
import type * as THREE from 'three';
import type {
  BossKind, DamageCause, Element, Enemy, LootItemState, PlayerStats, RoundPhase, Screen, WeaponDef,
} from './types';
import type { StandingEvents } from '@/standing/types';
import type { GearStats, Loadout } from '@/gear/types';

/** standing:*, hype:*, sponsor:chosen come from StandingEvents (src/standing/types.ts). */
export interface GameEvents extends StandingEvents {
  // weapons / player
  'weapon:fired': { playerId: string; weapon: WeaponDef; origin: THREE.Vector3; direction: THREE.Vector3; hits: number };
  'weapon:equipped': { playerId: string; weapon: WeaponDef; slot: number };
  'weapon:ammo': { playerId: string; ammo: number; reserve: number; magSize: number };
  'weapon:reload': { playerId: string; weapon: WeaponDef; duration: number };
  'player:damaged': { playerId: string; amount: number; health: number; shield: number; element: Element; from?: THREE.Vector3 };
  'player:shield': { playerId: string; shield: number; maxShield: number; broken: boolean };
  'player:healed': { playerId: string; amount: number; health: number };
  'player:died': { playerId: string };
  'player:revived': { playerId: string; health: number };
  'player:grenades': { playerId: string; count: number };
  'player:melee': { playerId: string; hit: boolean };
  'player:grenade': { playerId: string; position: THREE.Vector3 };

  // damage presentation (numbers, hit markers)
  'damage:dealt': { enemyId: string; playerId?: string; amount: number; crit: boolean; element: Element; point: THREE.Vector3; killed: boolean; cause?: DamageCause };

  // enemies
  'enemy:spawned': { enemy: Enemy };
  'enemy:killed': { enemy: Enemy; position: THREE.Vector3; isBoss: boolean; tier: number; killerId?: string; cause?: DamageCause };
  'enemy:attack': { enemy: Enemy; kind: string }; // for audio/fx hooks
  'boss:spawned': { enemy: Enemy; name: string };
  'boss:health': { enemyId: string; health: number; maxHealth: number; phase: number };
  'boss:phase': { enemyId: string; phase: number };

  // loot
  'loot:dropped': { item: LootItemState };
  'loot:nearby': { playerId: string; item: LootItemState | null }; // closest pickup-able item (for the prompt)
  'loot:pickup': { playerId: string; item: LootItemState };
  'loot:expired': { itemId: string };

  // progression
  'xp:gained': { playerId: string; amount: number; xp: number; xpToNext: number; level: number };
  'level:up': { playerId: string; level: number; skillPoints: number };
  'skill:changed': { skillId: string; rank: number; stats: PlayerStats };

  // gear (bridged from the inventory by src/gear createGearSystem)
  'gear:changed': { playerId: string; stats: GearStats; loadout: Readonly<Loadout> };

  // co-op (src/net session): any change of role/status/room/peers
  'net:changed': { role: 'offline' | 'host' | 'client'; status: 'idle' | 'connecting' | 'connected' | 'closed' | 'error'; code: string | null; peers: number; error: string | null };

  // rounds
  'round:phase': { phase: RoundPhase; round: number };
  'round:intermission': { round: number; seconds: number };
  'round:started': { round: number; killsRequired: number };
  'round:subwave': { round: number; subWave: number; total: number };
  'round:progress': { kills: number; killsRequired: number };
  'round:boss': { round: number; bossKind: BossKind };
  'round:cleared': { round: number };
  'game:started': Record<string, never>;
  'game:over': { round: number; kills: number };

  // ui
  'ui:message': { text: string; duration?: number; style?: 'info' | 'warning' | 'legendary' };
  'ui:screen': { screen: Screen };
}

export type EventName = keyof GameEvents;
export type Handler<K extends EventName> = (payload: GameEvents[K]) => void;

export class EventBus {
  private handlers = new Map<EventName, Set<Handler<any>>>();

  on<K extends EventName>(name: K, handler: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(handler);
    return () => set!.delete(handler);
  }

  once<K extends EventName>(name: K, handler: Handler<K>): () => void {
    const off = this.on(name, (p) => {
      off();
      handler(p);
    });
    return off;
  }

  off<K extends EventName>(name: K, handler: Handler<K>): void {
    this.handlers.get(name)?.delete(handler);
  }

  emit<K extends EventName>(name: K, payload: GameEvents[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const h of Array.from(set)) {
      try {
        h(payload);
      } catch (err) {
        console.error(`[events] handler for ${name} threw`, err);
      }
    }
  }
}
