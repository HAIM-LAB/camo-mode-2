import {
  ACESFilmicToneMapping,
  Clock,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { AssetLoadSummary, OptionalAssetLoader } from './assets';
import {
  ASSET_URLS,
  AssetId,
  PLAYER_SPAWN,
  SCENE_ANCHORS,
} from './config';
import {
  NearbyEntity,
  PlayerController,
  dropPosition,
  nearestPickup,
  promptFor,
} from './gameplay';
import {
  createBallFallback,
  createBlockFallback,
  createCamoFallback,
  createFriendFallback,
  createPlayerFallback,
  createRoomFallback,
  fallbackColors,
} from './procedural';

interface SceneEntity extends NearbyEntity {
  root: Group;
  visual: Group;
  labelHeight: number;
  worldLabel: string;
}

interface LabelBinding {
  entity: SceneEntity;
  element: HTMLDivElement;
}

export interface DemoSnapshot {
  ready: boolean;
  player: { x: number; z: number };
  carried: string | null;
  prompt: string;
  assetModes: Record<AssetId, string>;
  entities: Record<string, { x: number; z: number; location?: string }>;
}

declare global {
  interface Window {
    __CAMO_DEMO__?: {
      getState: () => DemoSnapshot;
    };
  }
}

const CAMERA_OFFSET = new Vector3(0, 4.8, 6.4);
const CAMERA_LOOK_OFFSET = new Vector3(0, 0.78, -0.34);

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required UI element #${id} is missing`);
  return element as T;
}

function createVisualTarget(fallback: Group, name: string): Group {
  const target = new Group();
  target.name = `${name}-visual`;
  target.userData.assetMode = 'procedural';
  target.add(fallback);
  return target;
}

function wrapEntity(
  id: string,
  label: string,
  kind: NearbyEntity['kind'],
  position: Vector3,
  fallback: Group,
  labelHeight: number,
  options: { worldLabel?: string; location?: NearbyEntity['location'] } = {},
): SceneEntity {
  const root = new Group();
  root.name = id;
  root.position.copy(position);
  const visual = createVisualTarget(fallback, id);
  root.add(visual);
  return {
    id,
    label,
    kind,
    position: root.position,
    root,
    visual,
    labelHeight,
    worldLabel: options.worldLabel ?? label,
    location: options.location,
  };
}

function shortestAngleDelta(from: number, to: number): number {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

export class CamoDemoApp {
  private readonly canvas = requiredElement<HTMLCanvasElement>('scene');
  private readonly startup = requiredElement<HTMLElement>('startup');
  private readonly assetStatus = requiredElement<HTMLElement>('asset-status');
  private readonly promptRoot = requiredElement<HTMLElement>('proximity');
  private readonly promptIcon = requiredElement<HTMLElement>('prompt-icon');
  private readonly promptKicker = requiredElement<HTMLElement>('prompt-kicker');
  private readonly promptText = requiredElement<HTMLElement>('prompt-text');
  private readonly promptKey = requiredElement<HTMLElement>('prompt-key');
  private readonly labelsRoot = requiredElement<HTMLElement>('world-labels');

  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(48, 1, 0.1, 80);
  private readonly renderer: WebGLRenderer;
  private readonly clock = new Clock();
  private readonly player = new PlayerController(PLAYER_SPAWN);
  private readonly playerRoot = new Group();
  private readonly playerVisual = createVisualTarget(createPlayerFallback(), 'player');
  private readonly carrySocket = new Group();
  private readonly roomVisual = createVisualTarget(createRoomFallback(), 'room');
  private readonly entities: SceneEntity[];
  private readonly labels: LabelBinding[] = [];
  private readonly keys = new Set<string>();
  private readonly cameraTarget = new Vector3();
  private readonly desiredCameraPosition = new Vector3();
  private carried?: SceneEntity;
  private lastPromptSignature = '';
  private ready = false;
  private elapsed = 0;
  private animationFrame = 0;

  constructor() {
    this.renderer = new WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.entities = [
      wrapEntity('camo', 'Camo', 'camo', SCENE_ANCHORS.camo, createCamoFallback(), 1.35),
      wrapEntity(
        'friend-a',
        'Friend A',
        'friend',
        SCENE_ANCHORS.friendA,
        createFriendFallback(fallbackColors.friendA, fallbackColors.friendAAccent, 'friend-a'),
        1.62,
        { worldLabel: 'INSIDE • FRIEND A', location: 'indoors' },
      ),
      wrapEntity(
        'friend-b',
        'Friend B',
        'friend',
        SCENE_ANCHORS.friendB,
        createFriendFallback(fallbackColors.friendB, fallbackColors.friendBAccent, 'friend-b'),
        1.62,
        { worldLabel: 'PATIO • FRIEND B', location: 'patio' },
      ),
      wrapEntity('ball', 'Ball', 'ball', SCENE_ANCHORS.ball, createBallFallback(), 0.78),
      wrapEntity('block', 'Building block', 'block', SCENE_ANCHORS.block, createBlockFallback(), 0.88),
    ];

    this.configureScene();
    this.configureInput();
    this.configureLabels();
    this.resize();
    window.addEventListener('resize', this.resize);

    window.__CAMO_DEMO__ = { getState: () => this.snapshot() };
  }

  start(): void {
    this.clock.start();
    this.animationFrame = requestAnimationFrame(this.renderFrame);
    void this.loadOptionalAssets();
  }

  stop(): void {
    cancelAnimationFrame(this.animationFrame);
    window.removeEventListener('resize', this.resize);
    this.renderer.dispose();
  }

  private configureScene(): void {
    this.scene.background = new Color(0xc9dfe1);
    this.scene.fog = new Fog(0xc9dfe1, 14, 27);

    const hemisphere = new HemisphereLight(0xfff5df, 0x536971, 2.3);
    this.scene.add(hemisphere);

    const sun = new DirectionalLight(0xffe9cf, 3.5);
    sun.position.set(3.8, 7.5, 5.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    sun.shadow.camera.left = -8;
    sun.shadow.camera.right = 8;
    sun.shadow.camera.top = 7;
    sun.shadow.camera.bottom = -7;
    sun.shadow.camera.near = 0.5;
    sun.shadow.camera.far = 22;
    this.scene.add(sun);

    this.scene.add(this.roomVisual);
    for (const entity of this.entities) this.scene.add(entity.root);

    this.playerRoot.name = 'player';
    this.playerRoot.position.copy(this.player.position);
    this.playerRoot.rotation.y = Math.PI;
    this.carrySocket.name = 'carry-socket';
    this.carrySocket.position.set(0, 1.02, 0.42);
    this.playerRoot.add(this.playerVisual, this.carrySocket);
    this.scene.add(this.playerRoot);

    this.desiredCameraPosition.copy(this.player.position).add(CAMERA_OFFSET);
    this.camera.position.copy(this.desiredCameraPosition);
    this.camera.lookAt(this.player.position.clone().add(CAMERA_LOOK_OFFSET));
  }

  private configureInput(): void {
    window.addEventListener('keydown', (event) => {
      const key = event.key.toLowerCase();
      if (
        key.startsWith('arrow') ||
        key === 'w' ||
        key === 'a' ||
        key === 's' ||
        key === 'd' ||
        key === 'e'
      ) {
        event.preventDefault();
      }
      if (key === 'e' && !event.repeat) this.toggleCarry();
      this.keys.add(key);
    });
    window.addEventListener('keyup', (event) => this.keys.delete(event.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private configureLabels(): void {
    const iconFor = (entity: SceneEntity): string => {
      if (entity.kind === 'camo') return '♥';
      if (entity.location === 'patio') return '☀';
      if (entity.kind === 'friend') return '☺';
      if (entity.kind === 'ball') return '●';
      return '◆';
    };

    for (const entity of this.entities) {
      const element = document.createElement('div');
      element.className = `world-label world-label--${entity.kind}`;
      if (entity.location) element.classList.add(`world-label--${entity.location}`);
      element.dataset.entity = entity.id;
      element.innerHTML = `<span>${iconFor(entity)}</span>${entity.worldLabel}`;
      this.labelsRoot.append(element);
      this.labels.push({ entity, element });
    }
  }

  private readonly resize = (): void => {
    const width = Math.max(window.innerWidth, 1);
    const height = Math.max(window.innerHeight, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  };

  private readonly renderFrame = (): void => {
    const delta = this.clock.getDelta();
    this.elapsed += delta;
    this.player.update(this.keys, delta);
    this.updatePlayer(delta);
    this.updateCamera(delta);
    this.updatePrompt();
    this.updateLabels();
    this.animateFallbacks(delta);
    this.renderer.render(this.scene, this.camera);

    if (!this.ready) {
      this.ready = true;
      document.body.dataset.appReady = 'true';
      this.startup.classList.add('startup--hidden');
    }
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  };

  private updatePlayer(delta: number): void {
    this.playerRoot.position.copy(this.player.position);
    const targetYaw = Math.atan2(this.player.facing.x, this.player.facing.z);
    this.playerRoot.rotation.y += shortestAngleDelta(this.playerRoot.rotation.y, targetYaw)
      * (1 - Math.exp(-14 * delta));
    const moving = this.player.velocity.lengthSq() > 0.04;
    this.playerVisual.position.y = moving ? Math.abs(Math.sin(this.elapsed * 9)) * 0.035 : 0;
  }

  private updateCamera(delta: number): void {
    this.desiredCameraPosition.copy(this.player.position).add(CAMERA_OFFSET);
    this.camera.position.lerp(this.desiredCameraPosition, 1 - Math.exp(-6.5 * delta));
    this.cameraTarget.copy(this.player.position).add(CAMERA_LOOK_OFFSET);
    this.camera.lookAt(this.cameraTarget);
  }

  private animateFallbacks(delta: number): void {
    for (const entity of this.entities) {
      if (entity.kind === 'ball' && !entity.carried) entity.visual.rotation.y += delta * 0.5;
      if (entity.kind === 'camo') {
        entity.visual.position.y = Math.sin(this.elapsed * 2.1) * 0.018;
      }
    }
  }

  private nearbyEntities(): NearbyEntity[] {
    return this.entities.map((entity) => ({
      id: entity.id,
      label: entity.label,
      kind: entity.kind,
      position: entity.root.position,
      location: entity.location,
      carried: entity.carried,
    }));
  }

  private updatePrompt(): void {
    const prompt = promptFor(this.player.position, this.nearbyEntities(), this.carried);
    const signature = `${prompt.entityId ?? 'none'}:${prompt.text}:${prompt.action}`;
    if (signature === this.lastPromptSignature) return;
    this.lastPromptSignature = signature;

    this.promptIcon.textContent = prompt.icon;
    this.promptKicker.textContent = prompt.kicker;
    this.promptText.textContent = prompt.text;
    this.promptKey.hidden = !prompt.action;
    this.promptRoot.classList.toggle('proximity--action', prompt.action);
    this.promptRoot.classList.remove('proximity--changed');
    requestAnimationFrame(() => this.promptRoot.classList.add('proximity--changed'));
  }

  private updateLabels(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    const projected = new Vector3();

    for (const { entity, element } of this.labels) {
      if (entity.carried) {
        element.classList.remove('world-label--visible');
        continue;
      }
      const distance = Math.hypot(
        entity.root.position.x - this.player.position.x,
        entity.root.position.z - this.player.position.z,
      );
      projected.copy(entity.root.position);
      projected.y += entity.labelHeight;
      projected.project(this.camera);
      const labelRange = entity.location === 'patio' ? 10 : 6.25;
      const visible =
        projected.z > -1 &&
        projected.z < 1 &&
        Math.abs(projected.x) < 1.08 &&
        Math.abs(projected.y) < 1.08 &&
        distance < labelRange;
      element.classList.toggle('world-label--visible', visible);
      if (visible) {
        element.style.transform = `translate(-50%, -50%) translate(${(projected.x * 0.5 + 0.5) * width}px, ${(-projected.y * 0.5 + 0.5) * height}px)`;
        element.style.setProperty('--label-depth', String(Math.max(0.76, 1.1 - distance * 0.045)));
      }
    }
  }

  private toggleCarry(): void {
    if (this.carried) {
      const entity = this.carried;
      this.carrySocket.remove(entity.root);
      this.scene.add(entity.root);
      entity.root.position.copy(dropPosition(this.player.position, this.player.facing));
      entity.root.rotation.set(0, 0, 0);
      entity.carried = false;
      this.carried = undefined;
      this.lastPromptSignature = '';
      return;
    }

    const candidate = nearestPickup(this.player.position, this.nearbyEntities());
    if (!candidate) return;
    const entity = this.entities.find((item) => item.id === candidate.id);
    if (!entity) return;

    this.scene.remove(entity.root);
    this.carrySocket.add(entity.root);
    entity.root.position.set(0, 0, 0);
    entity.root.rotation.set(0, 0, 0);
    entity.carried = true;
    this.carried = entity;
    this.lastPromptSignature = '';
  }

  private async loadOptionalAssets(): Promise<void> {
    const targets: Record<AssetId, Group> = {
      room: this.roomVisual,
      camo: this.entityById('camo').visual,
      player: this.playerVisual,
      friendA: this.entityById('friend-a').visual,
      friendB: this.entityById('friend-b').visual,
      ball: this.entityById('ball').visual,
      block: this.entityById('block').visual,
    };

    const loader = new OptionalAssetLoader();
    await loader.load(targets, (summary) => {
      this.renderAssetStatus(summary);
    });
  }

  private renderAssetStatus(summary: AssetLoadSummary): void {
    const text = this.assetStatus.querySelector('span:last-child');
    if (!text) return;
    if (summary.complete < summary.total) {
      text.textContent = `Backups ready • loading approved art ${summary.complete}/${summary.total}`;
      return;
    }
    if (summary.loaded.length === 0) {
      text.textContent = 'Ready • procedural fallback mode';
      this.assetStatus.classList.add('asset-status--fallback');
      return;
    }
    text.textContent = summary.fallback.length === 0
      ? `Ready • approved GLBs ${summary.loaded.length}/${summary.total}`
      : `Ready • ${summary.loaded.length}/${summary.total} GLBs • ${summary.fallback.length} fallback`;
    this.assetStatus.classList.add('asset-status--ready');
  }

  private entityById(id: string): SceneEntity {
    const entity = this.entities.find((item) => item.id === id);
    if (!entity) throw new Error(`Unknown scene entity: ${id}`);
    return entity;
  }

  private snapshot(): DemoSnapshot {
    const targetMap: Record<AssetId, Group> = {
      room: this.roomVisual,
      camo: this.entityById('camo').visual,
      player: this.playerVisual,
      friendA: this.entityById('friend-a').visual,
      friendB: this.entityById('friend-b').visual,
      ball: this.entityById('ball').visual,
      block: this.entityById('block').visual,
    };
    const assetModes = Object.fromEntries(
      (Object.keys(ASSET_URLS) as AssetId[]).map((id) => [
        id,
        String(targetMap[id].userData.assetMode ?? 'procedural'),
      ]),
    ) as Record<AssetId, string>;

    const entities = Object.fromEntries(
      this.entities.map((entity) => {
        const worldPosition = entity.root.getWorldPosition(new Vector3());
        return [
          entity.id,
          {
            x: worldPosition.x,
            z: worldPosition.z,
            ...(entity.location ? { location: entity.location } : {}),
          },
        ] as const;
      }),
    );

    return {
      ready: this.ready,
      player: { x: this.player.position.x, z: this.player.position.z },
      carried: this.carried?.id ?? null,
      prompt: this.promptText.textContent ?? '',
      assetModes,
      entities,
    };
  }
}
