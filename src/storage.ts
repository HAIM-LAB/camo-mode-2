/** The part of Web Storage the saved menu choices use. */
export type ChoiceStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The browser's storage, or null where there is none or it is blocked. */
export function browserStorage(): ChoiceStorage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Some privacy modes throw on access rather than returning null.
    return null;
  }
}
