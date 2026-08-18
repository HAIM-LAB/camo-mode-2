import { describe, expect, it, vi } from 'vitest';
import { createEmotionVector, EmotionState, EMOTION_SPECS } from '../src/dialogue/emotion';
import {
  evaluateCondition,
  resolveEdge,
  StoryletRuntime,
  type EvaluationContext,
  type IntentClassifier,
} from '../src/dialogue/interpreter';
import { loadLibrary } from '../src/dialogue/library';
import { findNode, isDeterministic, parseStorylet, type StoryletGraph } from '../src/dialogue/storylet';

const library = loadLibrary();
const camoGraph = library.storylets.find((graph) => graph.id === 'camo-check-in')!;
const camo = library.personas.find((persona) => persona.id === 'camo')!;

/** A graph whose only job is to make the hybrid rule easy to reason about. */
const testGraph: StoryletGraph = parseStorylet(
  {
    id: 'test-graph',
    title: 'Hybrid resolution fixture',
    entryNode: 'beat',
    variables: [
      { name: 'closeness', initial: 0.4, min: 0, max: 1, description: 'test variable here' },
    ],
    flags: [{ name: 'noticed', initial: false, description: 'test flag here' }],
    nodes: [
      {
        id: 'beat',
        beatGoal: 'stand in one place for the test',
        constraints: ['say very little'],
        edges: [
          {
            id: 'by-state',
            to: 'landed',
            why: 'deterministic edge for the test',
            when: { kind: 'variable', name: 'closeness', op: '>=', value: 0.9 },
            effects: { flags: [{ name: 'noticed', value: true }] },
          },
          {
            id: 'by-intent-a',
            to: 'landed',
            why: 'first intent edge for the test',
            when: { kind: 'intent', description: 'the child offers to help with something' },
            effects: {
              emotion: { warmth: 0.2 },
              variables: [{ name: 'closeness', delta: 0.3 }],
            },
          },
          {
            id: 'by-intent-b',
            to: 'other',
            why: 'second intent edge for the test',
            when: { kind: 'intent', description: 'the child wants to talk about something else' },
          },
        ],
      },
      { id: 'landed', beatGoal: 'arrive somewhere else', constraints: ['stop'], terminal: true, edges: [] },
      { id: 'other', beatGoal: 'arrive somewhere different', constraints: ['stop'], terminal: true, edges: [] },
    ],
  },
  'test-graph',
);

const beat = findNode(testGraph, 'beat');

function context(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    turnsInNode: 1,
    variables: { closeness: 0.4 },
    flags: { noticed: false },
    emotion: createEmotionVector(),
    ...overrides,
  };
}

const never: IntentClassifier = async () => undefined;

describe('condition evaluation', () => {
  it('decides state conditions without a model', () => {
    expect(
      evaluateCondition({ kind: 'variable', name: 'closeness', op: '>=', value: 0.4 }, context()),
    ).toBe(true);
    expect(evaluateCondition({ kind: 'turnsInNode', op: '>', value: 2 }, context())).toBe(false);
    expect(evaluateCondition({ kind: 'flag', name: 'noticed', value: false }, context())).toBe(true);
    expect(
      evaluateCondition(
        { kind: 'emotion', dimension: 'anger', op: '>=', value: 0.75 },
        context({ emotion: createEmotionVector({ anger: 0.8 }) }),
      ),
    ).toBe(true);
  });

  it('combines conditions with all, any, and not', () => {
    const high = { kind: 'variable', name: 'closeness', op: '>=', value: 0.4 } as const;
    const low = { kind: 'variable', name: 'closeness', op: '<', value: 0.1 } as const;
    expect(evaluateCondition({ kind: 'all', of: [high, low] }, context())).toBe(false);
    expect(evaluateCondition({ kind: 'any', of: [high, low] }, context())).toBe(true);
    expect(evaluateCondition({ kind: 'not', of: low }, context())).toBe(true);
  });

  it('classifies intent conditions as non-deterministic', () => {
    expect(isDeterministic({ kind: 'intent', description: 'the child offers help' })).toBe(false);
    expect(isDeterministic({ kind: 'turnsInNode', op: '>=', value: 1 })).toBe(true);
    expect(
      isDeterministic({
        kind: 'all',
        of: [{ kind: 'turnsInNode', op: '>=', value: 1 }, { kind: 'intent', description: 'anything at all' }],
      }),
    ).toBe(false);
  });
});

describe('hybrid edge resolution', () => {
  const base = {
    node: beat,
    childUtterance: 'I could help',
    characterReply: 'Hm.',
  };

  it('prefers a satisfied state condition and never calls the classifier', async () => {
    const classifier = vi.fn(never);
    const resolution = await resolveEdge({
      ...base,
      context: context({ variables: { closeness: 0.95 } }),
      classifier,
    });

    expect(resolution.method).toBe('condition');
    expect(resolution.edge?.id).toBe('by-state');
    expect(classifier).not.toHaveBeenCalled();
  });

  it('falls through to classification only for edges that need free text', async () => {
    const classifier = vi.fn<IntentClassifier>(async () => 'by-intent-b');
    const resolution = await resolveEdge({ ...base, context: context(), classifier });

    expect(resolution.method).toBe('classification');
    expect(resolution.edge?.id).toBe('by-intent-b');
    expect(classifier).toHaveBeenCalledTimes(1);
    // Only this node's intent edges are ever offered.
    expect(classifier.mock.calls[0][0].candidates.map((candidate) => candidate.id)).toEqual([
      'by-intent-a',
      'by-intent-b',
    ]);
  });

  it('holds position when the classifier names an edge this beat does not permit', async () => {
    const resolution = await resolveEdge({
      ...base,
      context: context(),
      classifier: async () => 'by-state',
    });

    expect(resolution.edge).toBeUndefined();
    expect(resolution.method).toBe('stay');
    expect(resolution.reason).toMatch(/does not permit/);
    expect(resolution.classifierAnswer).toBe('by-state');
  });

  it('holds position when the classifier invents an edge id', async () => {
    const resolution = await resolveEdge({
      ...base,
      context: context(),
      classifier: async () => 'child-becomes-a-wizard',
    });
    expect(resolution.edge).toBeUndefined();
    expect(resolution.method).toBe('stay');
  });

  it('holds position when the classifier throws', async () => {
    const resolution = await resolveEdge({
      ...base,
      context: context(),
      classifier: async () => {
        throw new Error('provider exploded');
      },
    });

    expect(resolution.edge).toBeUndefined();
    expect(resolution.method).toBe('stay');
    expect(resolution.reason).toMatch(/classifier failed \(provider exploded\)/);
  });

  it('holds position when no classifier is available at all', async () => {
    const resolution = await resolveEdge({ ...base, context: context() });
    expect(resolution.method).toBe('stay');
    expect(resolution.offered).toEqual(['by-intent-a', 'by-intent-b']);
  });

  it('holds position when the classifier answers none', async () => {
    const resolution = await resolveEdge({ ...base, context: context(), classifier: async () => 'none' });
    expect(resolution.method).toBe('stay');
    expect(resolution.reason).toMatch(/no clear intent/);
  });

  it('only ever returns an edge declared on the current node', async () => {
    const declared = new Set(beat.edges.map((edge) => edge.id));
    const answers = ['by-intent-a', 'by-intent-b', 'by-state', 'nonsense', 'none', ''];

    for (const answer of answers) {
      const resolution = await resolveEdge({
        ...base,
        context: context(),
        classifier: async () => answer,
      });
      if (resolution.edge) expect(declared.has(resolution.edge.id)).toBe(true);
    }
  });
});

describe('storylet runtime', () => {
  it('applies exit, edge, and entry effects on a transition', async () => {
    const runtime = new StoryletRuntime(testGraph, createEmotionVector({ warmth: 0.5 }));
    expect(runtime.nodeId).toBe('beat');
    expect(runtime.variables.closeness).toBeCloseTo(0.4);

    await runtime.advance({
      childUtterance: 'I could help',
      characterReply: 'Hm.',
      classifier: async () => 'by-intent-a',
    });

    expect(runtime.nodeId).toBe('landed');
    expect(runtime.variables.closeness).toBeCloseTo(0.7);
    expect(runtime.emotion.vector.warmth).toBeGreaterThan(0.5);
    expect(runtime.lastEdge).toMatchObject({
      fromNodeId: 'beat',
      toNodeId: 'landed',
      edgeId: 'by-intent-a',
      method: 'classification',
    });
  });

  it('resets the turn counter on arrival and counts turns while held', async () => {
    const runtime = new StoryletRuntime(testGraph, createEmotionVector());
    await runtime.advance({ childUtterance: 'hello', characterReply: 'hi', classifier: never });
    expect(runtime.nodeId).toBe('beat');
    expect(runtime.turnsInNode).toBe(1);

    await runtime.advance({ childUtterance: 'still here', characterReply: 'hm', classifier: never });
    expect(runtime.turnsInNode).toBe(2);
  });

  it('clamps variables to their declared range', async () => {
    const runtime = new StoryletRuntime(testGraph, createEmotionVector());
    runtime.applyEffect({ variables: [{ name: 'closeness', delta: 99 }] });
    expect(runtime.variables.closeness).toBe(1);
    runtime.applyEffect({ variables: [{ name: 'closeness', set: -99 }] });
    expect(runtime.variables.closeness).toBe(0);
  });

  it('walks the shipped Camo graph on deterministic edges alone', async () => {
    const runtime = new StoryletRuntime(camoGraph, camo.emotionBaseline);
    const visited = [runtime.nodeId];

    for (let turn = 0; turn < 8; turn += 1) {
      await runtime.advance({ childUtterance: 'okay', characterReply: 'hm', classifier: never });
      if (visited.at(-1) !== runtime.nodeId) visited.push(runtime.nodeId);
    }

    // No classifier ever answers, so only the authored safety nets fire. The
    // conversation still reaches a resting beat rather than getting stuck.
    expect(visited).toEqual(['approach', 'greeting', 'topic-raised', 'tension-surfaces', 'deflection']);
    expect(runtime.flags['topic-known']).toBe(true);
  });

  it('leaves a mark on scene state when the child offers to help', async () => {
    const runtime = new StoryletRuntime(camoGraph, camo.emotionBaseline);
    const before = runtime.variables.closeness;

    // Walk to the beat where the offer is possible.
    for (let turn = 0; turn < 4; turn += 1) {
      await runtime.advance({ childUtterance: 'okay', characterReply: 'hm', classifier: never });
    }
    expect(runtime.nodeId).toBe('tension-surfaces');

    await runtime.advance({
      childUtterance: 'I can talk to them',
      characterReply: 'I do not know what to do.',
      classifier: async () => 'child-offers-help',
    });

    expect(runtime.nodeId).toBe('repair');
    expect(runtime.flags['child-offered-help']).toBe(true);
    expect(runtime.variables.closeness).toBeGreaterThan(before);
  });
});

describe('emotion state', () => {
  it('drifts back toward baseline at each dimensions own rate', () => {
    const state = new EmotionState(createEmotionVector({ hurt: 0.2, anger: 0.2 }));
    state.apply({ hurt: 0.6, anger: 0.6 });
    const beforeHurt = state.vector.hurt;
    const beforeAnger = state.vector.anger;

    state.decay();

    // Anger fades faster than hurt, which is the authored difference.
    expect(EMOTION_SPECS.anger.decayPerTurn).toBeGreaterThan(EMOTION_SPECS.hurt.decayPerTurn);
    expect(beforeAnger - state.vector.anger).toBeGreaterThan(beforeHurt - state.vector.hurt);
  });

  it('clamps to 0..1 and reports only salient dimensions', () => {
    const state = new EmotionState(createEmotionVector());
    state.apply({ joy: 5, hurt: -5 });
    expect(state.vector.joy).toBe(1);
    expect(state.vector.hurt).toBe(0);

    const salient = state.salient().map((entry) => entry.dimension);
    expect(salient).toContain('joy');
    expect(salient).toContain('hurt');
    expect(salient).not.toContain('warmth');
  });
});
