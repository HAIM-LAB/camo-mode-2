/**
 * Keyless deterministic brain.
 *
 * This is the always-available fallback: `npm install && npm run dev` with no
 * `.env` at all must still open the panel and walk the example storylet. It is
 * also what the unit tests run against, so it must never be random and never
 * touch the network.
 *
 * It is a *fake*, not a simulator. It reads the same assembled prompt a real
 * model would, pulls the character and beat out of the standard markers, and
 * returns lines the captain authored in the persona data file. When a beat has no
 * authored line it degrades to a neutral in-character holding line rather than
 * inventing content.
 */

import { MARKERS, readMarker } from '../markers';
import type { ChatBrain, ChatChunk, ChatRequest, ModelParams } from './types';

export interface MockContext {
  characterId: string;
  nodeId: string;
  /** Number of assistant turns already spoken in this request's history. */
  turnIndex: number;
  /**
   * A stable number derived from what the child actually said.
   *
   * `turnIndex` alone is not enough to vary lines: history is bounded, so it
   * stops climbing once a conversation is longer than the window and the mock
   * would repeat itself forever. Mixing in a hash of the utterance keeps the
   * offline demo moving while staying a pure function of the request - the same
   * request still produces the same reply, which is what the tests rely on.
   */
  variation: number;
  /** The child's most recent message, lower-cased and trimmed. */
  childUtterance: string;
  /**
   * The character's own previous line, as carried in this request's history.
   * Lets a script avoid saying the same thing twice running without holding any
   * state of its own - the answer stays a pure function of the request.
   */
  previousReply: string;
}

/**
 * Supplies the offline lines. Implemented by the persona library so authored text
 * stays in data files; a test can pass a tiny inline script instead.
 */
export interface MockScript {
  reply(context: MockContext): string;
  /** Returns one of `allowed`, or `'none'` to hold position. */
  classify(context: MockContext, allowed: readonly string[]): string;
}

export const MOCK_DEFAULT_PARAMS: ModelParams = Object.freeze({
  model: 'mock-deterministic-1',
  maxOutputTokens: 220,
  temperature: 0,
});

const HOLDING_LINES = [
  'Mmm. I am still thinking about that one.',
  'Okay. I hear you.',
  'That is a lot to think about.',
];

/** A script with no authored content, used when persona data has not loaded. */
export const NULL_MOCK_SCRIPT: MockScript = {
  reply: (context) => {
    const index = (context.turnIndex + context.variation) % HOLDING_LINES.length;
    return HOLDING_LINES[index] === context.previousReply
      ? HOLDING_LINES[(index + 1) % HOLDING_LINES.length]
      : HOLDING_LINES[index];
  },
  classify: () => 'none',
};

export class MockBrain implements ChatBrain {
  readonly id = 'mock';
  readonly label = 'Mock (offline, no key)';
  readonly defaultParams = MOCK_DEFAULT_PARAMS;
  readonly available = true;

  constructor(
    private readonly script: MockScript = NULL_MOCK_SCRIPT,
    private readonly tokenDelayMs = 0,
  ) {}

  async *stream(request: ChatRequest): AsyncGenerator<ChatChunk> {
    const context = readContext(request);
    const text =
      request.task === 'classification'
        ? JSON.stringify({ edge: this.script.classify(context, request.json?.allowedValues ?? []) })
        : this.script.reply(context);

    // Emit in word-sized deltas so the UI's streaming path is exercised offline
    // exactly as it will be against a live provider.
    for (const piece of chunkText(text)) {
      if (request.signal?.aborted) return;
      if (this.tokenDelayMs > 0) await delay(this.tokenDelayMs);
      yield { delta: piece };
    }
  }
}

function readContext(request: ChatRequest): MockContext {
  const reversed = [...request.messages].reverse();
  const lastChild = reversed.find((message) => message.role === 'user');
  const lastSelf = reversed.find((message) => message.role === 'assistant');
  const childUtterance = (lastChild?.content ?? '').toLowerCase().trim();
  return {
    characterId: readMarker(request.system, MARKERS.character) ?? 'unknown',
    nodeId: readMarker(request.system, MARKERS.beat) ?? 'unknown',
    turnIndex: request.messages.filter((message) => message.role === 'assistant').length,
    variation: stableHash(childUtterance),
    childUtterance,
    previousReply: lastSelf?.content ?? '',
  };
}

/** Small deterministic non-cryptographic hash. Same input, same number, always. */
export function stableHash(text: string): number {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) % 100003;
  }
  return hash;
}

/** Splits into word-plus-trailing-space pieces, preserving the original text exactly. */
export function chunkText(text: string): string[] {
  return text.match(/\S+\s*/g) ?? (text.length > 0 ? [text] : []);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
