/**
 * OpenAI adapter. Server-side only - it holds an API key.
 */

import { OpenAICompatibleBrain } from './openai-compatible';
import type { ChatBrain, ChatChunk, ChatRequest, ModelParams } from './types';

export const OPENAI_DEFAULT_PARAMS: ModelParams = Object.freeze({
  model: 'gpt-4o-mini',
  maxOutputTokens: 220,
  temperature: 0.8,
});

export interface OpenAIOptions {
  apiKey: string;
  baseUrl?: string;
  defaultParams?: ModelParams;
  fetchImpl?: typeof fetch;
}

export class OpenAIBrain implements ChatBrain {
  readonly id = 'openai';
  readonly label = 'OpenAI';
  readonly defaultParams: ModelParams;
  readonly available = true;

  private readonly delegate: OpenAICompatibleBrain;

  constructor(options: OpenAIOptions) {
    this.defaultParams = options.defaultParams ?? OPENAI_DEFAULT_PARAMS;
    this.delegate = new OpenAICompatibleBrain({
      id: this.id,
      label: this.label,
      apiKey: options.apiKey,
      baseUrl: options.baseUrl ?? 'https://api.openai.com/v1',
      defaultParams: this.defaultParams,
      fetchImpl: options.fetchImpl,
    });
  }

  stream(request: ChatRequest): AsyncIterable<ChatChunk> {
    return this.delegate.stream(request);
  }
}
