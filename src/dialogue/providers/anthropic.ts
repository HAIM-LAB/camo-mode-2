/**
 * Anthropic Messages API adapter. Server-side only - it holds an API key.
 */

import {
  BrainRequestError,
  readServerSentEvents,
  type ChatBrain,
  type ChatChunk,
  type ChatRequest,
  type ModelParams,
} from './types';

export const ANTHROPIC_DEFAULT_PARAMS: ModelParams = Object.freeze({
  model: 'claude-sonnet-5',
  maxOutputTokens: 220,
  temperature: 0.8,
});

export interface AnthropicOptions {
  apiKey: string;
  baseUrl?: string;
  defaultParams?: ModelParams;
  fetchImpl?: typeof fetch;
}

export class AnthropicBrain implements ChatBrain {
  readonly id = 'anthropic';
  readonly label = 'Anthropic';
  readonly defaultParams: ModelParams;
  readonly available = true;

  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AnthropicOptions) {
    this.defaultParams = options.defaultParams ?? ANTHROPIC_DEFAULT_PARAMS;
    this.baseUrl = options.baseUrl ?? 'https://api.anthropic.com';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    // Anthropic has no JSON mode; the reliable equivalent is prefilling the
    // assistant turn with `{` so the model can only continue an object.
    const messages = request.json
      ? [...request.messages, { role: 'assistant' as const, content: '{' }]
      : request.messages;

    const response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.options.apiKey,
        'anthropic-version': '2023-06-01',
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.params.model,
        max_tokens: request.params.maxOutputTokens,
        temperature: request.params.temperature,
        top_p: request.params.topP,
        stop_sequences: request.params.stopSequences,
        system: request.system,
        messages: messages.map((message) => ({ role: message.role, content: message.content })),
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new BrainRequestError(this.id, response.status, await safeText(response));
    }

    // Replay the prefill so the caller receives a parseable object.
    if (request.json) yield { delta: '{' };

    for await (const event of readServerSentEvents(response, this.id)) {
      if (event.event === 'error') throw new BrainRequestError(this.id, undefined, event.data);
      if (event.event !== 'content_block_delta') continue;
      const parsed = parseEvent(event.data);
      const delta = parsed?.delta?.text;
      if (typeof delta === 'string' && delta.length > 0) yield { delta };
    }
  }
}

interface AnthropicDeltaEvent {
  delta?: { text?: string };
}

function parseEvent(data: string): AnthropicDeltaEvent | undefined {
  try {
    return JSON.parse(data) as AnthropicDeltaEvent;
  } catch {
    return undefined;
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return response.statusText;
  }
}
