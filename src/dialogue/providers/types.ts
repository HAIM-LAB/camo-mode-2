/**
 * The one transport-agnostic chat interface every brain implements.
 *
 * Design notes that are load-bearing, not decoration:
 *
 * - **Streaming-first.** `stream()` yields token deltas. There is deliberately no
 *   `complete()` on the interface. The endgame is Groq/Cerebras LPU inference where
 *   time-to-first-token is the whole point; an interface that awaits a full string
 *   would have to be torn up to get there. Callers that genuinely need the whole
 *   string (the edge classifier) use the `collect()` helper below.
 * - **Per-request params.** Model id, token ceiling, and sampling ride on the
 *   request, not on the adapter. A new provider is a new file plus a config line.
 * - **Runs anywhere.** Adapters use only `fetch` and async iterators, so the same
 *   file works inside the Vite server middleware (node) and inside a unit test.
 *
 * Provider adapters that need an API key run **server-side only**. The browser
 * talks to `ProxyBrain`, which implements this same interface over the dev/preview
 * server proxy. See `docs/dialogue-architecture.md`.
 */

export type ChatRole = 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Everything a provider needs to shape one call. Serializable on purpose. */
export interface ModelParams {
  /** Provider-native model id, e.g. `claude-sonnet-5` or `llama-3.3-70b-versatile`. */
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
}

/**
 * What the call is for. Adapters may shape params differently per task (a
 * classification wants near-zero temperature and a handful of tokens), and the
 * mock brain uses it to pick which deterministic responder to run.
 */
export type ChatTask = 'dialogue' | 'classification';

export interface ChatRequest {
  /** Persona + beat instructions. Kept separate from the turn history. */
  system: string;
  messages: ChatMessage[];
  params: ModelParams;
  task: ChatTask;
  /**
   * When set, the adapter asks the provider for a single JSON object and the
   * caller parses it. `allowedValues` is advisory for the model; the interpreter
   * still re-checks the answer against the graph and never trusts it.
   */
  json?: {
    schemaName: string;
    allowedValues?: readonly string[];
  };
  signal?: AbortSignal;
}

export interface ChatChunk {
  /** Text appended since the previous chunk. Never the cumulative string. */
  delta: string;
}

export interface ChatBrain {
  /** Stable id used in configuration and in the debug inspector. */
  readonly id: string;
  /** Human label for the inspector and status pill. */
  readonly label: string;
  /** Params used when a caller does not override them. */
  readonly defaultParams: ModelParams;
  /** True when this adapter can actually serve a request right now. */
  readonly available: boolean;
  stream(request: ChatRequest): AsyncIterable<ChatChunk>;
}

/** Raised by adapters whose shape exists but whose transport is not configured. */
export class BrainNotConfiguredError extends Error {
  constructor(
    readonly brainId: string,
    detail: string,
  ) {
    super(`${brainId} is not yet configured: ${detail}`);
    this.name = 'BrainNotConfiguredError';
  }
}

/** Raised when a provider call fails. Callers degrade; they never surface this to a child. */
export class BrainRequestError extends Error {
  constructor(
    readonly brainId: string,
    readonly status: number | undefined,
    detail: string,
  ) {
    super(`${brainId} request failed${status ? ` (HTTP ${status})` : ''}: ${detail}`);
    this.name = 'BrainRequestError';
  }
}

/**
 * Normalizes an injected or ambient `fetch` into something safe to store on an
 * object.
 *
 * This is not a style preference. A bare `fetch` reference kept as a field and
 * invoked as `this.fetchImpl(...)` is called with the *instance* as its receiver,
 * and the browser's native `fetch` brand-checks that receiver: it throws
 * `TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation`. Node's
 * undici `fetch` does not brand-check, so the same code passes server-side and in
 * unit tests that inject a plain function, and fails only in a real browser
 * against a real provider - which is exactly where it is most expensive to find.
 *
 * Binding once at construction removes the trap for every adapter.
 */
export function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? globalThis.fetch.bind(globalThis);
}

/** Drains a stream into one string. For classification, never for display. */
export async function collect(stream: AsyncIterable<ChatChunk>): Promise<string> {
  let text = '';
  for await (const chunk of stream) text += chunk.delta;
  return text;
}

/**
 * Shared line-oriented Server-Sent Events reader.
 *
 * Anthropic, OpenAI, Groq, and Cerebras all stream SSE, so the framing lives here
 * once and each adapter only supplies its own event-to-delta mapping.
 */
export async function* readServerSentEvents(
  response: Response,
  brainId: string,
): AsyncGenerator<{ event: string; data: string }> {
  if (!response.body) {
    throw new BrainRequestError(brainId, response.status, 'response carried no body');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        boundary = buffer.indexOf('\n\n');

        let event = 'message';
        const dataLines: string[] = [];
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length > 0) yield { event, data: dataLines.join('\n') };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
