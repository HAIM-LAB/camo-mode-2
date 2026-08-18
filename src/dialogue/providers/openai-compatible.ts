/**
 * Transport for every provider that speaks the OpenAI `/chat/completions` wire
 * format. OpenAI, Groq, and Cerebras all do, which is why the endgame swap to LPU
 * inference is a config line rather than a rewrite: those adapters supply an id,
 * a base URL, and a default model, and reuse this streaming implementation.
 *
 * Server-side only - it holds an API key.
 */

import {
  BrainRequestError,
  readServerSentEvents,
  resolveFetch,
  type ChatBrain,
  type ChatChunk,
  type ChatRequest,
  type ModelParams,
} from './types';

export interface OpenAICompatibleOptions {
  id: string;
  label: string;
  apiKey: string;
  baseUrl: string;
  defaultParams: ModelParams;
  fetchImpl?: typeof fetch;
}

export class OpenAICompatibleBrain implements ChatBrain {
  readonly id: string;
  readonly label: string;
  readonly defaultParams: ModelParams;
  readonly available = true;

  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.id = options.id;
    this.label = options.label;
    this.defaultParams = options.defaultParams;
    this.fetchImpl = resolveFetch(options.fetchImpl);
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const response = await this.fetchImpl(`${this.options.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.apiKey}`,
      },
      signal: request.signal,
      body: JSON.stringify({
        model: request.params.model,
        max_tokens: request.params.maxOutputTokens,
        temperature: request.params.temperature,
        top_p: request.params.topP,
        stop: request.params.stopSequences,
        stream: true,
        ...(request.json ? { response_format: { type: 'json_object' } } : {}),
        messages: [
          { role: 'system', content: request.system },
          ...request.messages.map((message) => ({ role: message.role, content: message.content })),
        ],
      }),
    });

    if (!response.ok) {
      throw new BrainRequestError(this.id, response.status, await safeText(response));
    }

    for await (const event of readServerSentEvents(response, this.id)) {
      if (event.data === '[DONE]') return;
      const parsed = parseChunk(event.data);
      const delta = parsed?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta.length > 0) yield { delta };
    }
  }
}

interface OpenAIStreamChunk {
  choices?: { delta?: { content?: string } }[];
}

function parseChunk(data: string): OpenAIStreamChunk | undefined {
  try {
    return JSON.parse(data) as OpenAIStreamChunk;
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
