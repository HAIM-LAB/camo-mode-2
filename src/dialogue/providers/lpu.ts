/**
 * Groq and Cerebras adapters - the captain's stated endgame for real-time
 * inference against an open model (Gemma, Llama).
 *
 * These are shipped as **stubs on purpose**: the wiring is complete, but with no
 * key present `stream()` throws `BrainNotConfiguredError` naming the exact
 * variable to set. That is the whole point of them being here now - they prove
 * the `ChatBrain` interface holds across four implementations before anyone
 * commits to the swap, and turning either one on is a `.env` line, not a refactor.
 *
 * Both providers expose the OpenAI `/chat/completions` wire format, so they reuse
 * `OpenAICompatibleBrain` verbatim. Server-side only.
 */

import { OpenAICompatibleBrain } from './openai-compatible';
import {
  BrainNotConfiguredError,
  type ChatBrain,
  type ChatChunk,
  type ChatRequest,
  type ModelParams,
} from './types';

export const GROQ_DEFAULT_PARAMS: ModelParams = Object.freeze({
  model: 'llama-3.3-70b-versatile',
  maxOutputTokens: 220,
  temperature: 0.8,
});

export const CEREBRAS_DEFAULT_PARAMS: ModelParams = Object.freeze({
  model: 'llama3.1-8b',
  maxOutputTokens: 220,
  temperature: 0.8,
});

interface LpuOptions {
  apiKey?: string;
  baseUrl?: string;
  defaultParams?: ModelParams;
  fetchImpl?: typeof fetch;
}

interface LpuDefinition {
  id: string;
  label: string;
  envVar: string;
  baseUrl: string;
  defaultParams: ModelParams;
}

class LpuBrain implements ChatBrain {
  readonly id: string;
  readonly label: string;
  readonly defaultParams: ModelParams;
  readonly available: boolean;

  private readonly delegate?: OpenAICompatibleBrain;

  constructor(
    private readonly definition: LpuDefinition,
    options: LpuOptions,
  ) {
    this.id = definition.id;
    this.label = definition.label;
    this.defaultParams = options.defaultParams ?? definition.defaultParams;
    this.available = Boolean(options.apiKey);

    if (options.apiKey) {
      this.delegate = new OpenAICompatibleBrain({
        id: this.id,
        label: this.label,
        apiKey: options.apiKey,
        baseUrl: options.baseUrl ?? definition.baseUrl,
        defaultParams: this.defaultParams,
        fetchImpl: options.fetchImpl,
      });
    }
  }

  stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    if (!this.delegate) {
      throw new BrainNotConfiguredError(
        this.id,
        `set ${this.definition.envVar} in .env and restart the dev server. ` +
          `No other change is needed - ${this.label} speaks the OpenAI wire format ` +
          `and this adapter is already wired to ${this.definition.baseUrl}.`,
      );
    }
    return this.delegate.stream(request);
  }
}

export class GroqBrain extends LpuBrain {
  constructor(options: LpuOptions = {}) {
    super(
      {
        id: 'groq',
        label: 'Groq LPU',
        envVar: 'GROQ_API_KEY',
        baseUrl: 'https://api.groq.com/openai/v1',
        defaultParams: GROQ_DEFAULT_PARAMS,
      },
      options,
    );
  }
}

export class CerebrasBrain extends LpuBrain {
  constructor(options: LpuOptions = {}) {
    super(
      {
        id: 'cerebras',
        label: 'Cerebras',
        envVar: 'CEREBRAS_API_KEY',
        baseUrl: 'https://api.cerebras.ai/v1',
        defaultParams: CEREBRAS_DEFAULT_PARAMS,
      },
      options,
    );
  }
}
