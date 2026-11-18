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

/** The characters: the player and everyone the player can talk to. */
export type CastAssetId = 'player' | 'camo' | 'friendA' | 'friendB';

/** The room and the toys look the same in every style. */
const SCENE_ASSET_URLS = Object.freeze({
  room: '/assets/world/living-room.glb',
  ball: '/assets/cast/ball.glb',
  block: '/assets/cast/block.glb',
});

/**
 * One model of each character per style the child can pick. The whole cast is
 * drawn in the chosen style, and only that style's models are requested.
 */
export const CAST_ASSET_URLS: Readonly<Record<PlayerStyleId, Readonly<Record<CastAssetId, string>>>> = Object.freeze({
  cartoon: Object.freeze({
    player: '/assets/cast/player-cartoon.glb',
    camo: '/assets/camo/camo-cartoon.glb',
    friendA: '/assets/cast/friend-a-cartoon.glb',
    friendB: '/assets/cast/friend-b-cartoon.glb',
  }),
  realistic: Object.freeze({
    player: '/assets/cast/player-realistic.glb',
    camo: '/assets/camo/camo-realistic.glb',
    friendA: '/assets/cast/friend-a-realistic.glb',
    friendB: '/assets/cast/friend-b-realistic.glb',
  }),
});

/** One player model per style the child can pick. */
export const PLAYER_ASSET_URLS: Readonly<Record<PlayerStyleId, string>> = Object.freeze({
  cartoon: CAST_ASSET_URLS.cartoon.player,
  realistic: CAST_ASSET_URLS.realistic.player,
});

/** Every optional asset's URL when the cast is drawn in the given style. */
export function assetUrls(style: PlayerStyleId): Readonly<Record<AssetId, string>> {
  return { ...SCENE_ASSET_URLS, ...CAST_ASSET_URLS[style] };
}

export const PLAYER_RADIUS = 0.36;
export const INTERACTION_RADIUS = 1.55;
export const PROXIMITY_RADIUS = 2.65;
