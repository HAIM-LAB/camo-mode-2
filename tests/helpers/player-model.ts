import { readFileSync } from 'node:fs';
import { Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PLAYER_ASSET_URLS } from '../../src/config';
import { PlayerStyleId } from '../../src/player-look';

// GLTFLoader decodes embedded textures through browser image APIs. Node has
// none and no test looks at a pixel, so every image decodes to a blank bitmap.
const scope = globalThis as Record<string, unknown>;
scope.self ??= globalThis;
scope.createImageBitmap ??= async () => ({ width: 1, height: 1, close: () => undefined });

/** Loads a style's real GLB from public/, with its clips attached as the asset loader attaches them. */
export async function loadPlayerModel(style: PlayerStyleId): Promise<Object3D> {
  const bytes = readFileSync(new URL(`../../public${PLAYER_ASSET_URLS[style]}`, import.meta.url));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  gltf.scene.animations = gltf.animations;
  return gltf.scene;
}

export function materialsByName(root: Object3D): Map<string, MeshStandardMaterial> {
  const found = new Map<string, MeshStandardMaterial>();
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    for (const material of Array.isArray(child.material) ? child.material : [child.material]) {
      if (material instanceof MeshStandardMaterial) found.set(material.name, material);
    }
  });
  return found;
}

export function meshNames(root: Object3D): string[] {
  const names: string[] = [];
  root.traverse((child) => {
    if (child instanceof Mesh) names.push(child.name);
  });
  return names;
}

/** Names of the meshes that would render, honoring hidden ancestors. */
export function shownParts(root: Object3D, prefix: string): string[] {
  const shown: string[] = [];
  root.traverseVisible((child) => {
    if (child instanceof Mesh && child.name.startsWith(prefix)) shown.push(child.name);
  });
  return shown.sort();
}
