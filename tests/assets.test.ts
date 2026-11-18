import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnimationClip, Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { GLTF, GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  OptionalAssetLoader,
  createVisualTarget,
  normalizeModelPlacement,
  shouldNormalizeModelPlacement,
} from '../src/assets';
import { assetUrls } from '../src/config';

describe('optional asset placement', () => {
  it('preserves the authored world origin for the asymmetric room and patio', () => {
    expect(shouldNormalizeModelPlacement('room')).toBe(false);
    expect(shouldNormalizeModelPlacement('camo')).toBe(true);
    expect(shouldNormalizeModelPlacement('player')).toBe(true);
  });

  it('does not alter scale or placement for a contract-compliant model', () => {
    const model = new Group();
    const geometry = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
    geometry.position.y = 0.5;
    model.add(geometry);

    normalizeModelPlacement(model);

    expect(model.position.toArray()).toEqual([0, 0, 0]);
    expect(model.scale.toArray()).toEqual([1, 1, 1]);
  });

  it('centers malformed placement at floor contact without rescaling', () => {
    const model = new Group();
    const geometry = new Mesh(new BoxGeometry(2, 2, 2), new MeshBasicMaterial());
    geometry.position.set(2, 2, -3);
    model.add(geometry);

    normalizeModelPlacement(model);
    const bounds = new Box3().setFromObject(model);
    const center = bounds.getCenter(new Vector3());

    expect(bounds.min.y).toBeCloseTo(0);
    expect(center.x).toBeCloseTo(0);
    expect(center.z).toBeCloseTo(0);
    expect(model.scale.toArray()).toEqual([1, 1, 1]);
  });
});

describe('optional asset loader', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads only the requested targets and prepares each model before it is shown', async () => {
    const model = new Group();
    model.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial()));
    const clips = [new AnimationClip('idle', 1, [])];
    const requested: string[] = [];
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async (url: string) => {
      requested.push(url);
      return { scene: model, animations: clips } as unknown as GLTF;
    });

    const fallback = new Group();
    const target = createVisualTarget(fallback, 'player');
    const prepared: boolean[] = [];
    const summary = await new OptionalAssetLoader(assetUrls('cartoon')).load({ player: target }, () => undefined, {
      // Runs while the stand-in is still on screen, so no unprepared frame renders.
      // The model's clips are already on it, ready for the preparer to bind.
      player: (loaded) => prepared.push(
        loaded === model && loaded.animations === clips && target.children[0] === fallback,
      ),
    });

    expect(requested).toEqual(['/assets/cast/player-cartoon.glb']);
    expect(summary).toMatchObject({ loaded: ['player'], fallback: [], complete: 1, total: 1 });
    expect(prepared).toEqual([true]);
    expect(target.children).toEqual([model]);
    expect(target.userData.assetMode).toBe('glb');
  });

  it('loads the player model of the chosen style and leaves every other asset alone', () => {
    const cartoon = assetUrls('cartoon');
    const realistic = assetUrls('realistic');
    expect(cartoon.player).toBe('/assets/cast/player-cartoon.glb');
    expect(realistic.player).toBe('/assets/cast/player-realistic.glb');
    expect({ ...realistic, player: cartoon.player }).toEqual(cartoon);
  });

  it('keeps the stand-in when a model cannot be loaded', async () => {
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockRejectedValue(new Error('404'));
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fallback = new Group();
    const target = createVisualTarget(fallback, 'player');

    const summary = await new OptionalAssetLoader(assetUrls('realistic')).load({ player: target }, () => undefined);

    expect(summary).toMatchObject({ loaded: [], fallback: ['player'] });
    expect(target.children).toEqual([fallback]);
    expect(target.userData.assetMode).toBe('procedural');
  });
});
