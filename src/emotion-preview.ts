import { DirectionalLight, Object3D, PerspectiveCamera, Vector3 } from 'three';
import { EMOTIONS, Emotion, EmotionExtent, Emotive, clearEmotion, playEmotion } from './emotions';
import type { PlayerStyleId } from './player-look';
import { createFaceLight } from './render';

/**
 * A development aid for looking at the emotions in the playroom. It is loaded
 * only by the dev server (`npm run dev`) and only when the address asks for it;
 * a built game never contains it. It is not gameplay: the modes that will use
 * the emotions call playEmotion() themselves.
 *
 *   ?skipMenu=1&emotions            every avatar cycles through the six
 *   ...&emotions=sadness            every avatar holds one
 *   ...&extent=face                 the face alone, the body in its idle
 *   ...&focus=friend-a              the camera goes to one avatar: player, friend-a, or friend-b
 *   ...&shot=face                   with focus: a close-up of the head, rather than the whole body
 *   ...&still=0.5                   holds the body's clip at that share of its loop, for a picture
 *
 * While it runs: 1 to 6 hold an emotion, 0 returns to idle, F swaps face and
 * body, and C cycles again.
 */

/** An avatar the preview can drive and point the camera at. */
export interface PreviewAvatar extends Emotive {
  readonly id: string;
  /** The avatar's place in the scene: its origin on the floor, facing +Z. */
  readonly root: Object3D;
  /** How tall it stands in meters. */
  readonly height: number;
}

/** Where the camera looks on an avatar and how far back it stands, as shares of the avatar's height. */
export interface PreviewFraming {
  readonly face: readonly [target: number, distance: number];
  readonly body: readonly [target: number, distance: number];
}

/** Each style's framing: a cartoon head is most of the character, a realistic one a seventh of it. */
export const PREVIEW_FRAMING: Readonly<Record<PlayerStyleId, PreviewFraming>> = Object.freeze({
  cartoon: { face: [0.66, 1.05], body: [0.5, 2.25] },
  realistic: { face: [0.905, 0.34], body: [0.52, 2.4] },
});

// Seconds each emotion gets in the cycle, and how many of them it is held for:
// the rest shows the avatar on its way back to idle.
const CYCLE_SECONDS = 4.5;
const CYCLE_HOLD = 3.6;

export class EmotionPreview {
  private emotion: Emotion | null;
  private extent: EmotionExtent;
  private cycling: boolean;
  private clock = CYCLE_SECONDS;
  private applied = '';
  private readonly focus: string | null;
  private readonly shot: 'face' | 'body';
  private readonly still?: number;
  private faceLight?: DirectionalLight;
  private readonly label = document.createElement('div');

  /** The preview the address asks for, or undefined when it asks for none. */
  static fromSearch(
    search: string,
    avatars: () => readonly PreviewAvatar[],
    framing: PreviewFraming,
  ): EmotionPreview | undefined {
    const params = new URLSearchParams(search);
    return params.has('emotions') ? new EmotionPreview(params, avatars, framing) : undefined;
  }

  private constructor(
    params: URLSearchParams,
    private readonly avatars: () => readonly PreviewAvatar[],
    private readonly framing: PreviewFraming,
  ) {
    const asked = params.get('emotions');
    this.emotion = EMOTIONS.find((emotion) => emotion === asked) ?? null;
    this.cycling = this.emotion === null && asked !== 'none';
    this.extent = params.get('extent') === 'face' ? 'face' : 'body';
    this.focus = params.get('focus');
    this.shot = params.get('shot') === 'face' ? 'face' : 'body';
    this.still = params.has('still') ? Number(params.get('still')) : undefined;

    this.label.dataset.testid = 'emotion-preview';
    this.label.style.cssText = [
      'position:fixed', 'left:50%', 'top:12px', 'translate:-50% 0', 'z-index:50', 'padding:6px 14px',
      'border-radius:999px', 'background:rgba(20,32,36,.82)', 'color:#fff', 'font:600 13px system-ui,sans-serif',
      'pointer-events:none', 'white-space:nowrap',
    ].join(';');
    document.body.append(this.label);
    if (this.focus) {
      // A close look at one avatar: the playroom's own overlays would sit on top of it.
      const quiet = document.createElement('style');
      quiet.textContent = '.world-labels,.proximity,.guide-card,.controls-card,.topbar,.vignette{display:none!important}';
      document.head.append(quiet);
    }
    window.addEventListener('keydown', this.onKey);
  }

  private readonly onKey = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.repeat) return;
    const key = event.key.toLowerCase();
    if (key >= '1' && key <= String(EMOTIONS.length)) {
      this.emotion = EMOTIONS[Number(key) - 1];
      this.cycling = false;
    } else if (key === '0') {
      this.emotion = null;
      this.cycling = false;
    } else if (key === 'f') {
      this.extent = this.extent === 'face' ? 'body' : 'face';
    } else if (key === 'c') {
      this.cycling = true;
      this.clock = CYCLE_SECONDS;
    } else {
      return;
    }
    this.applied = '';
  };

  /** Advances the preview; call once a frame, before the avatars update. */
  update(delta: number): void {
    if (this.cycling) {
      this.clock += delta;
      if (this.clock >= CYCLE_SECONDS) {
        this.clock = 0;
        this.emotion = EMOTIONS[(EMOTIONS.indexOf(this.emotion as Emotion) + 1) % EMOTIONS.length];
        this.applied = '';
      }
    }

    // An avatar joins in once its model has loaded, so the set shown is part of what was applied.
    const ready = this.avatars().filter((avatar) => avatar.emotions.available(this.extent).length > 0);
    const wanted = `${this.emotion}:${this.extent}:${ready.map((avatar) => avatar.id).join()}`;
    if (wanted !== this.applied) {
      this.applied = wanted;
      for (const avatar of ready) {
        if (this.emotion === null) clearEmotion(avatar);
        else {
          playEmotion(avatar, this.emotion, {
            extent: this.extent,
            seconds: this.cycling ? CYCLE_HOLD : Infinity,
            still: this.still,
          });
        }
      }
    }
    this.label.textContent = `Emotions preview: ${this.emotion ?? 'idle'} (${this.extent === 'face' ? 'face only' : 'face and body'})`
      + '  •  1-6 pick  •  0 idle  •  F face/body  •  C cycle';
  }

  /**
   * Points the camera at the focused avatar, from in front of it. Returns
   * false when no avatar is focused, and the playroom keeps its own camera.
   */
  frame(camera: PerspectiveCamera): boolean {
    const avatar = this.avatars().find((item) => item.id === this.focus);
    if (!avatar) return false;
    if (!this.faceLight && avatar.emotions.available().length > 0) {
      // A close-up is lit for the face, as a mode that zooms in on an avatar would
      // light it, once the model has loaded and its height is known.
      this.faceLight = createFaceLight(new Vector3(0, avatar.height * this.framing.face[0], 0));
      avatar.root.add(this.faceLight, this.faceLight.target);
    }
    const [target, distance] = this.framing[this.shot];
    const lookAt = avatar.root.getWorldPosition(new Vector3());
    lookAt.y += avatar.height * target;
    const front = avatar.root.getWorldDirection(new Vector3());
    camera.position.copy(lookAt).addScaledVector(front, avatar.height * distance);
    camera.position.y += avatar.height * distance * 0.06;
    camera.lookAt(lookAt);
    return true;
  }
}
