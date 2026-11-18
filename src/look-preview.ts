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
import { OptionalAssetLoader, createVisualTarget, disposeObject } from './assets';
import { PlayerLook, applyPlayerLook } from './player-look';
import { createPlayerFallback } from './procedural';
import { createPlayroomLights, createRenderer } from './render';

// The character idles facing the child with a gentle sway; dragging spins it.
const SWAY_ANGLE = 0.45; // radians either side of the dragged-to yaw
const SWAY_SPEED = 0.8; // radians of sway phase per second
const DRAG_TURN = 0.012; // radians per dragged pixel
const LOOK_AT = new Vector3(0, 0.6, 0);
// Meters around the character and platform that must stay in frame.
const FRAME_HEIGHT = 2.3;
const FRAME_WIDTH = 2;

/**
 * A turntable view of the player, built exactly as the game builds it: the
 * procedural stand-in, swapped for player.glb by the shared asset loader, with
 * the chosen look applied to both.
 */
export class LookPreview {
  private readonly canvas = document.createElement('canvas');
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(30, 1, 0.1, 40);
  private readonly turntable = new Group();
  private readonly visual = createVisualTarget(createPlayerFallback(), 'player');
  private readonly clock = new Clock();
  private readonly resizeObserver = new ResizeObserver(() => this.resize());
  private readonly sways = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private look: PlayerLook;
  private yaw = 0;
  private swayPhase = 0;
  private drag?: { pointerId: number; x: number };
  private frame = 0;
  private disposed = false;

  constructor(container: HTMLElement, look: PlayerLook) {
    this.look = look;
    this.canvas.className = 'look-preview';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Your character. Drag to turn them around.');
    container.append(this.canvas);
    this.renderer = createRenderer(this.canvas, { alpha: true });

    this.scene.add(...createPlayroomLights(1.4, 1.4));
    const platform = new Mesh(
      new CylinderGeometry(0.74, 0.78, 0.06, 56),
      new MeshStandardMaterial({ color: 0x8fcfae, roughness: 0.92, metalness: 0.02 }),
    );
    platform.position.y = -0.03;
    platform.receiveShadow = true;
    this.scene.add(platform, this.turntable);
    this.turntable.add(this.visual);
    applyPlayerLook(this.visual, look);

    void new OptionalAssetLoader()
      .load({ player: this.visual }, () => undefined, {
        player: (model) => applyPlayerLook(model, this.look),
      })
      .then(() => {
        if (this.disposed) {
          disposeObject(this.visual);
          return;
        }
        this.canvas.dataset.assetMode = String(this.visual.userData.assetMode);
        this.canvas.dataset.ready = 'true';
      });

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.resizeObserver.observe(this.canvas);
    this.resize();
    this.clock.start();
    this.frame = requestAnimationFrame(this.render);
  }

  setLook(look: PlayerLook): void {
    this.look = look;
    applyPlayerLook(this.visual, look);
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    disposeObject(this.scene);
    this.renderer.dispose();
    // Free the GPU context now rather than at garbage collection: the playroom
    // creates its own right after the menu closes.
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }

  private resize(): void {
    const width = Math.max(this.canvas.clientWidth, 1);
    const height = Math.max(this.canvas.clientHeight, 1);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;

    const tanHalfFov = Math.tan(MathUtils.degToRad(this.camera.fov / 2));
    const distance = Math.max(
      FRAME_HEIGHT / 2 / tanHalfFov,
      FRAME_WIDTH / 2 / (tanHalfFov * this.camera.aspect),
    );
    this.camera.position.set(0, LOOK_AT.y + distance * 0.12, distance);
    this.camera.lookAt(LOOK_AT);
    this.camera.updateProjectionMatrix();
  }

  private readonly render = (): void => {
    const delta = Math.min(this.clock.getDelta(), 0.1);
    if (this.sways && !this.drag) this.swayPhase += delta * SWAY_SPEED;
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
