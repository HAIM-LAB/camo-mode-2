import {
  AnimationAction,
  AnimationClip,
  AnimationMixer,
  Box3,
  MathUtils,
  Mesh,
  Object3D,
  Vector3,
} from 'three';
import { createVisualTarget } from './assets';
import { PlayerLook, PlayerStyleId, applyPlayerLook } from './player-look';
import { createPlayerFallback } from './procedural';

interface StyleMotion {
  /** How fast the player crosses the room at full tilt, in m/s. */
  readonly moveSpeed: number;
  /** Movement speed (m/s) at which the walk clip's stride matches the ground. */
  readonly walkSpeed: number;
  /** Where a carried toy rides in front of the player: meters up and forward. */
  readonly carry: readonly [number, number];
}

const STYLE_MOTION: Readonly<Record<PlayerStyleId, StyleMotion>> = Object.freeze({
  // A toy-like toddle: its feet are allowed to skate a little at this pace.
  cartoon: { moveSpeed: 2.75, walkSpeed: 2.4, carry: [0.34, 0.46] },
  // A real child's easy walk. Its clip plants each foot for exactly this speed
  // (the model records it as its rig's walk_speed), so it moves at that speed
  // and the feet never slide.
  realistic: { moveSpeed: 1.81, walkSpeed: 1.81, carry: [0.75, 0.37] },
});

// Below this speed (m/s) the player counts as standing.
const MOVING_SPEED = 0.2;
// How quickly idle and walk cross-fade, as an exponential rate per second.
const BLEND_RATE = 10;
// The walk clip follows the player's speed as it starts and stops, within
// limits: never so slow that it hangs mid-step or so fast that it blurs.
const WALK_RATE_RANGE = [0.4, 1.3] as const;
// The stand-in's height in meters, until a model reports its own.
const STAND_IN_HEIGHT = 1.25;
// The stand-in has no limbs, so it hops instead: hops per second and meters high.
const STAND_IN_HOP_RATE = 9;
const STAND_IN_HOP_HEIGHT = 0.035;

export type AvatarMotion = 'stand-in' | 'idle' | 'walk';

/**
 * The player as the playroom and the menu previews both draw it: the
 * procedural stand-in until the style's GLB replaces it, dressed in the chosen
 * look, and animated by the model's own idle and walk clips.
 */
export class PlayerAvatar {
  /** Add this to the scene; the asset loader swaps the GLB into it. */
  readonly visual = createVisualTarget(createPlayerFallback(), 'player');
  private look: PlayerLook;
  private mixer?: AnimationMixer;
  private idle?: AnimationAction;
  private walk?: AnimationAction;
  private walkBlend = 0;
  private hopPhase = 0;
  private modelHeight = STAND_IN_HEIGHT;

  constructor(look: PlayerLook) {
    this.look = look;
    applyPlayerLook(this.visual, look);
  }

  /** How fast this style's player moves at full tilt, in m/s. */
  get moveSpeed(): number {
    return STYLE_MOTION[this.look.style].moveSpeed;
  }

  /** Where a carried toy rides, in the player's own space (forward is +Z). */
  get carryPosition(): Vector3 {
    const [up, forward] = STYLE_MOTION[this.look.style].carry;
    return new Vector3(0, up, forward);
  }

  /** How tall the character stands in meters, for framing it. */
  get height(): number {
    return this.modelHeight;
  }

  get motion(): AvatarMotion {
    if (!this.mixer) return 'stand-in';
    return this.walkBlend > 0.5 ? 'walk' : 'idle';
  }

  /** The asset loader's preparer: dresses the loaded model and binds its clips. */
  readonly prepare = (model: Object3D): void => {
    applyPlayerLook(model, this.look);
    this.modelHeight = restHeight(model) || STAND_IN_HEIGHT;
    const idle = AnimationClip.findByName(model.animations, 'idle');
    const walk = AnimationClip.findByName(model.animations, 'walk');
    if (!idle || !walk) return;

    this.mixer = new AnimationMixer(model);
    this.idle = this.mixer.clipAction(idle).play();
    this.walk = this.mixer.clipAction(walk).play();
    this.walk.setEffectiveWeight(0);
    this.visual.position.y = 0;
    // Pose the model before its first frame, so it never flashes its bind pose.
    this.mixer.update(0);
  };

  /** Re-dresses the avatar. The style picks the model, so it cannot change here. */
  setLook(look: PlayerLook): void {
    if (look.style !== this.look.style) {
      throw new Error('A player avatar keeps its style; build a new one to change it');
    }
    this.look = look;
    applyPlayerLook(this.visual, look);
  }

  /** Advances the animation by delta seconds for a player moving at speed m/s. */
  update(delta: number, speed: number): void {
    const moving = speed > MOVING_SPEED;
    if (!this.mixer || !this.idle || !this.walk) {
      this.hopPhase = moving ? this.hopPhase + delta * STAND_IN_HOP_RATE : 0;
      this.visual.position.y = Math.abs(Math.sin(this.hopPhase)) * STAND_IN_HOP_HEIGHT;
      return;
    }

    this.walkBlend = MathUtils.damp(this.walkBlend, moving ? 1 : 0, BLEND_RATE, delta);
    this.walk.setEffectiveWeight(this.walkBlend);
    this.idle.setEffectiveWeight(1 - this.walkBlend);
    this.walk.timeScale = MathUtils.clamp(
      speed / STYLE_MOTION[this.look.style].walkSpeed,
      ...WALK_RATE_RANGE,
    );
    this.mixer.update(delta);
  }
}

/**
 * A model's height in its rest pose, from its geometry. A skinned mesh's own
 * bounds are not usable until its skeleton has rendered once, so they are not
 * asked.
 */
export function restHeight(model: Object3D): number {
  const bounds = new Box3();
  model.updateWorldMatrix(true, true);
  model.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.computeBoundingBox();
    if (child.geometry.boundingBox) {
      bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
    }
  });
  return bounds.isEmpty() ? 0 : bounds.max.y - bounds.min.y;
}
