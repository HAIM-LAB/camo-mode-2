/**
 * End-to-end through the whole pipeline with the keyless mock brain: the same
 * path `npm run dev` takes with an empty `.env`.
 */

import { describe, expect, it } from 'vitest';
import { activeBand } from '../src/dialogue/audience';
import { createMockScript, loadLibrary, storyletFor } from '../src/dialogue/library';
import { MockBrain } from '../src/dialogue/providers/mock';
import type { ChatBrain, ChatChunk, ChatRequest } from '../src/dialogue/providers/types';
import { NullModeration, PermissiveModeration, type ModerationProvider } from '../src/dialogue/safety';
import { DialogueSession } from '../src/dialogue/session';

const library = loadLibrary();
const band = activeBand(library.audience);

function personaById(id: string) {
  const persona = library.personas.find((item) => item.id === id);
  if (!persona) throw new Error(`no persona ${id}`);
  return persona;
}

interface Harness {
  session: DialogueSession;
  sentences: string[];
  replies: string[];
  prompts: string[];
}

function harness(
  personaId: string,
  options: { moderation?: ModerationProvider; brain?: ChatBrain; sceneFacts?: string[] } = {},
): Harness {
  const persona = personaById(personaId);
  const sentences: string[] = [];
  const replies: string[] = [];
  const prompts: string[] = [];

  const session = new DialogueSession({
    persona,
    graph: storyletFor(library, persona),
    band,
    brain: options.brain ?? new MockBrain(createMockScript(library)),
    moderation: options.moderation ?? new PermissiveModeration(),
    sceneFacts: (options.sceneFacts ?? ['carrying-nothing', 'first-meeting']) as never,
    events: {
      onSentence: (text) => sentences.push(text),
      onReplyComplete: (text) => replies.push(text),
      onInspectorUpdate: () => prompts.push(''),
    },
  });

  return { session, sentences, replies, prompts };
}

describe('a keyless conversation walks the example storylet', () => {
  it('greets without moving the graph, then advances on the child turns', async () => {
    const { session, replies } = harness('camo');
    const camo = personaById('camo');

    await session.greet();
    expect(session.runtime.nodeId).toBe('approach');
    expect(camo.offlineLines.approach).toContain(replies[0]);

    await session.say('hello Camo');
    expect(session.runtime.nodeId).toBe('greeting');
    expect(session.runtime.lastDecision?.method).toBe('condition');

    await session.say('just looking around');
    // One quiet turn is not enough for the safety net, and no intent matched.
    expect(session.runtime.nodeId).toBe('greeting');
    expect(session.runtime.lastDecision?.method).toBe('stay');

    await session.say('what are we doing today');
    expect(session.runtime.nodeId).toBe('topic-raised');
    expect(session.runtime.flags['topic-known']).toBe(true);
  });

  it('reaches the topic early when the child asks about the friends', async () => {
    const { session } = harness('camo');
    await session.greet();
    await session.say('hi');
    await session.say('what happened with your friends?');

    expect(session.runtime.nodeId).toBe('topic-raised');
    expect(session.runtime.lastDecision?.method).toBe('classification');
    expect(session.runtime.lastEdge?.edgeId).toBe('child-asks-about-friends');
  });

  it('takes the repair branch and leaves a mark on scene state', async () => {
    const { session } = harness('camo');
    await session.greet();
    for (const turn of ['hi', 'what happened with your friends?', 'that sounds hard']) {
      await session.say(turn);
    }
    expect(session.runtime.nodeId).toBe('tension-surfaces');

    const before = session.runtime.variables.closeness;
    await session.say('I can talk to them');

    expect(session.runtime.nodeId).toBe('repair');
    expect(session.runtime.flags['child-offered-help']).toBe(true);
    expect(session.runtime.variables.closeness).toBeGreaterThan(before);
    expect(session.runtime.emotion.vector.warmth).toBeGreaterThan(personaById('camo').emotionBaseline.warmth);
  });

  it('honours "not now" with its own beat and no retry', async () => {
    const { session, replies } = harness('camo');
    await session.greet();
    for (const turn of ['hi', 'what happened?', 'oh']) await session.say(turn);
    expect(session.runtime.nodeId).toBe('tension-surfaces');

    await session.say('no, not now');
    expect(session.runtime.nodeId).toBe('withdrawal');
    expect(session.runtime.flags['child-stepped-back']).toBe(true);

    // The reply is written at the beat the character was standing on, so the
    // withdrawal voice arrives on the next turn - and then stays there. It is a
    // terminal beat with no edges, so nothing can drag the child back.
    await session.say('okay');
    expect(personaById('camo').offlineLines.withdrawal).toContain(replies.at(-1));
    expect(session.runtime.nodeId).toBe('withdrawal');
    expect(session.runtime.node.edges).toHaveLength(0);
  });

  it('never repeats the same line twice running, however long the chat runs', async () => {
    const { session, replies } = harness('camo');
    await session.greet();
    for (const turn of ['hi', 'ok', 'mm', 'right', 'yeah', 'sure', 'ok', 'mm']) {
      await session.say(turn);
    }
    for (let index = 1; index < replies.length; index += 1) {
      expect(replies[index], `turn ${index} repeated the previous line`).not.toBe(replies[index - 1]);
    }
  });

  it('classifies the child, never the character it is standing in front of', async () => {
    // Regression: the classifier once received the character's own line in the
    // same user message as the child's, so Camo saying "I don't know why" read
    // as the CHILD saying "I don't know" and pushed the story to withdrawal.
    const { session } = harness('camo');
    await session.greet();
    for (const turn of ['hi', 'what happened with your friends?', 'that sounds hard']) {
      await session.say(turn);
    }
    expect(session.runtime.nodeId).toBe('tension-surfaces');

    // Camo's own lines at this beat include "I don't know what to do either"
    // and "I keep looking at the door. I don't know why." Neither may steer this.
    await session.say('I can talk to them');
    expect(session.runtime.nodeId).toBe('repair');
    expect(session.runtime.lastEdge?.edgeId).toBe('child-offers-help');
  });

  it('follows a change of subject without steering back', async () => {
    const { session } = harness('camo');
    await session.greet();
    for (const turn of ['hi', 'tell me what happened', 'ok']) await session.say(turn);

    await session.say("let's play with the ball");
    expect(session.runtime.nodeId).toBe('deflection');
    expect(session.runtime.lastEdge?.edgeId).toBe('child-changes-subject');
  });
});

describe('scene state reaches the conversation', () => {
  it('turns Friend B away when the child walks up holding the ball', async () => {
    const withBall = harness('friend-b', { sceneFacts: ['carrying-ball', 'first-meeting'] });
    await withBall.session.greet();
    await withBall.session.say('hi');

    // The carrying-ball reaction pushes anger over the graph's threshold, so the
    // authored deterministic guard sends him to "not now". Not every approach works.
    expect(withBall.session.runtime.nodeId).toBe('withdrawal');
    expect(withBall.session.runtime.flags.declined).toBe(true);
    expect(withBall.session.runtime.lastDecision?.method).toBe('condition');
  });

  it('lets the same child in when their hands are empty', async () => {
    const empty = harness('friend-b', { sceneFacts: ['carrying-nothing', 'first-meeting'] });
    await empty.session.greet();
    await empty.session.say('hi');

    expect(empty.session.runtime.nodeId).toBe('greeting');
    expect(empty.session.runtime.flags.declined).toBe(false);
  });
});

describe('streaming and the safety gate', () => {
  it('emits sentence by sentence rather than one finished block', async () => {
    const { session, sentences } = harness('camo');
    await session.greet();
    await session.say('hi');

    expect(sentences.length).toBeGreaterThan(1);
    expect(sentences.every((sentence) => /[.!?…]$/.test(sentence))).toBe(true);
  });

  it('deflects in character when the child turn is blocked, and does not move the graph', async () => {
    const { session, replies } = harness('camo');
    await session.greet();
    const nodeBefore = session.runtime.nodeId;
    const turnsBefore = session.runtime.turnsInNode;

    await session.say('I live at 42 Oak Street');

    const camo = personaById('camo');
    expect(camo.deflections).toContain(replies.at(-1));
    expect(replies.at(-1)).not.toMatch(/sorry|error|cannot|blocked|moderation/i);
    expect(session.runtime.nodeId).toBe(nodeBefore);
    expect(session.runtime.turnsInNode).toBe(turnsBefore);
  });

  it('never shows a character sentence the reply hook rejected', async () => {
    const blockAll: ModerationProvider = {
      id: 'block-all',
      label: 'Blocks everything',
      available: true,
      check: async (_text, ctx) =>
        ctx.stage === 'character-reply' ? { allowed: false, category: 'test' } : { allowed: true },
    };

    const { session, sentences, replies } = harness('camo', { moderation: blockAll });
    await session.greet();

    const camo = personaById('camo');
    // The only thing that reached the child is the in-character deflection.
    expect(sentences).toHaveLength(1);
    expect(camo.deflections).toContain(sentences[0]);
    expect(camo.offlineLines.approach).not.toContain(replies.at(-1));
  });

  it('deflects rather than surfacing a provider failure to the child', async () => {
    const broken: ChatBrain = {
      id: 'broken',
      label: 'Broken',
      available: true,
      defaultParams: { model: 'x', maxOutputTokens: 10 },
      // eslint-disable-next-line require-yield
      async *stream(_request: ChatRequest): AsyncGenerator<ChatChunk> {
        throw new Error('upstream 500');
      },
    };

    const { session, replies } = harness('camo', { brain: broken, moderation: new NullModeration() });
    await session.greet();

    expect(personaById('camo').deflections).toContain(replies.at(-1));
    expect(replies.at(-1)).not.toMatch(/500|upstream|error/i);
  });

  /**
   * A provider that dies *after* it has already streamed usable text is the case
   * live runs actually produce (a dropped connection, a token budget hit, an
   * upstream 5xx mid-response). The child keeps the sentences that already
   * arrived and the panel must not be left thinking forever.
   */
  it('keeps the text already streamed when the provider dies mid-reply', async () => {
    const diesMidway: ChatBrain = {
      id: 'flaky',
      label: 'Flaky',
      available: true,
      defaultParams: { model: 'x', maxOutputTokens: 40 },
      async *stream(_request: ChatRequest): AsyncGenerator<ChatChunk> {
        yield { delta: 'Oh, hello there. ' };
        yield { delta: 'I am glad you came over. ' };
        throw new Error('upstream 503 mid-stream');
      },
    };

    const { session, replies, sentences } = harness('camo', {
      brain: diesMidway,
      moderation: new NullModeration(),
    });
    await session.greet();

    // What arrived before the failure is kept, and nothing leaks the error.
    expect(sentences.length).toBeGreaterThan(0);
    expect(replies.at(-1)).toContain('Oh, hello there.');
    expect(replies.at(-1)).not.toMatch(/503|upstream|error/i);

    // The panel is released rather than stranded on a thinking state.
    expect(session.thinking).toBe(false);

    // The transcript holds the partial reply, so the child can carry on talking.
    expect(session.transcript.at(-1)?.role).toBe('character');
  });

  it('releases the panel when the provider fails before any text arrives', async () => {
    const broken: ChatBrain = {
      id: 'broken',
      label: 'Broken',
      available: true,
      defaultParams: { model: 'x', maxOutputTokens: 10 },
      // eslint-disable-next-line require-yield
      async *stream(_request: ChatRequest): AsyncGenerator<ChatChunk> {
        throw new Error('upstream 500');
      },
    };

    const { session } = harness('camo', { brain: broken, moderation: new NullModeration() });
    await session.greet();
    await session.say('are you okay?');

    expect(session.thinking).toBe(false);
  });
});

describe('inspector view', () => {
  it('reports position, mood, why the last edge fired, and the assembled prompt', async () => {
    const { session } = harness('camo');
    await session.greet();
    await session.say('hi Camo');

    const snapshot = session.inspect();
    expect(snapshot.nodeId).toBe('greeting');
    expect(snapshot.beatGoal.length).toBeGreaterThan(0);
    expect(snapshot.lastDecision?.method).toBe('condition');
    expect(snapshot.lastEdge?.edgeId).toBe('greeted');
    expect(snapshot.lastPrompt).toContain('# BEAT:');
    expect(Object.keys(snapshot.emotion)).toHaveLength(6);
    expect(snapshot.brainLabel).toMatch(/Mock/);
  });

  it('records which scene reactions fired at greeting time', () => {
    const { session } = harness('friend-b', { sceneFacts: ['carrying-ball', 'first-meeting'] });
    expect(session.inspect().sceneReactions.join(' ')).toMatch(/carrying-ball/);
  });
});

describe('leaving', () => {
  it('stops immediately and keeps nothing hanging', async () => {
    const { session } = harness('camo');
    await session.greet();
    session.leave();
    expect(session.thinking).toBe(false);
  });

  it('keeps the character where they were when the child comes back', async () => {
    const persona = personaById('camo');
    const graph = storyletFor(library, persona);
    const first = harness('camo');
    await first.session.greet();
    await first.session.say('hi');
    first.session.leave();

    const resumed = new DialogueSession({
      persona,
      graph,
      runtime: first.session.runtime,
      band,
      brain: new MockBrain(createMockScript(library)),
      moderation: new PermissiveModeration(),
      sceneFacts: ['carrying-nothing', 'returning'],
    });

    expect(resumed.runtime.nodeId).toBe('greeting');
    expect(resumed.transcript).toHaveLength(0);
  });
});
