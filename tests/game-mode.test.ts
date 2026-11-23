import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GAME_MODE,
  GAME_MODES,
  gameMode,
  gameModeFromSearch,
  loadGameMode,
  saveGameMode,
} from '../src/game-mode';
import { blockedStorage, memoryStorage } from './helpers/storage';

describe('game modes', () => {
  it('offers exactly the three modes, in menu order, under their exact names', () => {
    expect(GAME_MODES.map((mode) => mode.label)).toEqual([
      'Understanding Emotions',
      'Understanding Feelings',
      'Friendships',
    ]);
    expect(new Set(GAME_MODES.map((mode) => mode.id)).size).toBe(GAME_MODES.length);
  });

  it('looks a mode up by its id', () => {
    for (const mode of GAME_MODES) expect(gameMode(mode.id)).toBe(mode);
  });

  it('leads Understanding Emotions into the guessing game', () => {
    expect(gameMode('emotions').scene).toBe('emotion-game');
  });

  it('still leads Understanding Feelings and Friendships into the playroom', () => {
    expect(gameMode('feelings').scene).toBe('playroom');
    expect(gameMode('friendships').scene).toBe('playroom');
    expect(GAME_MODES.filter((mode) => mode.scene !== 'playroom').map((mode) => mode.id)).toEqual(['emotions']);
  });

  it('plays Understanding Feelings, in the playroom, when no mode was ever picked', () => {
    expect(gameMode(DEFAULT_GAME_MODE).label).toBe('Understanding Feelings');
    expect(gameMode(DEFAULT_GAME_MODE).scene).toBe('playroom');
  });
});

describe('mode named in the address', () => {
  it('reads any mode from ?mode=', () => {
    for (const mode of GAME_MODES) {
      expect(gameModeFromSearch(`?skipMenu=1&mode=${mode.id}`)).toBe(mode.id);
    }
  });

  it('names no mode when the address asks for none, or for one that does not exist', () => {
    for (const search of ['', '?skipMenu=1', '?mode=', '?mode=arcade', '?mode=Emotions']) {
      expect(gameModeFromSearch(search)).toBeUndefined();
    }
  });
});

describe('saved mode', () => {
  it('round-trips every mode through storage', () => {
    for (const mode of GAME_MODES) {
      const storage = memoryStorage();
      saveGameMode(mode.id, storage);
      expect(loadGameMode(storage)).toBe(mode.id);
    }
  });

  it('has no saved mode until one is picked', () => {
    expect(loadGameMode(memoryStorage())).toBeUndefined();
    expect(loadGameMode(null)).toBeUndefined();
  });

  it('ignores a saved value that is not a mode', () => {
    for (const saved of ['', 'Friendships', 'arcade', '{"mode":"feelings"}']) {
      expect(loadGameMode(memoryStorage({ 'camo-mode-2.game-mode': saved }))).toBeUndefined();
    }
  });

  it('survives storage that is blocked or full', () => {
    expect(loadGameMode(blockedStorage())).toBeUndefined();
    expect(() => saveGameMode('friendships', blockedStorage())).not.toThrow();
  });
});
