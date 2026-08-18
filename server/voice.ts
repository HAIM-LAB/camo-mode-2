/**
 * ElevenLabs voice, server-side.
 *
 * Streaming endpoint on purpose: playback starts on the first audio bytes rather
 * than after the whole reply is synthesized. Latency is the entire point of the
 * eventual LPU path, so the audio leg must not become the new bottleneck.
 *
 * Text never depends on this. If the key is missing, the request fails, or the
 * network drops, the dialogue panel is unaffected - voice is an enhancement.
 */

import { resolveFetch } from '../src/dialogue/providers/types';

export interface VoiceRequest {
  text: string;
  voiceId: string;
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  speed?: number;
}

/** Low-latency default. Overridable per persona via `voice.modelId`. */
export const DEFAULT_VOICE_MODEL = 'eleven_flash_v2_5';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

/**
 * Upload filename for a recorded turn, derived from the browser's mime type.
 *
 * Both transcription APIs infer the container from the filename extension, and
 * browsers do not agree on what MediaRecorder produces: Chrome gives
 * `audio/webm`, Safari gives `audio/mp4`. Sending everything as `turn.webm`
 * happens to work while Chrome is the only client and breaks quietly elsewhere.
 */
export function transcriptionFilename(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase();
  const extension =
    {
      'audio/webm': 'webm',
      'video/webm': 'webm',
      'audio/mp4': 'mp4',
      'audio/m4a': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/ogg': 'ogg',
      'audio/flac': 'flac',
    }[base] ?? 'webm';
  return `turn.${extension}`;
}

export class ElevenLabsVoice {
  readonly available: boolean;

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string | undefined,
    fetchImpl?: typeof fetch,
  ) {
    this.available = Boolean(apiKey && apiKey.trim());
    this.fetchImpl = resolveFetch(fetchImpl);
  }

  /** Returns the raw upstream response so the proxy can pipe it straight through. */
  async synthesize(request: VoiceRequest, signal?: AbortSignal): Promise<Response> {
    if (!this.apiKey) throw new Error('ELEVENLABS_API_KEY is not set');

    const url = `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(request.voiceId)}/stream?output_format=mp3_44100_128`;
    const response = await this.fetchImpl(url, {
      method: 'POST',
      signal,
      headers: {
        'xi-api-key': this.apiKey,
        'content-type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text: request.text,
        model_id: request.modelId ?? DEFAULT_VOICE_MODEL,
        voice_settings: {
          stability: request.stability ?? 0.5,
          similarity_boost: request.similarityBoost ?? 0.75,
          ...(request.speed === undefined ? {} : { speed: request.speed }),
        },
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`ElevenLabs HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    return response;
  }

  /** ElevenLabs Scribe. Same key, so speech-to-text comes free when voice is on. */
  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    if (!this.apiKey) throw new Error('ELEVENLABS_API_KEY is not set');

    const form = new FormData();
    form.append('file', new Blob([audio as BlobPart], { type: mimeType }), transcriptionFilename(mimeType));
    form.append('model_id', 'scribe_v1');

    const response = await this.fetchImpl(`${ELEVENLABS_BASE}/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.apiKey },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`ElevenLabs STT HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const parsed = (await response.json()) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  }
}

/** OpenAI Whisper, used when an OpenAI key is present but an ElevenLabs one is not. */
export class WhisperTranscriber {
  readonly available: boolean;

  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly apiKey: string | undefined,
    fetchImpl?: typeof fetch,
  ) {
    this.available = Boolean(apiKey && apiKey.trim());
    this.fetchImpl = resolveFetch(fetchImpl);
  }

  async transcribe(audio: Uint8Array, mimeType: string): Promise<string> {
    if (!this.apiKey) throw new Error('OPENAI_API_KEY is not set');

    const form = new FormData();
    form.append('file', new Blob([audio as BlobPart], { type: mimeType }), transcriptionFilename(mimeType));
    form.append('model', 'whisper-1');

    const response = await this.fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}` },
      body: form,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => response.statusText);
      throw new Error(`Whisper HTTP ${response.status}: ${detail.slice(0, 300)}`);
    }
    const parsed = (await response.json()) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text : '';
  }
}
