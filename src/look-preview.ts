import {
  Clock,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OptionalAssetLoader, disposeObject } from './assets';
import { assetUrls } from './config';
import { PlayerAvatar } from './player-avatar';
import { PlayerLook } from './player-look';
import { createPlayroomLights, createRenderer } from './render';

// The character idles facing the child with a gentle sway; dragging spins it.
const SWAY_ANGLE = 0.45; // radians either side of the dragged-to yaw
const SWAY_SPEED = 0.8; // radians of sway phase per second
const DRAG_TURN = 0.012; // radians per dragged pixel
// The camera aims a little below the character's middle, leaving room for the platform.
const AIM_HEIGHT = 0.46;

/** How a preview frames its character, whatever the character's height. */
interface Framing {
  /** The platform's radius in meters. */
  readonly platform: number;
  /** The share of the frame's height the character fills. */
  readonly fill: number;
  /** Meters across that must stay in frame. */
  readonly width: number;
}

// Room to turn the character on a wide platform.
const STAGE_FRAMING: Framing = { platform: 0.74, fill: 0.57, width: 2 };
// A portrait: the character fills its card, on a platform just wider than its feet.
const CARD_FRAMING: Framing = { platform: 0.5, fill: 0.7, width: 1.3 };

export interface LookPreviewOptions {
  /**
   * Whether the child can drag the character around. A preview that only
   * illustrates a button leaves pointer input to that button and frames the
   * character closer.
   */
  interactive: boolean;
}

/**
 * A turntable view of the player, built exactly as the game builds it: the
 * procedural stand-in, swapped for the style's GLB by the shared asset loader,
 * dressed in the chosen look and playing its idle clip.
 */
export class LookPreview {
  private readonly canvas = document.createElement('canvas');
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.1, 40);
  private readonly turntable = new Group();
  private readonly avatar: PlayerAvatar;
  private readonly clock = new Clock();
  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  private readonly moves = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private readonly framing: Framing;
  private yaw = 0;
  private swayPhase = 0;
  private drag?: { pointerId: number; x: number };
  private frame = 0;
  private disposed = false;

  constructor(container: HTMLElement, look: PlayerLook, options: LookPreviewOptions) {
    this.avatar = new PlayerAvatar(look);
    this.framing = options.interactive ? STAGE_FRAMING : CARD_FRAMING;
    this.canvas.className = 'look-preview';
    if (options.interactive) {
      this.canvas.setAttribute('role', 'img');
      this.canvas.setAttribute('aria-label', 'Your character. Drag to turn them around.');
    } else {
      this.canvas.classList.add('look-preview--static');
      this.canvas.setAttribute('aria-hidden', 'true');
    }
    container.append(this.canvas);
    this.renderer = createRenderer(this.canvas, { alpha: true });

    this.scene.add(...createPlayroomLights(1.4, 1.4));
    const platform = new Mesh(
      new CylinderGeometry(this.framing.platform, this.framing.platform + 0.04, 0.06, 56),
      new MeshStandardMaterial({ color: 0x8fcfae, roughness: 0.92, metalness: 0.02 }),
    );
    platform.position.y = -0.03;
    platform.receiveShadow = true;
    this.scene.add(platform, this.turntable);
    this.turntable.add(this.avatar.visual);

    void new OptionalAssetLoader(assetUrls(look.style))
      .load({ player: this.avatar.visual }, () => undefined, { player: this.avatar.prepare })
      .then(() => {
        if (this.disposed) {
          disposeObject(this.avatar.visual);
          return;
        }
        // The model knows its own height now; the canvas is still hidden, so
        // reframing to it is never seen.
        this.resize();
        this.canvas.dataset.assetMode = String(this.avatar.visual.userData.assetMode);
        this.canvas.dataset.ready = 'true';
      });

    if (options.interactive) {
      this.canvas.addEventListener('pointerdown', this.onPointerDown);
      this.canvas.addEventListener('pointermove', this.onPointerMove);
      this.canvas.addEventListener('pointerup', this.onPointerUp);
      this.canvas.addEventListener('pointercancel', this.onPointerUp);
    }
    this.resizeObserver.observe(this.canvas);
    this.resize();
    this.clock.start();
    this.frame = requestAnimationFrame(this.render);
  }

  setLook(look: PlayerLook): void {
    this.avatar.setLook(look);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    disposeObject(this.scene);
    this.renderer.dispose();
    // Free the GPU context now rather than at garbage collection: the next
    // screen creates its own right after this one closes.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private resize(): void {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;

    // Every character fills the same share of its frame, tall or short.
    const figure = this.avatar.height;
    const tanHalfFov = Math.tan(MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(
      figure / this.framing.fill / 2 / tanHalfFov,
      this.framing.width / 2 / (tanHalfFov * this.camera.aspect),
    );
    const aim = new Vector3(0, figure * AIM_HEIGHT, 0);
    this.camera.position.set(0, aim.y + distance * 0.12, distance);
    this.camera.lookAt(aim);
    this.camera.updateProjectionMatrix();
  }

  private readonly render = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    if (this.moves) {
      if (!this.drag) this.swayPhase += delta * SWAY_SPEED;
      this.avatar.update(delta, 0);
    }
    this.turntable.rotation.y = this.yaw + Math.sin(this.swayPhase) * SWAY_ANGLE;
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.render);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    this.drag = { pointerId: event.pointerId, x: event.clientX };
    this.canvas.setPointerCapture(event.pointerId);
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (event.pointerId !== this.drag?.pointerId) return;
    this.yaw += (event.clientX - this.drag.x) * DRAG_TURN;
    this.drag.x = event.clientX;
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (event.pointerId !== this.drag?.pointerId) return;
    this.drag = undefined;
  };
}
