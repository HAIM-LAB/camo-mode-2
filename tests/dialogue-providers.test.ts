import { describe, expect, it, vi } from 'vitest';
import { AnthropicBrain } from '../src/dialogue/providers/anthropic';
import { CerebrasBrain, GroqBrain } from '../src/dialogue/providers/lpu';
import { chunkText, MockBrain, type MockScript } from '../src/dialogue/providers/mock';
import { OpenAIBrain } from '../src/dialogue/providers/openai';
import { fetchRuntimeConfig, OFFLINE_CONFIG, ProxyBrain } from '../src/dialogue/providers/proxy';
import {
  BRAIN_IDS,
  configuredBrains,
  createBrain,
  defaultParamsFor,
  selectBrainId,
} from '../src/dialogue/providers/registry';
import {
  BrainNotConfiguredError,
  BrainRequestError,
  collect,
  type ChatBrain,
  type ChatRequest,
} from '../src/dialogue/providers/types';
import { createMockScript, loadLibrary } from '../src/dialogue/library';
import { MARKERS } from '../src/dialogue/markers';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    system: `${MARKERS.character} camo\n${MARKERS.beat} greeting`,
    messages: [{ role: 'user', content: 'hello' }],
    task: 'dialogue',
    params: { model: 'test-model', maxOutputTokens: 100 },
    ...overrides,
  };
}

function sseResponse(lines: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const line of lines) controller.enqueue(encoder.encode(line));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe('adapter selection is configuration, not code', () => {
  it('falls back to the mock with no keys at all', () => {
    expect(selectBrainId({})).toBe('mock');
    expect(createBrain({}).id).toBe('mock');
    expect(configuredBrains({})).toEqual([]);
  });

  it.each([
    ['ANTHROPIC_API_KEY', 'anthropic'],
    ['OPENAI_API_KEY', 'openai'],
    ['GROQ_API_KEY', 'groq'],
    ['CEREBRAS_API_KEY', 'cerebras'],
  ])('selects %s -> %s', (envVar, expected) => {
    expect(selectBrainId({ [envVar]: 'sk-test' })).toBe(expected);
    expect(createBrain({ [envVar]: 'sk-test' }).id).toBe(expected);
  });

  it('prefers the LPU providers when several keys are present', () => {
    const env = {
      ANTHROPIC_API_KEY: 'a',
      OPENAI_API_KEY: 'b',
      CEREBRAS_API_KEY: 'c',
      GROQ_API_KEY: 'd',
    };
    expect(selectBrainId(env)).toBe('groq');
    expect(configuredBrains(env)).toEqual(['groq', 'cerebras', 'anthropic', 'openai']);
  });

  it('lets CAMO_BRAIN pin a provider regardless of which keys exist', () => {
    expect(selectBrainId({ ANTHROPIC_API_KEY: 'a', CAMO_BRAIN: 'openai' })).toBe('openai');
    expect(selectBrainId({ GROQ_API_KEY: 'g', CAMO_BRAIN: 'mock' })).toBe('mock');
  });

  it('rejects an unknown pin with a message naming the valid options', () => {
    expect(() => selectBrainId({ CAMO_BRAIN: 'gemini' })).toThrow(/mock, anthropic, openai, groq, cerebras/);
  });

  it('applies CAMO_MODEL to whichever brain is active', () => {
    const brain = createBrain({ GROQ_API_KEY: 'g', CAMO_MODEL: 'gemma2-9b-it' });
    expect(brain.defaultParams.model).toBe('gemma2-9b-it');
  });

  it('publishes default params for every declared brain', () => {
    for (const id of BRAIN_IDS) {
      expect(defaultParamsFor(id).model.length).toBeGreaterThan(0);
      expect(defaultParamsFor(id).maxOutputTokens).toBeGreaterThan(0);
    }
  });
});

describe('the interface holds across implementations', () => {
  const brains: ChatBrain[] = [
    new MockBrain(),
    new AnthropicBrain({ apiKey: 'x' }),
    new OpenAIBrain({ apiKey: 'x' }),
    new GroqBrain({ apiKey: 'x' }),
    new CerebrasBrain({ apiKey: 'x' }),
    new ProxyBrain({ id: 'proxy', label: 'Proxy', defaultParams: defaultParamsFor('mock') }),
  ];

  it.each(brains.map((brain) => [brain.id, brain] as const))(
    '%s implements the streaming-first shape',
    (_id, brain) => {
      expect(typeof brain.label).toBe('string');
      expect(brain.defaultParams.model.length).toBeGreaterThan(0);
      expect(typeof brain.stream).toBe('function');
    },
  );
});

describe('mock brain', () => {
  const script: MockScript = {
    reply: (context) => `${context.characterId} at ${context.nodeId}, turn ${context.turnIndex}.`,
    classify: (context, allowed) => (context.childUtterance.includes('help') ? allowed[0] : 'none'),
  };

  it('needs no key and no network', async () => {
    const brain = new MockBrain(script);
    expect(brain.available).toBe(true);
    expect(await collect(brain.stream(request()))).toBe('camo at greeting, turn 0.');
  });

  it('streams deltas rather than one string, and reassembles exactly', async () => {
    const brain = new MockBrain(script);
    const chunks: string[] = [];
    for await (const chunk of brain.stream(request())) chunks.push(chunk.delta);

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe('camo at greeting, turn 0.');
  });

  it('answers classification requests as constrained JSON', async () => {
    const brain = new MockBrain(script);
    const text = await collect(
      brain.stream(
        request({
          task: 'classification',
          messages: [{ role: 'user', content: 'I can help' }],
          json: { schemaName: 'edge-choice', allowedValues: ['child-offers-help', 'none'] },
        }),
      ),
    );
    expect(JSON.parse(text)).toEqual({ edge: 'child-offers-help' });
  });

  it('drives its lines from authored persona data, not from source', async () => {
    const library = loadLibrary();
    const brain = new MockBrain(createMockScript(library));
    const camo = library.personas.find((persona) => persona.id === 'camo')!;
    const reply = await collect(brain.stream(request()));
    expect(camo.offlineLines.greeting).toContain(reply);
  });

  it('is deterministic: the same request yields the same reply', async () => {
    const brain = new MockBrain(createMockScript(loadLibrary()));
    const first = await collect(brain.stream(request()));
    const second = await collect(brain.stream(request()));
    expect(first).toBe(second);
  });

  it('preserves text exactly when chunking', () => {
    const text = 'Hm.  Two spaces, and a trailing newline.\n';
    expect(chunkText(text).join('')).toBe(text);
  });
});

describe('Groq and Cerebras stubs', () => {
  it.each([
    ['groq', new GroqBrain(), 'GROQ_API_KEY'],
    ['cerebras', new CerebrasBrain(), 'CEREBRAS_API_KEY'],
  ])('%s reports unavailable and throws a message naming the variable to set', (id, brain, envVar) => {
    expect(brain.available).toBe(false);
    expect(brain.id).toBe(id);
    try {
      brain.stream(request());
      throw new Error('expected a BrainNotConfiguredError');
    } catch (error) {
      expect(error).toBeInstanceOf(BrainNotConfiguredError);
      expect((error as Error).message).toContain(envVar);
      expect((error as Error).message).toMatch(/no other change is needed/i);
    }
  });

  it('goes live on a key alone, with no code change', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hm."}}]}\n\n',
        'data: [DONE]\n\n',
      ]),
    );
    const brain = new GroqBrain({ apiKey: 'gsk-test', fetchImpl });

    expect(brain.available).toBe(true);
    expect(await collect(brain.stream(request()))).toBe('Hm.');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api.groq.com/openai/v1/chat/completions');
  });
});

describe('provider wire formats', () => {
  it('reads Anthropic content_block_delta events', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'event: content_block_delta\ndata: {"delta":{"text":"Oh - "}}\n\n',
        'event: content_block_delta\ndata: {"delta":{"text":"hello."}}\n\n',
        'event: message_stop\ndata: {}\n\n',
      ]),
    );
    const brain = new AnthropicBrain({
      apiKey: 'sk-test',
      fetchImpl,
    });

    expect(await collect(brain.stream(request()))).toBe('Oh - hello.');
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('sk-test');
    expect(JSON.parse(init.body as string).stream).toBe(true);
  });

  it('prefills a brace for Anthropic JSON requests so the answer parses', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sseResponse(['event: content_block_delta\ndata: {"delta":{"text":"\\"edge\\":\\"none\\"}"}}\n\n']),
    );
    const brain = new AnthropicBrain({
      apiKey: 'sk-test',
      fetchImpl,
    });
    const text = await collect(
      brain.stream(request({ task: 'classification', json: { schemaName: 'edge-choice' } })),
    );
    expect(JSON.parse(text)).toEqual({ edge: 'none' });
  });

  it('reads OpenAI chat completion deltas and stops at [DONE]', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"What."}}]}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"never read"}}]}\n\n',
      ]),
    );
    const brain = new OpenAIBrain({ apiKey: 'sk-test', fetchImpl });
    expect(await collect(brain.stream(request()))).toBe('What.');
  });

  it('raises a typed error on an HTTP failure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('rate limited', { status: 429 }));
    const brain = new OpenAIBrain({ apiKey: 'sk-test', fetchImpl });
    await expect(collect(brain.stream(request()))).rejects.toBeInstanceOf(BrainRequestError);
  });
});

describe('browser proxy brain', () => {
  it('sends the prompt to the proxy and never a key', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sseResponse(['data: {"delta":"Hm."}\n\n', 'event: done\ndata: {}\n\n']),
    );
    const brain = new ProxyBrain({
      id: 'anthropic',
      label: 'Anthropic',
      defaultParams: defaultParamsFor('anthropic'),
      fetchImpl,
    });

    expect(await collect(brain.stream(request()))).toBe('Hm.');
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/__camo/chat');
    expect(JSON.stringify(init.body)).not.toMatch(/api[-_]?key/i);
  });

  it('surfaces a proxy error event as a typed error', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      sseResponse(['event: error\ndata: {"message":"upstream 500"}\n\n']),
    );
    const brain = new ProxyBrain({
      id: 'groq',
      label: 'Groq',
      defaultParams: defaultParamsFor('groq'),
      fetchImpl,
    });
    await expect(collect(brain.stream(request()))).rejects.toThrow(/upstream 500/);
  });

  it('treats an unreachable proxy as the keyless case rather than an error', async () => {
    const failing = vi.fn<typeof fetch>(async () => {
      throw new Error('connection refused');
    });
    expect(await fetchRuntimeConfig(failing)).toEqual(OFFLINE_CONFIG);
  });

  it('reads the capability report without any key material', async () => {
    const payload = {
      brain: { id: 'groq', label: 'Groq LPU', model: 'gemma2-9b-it' },
      voice: { available: true },
      speechToText: { available: true, provider: 'elevenlabs' },
      moderation: { id: 'permissive' },
    };
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const config = await fetchRuntimeConfig(fetchImpl);

    expect(config.brain.id).toBe('groq');
    expect(JSON.stringify(config)).not.toMatch(/sk-|gsk_|api[-_]?key/i);
  });
});
