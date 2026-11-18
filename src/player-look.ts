import { Color, Mesh, MeshStandardMaterial, Object3D } from 'three';

/**
 * Player customization. The child first picks a style, which picks the model:
 * the cartoon player (`build_player()` in blender/cast/generate_cast.py) or the
 * realistic one (blender/cast/generate_realistic_player.py). Both models name
 * their materials and their alternative part sets (hair, bottoms, headwear) the
 * same way, so one catalog of look axes drives either: each axis repaints
 * materials by name and shows one part set per choice. The menu preview and the
 * in-game player both go through applyPlayerLook, so they cannot drift.
 *
 * A new axis is one more entry in LOOK_AXES: the menu renders it, storage
 * keeps it, and applyPlayerLook applies it. Both models express every axis.
 */

/** Materials the player models carry by name. A model need not use every one. */
export const PLAYER_MATERIALS = Object.freeze({
  skin: 'Player Skin',
  skinLight: 'Player Skin Light',
  blush: 'Player Blush',
  hoodie: 'Player Teal',
  hoodieDark: 'Player Teal Dark',
  trousers: 'Player Coral',
  leggings: 'Player Leggings',
  pack: 'Player Gold',
  packDark: 'Player Gold Dark',
  shoes: 'Player Shoes',
  scarf: 'Player Scarf',
  scarfDark: 'Player Scarf Dark',
  skirt: 'Player Skirt',
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
  readonly paint?: LookPaint;
  /** Name prefixes of the model parts this option shows; its axis hides the rest of its parts. */
  readonly nodes?: readonly string[];
  /** Name prefixes this option hides whatever other axes chose, for parts it would clip. */
  readonly hides?: readonly string[];
  /** Picture the menu draws for an icon axis. */
  readonly icon?: string;
}

export interface LookAxis {
  readonly id: string;
  readonly label: string;
  /** A round color swatch with a spoken label, or a named card showing colors or a picture. */
  readonly display: 'swatch' | 'card' | 'icon';
  /** The roles whose colors the menu shows for each option of a swatch or card axis. */
  readonly swatchRoles?: readonly PlayerMaterialRole[];
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

function skinTone(id: string, label: string, skin: string, skinLight: string, blush: string): LookOption {
  return { id, label, paint: { skin, skinLight, blush, ...facialFeatures(skin) } };
}

// Each tone with its highlight and the warmer cheek color that reads as a blush on it.
const SKIN_TONES: readonly LookOption[] = [
  skinTone('very-light', 'Very light skin', '#efc3a2', '#f6d2b8', '#f0a094'),
  skinTone('light', 'Light skin', '#ddb58b', '#eccaa2', '#e69682'),
  skinTone('light-medium', 'Light medium skin', '#cb9c74', '#ddb48c', '#da8470'),
  // The skin both player models are authored in.
  skinTone('medium', 'Medium skin', '#b88561', '#ce9e76', '#cc7461'),
  skinTone('medium-brown', 'Medium brown skin', '#9c6644', '#b47d58', '#b65c4b'),
];

interface OutfitColors {
  hoodie: string;
  hoodieDark: string;
  trousers: string;
  pack: string;
  packDark: string;
}

// The head scarf and shoes wear the beanie's colors, the skirt the top's trim,
// and the leggings under the skirt the trousers', so every shape choice belongs
// to the chosen outfit.
function outfit(id: string, label: string, colors: OutfitColors): LookOption {
  return {
    id,
    label,
    paint: {
      ...colors,
      scarf: colors.pack,
      scarfDark: colors.packDark,
      shoes: colors.pack,
      skirt: colors.hoodieDark,
      leggings: colors.trousers,
    },
  };
}

const OUTFITS: readonly LookOption[] = [
  // The top, trousers, and accent both player models are authored in.
  outfit('ocean', 'Ocean', { hoodie: '#2ca8af', hoodieDark: '#248590', trousers: '#ea7373', pack: '#ffc73c', packDark: '#dd9521' }),
  outfit('sunny', 'Sunny', { hoodie: '#ffcf3f', hoodieDark: '#dba21c', trousers: '#4f86e0', pack: '#ef5b4c', packDark: '#c23e33' }),
  outfit('forest', 'Forest', { hoodie: '#5bbf6a', hoodieDark: '#3c8f4b', trousers: '#3d5a80', pack: '#f29e4c', packDark: '#c97628' }),
  outfit('berry', 'Berry', { hoodie: '#c4508f', hoodieDark: '#963a6c', trousers: '#5b6fd6', pack: '#ffd166', packDark: '#e0a93a' }),
  outfit('rocket', 'Rocket', { hoodie: '#e8524a', hoodieDark: '#b63a34', trousers: '#2f3e66', pack: '#9ad0f5', packDark: '#5fa6d6' }),
  outfit('bubblegum', 'Bubblegum', { hoodie: '#ff9ec7', hoodieDark: '#e077a4', trousers: '#7a6ae0', pack: '#7fe0d0', packDark: '#4fb8a8' }),
];

// Boy and Girl share one child body; only the hair differs. A model whose
// hairstyles differ over the top of the head, where only a bare head shows
// them, names those parts player_bare_hair_boy_ and player_bare_hair_girl_.
const GENDERS: readonly LookOption[] = [
  { id: 'boy', label: 'Boy', icon: 'boy', nodes: ['player_hair_boy_', 'player_bare_hair_boy_'] },
  { id: 'girl', label: 'Girl', icon: 'girl', nodes: ['player_hair_girl_', 'player_bare_hair_girl_'] },
];

// The skirt set brings its own leggings, so the legs are covered either way.
const BOTTOMS: readonly LookOption[] = [
  { id: 'trousers', label: 'Trousers', icon: 'trousers', nodes: ['player_trousers'] },
  { id: 'skirt', label: 'Skirt', icon: 'skirt', nodes: ['player_skirt'] },
];

// The player_hair_ parts are the hair that shows below a hat. The rest of the
// hair, which a hat covers, is the bare head's own part set.
const HEADWEAR: readonly LookOption[] = [
  { id: 'beanie', label: 'Beanie', icon: 'beanie', nodes: ['player_beanie_'] },
  // A full head covering: every hair set and the ears stay underneath it.
  {
    id: 'scarf',
    label: 'Head scarf',
    icon: 'scarf',
    nodes: ['player_scarf_'],
    hides: ['player_hair_', 'player_ear_'],
  },
  { id: 'none', label: 'Nothing', icon: 'bare', nodes: ['player_bare_'] },
];

export const LOOK_AXES = [
  {
    id: 'gender',
    label: 'Boy or girl',
    display: 'icon',
    defaultOption: 'boy',
    options: GENDERS,
  },
  {
    id: 'skin',
    label: 'Skin',
    display: 'swatch',
    swatchRoles: ['skin'],
    defaultOption: 'medium',
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
  {
    id: 'bottoms',
    label: 'Trousers or skirt',
    display: 'icon',
    defaultOption: 'trousers',
    options: BOTTOMS,
  },
  {
    id: 'headwear',
    label: 'On your head',
    display: 'icon',
    defaultOption: 'beanie',
    options: HEADWEAR,
  },
] as const satisfies readonly LookAxis[];

export type LookAxisId = (typeof LOOK_AXES)[number]['id'];

export type PlayerStyleId = 'cartoon' | 'realistic';

export interface PlayerStyle {
  readonly id: PlayerStyleId;
  readonly label: string;
  /** One line under the name on the style card. */
  readonly blurb: string;
}

export const PLAYER_STYLES: readonly PlayerStyle[] = [
  { id: 'cartoon', label: 'Cartoon', blurb: 'Round, bright, and bouncy' },
  { id: 'realistic', label: 'Realistic', blurb: 'Looks like a real kid' },
];

/** Looks saved before styles existed were made on the cartoon player's predecessor. */
const DEFAULT_STYLE: PlayerStyleId = 'cartoon';

/** A style and one chosen option id per axis. */
export type PlayerLook = Readonly<Record<LookAxisId, string>> & { readonly style: PlayerStyleId };

export const DEFAULT_PLAYER_LOOK: PlayerLook = Object.freeze({
  style: DEFAULT_STYLE,
  ...(Object.fromEntries(LOOK_AXES.map((axis) => [axis.id, axis.defaultOption])) as Record<LookAxisId, string>),
});

export function lookOption(axis: LookAxis, id: string): LookOption {
  const option = axis.options.find((item) => item.id === id)
    ?? axis.options.find((item) => item.id === axis.defaultOption);
  if (!option) throw new Error(`Look axis ${axis.id} has no default option`);
  return option;
}

/** Keeps known choices and falls back to each default for anything else. */
export function normalizePlayerLook(value: unknown): PlayerLook {
  const source = typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : {};
  const style = PLAYER_STYLES.find((item) => item.id === source.style)?.id ?? DEFAULT_STYLE;
  const choices = Object.fromEntries(
    LOOK_AXES.map((axis: LookAxis) => {
      const chosen = source[axis.id];
      const known = axis.options.some((option) => option.id === chosen);
      return [axis.id, known ? chosen : axis.defaultOption];
    }),
  ) as Record<LookAxisId, string>;
  return { style, ...choices };
}

/** Every surface the chosen look paints, keyed by material role. */
export function lookPaint(look: PlayerLook): LookPaint {
  return Object.assign(
    {},
    ...(LOOK_AXES as readonly LookAxis[]).map((axis) => lookOption(axis, look[axis.id as LookAxisId]).paint),
  );
}

function startsWithAny(name: string, prefixes: readonly string[] | undefined): boolean {
  return prefixes?.some((prefix) => name.startsWith(prefix)) ?? false;
}

/** Whether a part shows under the look, or undefined for parts no axis manages. */
function partVisibility(name: string, look: PlayerLook): boolean | undefined {
  let managed = false;
  let visible = true;
  for (const axis of LOOK_AXES as readonly LookAxis[]) {
    const chosen = lookOption(axis, look[axis.id as LookAxisId]);
    if (axis.options.some((option) => startsWithAny(name, option.nodes))) {
      managed = true;
      visible &&= startsWithAny(name, chosen.nodes);
    }
    if (axis.options.some((option) => startsWithAny(name, option.hides))) {
      managed = true;
      visible &&= !startsWithAny(name, chosen.hides);
    }
  }
  return managed ? visible : undefined;
}

/**
 * Repaints a player model and shows the chosen part sets, in place. It matches
 * materials and parts by their authored names rather than their current state,
 * so it can be applied repeatedly.
 */
export function applyPlayerLook(root: Object3D, look: PlayerLook): void {
  const surfaces = new Map<string, LookSurface>();
  for (const [role, surface] of Object.entries(lookPaint(look))) {
    surfaces.set(PLAYER_MATERIALS[role as PlayerMaterialRole], surface);
  }

  root.traverse((child) => {
    const visible = partVisibility(child.name, look);
    if (visible !== undefined) child.visible = visible;
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
