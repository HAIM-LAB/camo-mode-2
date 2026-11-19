import { describe, expect, it } from 'vitest';
import { Box3, Color, Group, Mesh, MeshStandardMaterial, Object3D, Raycaster, SkinnedMesh, Vector3 } from 'three';
import {
  DEFAULT_PLAYER_LOOK,
  LOOK_AXES,
  LookAxis,
  PLAYER_MATERIALS,
  PLAYER_STYLES,
  PlayerLook,
  PlayerMaterialRole,
  PlayerStyleId,
  applyPlayerLook,
  contrastRatio,
  loadPlayerLook,
  normalizePlayerLook,
  savePlayerLook,
  surfaceColor,
} from '../src/player-look';
import { createPlayerFallback } from '../src/procedural';
import { loadPlayerModel, materialsByName, meshNames, shownParts } from './helpers/player-model';
import { blockedStorage, memoryStorage } from './helpers/storage';

const AXES = LOOK_AXES as readonly LookAxis[];
const STYLES = PLAYER_STYLES.map((style) => style.id);

/** Name prefixes of parts that are on screen in every look, per style. */
const ALWAYS_SHOWN: Readonly<Record<PlayerStyleId, readonly string[]>> = {
  cartoon: ['player_head', 'player_tunic', 'player_shoe_L', 'player_shoe_R'],
  realistic: ['player_body', 'player_top', 'player_shoes'],
};

function look(choices: Partial<PlayerLook>): PlayerLook {
  return { ...DEFAULT_PLAYER_LOOK, ...choices };
}

function meshMaterial(root: Object3D, name: string): MeshStandardMaterial {
  const mesh = root.getObjectByName(name);
  if (!(mesh instanceof Mesh)) throw new Error(`No mesh named ${name}`);
  return mesh.material as MeshStandardMaterial;
}

function meshColor(root: Object3D, name: string): string {
  return `#${meshMaterial(root, name).color.getHexString()}`;
}

function materialColor(root: Object3D, role: PlayerMaterialRole): string {
  const material = materialsByName(root).get(PLAYER_MATERIALS[role]);
  if (!material) throw new Error(`No material for ${role}`);
  return `#${material.color.getHexString()}`;
}

function partPrefixes(kind: 'nodes' | 'hides'): string[] {
  return AXES.flatMap((axis) => axis.options.flatMap((option) => option[kind] ?? []));
}

/** Every option that shows a part set, with a label for failure messages. */
function partSets(): { label: string; nodes: readonly string[] }[] {
  return AXES.flatMap((axis) =>
    axis.options.flatMap((option) => (option.nodes ? [{ label: `${axis.id} ${option.id}`, nodes: option.nodes }] : [])),
  );
}

/** The middle of the meshes on screen whose names start with a prefix. */
function middleOfShown(root: Object3D, prefix: string): Vector3 {
  const bounds = new Box3();
  root.updateWorldMatrix(true, true);
  root.traverseVisible((child) => {
    if (!(child instanceof Mesh) || !child.name.startsWith(prefix)) return;
    child.geometry.computeBoundingBox();
    if (child.geometry.boundingBox) bounds.union(child.geometry.boundingBox.clone().applyMatrix4(child.matrixWorld));
  });
  return bounds.getCenter(new Vector3());
}

// Straight down, and tilted 40 degrees to the front, back, left, and right:
// about how steeply the playroom's camera looks down on the player.
const TILT = (40 * Math.PI) / 180;
const FROM_ABOVE: readonly Vector3[] = [
  new Vector3(0, 1, 0),
  ...[[0, 1], [0, -1], [1, 0], [-1, 0]].map(
    ([x, z]) => new Vector3(x * Math.sin(TILT), Math.cos(TILT), z * Math.sin(TILT)),
  ),
];

/** The name of the first mesh on screen that each look down at a point meets. */
function seenFromAbove(root: Object3D, target: Vector3): string[] {
  root.updateMatrixWorld(true);
  const shown: Mesh[] = [];
  root.traverseVisible((child) => {
    if (child instanceof SkinnedMesh) child.skeleton.update();
    if (child instanceof Mesh) shown.push(child);
  });
  const raycaster = new Raycaster();
  return FROM_ABOVE.map((toward) => {
    raycaster.set(target.clone().addScaledVector(toward, 3), toward.clone().negate());
    return raycaster.intersectObjects(shown, false)[0]?.object.name ?? 'nothing';
  });
}

describe('player look catalog', () => {
  it('names only materials and parts that the player models actually have', async () => {
    const models = await Promise.all(STYLES.map(loadPlayerModel));
    const materials = models.map((model) => materialsByName(model));
    const parts = models.map(meshNames);

    // Each role is on at least one model, and the ones every outfit shows are on both.
    for (const [role, name] of Object.entries(PLAYER_MATERIALS)) {
      expect(materials.some((authored) => authored.has(name)), role).toBe(true);
    }
    for (const role of ['skin', 'hoodie', 'trousers', 'leggings', 'pack', 'packDark', 'shoes', 'skirt', 'scarf'] as const) {
      for (const [index, authored] of materials.entries()) {
        expect(authored.has(PLAYER_MATERIALS[role]), `${STYLES[index]} ${role}`).toBe(true);
      }
    }

    // Every choice shows a part set on both models. A name it shows or hides
    // may be on only one of them, but is on one.
    for (const { label, nodes } of partSets()) {
      for (const [index, names] of parts.entries()) {
        expect(
          nodes.some((prefix) => names.some((name) => name.startsWith(prefix))),
          `${STYLES[index]} ${label}`,
        ).toBe(true);
      }
    }
    for (const prefix of [...partPrefixes('nodes'), ...partPrefixes('hides')]) {
      expect(parts.some((names) => names.some((name) => name.startsWith(prefix))), prefix).toBe(true);
    }
  });

  it.each(STYLES)('defaults to the %s model\'s authored colors and its Boy, trousers, and beanie parts', async (style) => {
    const model = await loadPlayerModel(style);
    const authored = new Map(
      [...materialsByName(model)].map(([name, material]) => [
        name,
        { color: material.color.clone(), roughness: material.roughness },
      ]),
    );

    applyPlayerLook(model, look({ style }));

    for (const [name, material] of materialsByName(model)) {
      const before = authored.get(name) as { color: Color; roughness: number };
      // Hex authoring rounds each sRGB channel to 1/255.
      expect(material.color.r, name).toBeCloseTo(before.color.r, 2);
      expect(material.color.g, name).toBeCloseTo(before.color.g, 2);
      expect(material.color.b, name).toBeCloseTo(before.color.b, 2);
      expect(material.roughness, name).toBeCloseTo(before.roughness, 5);
    }
    expect(shownParts(model, 'player_hair_boy_').length).toBeGreaterThan(0);
    expect(shownParts(model, 'player_hair_girl_')).toEqual([]);
    expect(shownParts(model, 'player_trousers').length).toBeGreaterThan(0);
    expect(shownParts(model, 'player_skirt')).toEqual([]);
    expect(shownParts(model, 'player_beanie_').length).toBeGreaterThan(0);
    expect(shownParts(model, 'player_scarf_')).toEqual([]);
    expect(shownParts(model, 'player_bare_')).toEqual([]);
  });

  it('offers a beanie, a head scarf, or nothing on the head, and starts with the beanie', () => {
    const headwear = AXES.find((axis) => axis.id === 'headwear');
    expect(headwear?.options.map((option) => option.id)).toEqual(['beanie', 'scarf', 'none']);
    expect(DEFAULT_PLAYER_LOOK.headwear).toBe('beanie');
  });

  it('gives every axis a valid default and unique option ids', () => {
    for (const axis of AXES) {
      const ids = axis.options.map((option) => option.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain(axis.defaultOption);
    }
  });

  it('offers exactly the cartoon and realistic styles, cartoon first', () => {
    expect(STYLES).toEqual(['cartoon', 'realistic']);
    expect(DEFAULT_PLAYER_LOOK.style).toBe('cartoon');
    for (const style of PLAYER_STYLES) {
      expect(style.label).not.toBe('');
      expect(style.blurb).not.toBe('');
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
  it('repaints the skin and outfit parts of the cartoon model and nothing else', async () => {
    const model = await loadPlayerModel('cartoon');

    applyPlayerLook(model, look({ skin: 'medium-brown', outfit: 'sunny' }));

    expect(meshColor(model, 'player_head')).toBe('#9c6644');
    expect(meshColor(model, 'player_hand_L')).toBe('#9c6644');
    expect(meshColor(model, 'player_nose')).toBe('#b47d58');
    expect(meshColor(model, 'player_cheek_L')).toBe('#b65c4b');
    expect(meshColor(model, 'player_tunic')).toBe('#ffcf3f');
    expect(meshColor(model, 'player_tunic_collar')).toBe('#dba21c');
    expect(meshColor(model, 'player_trousers_L')).toBe('#4f86e0');
    expect(meshColor(model, 'player_backpack')).toBe('#ef5b4c');
    expect(meshColor(model, 'player_beanie_band')).toBe('#c23e33');
    // The scarf and shoes wear the beanie's colors, the skirt the tunic's trim,
    // and the leggings the trousers'.
    expect(meshColor(model, 'player_scarf_hood')).toBe('#ef5b4c');
    expect(meshColor(model, 'player_scarf_band')).toBe('#c23e33');
    expect(meshColor(model, 'player_shoe_L')).toBe('#ef5b4c');
    expect(meshColor(model, 'player_skirt')).toBe('#dba21c');
    expect(meshColor(model, 'player_skirt_leg_L')).toBe('#4f86e0');
    // Hair, soles, and the rest stay as authored.
    expect(meshColor(model, 'player_hair_back')).toBe('#4d352c');
  });

  it('repaints the realistic model through its textures and leaves its hair and socks alone', async () => {
    const model = await loadPlayerModel('realistic');
    const untouched = ['Player Hair Boy', 'Player Hair Girl', 'Player Eyes', 'Player Sock', 'Player Sole'];
    const before = untouched.map((name) => materialsByName(model).get(name)?.color.getHexString());

    applyPlayerLook(model, look({ style: 'realistic', skin: 'medium-brown', outfit: 'sunny' }));

    // The skin, top, and trousers carry a detail texture; the color multiplies it.
    for (const role of ['skin', 'hoodie', 'trousers'] as const) {
      expect(materialsByName(model).get(PLAYER_MATERIALS[role])?.map, role).not.toBeNull();
    }
    expect(materialColor(model, 'skin')).toBe('#9c6644');
    expect(materialColor(model, 'hoodie')).toBe('#ffcf3f');
    expect(materialColor(model, 'trousers')).toBe('#4f86e0');
    expect(materialColor(model, 'leggings')).toBe('#4f86e0');
    expect(materialColor(model, 'pack')).toBe('#ef5b4c');
    expect(materialColor(model, 'packDark')).toBe('#c23e33');
    expect(materialColor(model, 'shoes')).toBe('#ef5b4c');
    expect(materialColor(model, 'scarf')).toBe('#ef5b4c');
    expect(materialColor(model, 'skirt')).toBe('#dba21c');
    expect(untouched.map((name) => materialsByName(model).get(name)?.color.getHexString())).toEqual(before);
  });

  it.each(STYLES)('can be applied to the %s model again with a different look', async (style) => {
    const model = await loadPlayerModel(style);
    applyPlayerLook(model, look({ style, skin: 'very-light', outfit: 'berry', headwear: 'scarf', bottoms: 'skirt' }));
    applyPlayerLook(model, look({ style, skin: 'medium-brown', outfit: 'forest' }));

    expect(materialColor(model, 'skin')).toBe('#9c6644');
    expect(materialColor(model, 'hoodie')).toBe('#5bbf6a');
    expect(shownParts(model, 'player_scarf_')).toEqual([]);
    expect(shownParts(model, 'player_skirt')).toEqual([]);
    expect(shownParts(model, 'player_hair_boy_').length).toBeGreaterThan(0);
  });

  it('gives medium brown skin glossy dark eyes and restores the authored face after', async () => {
    const model = await loadPlayerModel('cartoon');
    const eyes = meshMaterial(model, 'player_eye_L');
    const authored = { color: eyes.color.getHexString(), roughness: eyes.roughness };

    applyPlayerLook(model, look({ skin: 'medium-brown' }));
    expect(eyes.roughness).toBeLessThan(0.5);
    expect(eyes.color.getHexString()).not.toBe(authored.color);

    applyPlayerLook(model, DEFAULT_PLAYER_LOOK);
    expect(eyes.roughness).toBeCloseTo(authored.roughness, 5);
    expect(eyes.color.getHexString()).toBe(authored.color);
  });

  it.each(STYLES)('shows exactly one hair, bottoms, and headwear set for every %s combination', async (style) => {
    const model = await loadPlayerModel(style);
    const hasEars = shownParts(model, 'player_ear_').length > 0;
    for (const gender of ['boy', 'girl']) {
      for (const bottoms of ['trousers', 'skirt']) {
        for (const headwear of ['beanie', 'scarf', 'none']) {
          const combination = `${gender} ${bottoms} ${headwear}`;
          const other = gender === 'boy' ? 'girl' : 'boy';
          applyPlayerLook(model, look({ style, gender, bottoms, headwear }));

          // The scarf is a full head covering: no hair or ear shows under it.
          const hair = shownParts(model, 'player_hair_');
          if (headwear === 'scarf') {
            expect(hair, combination).toEqual([]);
            expect(shownParts(model, 'player_ear_'), combination).toEqual([]);
          } else {
            expect(hair.some((name) => name.startsWith(`player_hair_${gender}_`)), combination).toBe(true);
            expect(hair.some((name) => name.startsWith(`player_hair_${other}_`)), combination).toBe(false);
            expect(shownParts(model, 'player_ear_').length > 0, combination).toBe(hasEars);
          }
          // The hair a hat covers shows only on a bare head, and only the chosen hairstyle's.
          const bare = shownParts(model, 'player_bare_');
          expect(bare.length > 0, combination).toBe(headwear === 'none');
          expect(bare.some((name) => name.startsWith(`player_bare_hair_${other}_`)), combination).toBe(false);
          expect(shownParts(model, 'player_beanie_').length > 0, combination).toBe(headwear === 'beanie');
          expect(shownParts(model, 'player_scarf_').length > 0, combination).toBe(headwear === 'scarf');
          // The legs are covered either way: by trousers, or by the skirt and its leggings.
          expect(shownParts(model, 'player_trousers').length > 0, combination).toBe(bottoms === 'trousers');
          expect(shownParts(model, 'player_skirt').length >= 2, combination).toBe(bottoms === 'skirt');
          for (const part of ALWAYS_SHOWN[style]) {
            expect(shownParts(model, part).length, `${combination} ${part}`).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it.each(STYLES)('shows hair rather than scalp on the %s model\'s bare head from above', async (style) => {
    const model = await loadPlayerModel(style);
    for (const gender of ['boy', 'girl']) {
      applyPlayerLook(model, look({ style, gender, headwear: 'none' }));
      // The hair a hat would cover sits around the top of the head.
      const head = middleOfShown(model, 'player_bare_');
      for (const seen of seenFromAbove(model, head)) {
        expect(seen, `${gender} bare head`).toMatch(/^player_(bare_)?hair_/);
      }

      // The beanie covers that hair, and none of it comes through the knit.
      applyPlayerLook(model, look({ style, gender, headwear: 'beanie' }));
      for (const seen of seenFromAbove(model, head)) {
        expect(seen, `${gender} in the beanie`).toMatch(/^player_beanie_/);
      }
    }
  });

  it('applies the same choices to the procedural stand-in shown before or instead of the GLB', () => {
    const fallback = new Group().add(createPlayerFallback());
    // Every part set has a stand-in; the parts a choice hides need not.
    for (const { label, nodes } of partSets()) {
      let found = false;
      fallback.traverse((child) => {
        found ||= nodes.some((prefix) => child.name.startsWith(prefix));
      });
      expect(found, label).toBe(true);
    }

    applyPlayerLook(fallback, look({ gender: 'girl', bottoms: 'skirt', headwear: 'scarf', outfit: 'rocket' }));
    expect(shownParts(fallback, 'player_scarf_')).toEqual(['player_scarf_fallback']);
    expect(shownParts(fallback, 'player_beanie_')).toEqual([]);
    expect(shownParts(fallback, 'player_hair_')).toEqual([]);
    expect(shownParts(fallback, 'player_skirt')).toEqual(['player_skirt_fallback']);
    expect(shownParts(fallback, 'player_trousers')).toEqual([]);
    expect(meshColor(fallback, 'player_scarf_fallback')).toBe('#9ad0f5');

    applyPlayerLook(fallback, look({ style: 'realistic', gender: 'girl', headwear: 'beanie' }));
    expect(shownParts(fallback, 'player_hair_')).toEqual(['player_hair_girl_fallback_L', 'player_hair_girl_fallback_R']);
    expect(shownParts(fallback, 'player_bare_')).toEqual([]);
    expect(shownParts(fallback, 'player_trousers')).toEqual(['player_trousers_fallback']);

    applyPlayerLook(fallback, look({ gender: 'boy', headwear: 'none' }));
    expect(shownParts(fallback, 'player_bare_')).toEqual(['player_bare_hair_fallback']);
    expect(shownParts(fallback, 'player_hair_')).toEqual(['player_hair_boy_fallback']);
    expect(shownParts(fallback, 'player_beanie_')).toEqual([]);
    expect(shownParts(fallback, 'player_scarf_')).toEqual([]);
  });
});

describe('saved look', () => {
  it('round-trips through storage, style included', () => {
    const storage = memoryStorage();
    const chosen = look({
      style: 'realistic',
      gender: 'girl',
      skin: 'light',
      outfit: 'bubblegum',
      bottoms: 'skirt',
      headwear: 'scarf',
    });
    savePlayerLook(chosen, storage);
    expect(loadPlayerLook(storage)).toEqual(chosen);
  });

  it('round-trips a bare head through storage', () => {
    const storage = memoryStorage();
    const chosen = look({ style: 'realistic', gender: 'girl', headwear: 'none' });
    savePlayerLook(chosen, storage);
    expect(loadPlayerLook(storage)).toEqual(chosen);
  });

  it.each(['beanie', 'scarf'])('keeps the %s of a look saved before a bare head could be chosen', (headwear) => {
    const saved = { style: 'realistic', gender: 'boy', skin: 'light', outfit: 'forest', bottoms: 'trousers', headwear };
    const older = memoryStorage({ 'camo-mode-2.player-look': JSON.stringify(saved) });
    expect(loadPlayerLook(older)).toEqual(saved);
  });

  it('keeps known choices and defaults unknown or missing ones', () => {
    expect(normalizePlayerLook({ skin: 'light-medium', outfit: 'retired-outfit' })).toEqual(
      look({ skin: 'light-medium' }),
    );
    expect(normalizePlayerLook({ style: 'clay', skin: 'light' })).toEqual(look({ skin: 'light' }));
    expect(normalizePlayerLook('light-medium')).toEqual(DEFAULT_PLAYER_LOOK);
  });

  it('loads a look saved before styles existed as the cartoon player with every choice kept', () => {
    const saved = { gender: 'girl', skin: 'light', outfit: 'berry', bottoms: 'skirt', headwear: 'scarf' };
    const older = memoryStorage({ 'camo-mode-2.player-look': JSON.stringify(saved) });
    expect(loadPlayerLook(older)).toEqual({ style: 'cartoon', ...saved });
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
    expect(loadPlayerLook(blockedStorage())).toEqual(DEFAULT_PLAYER_LOOK);
    expect(() => savePlayerLook(DEFAULT_PLAYER_LOOK, blockedStorage())).not.toThrow();
  });
});
