/**
 * The seam between the 3D scene and the dialogue layer.
 *
 * Everything the scene needs is here: when to offer the Talk button, what is
 * true in the room when the child walks up, and what to remember afterwards.
 * `app.ts` calls four methods and reads one snapshot; it knows nothing about
 * providers, personas, or the graph.
 *
 * Two product rules are enforced here rather than being left to the UI:
 * walking out of range ends the conversation with no nagging, and a character's
 * position, mood, and relationship variables survive the child leaving.
 */

import { activeBand, type AudienceBand } from './audience';
import {
  createMockScript,
  loadLibrary,
  personaForEntity,
  storyletFor,
  type DialogueLibrary,
} from './library';
import { StoryletRuntime } from './interpreter';
import type { Persona, SceneFact } from './persona';
import { MockBrain } from './providers/mock';
import { fetchRuntimeConfig, OFFLINE_CONFIG, ProxyBrain, type RuntimeConfig } from './providers/proxy';
import type { ChatBrain } from './providers/types';
import { createModeration, type ModerationProvider } from './safety';
import { DialogueSession } from './session';
import { createSpeechRecognizer, type SpeechRecognizer } from './speech';
import { DialoguePanel } from './ui/panel';
import { DialogueInspector } from './ui/inspector';
import { VoicePlayer } from './voice';

/** Distance past which the conversation simply ends. */
export const LEAVE_RADIUS = 3.4;

export interface DialogueCandidate {
  entityId: string;
  label: string;
  distance: number;
}

export interface SceneSnapshotForDialogue {
  carried: 'ball' | 'block' | null;
}

export interface DialogueControllerOptions {
  /** Nearest character the child could talk to right now, if any. */
  getCandidate: () => DialogueCandidate | undefined;
  getSceneState: () => SceneSnapshotForDialogue;
  /** Called when the conversation changes a flag the scene should react to. */
  onSceneFlagsChanged: (flags: Readonly<Record<string, boolean>>) => void;
  /** Lets the scene drop held movement keys when focus moves into the panel. */
  onFocusCaptured: () => void;
}

export interface DialogueSnapshot {
  available: boolean;
  brain: string;
  voice: 'off' | 'on' | 'muted';
  speechToText: string;
  open: boolean;
  characterId: string | null;
  nodeId: string | null;
  turns: number;
  lastEdge: string | null;
  lastEdgeMethod: string | null;
  flags: Record<string, boolean>;
  variables: Record<string, number>;
  loadError: string | null;
}

export class DialogueController {
  private library?: DialogueLibrary;
  private band?: AudienceBand;
  private brain?: ChatBrain;
  private moderation: ModerationProvider = createModeration('permissive');
  private voice = new VoicePlayer(false);
  private recognizer: SpeechRecognizer = createSpeechRecognizer(false);
  private config: RuntimeConfig = OFFLINE_CONFIG;
  private panel?: DialoguePanel;
  private inspector?: DialogueInspector;
  private talkLabel?: HTMLElement;

  private readonly runtimes = new Map<string, StoryletRuntime>();
  private readonly met = new Set<string>();
  private readonly sceneFlags: Record<string, boolean> = {};
  private session?: DialogueSession;
  private activeEntityId?: string;
  private talkButton?: HTMLButtonElement;
  private loadError?: string;
  private ready = false;

  constructor(private readonly options: DialogueControllerOptions) {}

  /**
   * Loads authored data and resolves the runtime configuration. A broken data
   * file disables dialogue and reports why; it never takes the scene down with it.
   */
  async init(): Promise<void> {
    this.talkButton = (document.getElementById('talk-button') as HTMLButtonElement | null) ?? undefined;
    this.talkLabel = document.getElementById('talk-label') ?? undefined;
    this.talkButton?.addEventListener('click', () => this.open());

    try {
      this.library = loadLibrary();
      this.band = activeBand(this.library.audience);
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      console.error('[Camo] Dialogue data failed to load. Conversation is disabled.\n', this.loadError);
      return;
    }

    this.config = await fetchRuntimeConfig();
    this.brain =
      this.config.brain.id === 'mock'
        ? // No key anywhere: run the deterministic brain in the page. No network,
          // no proxy dependency, and the authored offline lines drive the demo.
          new MockBrain(createMockScript(this.library), 24)
        : new ProxyBrain({
            id: this.config.brain.id,
            label: this.config.brain.label,
            defaultParams: { model: this.config.brain.model, maxOutputTokens: 220, temperature: 0.85 },
          });

    this.moderation = createModeration(this.config.moderation.id);
    this.voice = new VoicePlayer(this.config.voice.available);
    this.recognizer = createSpeechRecognizer(this.config.speechToText.available);

    this.panel = new DialoguePanel({
      onSubmit: (text) => this.sendChildTurn(text),
      onLeave: () => this.close(),
      onToggleMute: (muted) => this.voice.setMuted(muted),
      onToggleMic: (listening) => void this.toggleMic(listening),
    });
    this.inspector = new DialogueInspector(() => this.session?.inspect());
    this.ready = true;
  }

  /** Per frame. Offers or withdraws the Talk button, and ends a walked-away chat. */
  update(): void {
    const candidate = this.options.getCandidate();

    if (this.session && this.activeEntityId) {
      const distance = candidate?.entityId === this.activeEntityId ? candidate.distance : Infinity;
      // Walking off is a complete, valid way to end a conversation.
      if (distance > LEAVE_RADIUS) this.close();
      return;
    }

    if (!this.talkButton) return;
    const offer = this.ready && Boolean(candidate);
    this.talkButton.hidden = !offer;
    if (offer && candidate) {
      if (this.talkLabel) this.talkLabel.textContent = `Talk to ${candidate.label}`;
      this.talkButton.dataset.entity = candidate.entityId;
    }
  }

  /** Opens a conversation with whoever is nearest. Safe to call when nobody is. */
  open(): void {
    if (!this.ready || this.session) return;
    const candidate = this.options.getCandidate();
    if (!candidate || !this.library || !this.band || !this.brain || !this.panel) return;

    const persona = personaForEntity(this.library, candidate.entityId);
    if (!persona) return;

    const graph = storyletFor(this.library, persona);
    let runtime = this.runtimes.get(persona.id);
    if (!runtime) {
      runtime = new StoryletRuntime(graph, persona.emotionBaseline);
      this.runtimes.set(persona.id, runtime);
    }

    this.session = new DialogueSession({
      persona,
      graph,
      runtime,
      band: this.band,
      brain: this.brain,
      moderation: this.moderation,
      voice: this.voice,
      sceneFacts: this.sceneFacts(persona),
      sceneNote: this.sceneNote(),
      events: {
        onThinking: (thinking) => this.panel?.setThinking(thinking),
        onSentence: (text) => this.panel?.addCharacterSentence(text),
        onReplyComplete: () => {
          this.panel?.endCharacterTurn();
          this.publishFlags();
        },
        onTransition: () => this.inspector?.update(),
        onInspectorUpdate: () => this.inspector?.update(),
      },
    });

    this.activeEntityId = candidate.entityId;
    this.met.add(persona.id);
    if (this.talkButton) this.talkButton.hidden = true;

    this.panel.open({
      characterName: persona.identity.name,
      entityId: candidate.entityId,
      voiceAvailable: this.config.voice.available,
      micAvailable: this.recognizer.available,
    });
    this.panel.setMuted(this.voice.muted);
    this.options.onFocusCaptured();

    // The panel wraps the child's own input; the character speaks first.
    void this.session.greet();
    this.inspector?.update();
  }

  close(): void {
    if (!this.session) return;
    this.recognizer.stop();
    this.session.leave();
    this.publishFlags();
    this.session = undefined;
    this.activeEntityId = undefined;
    this.panel?.close();
    this.inspector?.update();
  }

  snapshot(): DialogueSnapshot {
    const inspection = this.session?.inspect();
    return {
      available: this.ready,
      brain: this.config.brain.id,
      voice: this.config.voice.available ? (this.voice.muted ? 'muted' : 'on') : 'off',
      speechToText: this.recognizer.available ? this.recognizer.id : 'none',
      open: Boolean(this.session),
      characterId: inspection?.personaId ?? null,
      nodeId: inspection?.nodeId ?? null,
      turns: inspection?.turnsInNode ?? 0,
      lastEdge: inspection?.lastEdge?.edgeId ?? null,
      lastEdgeMethod: inspection?.lastDecision?.method ?? null,
      flags: { ...this.sceneFlags, ...(inspection?.flags ?? {}) },
      variables: { ...(inspection?.variables ?? {}) },
      loadError: this.loadError ?? null,
    };
  }

  /**
   * The child's bubble is shown immediately, before any provider or moderation
   * work. A child should always see their own words land, even on a turn the
   * safety gate goes on to deflect.
   */
  private sendChildTurn(text: string): void {
    if (!this.session || this.session.thinking) return;
    this.panel?.addChildTurn(text);
    void this.session.say(text);
  }

  private sceneFacts(persona: Persona): SceneFact[] {
    const carried = this.options.getSceneState().carried;
    const facts: SceneFact[] = [
      carried === 'ball' ? 'carrying-ball' : carried === 'block' ? 'carrying-block' : 'carrying-nothing',
      this.met.has(persona.id) ? 'returning' : 'first-meeting',
    ];
    if (this.sceneFlags['topic-known']) facts.push('topic-known');
    return facts;
  }

  private sceneNote(): string | undefined {
    const carried = this.options.getSceneState().carried;
    if (carried === 'ball') return 'The child is carrying the ball.';
    if (carried === 'block') return 'The child is carrying a building block.';
    return undefined;
  }

  /** Lifts conversation flags into scene state so the room can respond to them. */
  private publishFlags(): void {
    const flags = this.session?.runtime.flags;
    if (!flags) return;
    let changed = false;
    for (const [name, value] of Object.entries(flags)) {
      if (this.sceneFlags[name] === value) continue;
      this.sceneFlags[name] = value;
      changed = true;
    }
    if (changed) this.options.onSceneFlagsChanged({ ...this.sceneFlags });
  }

  private async toggleMic(listening: boolean): Promise<void> {
    if (!listening) {
      this.recognizer.stop();
      return;
    }
    await this.recognizer.start({
      onPartial: (text) => this.panel?.setPartialSpeech(text),
      onFinal: (text) => {
        this.panel?.setPartialSpeech('');
        this.sendChildTurn(text);
      },
      onError: (reason) => {
        // Typing always works; a failed mic never becomes a child-facing problem.
        console.info(`[Camo] speech input unavailable: ${reason}`);
        this.panel?.setMicListening(false);
      },
      onStateChange: (active) => this.panel?.setMicListening(active),
    });
  }
}
