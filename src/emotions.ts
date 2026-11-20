import { AnimationAction, AnimationClip, AnimationMixer, MathUtils, Mesh, Object3D } from 'three';
import { addMorphNormals } from './morph-normals';

/**
 * The emotions an avatar can show. This list is the game's whole knowledge of
 * them: a model gives an emotion a face by carrying a morph target of that
 * name, and a body by carrying a clip of that name. To add an emotion, add it
 * here and to the generators that build the models (docs/asset-contract.md).
 */
export const EMOTIONS = ['anger', 'disgust', 'fear', 'happiness', 'sadness', 'surprise'] as const;

export type Emotion = (typeof EMOTIONS)[number];

/** How much of the avatar shows an emotion: its face alone, or its face and its body. */
export type EmotionExtent = 'face' | 'body';

export interface EmotionOptions {
  /**
   * `face` changes the face and leaves the body in its idle, for a close-up of
   * the head. `body`, the default, also plays the emotion's clip.
   */
  readonly extent?: EmotionExtent;
  /** Seconds the emotion is held before the avatar returns to idle. `Infinity` holds it until it is cleared. */
  readonly seconds?: number;
  /**
   * For a still picture: holds the body's clip at this share, 0 to 1, of its
   * loop instead of playing it.
   */
  readonly still?: number;
}

/** An emotion an avatar is showing. */
export interface ShownEmotion {
  readonly emotion: Emotion;
  readonly extent: EmotionExtent;
}

/** An avatar that can show emotions: the player's, or a friend's. */
export interface Emotive {
  readonly emotions: EmotionPlayer;
}

/**
 * Shows an emotion on any avatar, then returns it to its idle. This is the one
 * way in: whatever the avatar's style, its face changes, and with the `body`
 * extent its body takes the emotion's posture too. Returns false if the
 * avatar's model cannot show the emotion: a stand-in, or a character without
 * emotions, such as Camo.
 */
export function playEmotion(avatar: Emotive, emotion: Emotion, options: EmotionOptions = {}): boolean {
  return avatar.emotions.play(emotion, options);
}

/** Returns an avatar to its idle now, rather than when its emotion's time is up. */
export function clearEmotion(avatar: Emotive): void {
  avatar.emotions.clear();
}

// How long an emotion is held unless its caller says, in seconds.
const DEFAULT_SECONDS = 3;
// How quickly an emotion comes and goes, as an exponential rate per second:
// quick enough that surprise is a start, slow enough that nothing pops.
const BLEND_RATE = 11;
// Close enough to its goal that a weight is set to it.
const SETTLED = 0.002;

interface FaceTarget {
  readonly mesh: Mesh;
  readonly index: number;
}

function ease(current: number, goal: number, delta: number): number {
  const next = MathUtils.damp(current, goal, BLEND_RATE, delta);
  return Math.abs(next - goal) < SETTLED ? goal : next;
}

/**
 * Plays emotions on one loaded model. An emotion has two layers, found on the
 * model by the emotion's name:
 *
 * - the face: a morph target on each mesh of the face;
 * - the body: a clip that holds the emotion's posture, looping in place.
 *
 * The face is set here. The body's clip is played on the mixer that plays the
 * avatar's idle, and takes the body over from it by weight: the avatar scales
 * its own clips by `1 - bodyShare`.
 */
export class EmotionPlayer {
  private readonly faces = new Map<Emotion, FaceTarget[]>();
  private readonly bodies = new Map<Emotion, AnimationAction>();
  private readonly faceWeight = new Map<Emotion, number>();
  private readonly bodyWeight = new Map<Emotion, number>();
  private shown?: ShownEmotion;
  private remaining = 0;

  /** Finds the model's faces and clips, and plays the clips on the avatar's mixer. */
  bind(model: Object3D, mixer: AnimationMixer): void {
    this.faces.clear();
    this.bodies.clear();
    this.shown = undefined;
    for (const emotion of EMOTIONS) {
      const targets: FaceTarget[] = [];
      model.traverse((child) => {
        const index = child instanceof Mesh ? child.morphTargetDictionary?.[emotion] : undefined;
        if (index === undefined) return;
        const mesh = child as Mesh;
        // The files carry each face's shape; the light on it is worked out here, once.
        addMorphNormals(mesh.geometry);
        targets.push({ mesh, index });
      });
      if (targets.length > 0) this.faces.set(emotion, targets);

      const clip = AnimationClip.findByName(model.animations, emotion);
      if (clip) {
        const action = mixer.clipAction(clip).play();
        action.setEffectiveWeight(0);
        this.bodies.set(emotion, action);
      }
      this.faceWeight.set(emotion, 0);
      this.bodyWeight.set(emotion, 0);
    }
  }

  /** The emotions this model can show at an extent. */
  available(extent: EmotionExtent = 'face'): Emotion[] {
    return EMOTIONS.filter((emotion) => this.faces.has(emotion) && (extent === 'face' || this.bodies.has(emotion)));
  }

  /** The emotion being shown, or undefined in idle. */
  get current(): ShownEmotion | undefined {
    return this.shown;
  }

  /** The share of the body, 0 to 1, that emotion clips hold. The avatar's own clips get the rest. */
  get bodyShare(): number {
    let share = 0;
    for (const weight of this.bodyWeight.values()) share += weight;
    return Math.min(share, 1);
  }

  /** Shows an emotion; see playEmotion(). */
  play(emotion: Emotion, options: EmotionOptions = {}): boolean {
    const extent = options.extent ?? 'body';
    if (!this.available(extent).includes(emotion)) return false;
    const body = this.bodies.get(emotion);
    if (extent === 'body' && body) {
      body.paused = options.still !== undefined;
      if (options.still !== undefined) {
        body.time = options.still * body.getClip().duration;
      } else if ((this.bodyWeight.get(emotion) ?? 0) === 0) {
        // A clip that is not already showing starts from its beginning.
        body.time = 0;
      }
    }
    this.shown = { emotion, extent };
    this.remaining = options.seconds ?? DEFAULT_SECONDS;
    return true;
  }

  /** Returns to idle; see clearEmotion(). */
  clear(): void {
    this.shown = undefined;
    this.remaining = 0;
  }

  /** Advances by delta seconds. The avatar calls this before it updates its mixer. */
  update(delta: number): void {
    if (this.shown) {
      this.remaining -= delta;
      if (this.remaining <= 0) this.clear();
    }
    for (const emotion of EMOTIONS) {
      const showing = this.shown?.emotion === emotion;
      const face = ease(this.faceWeight.get(emotion) ?? 0, showing ? 1 : 0, delta);
      this.faceWeight.set(emotion, face);
      for (const { mesh, index } of this.faces.get(emotion) ?? []) {
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = face;
      }

      const posed = showing && this.shown?.extent === 'body';
      const body = ease(this.bodyWeight.get(emotion) ?? 0, posed ? 1 : 0, delta);
      this.bodyWeight.set(emotion, body);
      this.bodies.get(emotion)?.setEffectiveWeight(body);
    }
  }
}
