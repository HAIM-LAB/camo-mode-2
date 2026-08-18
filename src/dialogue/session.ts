/**
 * One conversation with one character.
 *
 * This is the piece that puts the others in order, and the order is the design:
 *
 *   child speaks
 *     -> moderation hook 1 (before any prompt is assembled)
 *     -> prompt assembled from persona + emotion vector + THIS node only
 *     -> brain streams deltas
 *     -> deltas buffered into whole sentences
 *     -> moderation hook 2 per sentence, BEFORE display and BEFORE synthesis
 *     -> gated sentence goes to the panel and the voice queue together
 *     -> storylet interpreter resolves an edge and applies its effects
 *
 * Nothing here knows which provider is answering, whether voice is on, or what
 * the graph looks like beyond the node it is standing on.
 */

import type { AudienceBand } from './audience';
import type { EmotionVector } from './emotion';
import {
  StoryletRuntime,
  type EdgeResolution,
  type IntentClassifier,
  type TransitionRecord,
} from './interpreter';
import type { Persona, SceneFact } from './persona';
import {
  buildClassifierSystemPrompt,
  buildMessages,
  buildSystemPrompt,
  parseClassifierAnswer,
} from './prompt';
import { collect, type ChatBrain, type ChatMessage } from './providers/types';
import { takeCompleteSentences, type ModerationProvider } from './safety';
import type { StoryletGraph } from './storylet';
import type { VoicePlayer } from './voice';

export type SpeakerRole = 'child' | 'character';

export interface TranscriptEntry {
  role: SpeakerRole;
  text: string;
}

/** What the debug inspector reads. Never rendered in a demo run. */
export interface InspectorSnapshot {
  personaId: string;
  characterName: string;
  storyletId: string;
  nodeId: string;
  beatGoal: string;
  turnsInNode: number;
  emotion: EmotionVector;
  variables: Readonly<Record<string, number>>;
  flags: Readonly<Record<string, boolean>>;
  lastEdge?: TransitionRecord;
  lastDecision?: EdgeResolution;
  lastPrompt: string;
  brainLabel: string;
  sceneReactions: string[];
}

export interface SessionEvents {
  onThinking?: (thinking: boolean) => void;
  /** One moderated sentence, ready to display. */
  onSentence?: (text: string) => void;
  onReplyComplete?: (fullText: string) => void;
  onTransition?: (resolution: EdgeResolution) => void;
  onInspectorUpdate?: () => void;
}

export interface SessionOptions {
  persona: Persona;
  graph: StoryletGraph;
  band: AudienceBand;
  brain: ChatBrain;
  moderation: ModerationProvider;
  voice?: VoicePlayer;
  /**
   * Reuses a character's existing position, mood, and variables. Leaving and
   * coming back should not wipe what happened; the transcript starts fresh but
   * the relationship does not.
   */
  runtime?: StoryletRuntime;
  /** Facts true in the room when the child walked up. */
  sceneFacts: readonly SceneFact[];
  /** One line of world state for the prompt, e.g. "The child is holding the ball." */
  sceneNote?: string;
  events?: SessionEvents;
}

const MAX_HISTORY_MESSAGES = 8;

export class DialogueSession {
  readonly runtime: StoryletRuntime;
  readonly persona: Persona;

  private readonly history: ChatMessage[] = [];
  private readonly transcriptEntries: TranscriptEntry[] = [];
  private readonly appliedReactions: string[] = [];
  private lastPrompt = '';
  private deflectionIndex = 0;
  private abort?: AbortController;
  private busy = false;

  constructor(private readonly options: SessionOptions) {
    this.persona = options.persona;
    this.runtime =
      options.runtime ?? new StoryletRuntime(options.graph, options.persona.emotionBaseline);

    // Scene reactions run before the first word: walking up holding the ball two
    // friends fell out over is not the same as walking up empty-handed.
    for (const reaction of options.persona.sceneReactions) {
      if (!options.sceneFacts.includes(reaction.when)) continue;
      this.runtime.emotion.apply(reaction.emotion);
      this.appliedReactions.push(`${reaction.when}: ${reaction.note}`);
    }
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.transcriptEntries;
  }

  get thinking(): boolean {
    return this.busy;
  }

  /** The character's opening line. No child turn yet, so the graph does not move. */
  async greet(): Promise<void> {
    await this.respond('(The child comes over and stands next to you.)', { advance: false });
  }

  /** One full exchange. */
  async say(childText: string): Promise<void> {
    const text = childText.trim();
    if (!text || this.busy) return;

    this.transcriptEntries.push({ role: 'child', text });
    this.options.events?.onInspectorUpdate?.();

    // Hook 1: the child's turn, before any prompt exists.
    const verdict = await this.options.moderation.check(text, {
      stage: 'child-turn',
      personaId: this.persona.id,
      nodeId: this.runtime.nodeId,
      audienceBandId: this.options.band.id,
    });

    if (!verdict.allowed) {
      // In character, no error, no notice, and the story does not move.
      this.emitDeflection();
      return;
    }

    await this.respond(text, { advance: true });
  }

  /** Ends the conversation immediately. Nothing is owed and nothing is saved off. */
  leave(): void {
    this.abort?.abort();
    this.abort = undefined;
    this.busy = false;
    this.options.voice?.stop();
    this.options.events?.onThinking?.(false);
  }

  inspect(): InspectorSnapshot {
    return {
      personaId: this.persona.id,
      characterName: this.persona.identity.name,
      storyletId: this.options.graph.id,
      nodeId: this.runtime.nodeId,
      beatGoal: this.runtime.node.beatGoal,
      turnsInNode: this.runtime.turnsInNode,
      emotion: this.runtime.emotion.vector,
      variables: this.runtime.variables,
      flags: this.runtime.flags,
      lastEdge: this.runtime.lastEdge,
      lastDecision: this.runtime.lastDecision,
      lastPrompt: this.lastPrompt,
      brainLabel: this.options.brain.label,
      sceneReactions: this.appliedReactions,
    };
  }

  private async respond(childText: string, options: { advance: boolean }): Promise<void> {
    this.busy = true;
    this.abort = new AbortController();
    this.options.events?.onThinking?.(true);

    const system = buildSystemPrompt({
      persona: this.persona,
      node: this.runtime.node,
      emotion: this.runtime.emotion,
      band: this.options.band,
      sceneNote: this.options.sceneNote,
    });
    this.lastPrompt = system;

    const messages = buildMessages(this.history, childText, MAX_HISTORY_MESSAGES);
    let reply = '';
    let blocked = false;

    try {
      const stream = this.options.brain.stream({
        system,
        messages,
        task: 'dialogue',
        params: this.options.brain.defaultParams,
        signal: this.abort.signal,
      });

      let buffer = '';
      for await (const chunk of stream) {
        buffer += chunk.delta;
        const { sentences, rest } = takeCompleteSentences(buffer);
        buffer = rest;
        for (const sentence of sentences) {
          if (!(await this.emitSentence(sentence))) {
            blocked = true;
            break;
          }
          reply += (reply ? ' ' : '') + sentence;
        }
        if (blocked) break;
      }

      if (!blocked && buffer.trim()) {
        if (await this.emitSentence(buffer.trim())) {
          reply += (reply ? ' ' : '') + buffer.trim();
        } else {
          blocked = true;
        }
      }
    } catch (error) {
      // Provider failures are an operator problem, never a child-facing one.
      console.warn(
        `[Camo] dialogue provider failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (!reply) {
        this.emitDeflection();
        this.finish();
        return;
      }
    }

    if (blocked) {
      this.emitDeflection();
      this.finish();
      return;
    }

    this.history.push({ role: 'user', content: childText });
    this.history.push({ role: 'assistant', content: reply });
    this.transcriptEntries.push({ role: 'character', text: reply });
    this.options.events?.onReplyComplete?.(reply);

    if (options.advance) {
      const resolution = await this.runtime.advance({
        childUtterance: childText,
        characterReply: reply,
        classifier: this.classifier,
      });
      this.options.events?.onTransition?.(resolution);
    }

    this.finish();
  }

  private finish(): void {
    this.busy = false;
    this.abort = undefined;
    this.options.events?.onThinking?.(false);
    this.options.events?.onInspectorUpdate?.();
  }

  /** Hook 2. Returns false when the sentence must not reach the child. */
  private async emitSentence(sentence: string): Promise<boolean> {
    const verdict = await this.options.moderation.check(sentence, {
      stage: 'character-reply',
      personaId: this.persona.id,
      nodeId: this.runtime.nodeId,
      audienceBandId: this.options.band.id,
    });
    if (!verdict.allowed) return false;

    this.options.events?.onSentence?.(sentence);
    this.options.voice?.speak(sentence, this.persona.voice);
    return true;
  }

  private emitDeflection(): void {
    const lines = this.persona.deflections;
    const line = lines[this.deflectionIndex % lines.length] ?? 'Hm. What else is going on?';
    this.deflectionIndex += 1;

    this.options.voice?.stop();
    this.transcriptEntries.push({ role: 'character', text: line });
    this.options.events?.onSentence?.(line);
    this.options.events?.onReplyComplete?.(line);
    this.options.voice?.speak(line, this.persona.voice);
  }

  /**
   * The classification half of the hybrid rule. It is handed only the edges the
   * graph permits; the interpreter re-checks the answer regardless, so a model
   * that invents an id changes nothing.
   */
  private readonly classifier: IntentClassifier = async (input) => {
    const allowed = input.candidates.map((candidate) => candidate.id);
    const system = buildClassifierSystemPrompt({
      personaId: this.persona.id,
      nodeId: input.nodeId,
      characterName: this.persona.identity.name,
      characterReply: input.characterReply,
      candidates: input.candidates,
    });

    const text = await collect(
      this.options.brain.stream({
        system,
        // The child's words alone. See `buildClassifierSystemPrompt`.
        messages: [{ role: 'user', content: input.childUtterance }],
        task: 'classification',
        params: {
          ...this.options.brain.defaultParams,
          maxOutputTokens: 40,
          temperature: 0,
        },
        json: { schemaName: 'edge-choice', allowedValues: [...allowed, 'none'] },
      }),
    );

    return parseClassifierAnswer(text);
  };
}
