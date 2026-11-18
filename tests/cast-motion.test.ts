import { describe, expect, it } from 'vitest';
import { Object3D, PropertyBinding, SkinnedMesh } from 'three';
import { IdleMotion } from '../src/cast-motion';
import { CastAssetId } from '../src/config';
import { PLAYER_STYLES, PlayerStyleId } from '../src/player-look';
import { loadCastModel } from './helpers/player-model';

const STYLES = PLAYER_STYLES.map((style) => style.id);
const FRIENDS = ['friendA', 'friendB'] as const satisfies readonly CastAssetId[];
const CAST = STYLES.flatMap((style) => FRIENDS.map((friend) => [style, friend] as const));
const FRAME = 1 / 60;

/** The node names of each friend's model start with this. */
const PREFIX: Readonly<Record<(typeof FRIENDS)[number], string>> = { friendA: 'friend_a', friendB: 'friend_b' };
/** A leg joint and a head joint of each style's models, after the friend's prefix. */
const LEG: Readonly<Record<PlayerStyleId, string>> = { cartoon: '_pivot_leg_L', realistic: '_rig/thigh_l' };
const HEAD: Readonly<Record<PlayerStyleId, string>> = { cartoon: '_pivot_head', realistic: '_rig/head' };
/** How far an idle clip may turn a leg, as for the player: the knees give a little while the feet stay planted. */
const STILL_LEG_TURN = 0.06;
/** How tall each style's friends stand, in meters: about the player's height. */
const HEIGHT: Readonly<Record<PlayerStyleId, readonly [number, number]>> = { cartoon: [1.1, 1.3], realistic: [1.3, 1.43] };

/** A joint by its path: the cartoon models name pivots, the realistic ones bones under a rig. */
function joint(model: Object3D, path: string): Object3D {
  const found = path.split('/').reduce<Object3D | undefined>((node, name) => node?.getObjectByName(name), model);
  if (!found) throw new Error(`No joint at ${path}`);
  return found;
}

/** The widest angle a joint turns away from its first pose over a stretch of the idle. */
function widestTurn(motion: IdleMotion, target: Object3D, seconds: number): number {
  const start = target.quaternion.clone();
  let widest = 0;
  for (let elapsed = 0; elapsed < seconds; elapsed += FRAME) {
    motion.update(FRAME);
    widest = Math.max(widest, start.angleTo(target.quaternion));
  }
  return widest;
}

describe('the friends in each style', () => {
  it.each(CAST)('the %s %s carries one idle clip, bound to joints it has', async (style, friend) => {
    const model = await loadCastModel(friend, style);
    expect(model.animations.map((clip) => clip.name)).toEqual(['idle']);
    const [idle] = model.animations;
    expect(idle.duration).toBeGreaterThan(2);
    expect(idle.tracks.length).toBeGreaterThan(0);
    // A clip that started late would hold its first frame on every loop.
    expect(Math.min(...idle.tracks.map((track) => track.times[0]))).toBe(0);
    for (const track of idle.tracks) {
      const { nodeName } = PropertyBinding.parseTrackName(track.name);
      expect(model.getObjectByName(nodeName), track.name).toBeDefined();
    }
  });

  it.each(CAST)('the %s %s breathes and looks about on planted feet', async (style, friend) => {
    const model = await loadCastModel(friend, style);
    const motion = new IdleMotion();
    expect(motion.motion).toBe('still');
    motion.prepare(model);
    expect(motion.motion).toBe('idle');

    expect(widestTurn(motion, joint(model, PREFIX[friend] + HEAD[style]), 4)).toBeGreaterThan(0.01);
    expect(widestTurn(motion, joint(model, PREFIX[friend] + LEG[style]), 4)).toBeLessThan(STILL_LEG_TURN);
  });

  it.each(CAST)('the %s %s stands about as tall as the player and is named for who they are', async (style, friend) => {
    const model = await loadCastModel(friend, style);
    const motion = new IdleMotion();
    motion.prepare(model);
    const [low, high] = HEIGHT[style];
    expect(motion.height).toBeGreaterThan(low);
    expect(motion.height).toBeLessThan(high);

    // No part of a friend is mistaken for the player's, which the look repaints by name.
    model.traverse((child) => {
      if (child.name) expect(child.name.startsWith('player_'), child.name).toBe(false);
    });
  });

  it('skins the realistic friends to a skeleton and moves the cartoon ones by their pivots', async () => {
    for (const friend of FRIENDS) {
      const skinned = (model: Object3D): boolean => {
        let found = false;
        model.traverse((child) => {
          found ||= child instanceof SkinnedMesh;
        });
        return found;
      };
      expect(skinned(await loadCastModel(friend, 'realistic'))).toBe(true);
      expect(skinned(await loadCastModel(friend, 'cartoon'))).toBe(false);
    }
  });
});

describe('idle motion', () => {
  it('leaves a stand-in or a model without the clip still', () => {
    const motion = new IdleMotion();
    motion.prepare(new Object3D());
    motion.update(FRAME);
    expect(motion.motion).toBe('still');
    expect(motion.height).toBeUndefined();
  });

  it('starts each character at its own point in the loop', async () => {
    const early = await loadCastModel('friendA', 'cartoon');
    const late = await loadCastModel('friendA', 'cartoon');
    new IdleMotion(0).prepare(early);
    new IdleMotion(1.3).prepare(late);
    const head = PREFIX.friendA + HEAD.cartoon;
    expect(joint(early, head).quaternion.angleTo(joint(late, head).quaternion)).toBeGreaterThan(0.005);
  });
});
