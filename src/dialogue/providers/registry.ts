/**
 * Adapter selection.
 *
 * Selection is pure configuration: given an environment map, decide which brain
 * serves requests. No caller anywhere edits code to change providers.
 *
 * Precedence, highest first:
 *   1. `CAMO_BRAIN` - an explicit pin. Wins even if other keys are present.
 *   2. `GROQ_API_KEY`, then `CEREBRAS_API_KEY`. The LPU adapters win over the
 *      hosted APIs when configured because they are the stated target runtime:
 *      if a key for them is in `.env`, that is what is being evaluated.
 *   3. `ANTHROPIC_API_KEY`, then `OPENAI_API_KEY`.
 *   4. The mock. Always available, never needs a key.
 *
 * This module runs **server-side only**. It is the one place that reads key
 * material, and nothing it returns is ever serialized to the browser.
 */

import { AnthropicBrain, ANTHROPIC_DEFAULT_PARAMS } from './anthropic';
import {
  CEREBRAS_DEFAULT_PARAMS,
  CerebrasBrain,
  GROQ_DEFAULT_PARAMS,
  GroqBrain,
} from './lpu';
import { MockBrain, MOCK_DEFAULT_PARAMS, type MockScript } from './mock';
import { OpenAIBrain, OPENAI_DEFAULT_PARAMS } from './openai';
import type { ChatBrain, ModelParams } from './types';

export const BRAIN_IDS = ['mock', 'anthropic', 'openai', 'groq', 'cerebras'] as const;
export type BrainId = (typeof BRAIN_IDS)[number];

/** Env var that supplies each provider's key, in selection precedence order. */
export const BRAIN_KEY_VARS: readonly { id: BrainId; envVar: string }[] = Object.freeze([
  { id: 'groq', envVar: 'GROQ_API_KEY' },
  { id: 'cerebras', envVar: 'CEREBRAS_API_KEY' },
  { id: 'anthropic', envVar: 'ANTHROPIC_API_KEY' },
  { id: 'openai', envVar: 'OPENAI_API_KEY' },
]);

export type ServerEnv = Readonly<Record<string, string | undefined>>;

function present(env: ServerEnv, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

export function isBrainId(value: unknown): value is BrainId {
  return typeof value === 'string' && (BRAIN_IDS as readonly string[]).includes(value);
}

/**
 * Resolves the active brain id from configuration alone. Exported separately from
 * `createBrain` so selection is testable without constructing any adapter.
 */
export function selectBrainId(env: ServerEnv): BrainId {
  const pinned = env.CAMO_BRAIN?.trim();
  if (pinned) {
    if (!isBrainId(pinned)) {
      throw new Error(
        `CAMO_BRAIN="${pinned}" is not a known brain. Use one of: ${BRAIN_IDS.join(', ')}.`,
      );
    }
    return pinned;
  }

  for (const candidate of BRAIN_KEY_VARS) {
    if (present(env, candidate.envVar)) return candidate.id;
  }
  return 'mock';
}

/** Reports which providers hold a usable key. Safe to log; contains no key material. */
export function configuredBrains(env: ServerEnv): BrainId[] {
  return BRAIN_KEY_VARS.filter((candidate) => present(env, candidate.envVar)).map(
    (candidate) => candidate.id,
  );
}

export function defaultParamsFor(id: BrainId): ModelParams {
  switch (id) {
    case 'anthropic':
      return ANTHROPIC_DEFAULT_PARAMS;
    case 'openai':
      return OPENAI_DEFAULT_PARAMS;
    case 'groq':
      return GROQ_DEFAULT_PARAMS;
    case 'cerebras':
      return CEREBRAS_DEFAULT_PARAMS;
    case 'mock':
      return MOCK_DEFAULT_PARAMS;
  }
}

export interface CreateBrainDeps {
  /** Offline lines for the mock brain. */
  mockScript?: MockScript;
  fetchImpl?: typeof fetch;
}

/**
 * Builds the active brain. A pinned brain whose key is missing is still
 * constructed: the LPU adapters then throw `BrainNotConfiguredError` naming the
 * variable to set, which is a far better failure than silently falling back.
 */
export function createBrain(env: ServerEnv, deps: CreateBrainDeps = {}): ChatBrain {
  const id = selectBrainId(env);
  const overrideModel = env.CAMO_MODEL?.trim();
  const withModel = (params: ModelParams): ModelParams =>
    overrideModel ? { ...params, model: overrideModel } : params;

  switch (id) {
    case 'anthropic':
      return new AnthropicBrain({
        apiKey: env.ANTHROPIC_API_KEY ?? '',
        defaultParams: withModel(ANTHROPIC_DEFAULT_PARAMS),
        fetchImpl: deps.fetchImpl,
      });
    case 'openai':
      return new OpenAIBrain({
        apiKey: env.OPENAI_API_KEY ?? '',
        defaultParams: withModel(OPENAI_DEFAULT_PARAMS),
        fetchImpl: deps.fetchImpl,
      });
    case 'groq':
      return new GroqBrain({
        apiKey: env.GROQ_API_KEY,
        defaultParams: withModel(GROQ_DEFAULT_PARAMS),
        fetchImpl: deps.fetchImpl,
      });
    case 'cerebras':
      return new CerebrasBrain({
        apiKey: env.CEREBRAS_API_KEY,
        defaultParams: withModel(CEREBRAS_DEFAULT_PARAMS),
        fetchImpl: deps.fetchImpl,
      });
    case 'mock':
      return new MockBrain(deps.mockScript);
  }
}
