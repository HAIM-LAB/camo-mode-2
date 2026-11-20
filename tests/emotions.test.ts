import { describe, expect, it } from 'vitest';
import { AnimationClip, AnimationMixer, Mesh, Object3D, PropertyBinding, Quaternion } from 'three';
import { IdleMotion } from '../src/cast-motion';
import { CastAssetId } from '../src/config';
import { EMOTIONS, Emotion, EmotionPlayer, Emotive, clearEmotion, playEmotion } from '../src/emotions';
import { PlayerAvatar } from '../src/player-avatar';
import { DEFAULT_PLAYER_LOOK, PLAYER_STYLES, PlayerStyleId } from '../src/player-look';
import { loadCastModel } from './helpers/player-model';

const STYLES = PLAYER_STYLES.map((style) => style.id);
/** Everyone who shows emotions. Camo does not. */
const AVATARS = ['player', 'friendA', 'friendB'] as const satisfies readonly CastAssetId[];
const CAST = STYLES.flatMap((style) => AVATARS.map((avatar) => [style, avatar] as const));
const PAIRS = EMOTIONS.flatMap((first, index) => EMOTIONS.slice(index + 1).map((second) => [first, second] as const));
const FRAME = 1 / 60;

interface Driven extends Emotive {
  /** Advances the avatar as the playroom does while it stands still. */
  step(): void;
}

/** A character's real model, bound the way the playroom binds it. */
async function bound(avatar: (typeof AVATARS)[number], style: PlayerStyleId): Promise<{ model: Object3D; driven: Driven }> {
  const model = await loadCastModel(avatar, style);
  if (avatar === 'player') {
    const player = new PlayerAvatar({ ...DEFAULT_PLAYER_LOOK, style });
    player.prepare(model);
    return { model, driven: { emotions: player.emotions, step: () => player.update(FRAME, 0) } };
  }
  const motion = new IdleMotion();
  motion.prepare(model);
  return { model, driven: { emotions: motion.emotions, step: () => motion.update(FRAME) } };
}

function clipOf(model: Object3D, name: string): AnimationClip {
  const clip = AnimationClip.findByName(model.animations, name);
  if (!clip) throw new Error(`The model carries no ${name} clip`);
  return clip;
}

function run(driven: Driven, seconds: number): void {
  for (let elapsed = 0; elapsed < seconds; elapsed += FRAME) driven.step();
}

/** The joints the model's clips move, by name. */
function joints(model: Object3D): Map<string, Object3D> {
  const found = new Map<string, Object3D>();
  for (const clip of model.animations) {
    for (const track of clip.tracks) {
      const { nodeName } = PropertyBinding.parseTrackName(track.name);
      const joint = model.getObjectByName(nodeName);
      if (joint) found.set(nodeName, joint);
    }
  }
  return found;
}

/**
 * How far apart two models' poses are. `turn` is the widest angle between the
 * same joint on each, in radians, and `shift` the furthest a joint has moved,
 * in meters. `drift` is the largest difference in any number of any joint's
 * turn or place: unlike an angle, it can tell two poses are the same.
 */
function poseGap(one: Object3D, other: Object3D): { turn: number; shift: number; drift: number } {
  const others = joints(other);
  let turn = 0;
  let shift = 0;
  let drift = 0;
  for (const [name, joint] of joints(one)) {
    const twin = others.get(name) as Object3D;
    turn = Math.max(turn, joint.quaternion.angleTo(twin.quaternion));
    shift = Math.max(shift, joint.position.distanceTo(twin.position));
    const numbers = [...joint.quaternion.toArray(), ...joint.position.toArray()];
    const twins = [...twin.quaternion.toArray(), ...twin.position.toArray()];
    drift = Math.max(drift, ...numbers.map((value, index) => Math.abs(value - twins[index])));
  }
  return { turn, shift, drift };
}

/** The meshes of the face: those that carry morph targets. */
function faceMeshes(model: Object3D): Mesh[] {
  const meshes: Mesh[] = [];
  model.traverse((child) => {
    if (child instanceof Mesh && child.morphTargetDictionary) meshes.push(child);
  });
  return meshes;
}

/** How far an emotion's face moves every vertex of the face from rest, as one long vector. */
function faceShape(model: Object3D, emotion: Emotion): number[] {
  return faceMeshes(model).flatMap((mesh) => {
    const index = mesh.morphTargetDictionary?.[emotion] as number;
    const targets = mesh.geometry.morphAttributes.position ?? [];
    return Array.from(targets[index].array as ArrayLike<number>);
  });
}

function length(vector: readonly number[]): number {
  return Math.hypot(...vector);
}

function shown(model: Object3D, emotion: Emotion): number[] {
  return faceMeshes(model).map((mesh) => mesh.morphTargetInfluences?.[mesh.morphTargetDictionary?.[emotion] as number] ?? -1);
}

/** The pose a clip holds at a time, as the quaternion of every joint it turns. */
function clipPose(model: Object3D, clip: AnimationClip, share: number): Map<string, Quaternion> {
  const mixer = new AnimationMixer(model);
  const action = mixer.clipAction(clip).play();
  action.time = share * clip.duration;
  mixer.update(0);
  const pose = new Map<string, Quaternion>();
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
    if (propertyName === 'quaternion') pose.set(nodeName, (model.getObjectByName(nodeName) as Object3D).quaternion.clone());
  }
  mixer.stopAllAction();
  mixer.uncacheRoot(model);
  return pose;
}

describe('the list of emotions', () => {
  it('is the six basic emotions, in one place', () => {
    expect([...EMOTIONS]).toEqual(['anger', 'disgust', 'fear', 'happiness', 'sadness', 'surprise']);
  });
});

describe('each avatar\'s emotions, in each style', () => {
  it.each(CAST)('the %s %s carries a clip for every emotion, bound to joints it has', async (style, avatar) => {
    const model = await loadCastModel(avatar, style);
    for (const emotion of EMOTIONS) {
      const clip = clipOf(model, emotion);
      // A loop long enough to hold a posture, starting on its first frame.
      expect(clip.duration, emotion).toBeGreaterThanOrEqual(1);
      expect(Math.min(...clip.tracks.map((track) => track.times[0])), emotion).toBe(0);
      for (const track of clip.tracks) {
        const { nodeName } = PropertyBinding.parseTrackName(track.name);
        expect(model.getObjectByName(nodeName), `${emotion} ${track.name}`).toBeDefined();
      }
      // The clip closes on itself: its last frame is its first.
      for (const track of clip.tracks) {
        const size = track.getValueSize();
        const first = Array.from(track.values.slice(0, size));
        const last = Array.from(track.values.slice(-size));
        first.forEach((value, index) => expect(last[index], `${emotion} ${track.name}`).toBeCloseTo(value, 3));
      }
    }
  });

  it.each(CAST)('the %s %s holds each emotion\'s posture in its clip, arms and head included', async (style, avatar) => {
    const model = await loadCastModel(avatar, style);
    const idle = clipOf(model, 'idle');
    for (const emotion of EMOTIONS) {
      const clip = clipOf(model, emotion);
      const turned = new Set(clip.tracks.map((track) => PropertyBinding.parseTrackName(track.name))
        .filter((binding) => binding.propertyName === 'quaternion')
        .map((binding) => binding.nodeName));
      // A joint the clip holds still, away from its rest, is still in the clip:
      // every joint the idle turns is turned by the emotion too.
      for (const track of idle.tracks) {
        const { nodeName, propertyName } = PropertyBinding.parseTrackName(track.name);
        if (propertyName === 'quaternion') expect(turned.has(nodeName), `${emotion} ${nodeName}`).toBe(true);
      }
    }
  });

  it.each(CAST)('the %s %s has a face for every emotion on each mesh of its face', async (style, avatar) => {
    const model = await loadCastModel(avatar, style);
    const meshes = faceMeshes(model);
    expect(meshes.length).toBeGreaterThan(0);
    for (const mesh of meshes) {
      expect(Object.keys(mesh.morphTargetDictionary ?? {}).sort(), mesh.name).toEqual([...EMOTIONS]);
    }
    // Every face moves the face a real distance: a centimeter and more, summed over it.
    for (const emotion of EMOTIONS) expect(length(faceShape(model, emotion)), emotion).toBeGreaterThan(0.01);
  });

  it.each(CAST)('the %s %s\'s six faces are six different faces', async (style, avatar) => {
    const model = await loadCastModel(avatar, style);
    for (const [first, second] of PAIRS) {
      const one = faceShape(model, first);
      const two = faceShape(model, second);
      const apart = length(one.map((value, index) => value - two[index]));
      // No face is another one a little stronger or weaker: they differ by a
      // good part of their own size. Fear and surprise are the closest pair,
      // as they are on a real face: both lift the brows and widen the eyes,
      // and differ in how the brows pinch and what the mouth does.
      expect(apart / Math.max(length(one), length(two)), `${first} and ${second}`).toBeGreaterThan(0.35);
    }
  });

  it.each(CAST)('the %s %s\'s six postures are six different postures', async (style, avatar) => {
    const model = await loadCastModel(avatar, style);
    const poses = new Map(EMOTIONS.map((emotion) => [
      emotion,
      clipPose(model, clipOf(model, emotion), 0.25),
    ]));
    for (const [first, second] of PAIRS) {
      const one = poses.get(first) as Map<string, Quaternion>;
      const two = poses.get(second) as Map<string, Quaternion>;
      const widest = Math.max(...[...one].map(([name, turn]) => turn.angleTo(two.get(name) as Quaternion)));
      // Some joint is turned a clearly different way: a quarter of a radian is 14 degrees.
      expect(widest, `${first} and ${second}`).toBeGreaterThan(0.25);
    }
  });

  it.each(CAST)('shows a face alone on the %s %s and leaves its body in the idle', async (style, avatar) => {
    const { model, driven } = await bound(avatar, style);
    const { model: twin, driven: resting } = await bound(avatar, style);
    expect(driven.emotions.available('face')).toEqual([...EMOTIONS]);

    for (const emotion of EMOTIONS) {
      expect(playEmotion(driven, emotion, { extent: 'face', seconds: Infinity }), emotion).toBe(true);
      run(driven, 1);
      run(resting, 1);
      expect(driven.emotions.current).toEqual({ emotion, extent: 'face' });
      // The face is all the way there, and no other face lingers on it.
      for (const weight of shown(model, emotion)) expect(weight, emotion).toBe(1);
      for (const other of EMOTIONS.filter((item) => item !== emotion)) {
        for (const weight of shown(model, other)) expect(weight, `${other} during ${emotion}`).toBe(0);
      }
      // The body does exactly what an avatar with no emotion does.
      expect(driven.emotions.bodyShare).toBe(0);
      expect(poseGap(model, twin).drift, emotion).toBeLessThan(1e-6);
    }
  });

  it.each(CAST)('shows a face and a body on the %s %s, then returns it to the idle', async (style, avatar) => {
    const { model, driven } = await bound(avatar, style);
    const { model: twin, driven: resting } = await bound(avatar, style);
    expect(driven.emotions.available('body')).toEqual([...EMOTIONS]);

    for (const emotion of EMOTIONS) {
      expect(playEmotion(driven, emotion, { seconds: 1.5 }), emotion).toBe(true);
      run(driven, 1);
      run(resting, 1);
      expect(driven.emotions.current).toEqual({ emotion, extent: 'body' });
      expect(driven.emotions.bodyShare).toBe(1);
      for (const weight of shown(model, emotion)) expect(weight, emotion).toBe(1);
      // The body has left the idle for the emotion's posture.
      const posed = poseGap(model, twin);
      expect(Math.max(posed.turn, posed.shift * 10), emotion).toBeGreaterThan(0.2);

      // Its time is up half a second later, and it goes back to idle by itself.
      run(driven, 1.5);
      run(resting, 1.5);
      expect(driven.emotions.current).toBeUndefined();
      expect(driven.emotions.bodyShare).toBe(0);
      for (const weight of shown(model, emotion)) expect(weight, emotion).toBe(0);
      expect(poseGap(model, twin).drift, emotion).toBeLessThan(1e-6);
    }
  });
});

describe('playing an emotion', () => {
  it('eases in and out rather than snapping', async () => {
    const { model, driven } = await bound('friendA', 'cartoon');
    playEmotion(driven, 'surprise', { seconds: Infinity });
    driven.step();
    const starting = shown(model, 'surprise')[0];
    expect(starting).toBeGreaterThan(0);
    expect(starting).toBeLessThan(0.5);
    run(driven, 1);
    expect(shown(model, 'surprise')[0]).toBe(1);

    clearEmotion(driven);
    expect(driven.emotions.current).toBeUndefined();
    driven.step();
    const leaving = shown(model, 'surprise')[0];
    expect(leaving).toBeLessThan(1);
    expect(leaving).toBeGreaterThan(0.5);
    run(driven, 1);
    expect(shown(model, 'surprise')[0]).toBe(0);
    expect(driven.emotions.bodyShare).toBe(0);
  });

  it('goes from one emotion straight to the next', async () => {
    const { model, driven } = await bound('friendB', 'realistic');
    playEmotion(driven, 'happiness', { seconds: Infinity });
    run(driven, 1);
    playEmotion(driven, 'sadness', { seconds: Infinity });
    run(driven, 1);
    expect(driven.emotions.current).toEqual({ emotion: 'sadness', extent: 'body' });
    for (const weight of shown(model, 'sadness')) expect(weight).toBe(1);
    for (const weight of shown(model, 'happiness')) expect(weight).toBe(0);
    expect(driven.emotions.bodyShare).toBe(1);
  });

  it('holds an emotion until it is cleared when asked to', async () => {
    const { driven } = await bound('friendA', 'realistic');
    playEmotion(driven, 'fear', { seconds: Infinity });
    run(driven, 20);
    expect(driven.emotions.current).toEqual({ emotion: 'fear', extent: 'body' });
  });

  it('holds a clip still at a share of its loop for a picture', async () => {
    const { model, driven } = await bound('friendA', 'realistic');
    playEmotion(driven, 'happiness', { seconds: Infinity, still: 0.52 });
    run(driven, 1);
    const pelvis = model.getObjectByName('pelvis') as Object3D;
    const height = pelvis.position.y;
    run(driven, 0.4);
    // The hop does not go on: the hips stay at the height they were caught at.
    expect(pelvis.position.y).toBeCloseTo(height, 6);
  });

  it('ends the player\'s emotion when the player walks', async () => {
    const model = await loadCastModel('player', 'cartoon');
    const player = new PlayerAvatar(DEFAULT_PLAYER_LOOK);
    player.prepare(model);
    expect(playEmotion(player, 'anger', { seconds: Infinity })).toBe(true);
    for (let frame = 0; frame < 60; frame += 1) player.update(FRAME, 0);
    expect(player.emotions.bodyShare).toBe(1);
    expect(player.motion).toBe('idle');

    for (let frame = 0; frame < 60; frame += 1) player.update(FRAME, player.moveSpeed);
    expect(player.emotions.current).toBeUndefined();
    expect(player.emotions.bodyShare).toBe(0);
    expect(player.motion).toBe('walk');
  });

  it.each(STYLES)('has no emotions for the %s Camo, which is left out of them', async (style) => {
    const motion = new IdleMotion();
    motion.prepare(await loadCastModel('camo', style));
    expect(motion.emotions.available()).toEqual([]);
    for (const emotion of EMOTIONS) expect(playEmotion(motion, emotion)).toBe(false);
    expect(motion.emotions.current).toBeUndefined();
  });

  it('has none for a stand-in, before its model has loaded', () => {
    expect(playEmotion(new IdleMotion(), 'happiness')).toBe(false);
    expect(playEmotion(new PlayerAvatar(DEFAULT_PLAYER_LOOK), 'happiness')).toBe(false);
    const player = new EmotionPlayer();
    player.update(FRAME);
    expect(player.current).toBeUndefined();
    expect(player.bodyShare).toBe(0);
  });
});
