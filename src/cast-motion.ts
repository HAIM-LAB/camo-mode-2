import { AnimationClip, AnimationMixer, Object3D } from 'three';
import { restHeight } from './player-avatar';

export type CastMotion = 'still' | 'idle';

/**
 * A character who stays where they stand: plays the model's own `idle` clip,
 * in place, once the style's GLB has loaded. The procedural stand-in and a
 * model without the clip simply stay still.
 */
export class IdleMotion {
  private mixer?: AnimationMixer;
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

  /** The asset loader's preparer: measures the loaded model and binds its clip. */
  readonly prepare = (model: Object3D): void => {
    this.modelHeight = restHeight(model) || undefined;
    const idle = AnimationClip.findByName(model.animations, 'idle');
    if (!idle) return;
    this.mixer = new AnimationMixer(model);
    this.mixer.clipAction(idle).play();
    // Pose the model before its first frame, so it never flashes its bind pose.
    this.mixer.update(this.lead);
  };

  /** Advances the clip by delta seconds. */
  update(delta: number): void {
    this.mixer?.update(delta);
  }
}
