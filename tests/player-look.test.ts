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
const AXES = LOOK_AXES as readonly LookAxis[];

async function loadPlayerModel(): Promise<Object3D> {
  const bytes = readFileSync(PLAYER_GLB);
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  return gltf.scene;
}

function look(choices: Partial<PlayerLook>): PlayerLook {
  return { ...DEFAULT_PLAYER_LOOK, ...choices };
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

/** Names of the meshes that would render, honoring hidden ancestors. */
function shownParts(root: Object3D, prefix: string): string[] {
  const shown: string[] = [];
  root.traverseVisible((child) => {
    if (child instanceof Mesh && child.name.startsWith(prefix)) shown.push(child.name);
  });
  return shown.sort();
}

function partPrefixes(kind: 'nodes' | 'hides' | 'all' = 'all'): string[] {
  return AXES.flatMap((axis) => axis.options.flatMap((option) => [
    ...(kind === 'hides' ? [] : option.nodes ?? []),
    ...(kind === 'nodes' ? [] : option.hides ?? []),
  ]));
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
  it('only names materials and parts that the approved player.glb actually has', async () => {
    const model = await loadPlayerModel();
    const authored = materialsByName(model);
    for (const name of Object.values(PLAYER_MATERIALS)) expect(authored.has(name), name).toBe(true);

    const meshNames: string[] = [];
    model.traverse((child) => {
      if (child instanceof Mesh) meshNames.push(child.name);
    });
    for (const prefix of partPrefixes()) {
      expect(meshNames.some((name) => name.startsWith(prefix)), prefix).toBe(true);
    }
  });

  it('defaults to the authored player.glb colors, so an unchosen look keeps the approved art', async () => {
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
    // The approved beanie, hair, and trousers, plus the boy's fringe.
    expect(shownParts(model, 'player_beanie_')).toEqual(['player_beanie_band', 'player_beanie_crown']);
    expect(shownParts(model, 'player_hair_')).toEqual(['player_hair_back', 'player_hair_boy_fringe']);
    expect(shownParts(model, 'player_leg_')).toEqual(['player_leg_L', 'player_leg_R']);
    expect(shownParts(model, 'player_skirt')).toEqual([]);
    expect(shownParts(model, 'player_scarf_')).toEqual([]);
  });

  it('gives every axis a valid default and unique option ids', () => {
    for (const axis of AXES) {
      const ids = axis.options.map((option) => option.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain(axis.defaultOption);
    }
  });

  it('keeps the eyes and mouth darker than the skin and as readable as that skin allows', () => {
    const skinAxis = AXES.find((axis) => axis.id === 'skin');
    for (const option of skinAxis?.options ?? []) {
      const skin = surfaceColor(option.paint?.skin ?? '');
      // On deep skin even black cannot clear these bars, so the bar there is
      // most of what black would give.
      const blackContrast = contrastRatio(skin, '#000000');
      for (const [feature, minimum] of [['eyes', 3], ['mouth', 2]] as const) {
        const color = surfaceColor(option.paint?.[feature] ?? '');
        expect(contrastRatio(color, '#000000'), `${option.id} ${feature} is darker than skin`)
          .toBeLessThan(blackContrast);
        expect(contrastRatio(skin, color), `${option.id} ${feature} contrast`)
          .toBeGreaterThanOrEqual(Math.min(minimum, 0.85 * blackContrast));
      }
    }
  });
});

describe('applyPlayerLook', () => {
  it('repaints the skin and outfit parts of the real model and nothing else', async () => {
    const model = await loadPlayerModel();

    applyPlayerLook(model, look({ skin: 'medium-brown', outfit: 'sunny' }));

    expect(meshColor(model, 'player_head')).toBe('#9c6644');
    expect(meshColor(model, 'player_hand_L')).toBe('#9c6644');
    expect(meshColor(model, 'player_nose')).toBe('#b47d58');
    expect(meshColor(model, 'player_hoodie')).toBe('#ffcf3f');
    expect(meshColor(model, 'player_leg_L')).toBe('#4f86e0');
    expect(meshColor(model, 'player_backpack')).toBe('#ef5b4c');
    // The scarf wears the beanie's colors and the skirt the hood's.
    expect(meshColor(model, 'player_scarf_hood')).toBe('#ef5b4c');
    expect(meshColor(model, 'player_scarf_band')).toBe('#c23e33');
    expect(meshColor(model, 'player_skirt')).toBe('#dba21c');
    // Hair, soles, and the rest stay as authored.
    expect(meshColor(model, 'player_hair_back')).toBe('#4d352c');
  });

  it('can be applied again with a different look', async () => {
    const model = await loadPlayerModel();
    applyPlayerLook(model, look({ skin: 'very-light', outfit: 'berry', headwear: 'scarf' }));
    applyPlayerLook(model, look({ skin: 'medium-brown', outfit: 'forest', headwear: 'beanie' }));

    expect(meshColor(model, 'player_head')).toBe('#9c6644');
    expect(meshColor(model, 'player_hoodie')).toBe('#5bbf6a');
    expect(shownParts(model, 'player_scarf_')).toEqual([]);
    expect(shownParts(model, 'player_hair_')).toEqual(['player_hair_back', 'player_hair_boy_fringe']);
  });

  it('gives medium brown skin glossy dark eyes and restores the authored face after', async () => {
    const model = await loadPlayerModel();
    const eyes = meshMaterial(model, 'player_eye_L');
    const authored = { color: eyes.color.getHexString(), roughness: eyes.roughness };

    applyPlayerLook(model, look({ skin: 'medium-brown' }));
    expect(eyes.roughness).toBeLessThan(0.5);
    expect(eyes.color.getHexString()).not.toBe(authored.color);

    applyPlayerLook(model, DEFAULT_PLAYER_LOOK);
    expect(eyes.roughness).toBeCloseTo(authored.roughness, 5);
    expect(eyes.color.getHexString()).toBe(authored.color);
  });

  it('shows exactly one hair, bottoms, and headwear set for every combination', async () => {
    const model = await loadPlayerModel();
    for (const gender of ['boy', 'girl']) {
      for (const bottoms of ['trousers', 'skirt']) {
        for (const headwear of ['beanie', 'scarf']) {
          const combination = `${gender} ${bottoms} ${headwear}`;
          applyPlayerLook(model, look({ gender, bottoms, headwear }));

          // The scarf is a full head covering: no hair shows under it.
          const hair = shownParts(model, 'player_hair_');
          if (headwear === 'scarf') {
            expect(hair, combination).toEqual([]);
          } else {
            expect(hair, combination).toContain('player_hair_back');
            expect(hair.some((name) => name.startsWith(`player_hair_${gender}_`)), combination).toBe(true);
            const other = gender === 'boy' ? 'girl' : 'boy';
            expect(hair.some((name) => name.startsWith(`player_hair_${other}_`)), combination).toBe(false);
          }
          expect(shownParts(model, 'player_beanie_').length > 0, combination).toBe(headwear === 'beanie');
          expect(shownParts(model, 'player_scarf_').length > 0, combination).toBe(headwear === 'scarf');
          expect(shownParts(model, 'player_skirt').length > 0, combination).toBe(bottoms === 'skirt');
          // One shared body: legs, head, and hoodie are there in every combination.
          for (const part of ['player_leg_L', 'player_leg_R', 'player_head', 'player_hoodie']) {
            expect(shownParts(model, part), `${combination} ${part}`).toContain(part);
          }
        }
      }
    }
  });

  it('applies the same choices to the procedural stand-in shown before or instead of the GLB', () => {
    const fallback = new Group().add(createPlayerFallback());
    // Every part set has a stand-in; the parts a choice hides need not.
    for (const prefix of partPrefixes('nodes')) {
      let found = false;
      fallback.traverse((child) => {
        found ||= child.name.startsWith(prefix);
      });
      expect(found, prefix).toBe(true);
    }

    applyPlayerLook(fallback, look({ gender: 'girl', bottoms: 'skirt', headwear: 'scarf', outfit: 'rocket' }));
    expect(shownParts(fallback, 'player_scarf_')).toEqual(['player_scarf_fallback']);
    expect(shownParts(fallback, 'player_beanie_')).toEqual([]);
    expect(shownParts(fallback, 'player_hair_')).toEqual([]);
    expect(shownParts(fallback, 'player_skirt')).toEqual(['player_skirt_fallback']);
    expect(meshColor(fallback, 'player_scarf_fallback')).toBe('#9ad0f5');

    applyPlayerLook(fallback, look({ gender: 'girl', headwear: 'beanie' }));
    expect(shownParts(fallback, 'player_hair_')).toEqual(['player_hair_girl_fallback_L', 'player_hair_girl_fallback_R']);
  });
});

describe('saved look', () => {
  it('round-trips through storage', () => {
    const storage = memoryStorage();
    const chosen = look({ gender: 'girl', skin: 'light', outfit: 'bubblegum', bottoms: 'skirt', headwear: 'scarf' });
    savePlayerLook(chosen, storage);
    expect(loadPlayerLook(storage)).toEqual(chosen);
  });

  it('keeps known choices and defaults unknown or missing ones', () => {
    expect(normalizePlayerLook({ skin: 'light-medium', outfit: 'retired-outfit' })).toEqual(
      look({ skin: 'light-medium' }),
    );
    expect(normalizePlayerLook('light-medium')).toEqual(DEFAULT_PLAYER_LOOK);
  });

  it('still loads a look saved before the shape choices and skin trim existed', () => {
    const older = memoryStorage({
      'camo-mode-2.player-look': JSON.stringify({ skin: 'tone-6', outfit: 'rocket' }),
    });
    expect(loadPlayerLook(older)).toEqual(look({ outfit: 'rocket' }));
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
