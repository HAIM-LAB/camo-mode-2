import { describe, expect, it } from 'vitest';
import { activeBand, type AudienceBand } from '../src/dialogue/audience';
import { EmotionState } from '../src/dialogue/emotion';
import { loadLibrary, storyletFor } from '../src/dialogue/library';
import { MARKERS, readMarker } from '../src/dialogue/markers';
import type { Persona } from '../src/dialogue/persona';
import {
  bandForTrait,
  buildClassifierSystemPrompt,
  buildMessages,
  buildSystemPrompt,
  parseClassifierAnswer,
  translateTraits,
  UNIVERSAL_RULES,
} from '../src/dialogue/prompt';
import { findNode } from '../src/dialogue/storylet';

const library = loadLibrary();
const camo = library.personas.find((persona) => persona.id === 'camo')!;
const graph = storyletFor(library, camo);
const band = activeBand(library.audience);

function promptFor(persona: Persona, nodeId: string, emotion = new EmotionState(persona.emotionBaseline)) {
  return buildSystemPrompt({
    persona,
    node: findNode(storyletFor(library, persona), nodeId),
    emotion,
    band,
  });
}

describe('trait to behaviour translation', () => {
  it('bands values rather than passing numbers through', () => {
    expect(bandForTrait(0.05)).toBe('very low');
    expect(bandForTrait(0.3)).toBe('low');
    expect(bandForTrait(0.5)).toBe('moderate');
    expect(bandForTrait(0.72)).toBe('high');
    expect(bandForTrait(0.95)).toBe('very high');
  });

  it('turns every OCEAN value into a concrete behaviour plus the author note', () => {
    const translations = translateTraits(camo);
    expect(translations).toHaveLength(5);

    const agreeableness = translations.find((item) => item.trait === 'agreeableness')!;
    expect(agreeableness.band).toBe('very high');
    expect(agreeableness.behaviour).toMatch(/give in quickly to keep the peace/);
    expect(agreeableness.note).toBe(camo.traits.agreeableness.note);
  });

  it('produces different behaviour text for opposite ends of the same trait', () => {
    const friendB = library.personas.find((persona) => persona.id === 'friend-b')!;
    const camoAgreeable = translateTraits(camo).find((item) => item.trait === 'agreeableness')!;
    const theoAgreeable = translateTraits(friendB).find((item) => item.trait === 'agreeableness')!;

    expect(theoAgreeable.band).toBe('low');
    expect(theoAgreeable.behaviour).not.toBe(camoAgreeable.behaviour);
    expect(theoAgreeable.behaviour).toMatch(/hold your ground/);
  });

  it('never leaks a raw trait number into the assembled prompt', () => {
    const prompt = promptFor(camo, 'greeting');
    for (const [name, trait] of Object.entries(camo.traits)) {
      expect(prompt, `${name} value leaked`).not.toContain(String(trait.value));
    }
    expect(prompt).not.toMatch(/openness|conscientiousness|neuroticism/i);
  });
});

describe('assembled system prompt', () => {
  it('carries the machine-readable markers the mock brain routes on', () => {
    const prompt = promptFor(camo, 'tension-surfaces');
    expect(readMarker(prompt, MARKERS.character)).toBe('camo');
    expect(readMarker(prompt, MARKERS.beat)).toBe('tension-surfaces');
  });

  it('shows only the current beat, never the graph', () => {
    const prompt = promptFor(camo, 'greeting');
    expect(prompt).toContain(findNode(graph, 'greeting').beatGoal);

    for (const node of graph.nodes) {
      if (node.id === 'greeting') continue;
      expect(prompt, `beat "${node.id}" leaked into the prompt`).not.toContain(node.beatGoal);
    }
    // Nor any edge, target, or condition.
    expect(prompt).not.toContain('child-offers-help');
    expect(prompt).not.toContain('withdrawal');
  });

  it('applies the authored age band rather than a hardcoded reading level', () => {
    const prompt = promptFor(camo, 'greeting');
    expect(prompt).toContain(`about ${band.maxSentenceWords} words`);
    expect(prompt).toContain(`at most ${band.maxSentencesPerReply} sentence`);
    expect(prompt).toContain(band.vocabulary);
  });

  it('retunes the whole prompt from one band swap', () => {
    const older: AudienceBand = library.audience.bands.find((item) => item.id === '8-10')!;
    const prompt = buildSystemPrompt({
      persona: camo,
      node: findNode(graph, 'greeting'),
      emotion: new EmotionState(camo.emotionBaseline),
      band: older,
    });
    expect(prompt).toContain(`about ${older.maxSentenceWords} words`);
    expect(prompt).not.toContain(`about ${band.maxSentenceWords} words`);
  });

  it('carries the non-negotiable product rules and the persona boundaries', () => {
    const prompt = promptFor(camo, 'tension-surfaces');
    for (const rule of UNIVERSAL_RULES) expect(prompt).toContain(rule);
    for (const boundary of camo.boundaries) expect(prompt).toContain(boundary);
  });

  it('describes the live emotion vector, not the baseline', () => {
    const emotion = new EmotionState(camo.emotionBaseline);
    const calm = promptFor(camo, 'tension-surfaces', emotion);
    emotion.apply({ hurt: 0.8, joy: -0.5 });
    const upset = promptFor(camo, 'tension-surfaces', emotion);

    expect(calm).not.toBe(upset);
    expect(upset).toMatch(/still feels wronged/);
  });

  it('includes scene state when the room supplies it', () => {
    const prompt = buildSystemPrompt({
      persona: camo,
      node: findNode(graph, 'greeting'),
      emotion: new EmotionState(camo.emotionBaseline),
      band,
      sceneNote: 'The child is carrying the ball.',
    });
    expect(prompt).toContain('The child is carrying the ball.');
  });
});

describe('bounded history', () => {
  it('sends only the most recent exchanges plus the new turn', () => {
    const history = Array.from({ length: 20 }, (_value, index) => ({
      role: index % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `turn ${index}`,
    }));
    const messages = buildMessages(history, 'what about the ball?', 6);

    expect(messages).toHaveLength(7);
    expect(messages[0].content).toBe('turn 14');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'what about the ball?' });
  });
});

describe('classifier prompt', () => {
  const candidates = [
    { id: 'child-offers-help', description: 'the child offers to help' },
    { id: 'child-steps-back', description: 'the child says not now' },
  ];

  it('offers only the permitted edges, plus none', () => {
    const prompt = buildClassifierSystemPrompt({
      personaId: 'camo',
      nodeId: 'tension-surfaces',
      characterName: 'Camo',
      characterReply: 'I do not know what to do either.',
      candidates,
    });
    expect(prompt).toContain('"child-offers-help"');
    expect(prompt).toContain('"child-steps-back"');
    expect(prompt).toContain('"none"');
    expect(prompt).not.toContain('child-changes-subject');
    expect(readMarker(prompt, MARKERS.beat)).toBe('tension-surfaces');
    // The character's own line is context, and is never the thing being labelled.
    expect(prompt).toContain('I do not know what to do either.');
  });

  it('reads an edge id back out of a messy answer', () => {
    expect(parseClassifierAnswer('{"edge":"child-offers-help"}')).toBe('child-offers-help');
    expect(parseClassifierAnswer('Sure! {"edge": "none"} hope that helps')).toBe('none');
    expect(parseClassifierAnswer('no json here')).toBeUndefined();
    expect(parseClassifierAnswer('{"edge": 12}')).toBeUndefined();
  });
});
