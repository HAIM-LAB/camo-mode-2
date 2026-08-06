import {
  Box3,
  Group,
  Material,
  Mesh,
  Object3D,
  Vector3,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { ASSET_URLS, AssetId } from './config';

export interface AssetLoadSummary {
  loaded: AssetId[];
  fallback: AssetId[];
  complete: number;
  total: number;
}

type AssetTargets = Record<AssetId, Group>;
type ProgressCallback = (summary: AssetLoadSummary) => void;

function disposeObject(root: Object3D): void {
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    child.geometry.dispose();
    const materials: Material[] = Array.isArray(child.material)
      ? child.material
      : [child.material];
    for (const item of materials) item.dispose();
  });
}

/**
 * Moves the model's bounds to floor contact and centers them in X/Z. Scale is
 * deliberately untouched: contract-compliant models already resolve to a no-op.
 */
export function normalizeModelPlacement(model: Object3D): void {
  model.updateMatrixWorld(true);
  const bounds = new Box3().setFromObject(model);
  if (bounds.isEmpty()) return;

  const center = bounds.getCenter(new Vector3());
  const correction = new Vector3(-center.x, -bounds.min.y, -center.z);
  if (correction.lengthSq() < 1e-10) return;
  model.position.add(correction);
  model.updateMatrixWorld(true);
}

function prepareModel(model: Object3D, id: AssetId): Object3D {
  model.name = `optional-${id}`;
  normalizeModelPlacement(model);
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

  async load(targets: AssetTargets, onProgress: ProgressCallback): Promise<AssetLoadSummary> {
    const loaded: AssetId[] = [];
    const fallback: AssetId[] = [];
    const entries = Object.entries(ASSET_URLS) as [AssetId, string][];

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
      entries.map(async ([id, url]) => {
        try {
          const gltf = await this.loader.loadAsync(url);
          if (!gltf.scene || gltf.scene.children.length === 0) {
            throw new Error('GLB contains no scene geometry');
          }
          const target = targets[id];
          const oldVisuals = [...target.children];
          target.clear();
          target.add(prepareModel(gltf.scene, id));
          for (const oldVisual of oldVisuals) disposeObject(oldVisual);
          target.userData.assetMode = 'glb';
          target.userData.assetUrl = url;
          loaded.push(id);
        } catch (error) {
          targetFallback(targets[id], url, error);
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
