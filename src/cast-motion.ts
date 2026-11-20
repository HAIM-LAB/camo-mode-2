import { AnimationAction, AnimationClip, AnimationMixer, Object3D } from 'three';
import { EmotionPlayer } from './emotions';
import { restHeight } from './player-avatar';

export type CastMotion = 'still' | 'idle';

/**
 * A character who stays where they stand: plays the model's own `idle` clip,
 * in place, once the style's GLB has loaded, and shows emotions over it. The
 * procedural stand-in and a model without the clip simply stay still.
 */
export class IdleMotion {
  /** The character's emotions; play one with playEmotion() from emotions.ts. */
  readonly emotions = new EmotionPlayer();
  private mixer?: AnimationMixer;
  private idle?: AnimationAction;
  private modelHeight?: number;

  /**
   * @param lead Seconds into the loop this character starts, so that a room
   * of characters does not breathe in unison.
   */
  constructor(private readonly lead = 0) {}

  get motion(): CastMotion {
    return this.mixer ? 'idle' : 'still';
  }

  /** How tall the loaded model stands in meters, or undefined while the stand-in shows. */
  get height(): number | undefined {
    return this.modelHeight;
  }

  /** The asset loader's preparer: measures the loaded model and binds its clips. */
  readonly prepare = (model: Object3D): void => {
    this.modelHeight = restHeight(model) || undefined;
    const idle = AnimationClip.findByName(model.animations, 'idle');
    if (!idle) return;
    this.mixer = new AnimationMixer(model);
    this.idle = this.mixer.clipAction(idle).play();
    this.emotions.bind(model, this.mixer);
    // Pose the model before its first frame, so it never flashes its bind pose.
    this.mixer.update(this.lead);
  };

  /** Advances the clips by delta seconds. */
  update(delta: number): void {
    if (!this.mixer || !this.idle) return;
    this.emotions.update(delta);
    // An emotion's body clip takes the body over from the idle.
    this.idle.setEffectiveWeight(1 - this.emotions.bodyShare);
    this.mixer.update(delta);
  }
}
