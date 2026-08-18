/**
 * Minimal JSONC reader.
 *
 * Authored persona, storylet, and audience files are data - not TypeScript - but
 * the captain needs to leave notes next to the values being tuned. Plain JSON has
 * no comments, so the authored files are `.jsonc` and pass through here first.
 *
 * Supported beyond strict JSON: `//` line comments, block comments, and trailing
 * commas. Everything else stays strict so a typo is still a loud parse error.
 */

class Reader {
  private index = 0;

  constructor(private readonly source: string) {}

  strip(): string {
    const out: string[] = [];
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '"') {
        out.push(this.readString());
        continue;
      }
      if (char === '/' && this.source[this.index + 1] === '/') {
        this.skipLineComment();
        continue;
      }
      if (char === '/' && this.source[this.index + 1] === '*') {
        this.skipBlockComment();
        continue;
      }
      out.push(char);
      this.index += 1;
    }
    return out.join('');
  }

  private readString(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.source[this.index];
      if (char === '\\') {
        this.index += 2;
        continue;
      }
      this.index += 1;
      if (char === '"') break;
    }
    return this.source.slice(start, this.index);
  }

  private skipLineComment(): void {
    while (this.index < this.source.length && this.source[this.index] !== '\n') {
      this.index += 1;
    }
  }

  private skipBlockComment(): void {
    this.index += 2;
    while (this.index < this.source.length) {
      if (this.source[this.index] === '*' && this.source[this.index + 1] === '/') {
        this.index += 2;
        return;
      }
      this.index += 1;
    }
  }
}

/** Removes comments while preserving string literals and line/column positions. */
export function stripJsonComments(source: string): string {
  return new Reader(source).strip();
}

/** Removes commas that immediately precede a closing brace or bracket. */
export function stripTrailingCommas(source: string): string {
  let out = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === '"') {
      const start = index;
      index += 1;
      while (index < source.length) {
        if (source[index] === '\\') {
          index += 2;
          continue;
        }
        const current = source[index];
        index += 1;
        if (current === '"') break;
      }
      out += source.slice(start, index);
      continue;
    }
    if (char === ',') {
      const rest = source.slice(index + 1);
      const nextMeaningful = rest.replace(/^\s*/, '')[0];
      if (nextMeaningful === '}' || nextMeaningful === ']') {
        index += 1;
        continue;
      }
    }
    out += char;
    index += 1;
  }
  return out;
}

/**
 * Parses a `.jsonc` document. `sourceName` is quoted verbatim in the thrown
 * error so an authoring mistake points at the file the captain edited.
 */
export function parseJsonc<T>(source: string, sourceName: string): T {
  const cleaned = stripTrailingCommas(stripJsonComments(source));
  try {
    return JSON.parse(cleaned) as T;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${sourceName}: not valid JSONC - ${detail}`);
  }
}
