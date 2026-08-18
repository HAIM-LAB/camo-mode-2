/**
 * Server-side voice and transcription helpers.
 *
 * These run in the node process that serves the app, never in the browser, so
 * the only thing under test here is request shaping - no key material is
 * involved and none is asserted on.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_VOICE_MODEL,
  ElevenLabsVoice,
  transcriptionFilename,
  WhisperTranscriber,
} from '../server/voice';

describe('transcription upload filename', () => {
  it('derives the extension from what the browser actually recorded', () => {
    // Chrome's MediaRecorder.
    expect(transcriptionFilename('audio/webm')).toBe('turn.webm');
    expect(transcriptionFilename('audio/webm;codecs=opus')).toBe('turn.webm');
    // Safari's MediaRecorder, which would previously have been mislabelled.
    expect(transcriptionFilename('audio/mp4')).toBe('turn.mp4');
    expect(transcriptionFilename('audio/mp4;codecs=mp4a.40.2')).toBe('turn.mp4');
    // Plain uploads.
    expect(transcriptionFilename('audio/wav')).toBe('turn.wav');
    expect(transcriptionFilename('audio/mpeg')).toBe('turn.mp3');
  });

  it('is case and whitespace insensitive', () => {
    expect(transcriptionFilename('  AUDIO/WAV  ')).toBe('turn.wav');
  });

  it('falls back to webm for anything unrecognised rather than sending no extension', () => {
    expect(transcriptionFilename('application/octet-stream')).toBe('turn.webm');
    expect(transcriptionFilename('')).toBe('turn.webm');
  });
});

describe('availability follows the key, not the code path', () => {
  it('reports unavailable with no key so the proxy can degrade', () => {
    expect(new ElevenLabsVoice(undefined).available).toBe(false);
    expect(new ElevenLabsVoice('   ').available).toBe(false);
    expect(new WhisperTranscriber(undefined).available).toBe(false);
  });

  it('reports available once a key is present', () => {
    expect(new ElevenLabsVoice('xi-test').available).toBe(true);
    expect(new WhisperTranscriber('sk-test').available).toBe(true);
  });

  it('refuses to call upstream without a key instead of sending an empty header', async () => {
    await expect(new WhisperTranscriber(undefined).transcribe(new Uint8Array(), 'audio/webm')).rejects.toThrow(
      /OPENAI_API_KEY/,
    );
    await expect(
      new ElevenLabsVoice(undefined).synthesize({ text: 'hi', voiceId: 'v' }),
    ).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });
});

describe('ElevenLabs request shaping', () => {
  it('asks for the streaming endpoint so playback can start on the first bytes', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('audio', { status: 200 }));
    const voice = new ElevenLabsVoice('xi-test', fetchImpl);

    await voice.synthesize({ text: 'hello there', voiceId: 'voice-abc' });

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/text-to-speech/voice-abc/stream');
    expect(JSON.parse(String(init.body)).model_id).toBe(DEFAULT_VOICE_MODEL);
  });

  it('escapes a voice id rather than pasting it into the path', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('audio', { status: 200 }));
    await new ElevenLabsVoice('xi-test', fetchImpl).synthesize({
      text: 'hi',
      voiceId: 'a/../b',
    });

    expect(fetchImpl.mock.calls[0][0]).toContain('a%2F..%2Fb');
  });

  it('surfaces an upstream failure to the proxy, which turns voice off quietly', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('quota exceeded', { status: 401 }));
    await expect(
      new ElevenLabsVoice('xi-test', fetchImpl).synthesize({ text: 'hi', voiceId: 'v' }),
    ).rejects.toThrow(/401/);
  });
});
