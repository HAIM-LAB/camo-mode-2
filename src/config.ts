import { Vector3 } from 'three';

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

export const ASSET_URLS: Readonly<Record<AssetId, string>> = Object.freeze({
  camo: '/assets/camo/camo.glb',
  room: '/assets/world/living-room.glb',
  player: '/assets/cast/player.glb',
  friendA: '/assets/cast/friend-a.glb',
  friendB: '/assets/cast/friend-b.glb',
  ball: '/assets/cast/ball.glb',
  block: '/assets/cast/block.glb',
});

export const PLAYER_RADIUS = 0.36;
export const INTERACTION_RADIUS = 1.55;
export const PROXIMITY_RADIUS = 2.65;
