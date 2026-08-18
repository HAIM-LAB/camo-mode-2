/**
 * Voice playback, browser side.
 *
 * Fed one gated sentence at a time rather than one whole reply, for two reasons:
 *
 * 1. **Latency.** Sentence one is synthesized and playing while sentence two is
 *    still being generated. Waiting for a complete reply would hand back all the
 *    time the LPU path is meant to win.
 * 2. **Safety.** The same gated sentence queue drives the panel and the
 *    synthesizer, so nothing is ever spoken that the moderation hook has not
 *    already passed.
 *
 * Every failure path is silent to the child. If the key is missing, the request
 * fails, or the browser blocks autoplay, the text is still there and complete.
 */

import type { PersonaVoice } from './persona';

export const PROXY_VOICE_URL = '/__camo/voice';

export interface VoicePlayerOptions {
  url?: string;
  fetchImpl?: typeof fetch;
  /** Reports a change in speaking state so the UI can show it. */
  onSpeakingChange?: (speaking: boolean) => void;
}

interface QueueItem {
  text: string;
  voice: PersonaVoice;
}

export class VoicePlayer {
  private queue: QueueItem[] = [];
  private draining = false;
  private current?: HTMLAudioElement;
  private objectUrls: string[] = [];
  private mutedState = false;
  private generation = 0;

  constructor(
    private available: boolean,
    private readonly options: VoicePlayerOptions = {},
  ) {}

  get muted(): boolean {
    return this.mutedState;
  }

  get enabled(): boolean {
    return this.available && !this.mutedState;
  }

  setAvailable(available: boolean): void {
    this.available = available;
  }

  setMuted(muted: boolean): void {
    this.mutedState = muted;
    if (muted) this.stop();
  }

  /** Queues one already-moderated sentence. Returns immediately. */
  speak(text: string, voice: PersonaVoice | undefined): void {
    if (!this.enabled || !voice || !text.trim()) return;
    this.queue.push({ text: text.trim(), voice });
    if (!this.draining) void this.drain(this.generation);
  }

  /** Cancels everything in flight. Called when the child leaves or interrupts. */
  stop(): void {
    this.generation += 1;
    this.queue = [];
    if (this.current) {
      this.current.pause();
      this.current.src = '';
      this.current = undefined;
    }
    this.releaseUrls();
    this.options.onSpeakingChange?.(false);
  }

  private releaseUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  private async drain(generation: number): Promise<void> {
    this.draining = true;
    this.options.onSpeakingChange?.(true);

    try {
      while (this.queue.length > 0 && generation === this.generation) {
        const item = this.queue.shift();
        if (!item) break;
        await this.playOne(item, generation);
      }
    } finally {
      this.draining = false;
      if (generation === this.generation) this.options.onSpeakingChange?.(false);
    }
  }

  private async playOne(item: QueueItem, generation: number): Promise<void> {
    try {
      const fetchImpl = this.options.fetchImpl ?? fetch;
      const response = await fetchImpl(this.options.url ?? PROXY_VOICE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          text: item.text,
          voiceId: item.voice.voiceId,
          modelId: item.voice.modelId,
          stability: item.voice.stability,
          similarityBoost: item.voice.similarityBoost,
          speed: item.voice.speed,
        }),
      });
      if (!response.ok) {
        // A missing key reports 503 here; turn voice off rather than retrying
        // once per sentence for the rest of the session.
        if (response.status === 503) this.available = false;
        return;
      }
      if (generation !== this.generation) return;

      const blob = await response.blob();
      if (generation !== this.generation) return;

      const url = URL.createObjectURL(blob);
      this.objectUrls.push(url);
      const audio = new Audio(url);
      this.current = audio;
      await audio.play();
      await new Promise<void>((resolve) => {
        audio.addEventListener('ended', () => resolve(), { once: true });
        audio.addEventListener('error', () => resolve(), { once: true });
      });
    } catch {
      // Autoplay blocks, aborted fetches, decode failures: all silent. Text stands
      // on its own and the child never learns the audio was meant to be there.
    } finally {
      if (this.current) {
        URL.revokeObjectURL(this.current.src);
        this.objectUrls = this.objectUrls.filter((url) => url !== this.current?.src);
        this.current = undefined;
      }
    }
  }
}
