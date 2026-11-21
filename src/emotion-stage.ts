import {
  Clock,
  Group,
  MathUtils,
  Object3D,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OptionalAssetLoader, disposeObject } from './assets';
import { IdleMotion } from './cast-motion';
import { CastAssetId, assetUrls } from './config';
import { Emotion, EmotionExtent, Emotive, ShownEmotion, clearEmotion, playEmotion } from './emotions';
import type { RoundAvatar } from './emotion-rounds';
import { PlayerAvatar } from './player-avatar';
import { PlayerLook, PlayerStyleId } from './player-look';
import { createFaceLight, createPlatform, createPlayroomLights, createRenderer } from './render';

/**
 * Who the guessing game asks about: the child's own character and both
 * friends, in the style the child picked. Camo is not among them: a chameleon
 * has no emotions to show.
 */
export const STAGE_CAST = [
  { id: 'player', asset: 'player', name: 'your explorer' },
  { id: 'friend-a', asset: 'friendA', name: 'Friend A' },
  { id: 'friend-b', asset: 'friendB', name: 'Friend B' },
] as const satisfies readonly { id: string; asset: CastAssetId; name: string }[];

export type StageAvatarId = (typeof STAGE_CAST)[number]['id'];

/**
 * What a shot keeps in view, as shares of the avatar's height: the height the
 * camera aims at, and how tall and how wide the view is there.
 */
interface Shot {
  readonly aim: number;
  readonly tall: number;
  readonly wide: number;
}

/**
 * Each style's shots: a cartoon head is most of the character, a realistic one
 * a seventh of it. The body's shot leaves room for a jump and for arms flung out.
 */
const SHOTS: Readonly<Record<PlayerStyleId, Readonly<Record<EmotionExtent, Shot>>>> = Object.freeze({
  cartoon: { face: { aim: 0.66, tall: 0.86, wide: 0.8 }, body: { aim: 0.54, tall: 1.38, wide: 1.02 } },
  realistic: { face: { aim: 0.9, tall: 0.3, wide: 0.3 }, body: { aim: 0.6, tall: 1.52, wide: 1.1 } },
});

// A round opens this much further back than the body's shot, and zooms in from there.
const OPENING_PULLBACK = 1.3;
// How long the zoom takes, and how far through it the avatar starts to show its emotion.
const ZOOM_SECONDS = 1.5;
const EXPRESS_AT = 0.72;
// How long an avatar rests in its idle before it shows its emotion again: long
// enough for its face and body to have come all the way back.
const REPLAY_REST_SECONDS = 0.8;
// The camera stands a little above where it aims, as shares of its distance.
const CAMERA_LIFT = 0.07;
// More than enough time for an avatar that leaves the stage to return to its idle.
const SETTLE_SECONDS = 10;
const PLATFORM_RADIUS = 0.74;

/** An avatar on the stage. */
interface Performer extends Emotive {
  readonly id: StageAvatarId;
  readonly asset: CastAssetId;
  /** Its place on the stage: its origin on the floor, facing the camera. */
  readonly root: Group;
  /** The group its model loads into. */
  readonly visual: Group;
  readonly prepare: (model: Object3D) => void;
  /** How tall its model stands in meters; 0 until it has loaded. */
  height(): number;
  update(delta: number): void;
}

function createPerformers(look: PlayerLook): Performer[] {
  return STAGE_CAST.map(({ id, asset }) => {
    const root = new Group();
    root.name = id;
    root.visible = false;
    if (asset === 'player') {
      const avatar = new PlayerAvatar(look);
      root.add(avatar.visual);
      return {
        id,
        asset,
        root,
        visual: avatar.visual,
        emotions: avatar.emotions,
        prepare: avatar.prepare,
        height: () => avatar.height,
        update: (delta) => avatar.update(delta, 0),
      };
    }
    // A friend is only ever seen as its model, so it has no stand-in to load over.
    const visual = new Group();
    const motion = new IdleMotion();
    root.add(visual);
    return {
      id,
      asset,
      root,
      visual,
      emotions: motion.emotions,
      prepare: motion.prepare,
      height: () => motion.height ?? 0,
      update: (delta) => motion.update(delta),
    };
  });
}

function easeInOut(share: number): number {
  return share < 0.5 ? 4 * share ** 3 : 1 - (-2 * share + 2) ** 3 / 2;
}

/**
 * The guessing game's stage: one avatar at a time on a platform, the camera
 * zooming in on it, and the avatar then showing an emotion until it is told
 * otherwise. The avatars are built as the playroom builds them, from the same
 * models, and show their emotions through playEmotion().
 */
export class EmotionStage {
  private readonly canvas = document.createElement('canvas');
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.05, 40);
  private readonly clock = new Clock();
  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  private readonly moves = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly performers: Performer[];
  /** The performers whose models have loaded and can show emotions, by id. */
  private readonly ready = new Map<StageAvatarId, Performer>();
  private readonly shots: Readonly<Record<EmotionExtent, Shot>>;
  private current?: Performer;
  private act?: ShownEmotion;
  /** How far the camera is through its zoom, from 0 to 1. */
  private zoom = 1;
  /** Seconds until the avatar shows its emotion, while that is still to come. */
  private cue?: number;
  private frame = 0;
  private disposed = false;

  /**
   * @param onExpress Called each time the avatar starts to show its emotion:
   * that is when there is something to guess.
   */
  constructor(
    container: HTMLElement,
    private readonly look: PlayerLook,
    private readonly onExpress: () => void,
  ) {
    this.shots = SHOTS[look.style];
    this.performers = createPerformers(look);
    this.canvas.className = 'emotion-game__canvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    container.append(this.canvas);
    this.renderer = createRenderer(this.canvas, { alpha: true });

    this.scene.add(...createPlayroomLights(1.4, 1.4), createPlatform(PLATFORM_RADIUS));
    for (const performer of this.performers) this.scene.add(performer.root);

    this.resizeObserver.observe(this.canvas);
    this.resize();
    this.clock.start();
    this.frame = requestAnimationFrame(this.render);
  }

  /**
   * Loads the cast's models in the child's style. Afterwards `cast()` lists
   * the avatars that can play, which is none if no model arrived.
   */
  async load(): Promise<void> {
    const targets = Object.fromEntries(this.performers.map((performer) => [performer.asset, performer.visual]));
    const preparers = Object.fromEntries(this.performers.map((performer) => [performer.asset, performer.prepare]));
    await new OptionalAssetLoader(assetUrls(this.look.style)).load(targets, () => undefined, preparers);
    if (this.disposed) {
      for (const performer of this.performers) disposeObject(performer.visual);
      return;
    }
    for (const performer of this.performers) {
      const height = performer.height();
      if (height <= 0 || performer.emotions.available().length === 0) continue;
      // The camera is always close here, so each avatar keeps its face light.
      const light = createFaceLight(new Vector3(0, height * this.shots.face.aim, 0));
      performer.root.add(light, light.target);
      this.ready.set(performer.id, performer);
    }
    this.canvas.dataset.ready = 'true';
  }

  /** The avatars that can take a round, for planRounds(). */
  cast(): RoundAvatar<StageAvatarId>[] {
    return [...this.ready.values()].map((performer) => ({
      id: performer.id,
      available: (extent) => performer.emotions.available(extent),
    }));
  }

  /** What the avatar on the stage is showing now, or undefined while it is in its idle. */
  get showing(): (ShownEmotion & { avatar: StageAvatarId }) | undefined {
    const shown = this.current?.emotions.current;
    return this.current && shown ? { avatar: this.current.id, ...shown } : undefined;
  }

  /**
   * Starts a round: brings one avatar on in its idle, zooms in on its face or
   * its whole body, and has it show the emotion from then on.
   */
  present(avatar: StageAvatarId, emotion: Emotion, extent: EmotionExtent): void {
    const performer = this.ready.get(avatar);
    if (!performer) throw new Error(`No avatar on the stage can play ${avatar}`);
    if (this.current && this.current !== performer) this.retire(this.current);
    clearEmotion(performer);
    performer.root.visible = true;
    this.current = performer;
    this.act = { emotion, extent };
    if (this.moves) {
      this.zoom = 0;
      this.cue = ZOOM_SECONDS * EXPRESS_AT;
      // A soft cut: the new avatar and the pulled-back camera arrive together.
      this.canvas.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: 'ease-out' });
    } else {
      this.zoom = 1;
      this.cue = 0;
    }
  }

  /** Has the avatar return to its idle and then show its emotion again. */
  replay(): void {
    if (!this.current || !this.act) return;
    clearEmotion(this.current);
    this.cue = REPLAY_REST_SECONDS;
  }

  /** Returns the avatar to its idle, with nothing more to show. */
  rest(): void {
    this.act = undefined;
    this.cue = undefined;
    if (this.current) clearEmotion(this.current);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    disposeObject(this.scene);
    this.renderer.dispose();
    // Free the GPU context now rather than at garbage collection: the menus
    // create their own right after the game closes.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  /** Takes an avatar off the stage, back in its idle for the next time it comes on. */
  private retire(performer: Performer): void {
    clearEmotion(performer);
    performer.update(SETTLE_SECONDS);
    performer.root.visible = false;
  }

  private express(): void {
    if (!this.current || !this.act) return;
    playEmotion(this.current, this.act.emotion, { extent: this.act.extent, seconds: Infinity });
    this.onExpress();
  }

  private resize(): void {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  /** Where the camera aims and how far back it stands, in meters, to hold a shot of an avatar. */
  private framing(shot: Shot, height: number): { aim: number; distance: number } {
    const tanHalfFov = Math.tan(MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(shot.tall / 2 / tanHalfFov, shot.wide / 2 / (tanHalfFov * this.camera.aspect));
    return { aim: shot.aim * height, distance: distance * height };
  }

  private placeCamera(): void {
    if (!this.current) return;
    const height = this.current.height();
    const body = this.framing(this.shots.body, height);
    const to = this.framing(this.shots[this.act?.extent ?? 'body'], height);
    const share = easeInOut(this.zoom);
    const aim = MathUtils.lerp(body.aim, to.aim, share);
    // Distance changes by a steady ratio, so the zoom neither rushes nor stalls.
    const from = body.distance * OPENING_PULLBACK;
    const distance = from * (to.distance / from) ** share;
    this.camera.position.set(0, aim + distance * CAMERA_LIFT, distance);
    this.camera.lookAt(0, aim, 0);
  }

  private readonly render = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    if (this.zoom < 1) this.zoom = Math.min(this.zoom + delta / ZOOM_SECONDS, 1);
    if (this.cue !== undefined) {
      this.cue -= delta;
      if (this.cue <= 0) {
        this.cue = undefined;
        this.express();
      }
    }
    this.current?.update(delta);
    this.placeCamera();
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.render);
  };
}
