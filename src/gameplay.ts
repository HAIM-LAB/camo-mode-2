import { Vector2, Vector3 } from 'three';
import {
  INTERACTION_RADIUS,
  PLAYER_RADIUS,
  PROXIMITY_RADIUS,
  ROOM_BOUNDS,
} from './config';

export type EntityKind = 'camo' | 'friend' | 'ball' | 'block';

export interface NearbyEntity {
  id: string;
  label: string;
  kind: EntityKind;
  position: Vector3;
  carried?: boolean;
}

export interface ProximityResult extends NearbyEntity {
  distance: number;
}

export interface PromptContent {
  entityId?: string;
  icon: string;
  kicker: string;
  text: string;
  action: boolean;
}

const MOVEMENT_KEYS = Object.freeze({
  left: ['arrowleft', 'a'],
  right: ['arrowright', 'd'],
  forward: ['arrowup', 'w'],
  back: ['arrowdown', 's'],
});

function hasAnyKey(keys: ReadonlySet<string>, candidates: readonly string[]): boolean {
  return candidates.some((key) => keys.has(key));
}

/** Maps keyboard input into the fixed follow-camera plane. */
export function readMovementIntent(keys: ReadonlySet<string>): Vector2 {
  const intent = new Vector2(
    Number(hasAnyKey(keys, MOVEMENT_KEYS.right)) - Number(hasAnyKey(keys, MOVEMENT_KEYS.left)),
    Number(hasAnyKey(keys, MOVEMENT_KEYS.back)) - Number(hasAnyKey(keys, MOVEMENT_KEYS.forward)),
  );

  return intent.lengthSq() > 1 ? intent.normalize() : intent;
}

export class PlayerController {
  readonly position: Vector3;
  readonly velocity = new Vector3();
  readonly facing = new Vector3(0, 0, -1);

  constructor(spawn: Vector3, private readonly maxSpeed = 2.75) {
    this.position = spawn.clone();
  }

  update(keys: ReadonlySet<string>, deltaSeconds: number): void {
    const delta = Math.min(Math.max(deltaSeconds, 0), 0.05);
    const intent = readMovementIntent(keys);
    const desiredVelocity = new Vector3(intent.x, 0, intent.y).multiplyScalar(this.maxSpeed);
    const smoothing = intent.lengthSq() > 0 ? 11 : 15;
    const blend = 1 - Math.exp(-smoothing * delta);

    this.velocity.lerp(desiredVelocity, blend);
    if (this.velocity.lengthSq() < 0.0001) this.velocity.set(0, 0, 0);

    this.position.addScaledVector(this.velocity, delta);
    this.constrainToRoom();

    if (this.velocity.lengthSq() > 0.02) {
      this.facing.lerp(this.velocity.clone().normalize(), 1 - Math.exp(-14 * delta)).normalize();
    }
  }

  private constrainToRoom(): void {
    const minX = ROOM_BOUNDS.minX + PLAYER_RADIUS;
    const maxX = ROOM_BOUNDS.maxX - PLAYER_RADIUS;
    const minZ = ROOM_BOUNDS.minZ + PLAYER_RADIUS;
    const maxZ = ROOM_BOUNDS.maxZ - PLAYER_RADIUS;
    const clampedX = Math.min(maxX, Math.max(minX, this.position.x));
    const clampedZ = Math.min(maxZ, Math.max(minZ, this.position.z));

    if (clampedX !== this.position.x) this.velocity.x = 0;
    if (clampedZ !== this.position.z) this.velocity.z = 0;
    this.position.set(clampedX, 0, clampedZ);
  }
}

export function entitiesByProximity(
  playerPosition: Vector3,
  entities: readonly NearbyEntity[],
  radius = PROXIMITY_RADIUS,
): ProximityResult[] {
  return entities
    .filter((entity) => !entity.carried)
    .map((entity) => ({
      ...entity,
      distance: Math.hypot(
        entity.position.x - playerPosition.x,
        entity.position.z - playerPosition.z,
      ),
    }))
    .filter((entity) => entity.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

export function nearestPickup(
  playerPosition: Vector3,
  entities: readonly NearbyEntity[],
  radius = INTERACTION_RADIUS,
): ProximityResult | undefined {
  return entitiesByProximity(playerPosition, entities, radius).find(
    (entity) => entity.kind === 'ball' || entity.kind === 'block',
  );
}

export function dropPosition(playerPosition: Vector3, facing: Vector3): Vector3 {
  const planarFacing = new Vector3(facing.x, 0, facing.z);
  if (planarFacing.lengthSq() < 0.01) planarFacing.set(0, 0, -1);
  planarFacing.normalize();

  return playerPosition
    .clone()
    .addScaledVector(planarFacing, 0.95)
    .set(
      Math.min(ROOM_BOUNDS.maxX - 0.3, Math.max(ROOM_BOUNDS.minX + 0.3, playerPosition.x + planarFacing.x * 0.95)),
      0,
      Math.min(ROOM_BOUNDS.maxZ - 0.3, Math.max(ROOM_BOUNDS.minZ + 0.3, playerPosition.z + planarFacing.z * 0.95)),
    );
}

export function promptFor(
  playerPosition: Vector3,
  entities: readonly NearbyEntity[],
  carriedEntity?: NearbyEntity,
): PromptContent {
  if (carriedEntity) {
    return {
      entityId: carriedEntity.id,
      icon: carriedEntity.kind === 'ball' ? '●' : '◆',
      kicker: `Carrying ${carriedEntity.label}`,
      text: `Press E to drop the ${carriedEntity.label.toLowerCase()}.`,
      action: true,
    };
  }

  const nearby = entitiesByProximity(playerPosition, entities)[0];
  if (!nearby) {
    return {
      icon: '✦',
      kicker: 'Explore the room',
      text: 'Use the arrow keys to meet Camo and friends.',
      action: false,
    };
  }

  if (nearby.kind === 'ball' || nearby.kind === 'block') {
    const isReachable = nearby.distance <= INTERACTION_RADIUS;
    return {
      entityId: nearby.id,
      icon: nearby.kind === 'ball' ? '●' : '◆',
      kicker: `${nearby.label} nearby`,
      text: isReachable
        ? `Press E to pick up the ${nearby.label.toLowerCase()}.`
        : `Move a little closer to the ${nearby.label.toLowerCase()}.`,
      action: isReachable,
    };
  }

  if (nearby.kind === 'camo') {
    return {
      entityId: nearby.id,
      icon: '♥',
      kicker: 'Camo is nearby',
      text: 'Your guide is ready for the next adventure.',
      action: false,
    };
  }

  return {
    entityId: nearby.id,
    icon: '☺',
    kicker: `${nearby.label} is nearby`,
    text: 'A friend to explore and play with!',
    action: false,
  };
}
