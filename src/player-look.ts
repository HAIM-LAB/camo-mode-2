import { Color, Mesh, MeshStandardMaterial, Object3D } from 'three';

/**
 * Player customization. The approved player (`build_player()` in
 * blender/cast/generate_cast.py) is one model whose parts share a small set of
 * named materials, and each look axis repaints some of them. The menu preview
 * and the in-game player both go through applyPlayerLook, so they cannot drift.
 *
 * A new axis is one more entry in LOOK_AXES: the menu renders it, storage
 * keeps it, and applyPlayerLook applies it.
 */

/** Materials authored in build_player() and exported into player.glb by name. */
export const PLAYER_MATERIALS = Object.freeze({
  skin: 'Player Skin',
  skinLight: 'Player Skin Light',
  hoodie: 'Player Teal',
  hoodieDark: 'Player Teal Dark',
  trousers: 'Player Coral',
  pack: 'Player Gold',
  packDark: 'Player Gold Dark',
  eyes: 'Ink',
  mouth: 'Smile',
});

export type PlayerMaterialRole = keyof typeof PLAYER_MATERIALS;

/** An sRGB hex color, or a color with the surface roughness to go with it. */
export type LookSurface = string | { readonly color: string; readonly roughness: number };

/** Surfaces keyed by the material role they repaint. */
export type LookPaint = Readonly<Partial<Record<PlayerMaterialRole, LookSurface>>>;

export function surfaceColor(surface: LookSurface): string {
  return typeof surface === 'string' ? surface : surface.color;
}

export interface LookOption {
  readonly id: string;
  readonly label: string;
  readonly paint: LookPaint;
}

export interface LookAxis {
  readonly id: string;
  readonly label: string;
  /** A round color swatch with a spoken label, or a card that shows its name. */
  readonly display: 'swatch' | 'card';
  /** The roles whose colors the menu shows for each option. */
  readonly swatchRoles: readonly PlayerMaterialRole[];
  readonly defaultOption: string;
  readonly options: readonly LookOption[];
}

/** WCAG relative luminance; Color keeps its components in linear sRGB. */
function luminance(hex: string): number {
  const color = new Color(hex);
  return 0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b;
}

export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// The face is drawn in dark ink on every tone: features stay darker than the
// skin, never lighter, so a deep tone does not get pale lips or eye rings.
const AUTHORED_EYES = { color: '#353c48', roughness: 0.9 };
const AUTHORED_MOUTH = { color: '#84423c', roughness: 0.95 };
// Where the authored ink would sink into the skin, it deepens toward black and
// the eyes turn glossy, so a catchlight keeps them reading as eyes.
const DEEP_EYES = { color: '#060709', roughness: 0.28 };
const MIN_EYE_CONTRAST = 3;
const MIN_MOUTH_CONTRAST = 2;
const DEEP_MOUTH_SHADE = 0.1; // fraction of the skin's linear color
const DEEP_MOUTH_ROUGHNESS = 0.4;

function readableOn(skin: string, feature: string, minimum: number): boolean {
  return luminance(feature) < luminance(skin) && contrastRatio(skin, feature) >= minimum;
}

/** Eye and mouth surfaces that stay readable on the given skin color. */
export function facialFeatures(skin: string): LookPaint {
  return {
    eyes: readableOn(skin, AUTHORED_EYES.color, MIN_EYE_CONTRAST) ? AUTHORED_EYES : DEEP_EYES,
    mouth: readableOn(skin, AUTHORED_MOUTH.color, MIN_MOUTH_CONTRAST)
      ? AUTHORED_MOUTH
      : {
          color: `#${new Color(skin).multiplyScalar(DEEP_MOUTH_SHADE).getHexString()}`,
          roughness: DEEP_MOUTH_ROUGHNESS,
        },
  };
}

function skinTone(id: string, label: string, skin: string, skinLight: string): LookOption {
  return { id, label, paint: { skin, skinLight, ...facialFeatures(skin) } };
}

const SKIN_TONES: readonly LookOption[] = [
  skinTone('tone-1', 'Very light skin', '#efc3a2', '#f6d2b8'),
  skinTone('tone-2', 'Light skin', '#ddb58b', '#eccaa2'),
  // The authored player.glb skin.
  skinTone('tone-3', 'Medium skin', '#b88561', '#ce9e76'),
  skinTone('tone-4', 'Medium deep skin', '#9c6644', '#b47d58'),
  skinTone('tone-5', 'Deep skin', '#845238', '#9e694b'),
  skinTone('tone-6', 'Very deep skin', '#5c3a28', '#744a34'),
];

const OUTFITS: readonly LookOption[] = [
  {
    // The authored player.glb hoodie, trousers, and backpack.
    id: 'ocean',
    label: 'Ocean',
    paint: { hoodie: '#2ca8af', hoodieDark: '#248590', trousers: '#ea7373', pack: '#ffc73c', packDark: '#dd9521' },
  },
  {
    id: 'sunny',
    label: 'Sunny',
    paint: { hoodie: '#ffcf3f', hoodieDark: '#dba21c', trousers: '#4f86e0', pack: '#ef5b4c', packDark: '#c23e33' },
  },
  {
    id: 'forest',
    label: 'Forest',
    paint: { hoodie: '#5bbf6a', hoodieDark: '#3c8f4b', trousers: '#3d5a80', pack: '#f29e4c', packDark: '#c97628' },
  },
  {
    id: 'berry',
    label: 'Berry',
    paint: { hoodie: '#c4508f', hoodieDark: '#963a6c', trousers: '#5b6fd6', pack: '#ffd166', packDark: '#e0a93a' },
  },
  {
    id: 'rocket',
    label: 'Rocket',
    paint: { hoodie: '#e8524a', hoodieDark: '#b63a34', trousers: '#2f3e66', pack: '#9ad0f5', packDark: '#5fa6d6' },
  },
  {
    id: 'bubblegum',
    label: 'Bubblegum',
    paint: { hoodie: '#ff9ec7', hoodieDark: '#e077a4', trousers: '#7a6ae0', pack: '#7fe0d0', packDark: '#4fb8a8' },
  },
];

export const LOOK_AXES = [
  {
    id: 'skin',
    label: 'Skin',
    display: 'swatch',
    swatchRoles: ['skin'],
    defaultOption: 'tone-3',
    options: SKIN_TONES,
  },
  {
    id: 'outfit',
    label: 'Clothes',
    display: 'card',
    swatchRoles: ['hoodie', 'trousers', 'pack'],
    defaultOption: 'ocean',
    options: OUTFITS,
  },
] as const satisfies readonly LookAxis[];

export type LookAxisId = (typeof LOOK_AXES)[number]['id'];

/** One chosen option id per axis. */
export type PlayerLook = Readonly<Record<LookAxisId, string>>;

export const DEFAULT_PLAYER_LOOK: PlayerLook = Object.freeze(
  Object.fromEntries(LOOK_AXES.map((axis) => [axis.id, axis.defaultOption])) as PlayerLook,
);

export function lookOption(axis: LookAxis, id: string): LookOption {
  const option = axis.options.find((item) => item.id === id)
    ?? axis.options.find((item) => item.id === axis.defaultOption);
  if (!option) throw new Error(`Look axis ${axis.id} has no default option`);
  return option;
}

/** Keeps known choices and falls back to each axis default for anything else. */
export function normalizePlayerLook(value: unknown): PlayerLook {
  const source = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
  return Object.fromEntries(
    LOOK_AXES.map((axis: LookAxis) => {
      const chosen = source[axis.id];
      const known = axis.options.some((option) => option.id === chosen);
      return [axis.id, known ? chosen : axis.defaultOption];
    }),
  ) as PlayerLook;
}

/**
 * Repaints a player model in place. It matches materials by their authored
 * name rather than their current color, so it can be applied repeatedly.
 */
export function applyPlayerLook(root: Object3D, look: PlayerLook): void {
  const surfaces = new Map<string, LookSurface>();
  for (const axis of LOOK_AXES as readonly LookAxis[]) {
    const option = lookOption(axis, look[axis.id as LookAxisId]);
    for (const [role, surface] of Object.entries(option.paint)) {
      surfaces.set(PLAYER_MATERIALS[role as PlayerMaterialRole], surface);
    }
  }

  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const materials = Array.isArray(child.material) ? child.material : [child.material];
    for (const material of materials) {
      const surface = surfaces.get(material.name);
      if (!surface || !(material instanceof MeshStandardMaterial)) continue;
      material.color.set(surfaceColor(surface));
      if (typeof surface !== 'string') material.roughness = surface.roughness;
    }
  });
}

const STORAGE_KEY = 'camo-mode-2.player-look';

type LookStorage = Pick<Storage, 'getItem' | 'setItem'>;

function browserStorage(): LookStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some privacy modes throw on access rather than returning null.
    return null;
  }
}

export function loadPlayerLook(storage: LookStorage | null = browserStorage()): PlayerLook {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    return normalizePlayerLook(saved ? JSON.parse(saved) : undefined);
  } catch {
    return DEFAULT_PLAYER_LOOK;
  }
}

export function savePlayerLook(look: PlayerLook, storage: LookStorage | null = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, JSON.stringify(look));
  } catch {
    // Storage can be full or blocked; the look still applies for this visit.
  }
}
