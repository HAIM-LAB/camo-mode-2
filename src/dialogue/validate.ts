/**
 * Shared validation helpers for authored data files.
 *
 * The goal is actionable errors: every issue names the file, the exact path
 * inside it, what was expected, and what was actually found. Authors read these
 * in the browser console and in `npm test`, so they must stand alone.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export class SchemaValidationError extends Error {
  constructor(
    readonly sourceName: string,
    readonly issues: readonly ValidationIssue[],
  ) {
    super(
      `${sourceName}: ${issues.length} validation ${issues.length === 1 ? 'issue' : 'issues'}\n` +
        issues.map((issue) => `  - ${issue.path}: ${issue.message}`).join('\n'),
    );
    this.name = 'SchemaValidationError';
  }
}

function describe(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Accumulates issues so one load reports every problem, not just the first. */
export class Validator {
  private readonly issues: ValidationIssue[] = [];

  constructor(private readonly sourceName: string) {}

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  record(): readonly ValidationIssue[] {
    return this.issues;
  }

  throwIfInvalid(): void {
    if (this.issues.length > 0) throw new SchemaValidationError(this.sourceName, this.issues);
  }

  object(value: unknown, path: string): Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, `must be an object, found ${describe(value)}`);
      return {};
    }
    return value as Record<string, unknown>;
  }

  string(value: unknown, path: string, options: { minLength?: number } = {}): string {
    if (typeof value !== 'string') {
      this.fail(path, `must be a string, found ${describe(value)}`);
      return '';
    }
    const minLength = options.minLength ?? 1;
    if (value.trim().length < minLength) {
      this.fail(path, `must be at least ${minLength} character(s) of real text`);
    }
    return value;
  }

  optionalString(value: unknown, path: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    return this.string(value, path);
  }

  number(
    value: unknown,
    path: string,
    range: { min: number; max: number },
  ): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      this.fail(path, `must be a number between ${range.min} and ${range.max}, found ${describe(value)}`);
      return range.min;
    }
    if (value < range.min || value > range.max) {
      this.fail(path, `must be between ${range.min} and ${range.max}, found ${value}`);
      return Math.min(range.max, Math.max(range.min, value));
    }
    return value;
  }

  integer(value: unknown, path: string, range: { min: number; max: number }): number {
    const parsed = this.number(value, path, range);
    if (!Number.isInteger(parsed)) this.fail(path, `must be a whole number, found ${parsed}`);
    return Math.round(parsed);
  }

  boolean(value: unknown, path: string, fallback = false): boolean {
    if (typeof value !== 'boolean') {
      this.fail(path, `must be true or false, found ${describe(value)}`);
      return fallback;
    }
    return value;
  }

  array(value: unknown, path: string, options: { minLength?: number } = {}): unknown[] {
    if (!Array.isArray(value)) {
      this.fail(path, `must be an array, found ${describe(value)}`);
      return [];
    }
    const minLength = options.minLength ?? 0;
    if (value.length < minLength) {
      this.fail(path, `must list at least ${minLength} item(s), found ${value.length}`);
    }
    return value;
  }

  stringArray(value: unknown, path: string, options: { minLength?: number } = {}): string[] {
    const items = this.array(value, path, options);
    return items.map((item, index) => this.string(item, `${path}[${index}]`));
  }

  oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
    if (typeof value !== 'string' || !allowed.includes(value as T)) {
      this.fail(path, `must be one of ${allowed.map((item) => `"${item}"`).join(', ')}, found ${describe(value)}`);
      return allowed[0];
    }
    return value as T;
  }

  /** Guards identifiers that other files reference by name. */
  identifier(value: unknown, path: string): string {
    const text = this.string(value, path);
    if (text && !/^[a-z0-9][a-z0-9-]*$/.test(text)) {
      this.fail(path, `must be lower-case kebab-case (letters, digits, dashes), found ${JSON.stringify(text)}`);
    }
    return text;
  }
}
