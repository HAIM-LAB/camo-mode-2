import { Vector3 } from 'three';
import type { PlayerStyleId } from './player-look';

export const ROOM_BOUNDS = Object.freeze({
  minX: -6,
  maxX: 6,
  minZ: -4.5,
  maxZ: 4.5,
});

// Integrated against the authored rug, coffee table, couch, and patio opening.
export const PLAYER_SPAWN = new Vector3(-0.95, 0, 2.9);

export const SCENE_ANCHORS = Object.freeze({
  camo: new Vector3(-1.52, 0, 1.72),
  friendA: new Vector3(3.42, 0, 1.42),
  friendB: new Vector3(2.62, 0, -5.35),
  ball: new Vector3(-0.15, 0, 0.78),
  block: new Vector3(1.2, 0, 1.32),
});

export type AssetId =
  | 'room'
  | 'camo'
  | 'player'
  | 'friendA'
  | 'friendB'
  | 'ball'
  | 'block';

const SCENE_ASSET_URLS = Object.freeze({
  camo: '/assets/camo/camo.glb',
  room: '/assets/world/living-room.glb',
  friendA: '/assets/cast/friend-a.glb',
  friendB: '/assets/cast/friend-b.glb',
  ball: '/assets/cast/ball.glb',
  block: '/assets/cast/block.glb',
});

/** One player model per style the child can pick. */
export const PLAYER_ASSET_URLS: Readonly<Record<PlayerStyleId, string>> = Object.freeze({
  cartoon: '/assets/cast/player-cartoon.glb',
  realistic: '/assets/cast/player-realistic.glb',
});

/** Every optional asset's URL when the player is drawn in the given style. */
export function assetUrls(style: PlayerStyleId): Readonly<Record<AssetId, string>> {
  return { ...SCENE_ASSET_URLS, player: PLAYER_ASSET_URLS[style] };
}

export const PLAYER_RADIUS = 0.36;
export const INTERACTION_RADIUS = 1.55;
export const PROXIMITY_RADIUS = 2.65;
