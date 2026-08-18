/**
 * Speech-to-text seam.
 *
 * Same discipline as the chat providers: one interface, more than one adapter,
 * keyless-degradable. The typed path is the primary input and is complete on its
 * own; the microphone sits behind a toggle that is off by default.
 *
 * Two adapters ship:
 *
 * - `BrowserSpeechRecognizer` - the Web Speech API. No key, no proxy, no audio
 *   leaves the page except to the browser's own recognizer. Gives live partial
 *   text, which is what makes dictation feel responsive.
 * - `ProxySpeechRecognizer` - records with MediaRecorder and posts the clip to
 *   `/__camo/stt`, which transcribes it server-side with ElevenLabs Scribe or
 *   Whisper. Final text only, but works in browsers with no Web Speech support.
 *
 * Selection prefers the browser adapter when available: it is lower latency, it
 * needs no key, and it keeps the audio local.
 */

export interface RecognitionCallbacks {
  /** Live text while the child is still speaking. May be revised. */
  onPartial?: (text: string) => void;
  /** Settled text for the turn. */
  onFinal: (text: string) => void;
  /** Recognizer gave up. The UI drops back to typing without comment. */
  onError?: (reason: string) => void;
  onStateChange?: (listening: boolean) => void;
}

export interface SpeechRecognizer {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  /** True when this adapter reports text before the child stops speaking. */
  readonly supportsPartials: boolean;
  start(callbacks: RecognitionCallbacks): Promise<void>;
  stop(): void;
}

/* -------------------------------------------------------------------------- */
/* Web Speech API                                                             */
/* -------------------------------------------------------------------------- */

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  0: { transcript: string };
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: { length: number; [index: number]: SpeechRecognitionResultLike };
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

function browserRecognitionConstructor(): SpeechRecognitionConstructor | undefined {
  const scope = globalThis as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

export class BrowserSpeechRecognizer implements SpeechRecognizer {
  readonly id = 'web-speech';
  readonly label = 'Browser speech recognition';
  readonly supportsPartials = true;
  readonly available: boolean;

  private recognition?: SpeechRecognitionLike;

  constructor() {
    this.available = Boolean(browserRecognitionConstructor());
  }

  async start(callbacks: RecognitionCallbacks): Promise<void> {
    const Constructor = browserRecognitionConstructor();
    if (!Constructor) {
      callbacks.onError?.('this browser has no speech recognition');
      return;
    }

    const recognition = new Constructor();
    this.recognition = recognition;
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = false;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let partial = '';
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) callbacks.onFinal(text);
        } else {
          partial += result[0].transcript;
        }
      }
      if (partial.trim()) callbacks.onPartial?.(partial.trim());
    };
    recognition.onerror = (event) => callbacks.onError?.(event.error ?? 'recognition failed');
    recognition.onend = () => {
      this.recognition = undefined;
      callbacks.onStateChange?.(false);
    };

    recognition.start();
    callbacks.onStateChange?.(true);
  }

  stop(): void {
    this.recognition?.stop();
    this.recognition = undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Server proxy (ElevenLabs Scribe / Whisper)                                 */
/* -------------------------------------------------------------------------- */

export const PROXY_STT_URL = '/__camo/stt';

export class ProxySpeechRecognizer implements SpeechRecognizer {
  readonly id = 'proxy-stt';
  readonly label = 'Server speech-to-text';
  readonly supportsPartials = false;

  private recorder?: MediaRecorder;
  private stream?: MediaStream;

  constructor(
    readonly available: boolean,
    private readonly url: string = PROXY_STT_URL,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async start(callbacks: RecognitionCallbacks): Promise<void> {
    if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices) {
      callbacks.onError?.('this browser cannot record audio');
      return;
    }

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      callbacks.onError?.('microphone permission was declined');
      return;
    }

    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(this.stream);
    this.recorder = recorder;

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      this.releaseStream();
      callbacks.onStateChange?.(false);
      if (chunks.length === 0) return;

      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      try {
        const response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': blob.type },
          body: blob,
        });
        if (!response.ok) {
          callbacks.onError?.(`transcription unavailable (HTTP ${response.status})`);
          return;
        }
        const parsed = (await response.json()) as { text?: unknown };
        const text = typeof parsed.text === 'string' ? parsed.text.trim() : '';
        if (text) callbacks.onFinal(text);
        else callbacks.onError?.('nothing was heard');
      } catch (error) {
        callbacks.onError?.(error instanceof Error ? error.message : 'transcription failed');
      }
    };

    recorder.start();
    callbacks.onStateChange?.(true);
  }

  stop(): void {
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
    else this.releaseStream();
    this.recorder = undefined;
  }

  private releaseStream(): void {
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = undefined;
  }
}

/** Nothing available. The mic button hides rather than offering a broken control. */
export class NullSpeechRecognizer implements SpeechRecognizer {
  readonly id = 'none';
  readonly label = 'Typing only';
  readonly available = false;
  readonly supportsPartials = false;

  async start(callbacks: RecognitionCallbacks): Promise<void> {
    callbacks.onError?.('no speech recognition is available');
  }

  stop(): void {}
}

/**
 * Picks the recognizer. Browser first (no key, lowest latency, audio stays
 * local), then the server proxy, then nothing.
 */
export function createSpeechRecognizer(serverAvailable: boolean): SpeechRecognizer {
  const browser = new BrowserSpeechRecognizer();
  if (browser.available) return browser;
  if (serverAvailable) return new ProxySpeechRecognizer(true);
  return new NullSpeechRecognizer();
}
