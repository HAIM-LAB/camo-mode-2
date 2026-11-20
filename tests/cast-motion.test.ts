import { describe, expect, it } from 'vitest';
import { AnimationClip, Object3D, PropertyBinding, SkinnedMesh } from 'three';
import { IdleMotion } from '../src/cast-motion';
import { CastAssetId } from '../src/config';
import { EMOTIONS } from '../src/emotions';
import { PLAYER_STYLES, PlayerStyleId } from '../src/player-look';
import { loadCastModel } from './helpers/player-model';

type PerStyle<T> = Readonly<Record<PlayerStyleId, T>>;

interface Member {
  /** The node names of the character's model start with this. */
  readonly prefix: string;
  /** A joint the idle turns, and one that holds the feet still, after the prefix. */
  readonly head: PerStyle<string>;
  readonly planted: PerStyle<string>;
  /** How tall the model stands in meters, hair and all. */
  readonly height: PerStyle<readonly [number, number]>;
}

// The cartoon models name pivots; the realistic ones, bones under a rig.
const CHILD = {
  head: { cartoon: '_pivot_head', realistic: '_rig/head' },
  planted: { cartoon: '_pivot_leg_L', realistic: '_rig/thigh_l' },
  // About the player's height.
  height: { cartoon: [1.1, 1.3], realistic: [1.3, 1.43] },
} as const;

/** Everyone in the playroom but the player. */
const MEMBERS: Readonly<Record<Exclude<CastAssetId, 'player'>, Member>> = {
  friendA: { prefix: 'friend_a', ...CHILD },
  friendB: { prefix: 'friend_b', ...CHILD },
  camo: {
    prefix: 'camo',
    head: { cartoon: '_pivot_head', realistic: '_rig/head' },
    // Camo's legs hang from no joint of their own in the cartoon model, and from the rig's root in the realistic one.
    planted: { cartoon: '_leg_front_L', realistic: '_rig/root' },
    height: { cartoon: [0.59, 0.75], realistic: [0.59, 0.75] },
  },
};

const STYLES = PLAYER_STYLES.map((style) => style.id);
const NAMES = Object.keys(MEMBERS) as (keyof typeof MEMBERS)[];
const CAST = STYLES.flatMap((style) => NAMES.map((name) => [style, name] as const));
const FRAME = 1 / 60;
/** How far an idle clip may turn a leg, as for the player: the knees give a little while the feet stay planted. */
const STILL_LEG_TURN = 0.06;

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

function isSkinned(model: Object3D): boolean {
  let found = false;
  model.traverse((child) => {
    found ||= child instanceof SkinnedMesh;
  });
  return found;
}

describe('the cast in each style', () => {
  it.each(CAST)('the %s %s carries one idle clip, bound to joints it has', async (style, name) => {
    const model = await loadCastModel(name, style);
    // The friends also carry a clip for each emotion (tests/emotions.test.ts); Camo does not.
    const emotions = name === 'camo' ? [] : EMOTIONS;
    expect(model.animations.map((clip) => clip.name).sort()).toEqual([...emotions, 'idle'].sort());
    const idle = AnimationClip.findByName(model.animations, 'idle') as AnimationClip;
    expect(idle.duration).toBeGreaterThan(2);
    expect(idle.tracks.length).toBeGreaterThan(0);
    // A clip that started late would hold its first frame on every loop.
    expect(Math.min(...idle.tracks.map((track) => track.times[0]))).toBe(0);
    for (const track of idle.tracks) {
      const { nodeName } = PropertyBinding.parseTrackName(track.name);
      expect(model.getObjectByName(nodeName), track.name).toBeDefined();
    }
  });

  it.each(CAST)('the %s %s breathes and looks about on planted feet', async (style, name) => {
    const member = MEMBERS[name];
    const model = await loadCastModel(name, style);
    const motion = new IdleMotion();
    expect(motion.motion).toBe('still');
    motion.prepare(model);
    expect(motion.motion).toBe('idle');

    expect(widestTurn(motion, joint(model, member.prefix + member.head[style]), 4)).toBeGreaterThan(0.01);
    expect(widestTurn(motion, joint(model, member.prefix + member.planted[style]), 4)).toBeLessThan(STILL_LEG_TURN);
  });

  it.each(CAST)('the %s %s is the size the playroom expects and is named for who they are', async (style, name) => {
    const model = await loadCastModel(name, style);
    const motion = new IdleMotion();
    motion.prepare(model);
    const [low, high] = MEMBERS[name].height[style];
    expect(motion.height).toBeGreaterThan(low);
    expect(motion.height).toBeLessThan(high);

    // No part is mistaken for the player's, which the look repaints by name.
    model.traverse((child) => {
      if (child.name) expect(child.name.startsWith('player_'), child.name).toBe(false);
    });
  });

  it.each(NAMES)('skins the realistic %s to a skeleton and moves the cartoon one by its pivots', async (name) => {
    expect(isSkinned(await loadCastModel(name, 'realistic'))).toBe(true);
    expect(isSkinned(await loadCastModel(name, 'cartoon'))).toBe(false);
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
    const head = MEMBERS.friendA.prefix + MEMBERS.friendA.head.cartoon;
    expect(joint(early, head).quaternion.angleTo(joint(late, head).quaternion)).toBeGreaterThan(0.005);
  });
});
