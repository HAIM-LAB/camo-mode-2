/**
 * Safety seam.
 *
 * The audience is children, so moderation is a stage of the pipeline, not a
 * wrapper someone remembers to add. There are exactly two hooks:
 *
 *   - `child-turn`     - before the prompt is assembled.
 *   - `character-reply`- before any text reaches the child or the synthesizer.
 *
 * The reply hook runs per completed sentence, so a blocked reply is caught before
 * the child reads it rather than after. On a block, the character deflects in its
 * own voice; the child never sees an error, a warning, or a moderation notice.
 *
 * Two implementations ship: a permissive default, and a stub shaped for Llama
 * Guard (or any comparable shield model) that the captain can point at a real
 * endpoint without touching dialogue code.
 */

export type ModerationStage = 'child-turn' | 'character-reply';

export interface ModerationContext {
  stage: ModerationStage;
  personaId: string;
  nodeId: string;
  audienceBandId: string;
}

export interface ModerationVerdict {
  allowed: boolean;
  /** Short machine label, e.g. `personal-information`. Logged, never displayed. */
  category?: string;
  /** Operator-facing detail for the inspector. Never displayed to the child. */
  reason?: string;
}

export const ALLOWED: ModerationVerdict = Object.freeze({ allowed: true });

export interface ModerationProvider {
  readonly id: string;
  readonly label: string;
  /** False when the shape exists but the backing service is not configured. */
  readonly available: boolean;
  check(text: string, context: ModerationContext): Promise<ModerationVerdict>;
}

/**
 * The default. Permissive by design: this is a research prototype and an
 * over-eager filter would make every tuning session about the filter.
 *
 * It blocks only what is unambiguous and specific to a child audience: a child
 * volunteering identifying details, and explicit self-harm or violent-harm
 * content in either direction. Everything else passes. Swap this out via
 * `createModeration` rather than adding rules here.
 */
export class PermissiveModeration implements ModerationProvider {
  readonly id = 'permissive';
  readonly label = 'Permissive (default)';
  readonly available = true;

  private static readonly PATTERNS: readonly { category: string; test: RegExp }[] = [
    {
      category: 'personal-information',
      // A child reciting an address, phone number, or email at a character.
      test: /\b(\d{1,5}\s+\w+\s+(street|st|road|rd|avenue|ave|lane|ln|drive|dr)\b|\d{3}[-\s.]?\d{3}[-\s.]?\d{4}\b|[\w.+-]+@[\w-]+\.[a-z]{2,})/i,
    },
    {
      category: 'self-harm',
      test: /\b(kill myself|hurt myself|end my life|want to die)\b/i,
    },
    {
      category: 'violence',
      test: /\b(kill (you|him|her|them)|stab|shoot (you|him|her|them))\b/i,
    },
  ];

  async check(text: string, context: ModerationContext): Promise<ModerationVerdict> {
    for (const pattern of PermissiveModeration.PATTERNS) {
      if (pattern.test.test(text)) {
        return {
          allowed: false,
          category: pattern.category,
          reason: `${context.stage} matched the ${pattern.category} pattern`,
        };
      }
    }
    return ALLOWED;
  }
}

/** Never blocks. Useful for isolating the pipeline while tuning personas. */
export class NullModeration implements ModerationProvider {
  readonly id = 'none';
  readonly label = 'Disabled';
  readonly available = true;

  async check(): Promise<ModerationVerdict> {
    return ALLOWED;
  }
}

export interface ShieldOptions {
  /**
   * Proxy endpoint that fronts the shield model. Left undefined the provider is
   * inert and reports `available: false`, so the pipeline falls back rather than
   * failing open silently.
   */
  endpoint?: string;
  model?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Shaped for Llama Guard and comparable shield models.
 *
 * The contract is deliberately tiny: post `{ stage, text, context }`, get back
 * `{ allowed, category }`. When the captain stands one up - most likely on the
 * same Groq/Cerebras endpoint as the dialogue model - it plugs in here and no
 * dialogue code changes.
 *
 * A shield that errors or times out **blocks**. For a children's product,
 * failing closed on the reply path is the correct default.
 */
export class ShieldModelModeration implements ModerationProvider {
  readonly id = 'shield';
  readonly label = 'Shield model (Llama Guard shaped)';
  readonly available: boolean;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ShieldOptions = {}) {
    this.available = Boolean(options.endpoint);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async check(text: string, context: ModerationContext): Promise<ModerationVerdict> {
    if (!this.options.endpoint) {
      return {
        allowed: false,
        category: 'not-configured',
        reason:
          'ShieldModelModeration has no endpoint. Set MODERATION_ENDPOINT in .env, or leave CAMO_MODERATION unset to use the permissive default.',
      };
    }

    try {
      const response = await this.fetchImpl(this.options.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.options.model,
          stage: context.stage,
          text,
          context: {
            personaId: context.personaId,
            nodeId: context.nodeId,
            audienceBandId: context.audienceBandId,
          },
        }),
      });
      if (!response.ok) {
        return { allowed: false, category: 'shield-error', reason: `HTTP ${response.status}` };
      }
      const parsed = (await response.json()) as { allowed?: unknown; category?: unknown };
      return {
        allowed: parsed.allowed === true,
        category: typeof parsed.category === 'string' ? parsed.category : undefined,
      };
    } catch (error) {
      return {
        allowed: false,
        category: 'shield-error',
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export const MODERATION_IDS = ['permissive', 'shield', 'none'] as const;
export type ModerationId = (typeof MODERATION_IDS)[number];

/** Selection by configuration, matching how brains are chosen. */
export function createModeration(
  id: string | undefined,
  options: ShieldOptions = {},
): ModerationProvider {
  switch (id) {
    case 'shield':
      return new ShieldModelModeration(options);
    case 'none':
      return new NullModeration();
    default:
      return new PermissiveModeration();
  }
}

/**
 * Splits streamed text into complete sentences plus a remainder.
 *
 * This is what lets the reply hook run *before* the child reads anything: the
 * panel and the voice queue are both fed from gated sentences, never from raw
 * token deltas.
 */
export function takeCompleteSentences(buffer: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  let rest = buffer;

  for (;;) {
    const match = rest.match(/^[\s\S]*?[.!?…]+["')\]]*\s+/);
    if (!match) break;
    sentences.push(match[0].trim());
    rest = rest.slice(match[0].length);
  }
  return { sentences, rest };
}
