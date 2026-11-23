import { ChoiceStorage, browserStorage } from './storage';

/**
 * The game's modes. The child picks one right after Play, and the rest of the
 * game learns the choice as a GameModeId to branch on.
 *
 * `scene` says where a mode plays. Understanding Emotions is a guessing game
 * of its own; the other two lead into the playroom and its scenario. Sending
 * a mode somewhere new is two edits in this file, a new GameScene and that
 * scene named on the mode; main.ts then does not compile until it says how
 * the scene starts.
 */

/**
 * Where a mode leads once the menus are done: the playroom, or the game that
 * shows an emotion on an avatar and asks which one it is.
 */
export type GameScene = 'playroom' | 'emotion-game';

export interface GameMode {
  readonly id: string;
  /** The words on the mode's menu button, and wherever its scene names the mode. */
  readonly label: string;
  readonly scene: GameScene;
}

/** In menu order. */
export const GAME_MODES = [
  { id: 'emotions', label: 'Understanding Emotions', scene: 'emotion-game' },
  { id: 'feelings', label: 'Understanding Feelings', scene: 'playroom' },
  { id: 'friendships', label: 'Friendships', scene: 'playroom' },
] as const satisfies readonly GameMode[];

export type GameModeId = (typeof GAME_MODES)[number]['id'];

/**
 * The mode a visit plays when it skips the menus and no mode was ever picked:
 * the one whose content is the playroom as it stands.
 */
export const DEFAULT_GAME_MODE: GameModeId = 'feelings';

export function gameMode(id: GameModeId): GameMode {
  const mode = GAME_MODES.find((item) => item.id === id);
  if (!mode) throw new Error(`Unknown game mode: ${id}`);
  return mode;
}

/** The mode an address asks for with `?mode=`, or undefined when it asks for none that exists. */
export function gameModeFromSearch(search: string): GameModeId | undefined {
  const asked = new URLSearchParams(search).get('mode');
  return GAME_MODES.find((mode) => mode.id === asked)?.id;
}

const STORAGE_KEY = 'camo-mode-2.game-mode';

/** The mode picked last time, or undefined when none was picked or none can be read. */
export function loadGameMode(storage: ChoiceStorage | null = browserStorage()): GameModeId | undefined {
  try {
    const saved = storage?.getItem(STORAGE_KEY);
    return GAME_MODES.find((mode) => mode.id === saved)?.id;
  } catch {
    return undefined;
  }
}

export function saveGameMode(mode: GameModeId, storage: ChoiceStorage | null = browserStorage()): void {
  try {
    storage?.setItem(STORAGE_KEY, mode);
  } catch {
    // Storage can be full or blocked; the mode still applies for this visit.
  }
}
