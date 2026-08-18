/**
 * Dialogue proxy: a Vite middleware plugin.
 *
 * Why a plugin and not a service: this is a research prototype and the only job
 * is keeping API keys out of browser-delivered code. A plugin does that in one
 * file with no extra process to start, and `npm install && npm run dev` stays the
 * authoritative one-command start.
 *
 * It is installed on BOTH the dev server and the preview server, so the
 * presenter's `npm run preview` path has the same capabilities as `npm run dev`.
 *
 * Routes (all under `/__camo/`, all POST unless noted):
 *   GET  /__camo/config  - capability report. Allow-listed; carries no key material.
 *   POST /__camo/chat    - streams the active brain's deltas back as SSE.
 *   POST /__camo/voice   - pipes ElevenLabs audio through, unbuffered.
 *   POST /__camo/stt     - one-shot transcription of a recorded turn.
 *
 * Nothing here is imported by `src/`. The browser only ever sees these URLs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import {
  createBrain,
  defaultParamsFor,
  selectBrainId,
  type BrainId,
} from '../src/dialogue/providers/registry';
import type { ChatMessage, ChatRequest, ModelParams } from '../src/dialogue/providers/types';
import { loadServerEnv, type PublicConfig, type ServerEnv } from './env';
import { ElevenLabsVoice, WhisperTranscriber } from './voice';

const ROUTE_PREFIX = '/__camo/';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: ProxyContext,
) => Promise<void>;

interface ProxyContext {
  env: ServerEnv;
  brainId: BrainId;
  voice: ElevenLabsVoice;
  whisper: WhisperTranscriber;
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Buffer);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const body = await readBody(request);
  return JSON.parse(body.toString('utf8')) as T;
}

/** Capability report. Built by allow-list so a new secret cannot leak by omission. */
function publicConfig(context: ProxyContext): PublicConfig {
  const params = defaultParamsFor(context.brainId);
  const model = context.env.CAMO_MODEL?.trim() || params.model;
  const brain = createBrain(context.env);

  return {
    brain: { id: brain.id, label: brain.label, model },
    voice: { available: context.voice.available },
    speechToText: {
      available: context.voice.available || context.whisper.available,
      provider: context.voice.available ? 'elevenlabs' : context.whisper.available ? 'whisper' : null,
    },
    moderation: { id: context.env.CAMO_MODERATION?.trim() || 'permissive' },
  };
}

interface ChatBody {
  system?: unknown;
  messages?: unknown;
  params?: unknown;
  task?: unknown;
  json?: unknown;
}

function parseChatBody(body: ChatBody, fallback: ModelParams): ChatRequest {
  const messages = Array.isArray(body.messages)
    ? (body.messages as ChatMessage[]).filter(
        (message) =>
          message &&
          (message.role === 'user' || message.role === 'assistant') &&
          typeof message.content === 'string',
      )
    : [];

  const rawParams = (body.params ?? {}) as Partial<ModelParams>;
  return {
    system: typeof body.system === 'string' ? body.system : '',
    messages,
    task: body.task === 'classification' ? 'classification' : 'dialogue',
    json: (body.json ?? undefined) as ChatRequest['json'],
    params: {
      model: typeof rawParams.model === 'string' ? rawParams.model : fallback.model,
      maxOutputTokens:
        typeof rawParams.maxOutputTokens === 'number'
          ? Math.min(2000, Math.max(1, rawParams.maxOutputTokens))
          : fallback.maxOutputTokens,
      temperature: typeof rawParams.temperature === 'number' ? rawParams.temperature : fallback.temperature,
      topP: typeof rawParams.topP === 'number' ? rawParams.topP : fallback.topP,
      stopSequences: Array.isArray(rawParams.stopSequences) ? rawParams.stopSequences : undefined,
    },
  };
}

const handleConfig: Handler = async (_request, response, context) => {
  sendJson(response, 200, publicConfig(context));
};

const handleChat: Handler = async (request, response, context) => {
  const body = await readJson<ChatBody>(request);
  const brain = createBrain(context.env);
  const chatRequest = parseChatBody(body, brain.defaultParams);

  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Streaming is the whole point; nothing may sit on this response.
    'x-accel-buffering': 'no',
  });

  const abort = new AbortController();
  request.on('close', () => abort.abort());

  try {
    for await (const chunk of brain.stream({ ...chatRequest, signal: abort.signal })) {
      response.write(`data: ${JSON.stringify({ delta: chunk.delta })}\n\n`);
    }
    response.write('event: done\ndata: {}\n\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[camo-proxy] chat failed:', message);
    // The client degrades in character; it never shows this to a child.
    response.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
  } finally {
    response.end();
  }
};

const handleVoice: Handler = async (request, response, context) => {
  if (!context.voice.available) {
    sendJson(response, 503, { error: 'ELEVENLABS_API_KEY is not set' });
    return;
  }

  const body = await readJson<Record<string, unknown>>(request);
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  const voiceId = typeof body.voiceId === 'string' ? body.voiceId : '';
  if (!text || !voiceId) {
    sendJson(response, 400, { error: 'text and voiceId are required' });
    return;
  }

  const abort = new AbortController();
  request.on('close', () => abort.abort());

  try {
    const upstream = await context.voice.synthesize(
      {
        text,
        voiceId,
        modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
        stability: typeof body.stability === 'number' ? body.stability : undefined,
        similarityBoost: typeof body.similarityBoost === 'number' ? body.similarityBoost : undefined,
        speed: typeof body.speed === 'number' ? body.speed : undefined,
      },
      abort.signal,
    );

    response.writeHead(200, {
      'content-type': 'audio/mpeg',
      'cache-control': 'no-store',
      'x-accel-buffering': 'no',
    });

    // Pipe chunk by chunk so playback can start on the first bytes.
    const reader = upstream.body?.getReader();
    if (!reader) {
      response.end();
      return;
    }
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) response.write(Buffer.from(value));
    }
    response.end();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[camo-proxy] voice failed:', message);
    if (!response.headersSent) sendJson(response, 502, { error: message });
    else response.end();
  }
};

const handleSpeechToText: Handler = async (request, response, context) => {
  const mimeType = request.headers['content-type'] ?? 'audio/webm';
  const audio = await readBody(request);
  if (audio.length === 0) {
    sendJson(response, 400, { error: 'no audio received' });
    return;
  }

  try {
    if (context.voice.available) {
      sendJson(response, 200, { text: await context.voice.transcribe(audio, mimeType) });
      return;
    }
    if (context.whisper.available) {
      sendJson(response, 200, { text: await context.whisper.transcribe(audio, mimeType) });
      return;
    }
    sendJson(response, 503, { error: 'no speech-to-text provider is configured' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[camo-proxy] speech-to-text failed:', message);
    sendJson(response, 502, { error: message });
  }
};

const ROUTES: Record<string, { method: string; handler: Handler }> = {
  config: { method: 'GET', handler: handleConfig },
  chat: { method: 'POST', handler: handleChat },
  voice: { method: 'POST', handler: handleVoice },
  stt: { method: 'POST', handler: handleSpeechToText },
};

function describeStartup(context: ProxyContext): string {
  const parts = [`brain=${context.brainId}`];
  parts.push(`voice=${context.voice.available ? 'elevenlabs' : 'off'}`);
  parts.push(
    `stt=${context.voice.available ? 'elevenlabs' : context.whisper.available ? 'whisper' : 'browser-only'}`,
  );
  return parts.join(' ');
}

export function dialogueProxyPlugin(): Plugin {
  let context: ProxyContext;

  const middleware = async (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): Promise<void> => {
    const url = request.url ?? '';
    if (!url.startsWith(ROUTE_PREFIX)) {
      next();
      return;
    }

    const name = url.slice(ROUTE_PREFIX.length).split('?')[0];
    const route = ROUTES[name];
    if (!route) {
      sendJson(response, 404, { error: `unknown proxy route "${name}"` });
      return;
    }
    if (request.method !== route.method) {
      sendJson(response, 405, { error: `${name} expects ${route.method}` });
      return;
    }

    try {
      await route.handler(request, response, context);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[camo-proxy] ${name} failed:`, message);
      if (!response.headersSent) sendJson(response, 500, { error: message });
      else response.end();
    }
  };

  return {
    name: 'camo-dialogue-proxy',
    // Only server hooks are declared, so nothing in this file reaches the client
    // bundle. That is what keeps the keys it reads out of the browser.
    configResolved(config) {
      const env = loadServerEnv(config.mode, config.root);
      context = {
        env,
        brainId: selectBrainId(env),
        voice: new ElevenLabsVoice(env.ELEVENLABS_API_KEY),
        whisper: new WhisperTranscriber(env.OPENAI_API_KEY),
      };
      config.logger.info(`  camo dialogue: ${describeStartup(context)}`);
    },
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
