import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Color, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  DEFAULT_PLAYER_LOOK,
  LOOK_AXES,
  LookAxis,
  PLAYER_MATERIALS,
  PlayerLook,
  applyPlayerLook,
  contrastRatio,
  loadPlayerLook,
  normalizePlayerLook,
  savePlayerLook,
  surfaceColor,
} from '../src/player-look';
import { shouldSkipMenu } from '../src/menus';
import { createPlayerFallback } from '../src/procedural';

const PLAYER_GLB = new URL('../public/assets/cast/player.glb', import.meta.url);

async function loadPlayerModel(): Promise<Object3D> {
  const bytes = readFileSync(PLAYER_GLB);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

function materialsByName(root: Object3D): Map<string, MeshStandardMaterial> {
  const found = new Map<string, MeshStandardMaterial>();
  root.traverse((child) => {
    if (child instanceof Mesh && child.material instanceof MeshStandardMaterial) {
      found.set(child.material.name, child.material);
    }
  });
  return found;
}

function meshMaterial(root: Object3D, name: string): MeshStandardMaterial {
  const mesh = root.getObjectByName(name);
  if (!(mesh instanceof Mesh)) throw new Error(`No mesh named ${name}`);
  return mesh.material as MeshStandardMaterial;
}

function meshColor(root: Object3D, name: string): string {
  return `#${meshMaterial(root, name).color.getHexString()}`;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const items = new Map(Object.entries(initial));
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
  };
}

describe('player look catalog', () => {
  it('only repaints materials that the approved player.glb actually has', async () => {
    const authored = materialsByName(await loadPlayerModel());
    for (const name of Object.values(PLAYER_MATERIALS)) expect(authored.has(name)).toBe(true);
  });

  it('defaults to the authored player.glb colors, so an unchosen look changes nothing', async () => {
    const model = await loadPlayerModel();
    const authored = new Map(
      [...materialsByName(model)].map(([name, material]) => [
        name,
        { color: material.color.clone(), roughness: material.roughness },
      ]),
    );

    applyPlayerLook(model, DEFAULT_PLAYER_LOOK);

    for (const [name, material] of materialsByName(model)) {
      const before = authored.get(name) as { color: Color; roughness: number };
      // Hex authoring rounds each sRGB channel to 1/255.
      expect(material.color.r).toBeCloseTo(before.color.r, 2);
      expect(material.color.g).toBeCloseTo(before.color.g, 2);
      expect(material.color.b).toBeCloseTo(before.color.b, 2);
      expect(material.roughness).toBeCloseTo(before.roughness, 5);
    }
  });

  it('keeps the eyes and mouth darker than the skin and as readable as that skin allows', () => {
    const skinAxis = (LOOK_AXES as readonly LookAxis[]).find((axis) => axis.id === 'skin');
    for (const option of skinAxis?.options ?? []) {
      const skin = surfaceColor(option.paint.skin ?? '');
      // Even black cannot clear these bars on the deepest skin, so the bar there
      // is most of what black would give.
      const blackContrast = contrastRatio(skin, '#000000');
      for (const [feature, minimum] of [['eyes', 3], ['mouth', 2]] as const) {
        const color = surfaceColor(option.paint[feature] ?? '');
        expect(contrastRatio(color, '#000000'), `${option.id} ${feature} is darker than skin`)
          .toBeLessThan(blackContrast);
        expect(contrastRatio(skin, color), `${option.id} ${feature} contrast`)
          .toBeGreaterThanOrEqual(Math.min(minimum, 0.85 * blackContrast));
      }
    }
  });

  it('gives every axis a valid default and unique option ids', () => {
    for (const axis of LOOK_AXES as readonly LookAxis[]) {
      const ids = axis.options.map((option) => option.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain(axis.defaultOption);
    }
  });
});

describe('applyPlayerLook', () => {
  it('repaints the skin and outfit parts of the real model and nothing else', async () => {
    const model = await loadPlayerModel();
    const look: PlayerLook = { skin: 'tone-6', outfit: 'sunny' };

    applyPlayerLook(model, look);

    expect(meshColor(model, 'player_head')).toBe('#5c3a28');
    expect(meshColor(model, 'player_hand_L')).toBe('#5c3a28');
    expect(meshColor(model, 'player_nose')).toBe('#744a34');
    expect(meshColor(model, 'player_hoodie')).toBe('#ffcf3f');
    expect(meshColor(model, 'player_leg_L')).toBe('#4f86e0');
    expect(meshColor(model, 'player_backpack')).toBe('#ef5b4c');
    // Hair, eyes, and soles are not part of any axis.
    expect(meshColor(model, 'player_hair_back')).toBe('#4d352c');
  });

  it('can be applied again with a different look', async () => {
    const model = await loadPlayerModel();
    applyPlayerLook(model, { skin: 'tone-1', outfit: 'berry' });
    applyPlayerLook(model, { skin: 'tone-5', outfit: 'forest' });

    expect(meshColor(model, 'player_head')).toBe('#845238');
    expect(meshColor(model, 'player_hoodie')).toBe('#5bbf6a');
  });

  it('gives deep skin glossy dark eyes and restores the authored face after', async () => {
    const model = await loadPlayerModel();
    const eyes = meshMaterial(model, 'player_eye_L');
    const authored = { color: eyes.color.getHexString(), roughness: eyes.roughness };

    applyPlayerLook(model, { skin: 'tone-6', outfit: 'ocean' });
    expect(eyes.roughness).toBeLessThan(0.5);
    expect(eyes.color.getHexString()).not.toBe(authored.color);

    applyPlayerLook(model, DEFAULT_PLAYER_LOOK);
    expect(eyes.roughness).toBeCloseTo(authored.roughness, 5);
    expect(eyes.color.getHexString()).toBe(authored.color);
  });

  it('repaints the procedural stand-in shown before or instead of the GLB', () => {
    const fallback = createPlayerFallback();
    const body = fallback.children.find(
      (child) => child instanceof Mesh && child.material.name === PLAYER_MATERIALS.hoodie,
    ) as Mesh<never, MeshStandardMaterial> | undefined;

    applyPlayerLook(new Group().add(fallback), { skin: 'tone-3', outfit: 'rocket' });

    expect(body?.material.color.getHexString()).toBe('e8524a');
  });
});

describe('saved look', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    savePlayerLook({ skin: 'tone-2', outfit: 'bubblegum' }, storage);
    expect(loadPlayerLook(storage)).toEqual({ skin: 'tone-2', outfit: 'bubblegum' });
  });

  it('keeps known choices and defaults unknown or missing ones', () => {
    expect(normalizePlayerLook({ skin: 'tone-4', outfit: 'retired-outfit' })).toEqual({
      skin: 'tone-4',
      outfit: DEFAULT_PLAYER_LOOK.outfit,
    });
    expect(normalizePlayerLook({ outfit: 'forest' })).toEqual({
      skin: DEFAULT_PLAYER_LOOK.skin,
      outfit: 'forest',
    });
    expect(normalizePlayerLook('tone-4')).toEqual(DEFAULT_PLAYER_LOOK);
  });

  it('falls back to the default look when storage is empty, corrupt, or blocked', () => {
    expect(loadPlayerLook(memoryStorage())).toEqual(DEFAULT_PLAYER_LOOK);
    expect(loadPlayerLook(memoryStorage({ 'camo-mode-2.player-look': '{not json' }))).toEqual(
      DEFAULT_PLAYER_LOOK,
    );
    expect(loadPlayerLook(null)).toEqual(DEFAULT_PLAYER_LOOK);

    const blocked = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadPlayerLook(blocked)).toEqual(DEFAULT_PLAYER_LOOK);
    expect(() => savePlayerLook(DEFAULT_PLAYER_LOOK, blocked)).not.toThrow();
  });
});

describe('menu skip', () => {
  it('skips the menus only for skipMenu=1', () => {
    expect(shouldSkipMenu('?skipMenu=1')).toBe(true);
    expect(shouldSkipMenu('?debug=1&skipMenu=1')).toBe(true);
    expect(shouldSkipMenu('')).toBe(false);
    expect(shouldSkipMenu('?skipMenu=0')).toBe(false);
  });
});
