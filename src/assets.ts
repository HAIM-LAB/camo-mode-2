import {
  Box3,
  BufferAttribute,
  Group,
  Material,
  Mesh,
  Object3D,
  SkinnedMesh,
  Texture,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { AssetId } from './config';

export interface AssetLoadSummary {
  loaded: AssetId[];
  fallback: AssetId[];
  complete: number;
  total: number;
}

type AssetTargets = Partial<Record<AssetId, Group>>;
type ProgressCallback = (summary: AssetLoadSummary) => void;
/** Finishes a freshly loaded model before it replaces its procedural stand-in. */
type AssetPreparers = Partial<Record<AssetId, (model: Object3D) => void>>;

/**
 * A group that shows the procedural stand-in until OptionalAssetLoader swaps
 * the approved GLB into it.
 */
export function createVisualTarget(fallback: Group, name: string): Group {
  const target = new Group();
  target.name = `${name}-visual`;
  target.userData.assetMode = 'procedural';
  target.add(fallback);
  return target;
}

export function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    if (child instanceof SkinnedMesh) child.skeleton.dispose();
    const materials: Material[] = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const item of materials) {
      // A material does not own its maps, so they are released alongside it.
      for (const value of Object.values(item)) {
        if (value instanceof Texture) value.dispose();
      }
      item.dispose();
    }
  });
}

/**
 * A model's bounds as it rests, from its geometry. A face's morph targets
 * reach a little beyond the resting face, and a geometry's own bounding box
 * counts them in; they are not part of where the model stands or how tall it
 * is. (A skinned mesh's own bounds are not usable until its skeleton has
 * rendered once, so they are not asked either.)
 */
export function restBounds(model: Object3D): Box3 {
  const bounds = new Box3();
  const part = new Box3();
  model.updateWorldMatrix(true, true);
  model.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const position = child.geometry.getAttribute('position');
    if (position instanceof BufferAttribute) {
      bounds.union(part.setFromBufferAttribute(position).applyMatrix4(child.matrixWorld));
    }
  });
  return bounds;
}

/**
 * Moves the model's bounds to floor contact and centers them in X/Z. Scale is
 * deliberately untouched: contract-compliant models already resolve to a no-op.
 */
export function normalizeModelPlacement(model: Object3D): void {
  const bounds = restBounds(model);
  if (bounds.isEmpty()) return;

  const center = bounds.getCenter(new Vector3());
  const correction = new Vector3(-center.x, -bounds.min.y, -center.z);
  if (correction.lengthSq() < 1e-10) return;
  model.position.add(correction);
  model.updateMatrixWorld(true);
}

export function shouldNormalizeModelPlacement(id: AssetId): boolean {
  // The room is authored directly in world coordinates. Its intentional,
  // asymmetric backyard glimpse extends beyond the indoor footprint, so
  // centering its aggregate bounds would shift every wall and furnishing.
  return id !== 'room';
}

function prepareModel(model: Object3D, id: AssetId): Object3D {
  model.name = `optional-${id}`;
  if (shouldNormalizeModelPlacement(id)) normalizeModelPlacement(model);
  model.traverse((child) => {
    if (child instanceof Mesh) {
      child.castShadow = id !== 'room';
      child.receiveShadow = true;
    }
  });
  return model;
}

export class OptionalAssetLoader {
  private readonly loader = new GLTFLoader();

  /** Takes the URL of each asset; `assetUrls(style)` in config.ts builds the map. */
  constructor(private readonly urls: Readonly<Record<AssetId, string>>) {}

  async load(
    targets: AssetTargets,
    onProgress: ProgressCallback,
    preparers: AssetPreparers = {},
  ): Promise<AssetLoadSummary> {
    const loaded: AssetId[] = [];
    const fallback: AssetId[] = [];
    const entries = Object.entries(targets) as [AssetId, Group][];

    const publish = (): AssetLoadSummary => {
      const summary = {
        loaded: [...loaded],
        fallback: [...fallback],
        complete: loaded.length + fallback.length,
        total: entries.length,
      };
      onProgress(summary);
      return summary;
    };

    publish();
    await Promise.all(
      entries.map(async ([id, target]) => {
        const url = this.urls[id];
        try {
          const gltf = await this.loader.loadAsync(url);
          if (!gltf.scene || gltf.scene.children.length === 0) {
            throw new Error('GLB contains no scene geometry');
          }
          const model = prepareModel(gltf.scene, id);
          // Clips travel with the model, where an AnimationMixer looks for them.
          model.animations = gltf.animations ?? [];
          preparers[id]?.(model);
          const oldVisuals = [...target.children];
          target.clear();
          target.add(model);
          for (const oldVisual of oldVisuals) disposeObject(oldVisual);
          target.userData.assetMode = 'glb';
          target.userData.assetUrl = url;
          loaded.push(id);
        } catch (error) {
          targetFallback(target, url, error);
          fallback.push(id);
        }
        publish();
      }),
    );

    return publish();
  }
}

function targetFallback(target: Group, url: string, error: unknown): void {
  target.userData.assetMode = 'procedural';
  target.userData.assetUrl = url;
  target.userData.assetError = error instanceof Error ? error.message : String(error);
  // Missing optional art is an expected demo mode, not an application error.
  console.info(`[Camo] Optional asset unavailable; using fallback: ${url}`);
}
