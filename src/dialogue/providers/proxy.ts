/**
 * Browser-side brain that speaks to the server proxy.
 *
 * This is the only adapter the browser ever instantiates for a keyed provider.
 * It implements the same `ChatBrain` interface as the server-side adapters, so
 * nothing above it knows or cares whether the tokens came from Anthropic, Groq,
 * or a Cerebras LPU - that choice is made server-side from `.env`.
 *
 * No key material passes through here. The request carries a prompt; the reply
 * carries text.
 */

import {
  BrainRequestError,
  readServerSentEvents,
  type ChatBrain,
  type ChatChunk,
  type ChatRequest,
  type ModelParams,
} from './types';

export const PROXY_CHAT_URL = '/__camo/chat';

export interface ProxyBrainOptions {
  id: string;
  label: string;
  defaultParams: ModelParams;
  url?: string;
  fetchImpl?: typeof fetch;
}

export class ProxyBrain implements ChatBrain {
  readonly id: string;
  readonly label: string;
  readonly defaultParams: ModelParams;
  readonly available = true;

  private readonly url: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ProxyBrainOptions) {
    this.id = options.id;
    this.label = options.label;
    this.defaultParams = options.defaultParams;
    this.url = options.url ?? PROXY_CHAT_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async *stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: request.signal,
      body: JSON.stringify({
        system: request.system,
        messages: request.messages,
        params: request.params,
        task: request.task,
        json: request.json,
      }),
    });

    if (!response.ok) {
      throw new BrainRequestError(this.id, response.status, await response.text().catch(() => ''));
    }

    for await (const event of readServerSentEvents(response, this.id)) {
      if (event.event === 'done') return;
      if (event.event === 'error') {
        const parsed = safeParse(event.data);
        throw new BrainRequestError(this.id, undefined, parsed?.message ?? event.data);
      }
      const parsed = safeParse(event.data);
      if (parsed && typeof parsed.delta === 'string' && parsed.delta.length > 0) {
        yield { delta: parsed.delta };
      }
    }
  }
}

function safeParse(data: string): { delta?: unknown; message?: string } | undefined {
  try {
    return JSON.parse(data) as { delta?: unknown; message?: string };
  } catch {
    return undefined;
  }
}

/** The capability report from `GET /__camo/config`. Contains no key material. */
export interface RuntimeConfig {
  brain: { id: string; label: string; model: string };
  voice: { available: boolean };
  speechToText: { available: boolean; provider: string | null };
  moderation: { id: string };
}

export const OFFLINE_CONFIG: RuntimeConfig = Object.freeze({
  brain: { id: 'mock', label: 'Mock (offline, no key)', model: 'mock-deterministic-1' },
  voice: { available: false },
  speechToText: { available: false, provider: null },
  moderation: { id: 'permissive' },
});

/**
 * Asks the server what is configured. A failure here is not an error condition:
 * it means the proxy is not running, which is exactly the keyless case, so the
 * app falls back to the local mock and carries on.
 */
export async function fetchRuntimeConfig(fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const response = await fetchImpl('/__camo/config', { headers: { accept: 'application/json' } });
    if (!response.ok) return OFFLINE_CONFIG;
    const parsed = (await response.json()) as Partial<RuntimeConfig>;
    if (!parsed.brain || typeof parsed.brain.id !== 'string') return OFFLINE_CONFIG;
    return {
      brain: parsed.brain,
      voice: parsed.voice ?? OFFLINE_CONFIG.voice,
      speechToText: parsed.speechToText ?? OFFLINE_CONFIG.speechToText,
      moderation: parsed.moderation ?? OFFLINE_CONFIG.moderation,
    };
  } catch {
    return OFFLINE_CONFIG;
  }
}
