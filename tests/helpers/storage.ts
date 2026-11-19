import { ChoiceStorage } from '../../src/storage';

/** Storage that lives for one test, optionally holding saved items already. */
export function memoryStorage(initial: Record<string, string> = {}): ChoiceStorage {
  const items = new Map(Object.entries(initial));
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
  };
}

/** Storage that throws on every use, as a browser's does when it is blocked or full. */
export function blockedStorage(): ChoiceStorage {
  return {
    getItem: () => {
      throw new Error('SecurityError');
    },
    setItem: () => {
      throw new Error('QuotaExceededError');
    },
  };
}
