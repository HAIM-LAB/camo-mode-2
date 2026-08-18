/**
 * Prompt assembly.
 *
 * Two jobs, both deliberately narrow:
 *
 * 1. **Traits become behaviour, never numbers.** A model handed
 *    `agreeableness: 0.82` has to invent what that means. A model told "looks for
 *    a way to agree and steers away from conflict" does not. Every OCEAN value is
 *    banded and translated here, then paired with the author's own note.
 * 2. **The model sees one beat.** Never the graph, never the other nodes, never
 *    where the conversation could go. That bound is what will keep a small open
 *    model on the rails when the captain moves to Gemma or Llama on an LPU.
 */

import type { AudienceBand } from './audience';
import { EMOTION_SPECS, EmotionState } from './emotion';
import { MARKERS } from './markers';
import { OCEAN_TRAITS, type OceanTrait, type Persona } from './persona';
import type { ChatMessage } from './providers/types';
import type { StoryletNode } from './storylet';

export type TraitBand = 'very low' | 'low' | 'moderate' | 'high' | 'very high';

export function bandForTrait(value: number): TraitBand {
  if (value < 0.2) return 'very low';
  if (value < 0.4) return 'low';
  if (value < 0.6) return 'moderate';
  if (value < 0.8) return 'high';
  return 'very high';
}

/**
 * Concrete, observable behaviour per trait per band. Written in second person and
 * in plain words on purpose: this text is read by the model *and* by the captain
 * tuning a character in the inspector.
 */
const TRAIT_BEHAVIOUR: Readonly<Record<OceanTrait, Record<TraitBand, string>>> = Object.freeze({
  openness: {
    'very low': 'you stick to what you already know, and new ideas make you uneasy',
    low: 'you prefer the familiar and try new things only when someone else starts',
    moderate: 'you will join a new idea once somebody else brings it up',
    high: 'you bring up imaginative ideas without being asked',
    'very high': 'you leap to inventive ideas and change one halfway through',
  },
  conscientiousness: {
    'very low': 'you forget what you were doing and leave things half finished',
    low: 'you are loose about rules and plans and do not mind mess',
    moderate: 'you keep a plan in mind but bend it easily',
    high: 'you want things done properly and you notice when they are not',
    'very high': 'you insist on the right order and get stuck on whether it was fair',
  },
  extraversion: {
    'very low': 'you say as little as you can and wait to be asked',
    low: 'you answer briefly and rarely start a new subject',
    moderate: 'you talk readily but you do not take over',
    high: 'you start conversations and you fill silences',
    'very high': 'you talk a lot and fast, and you hop between subjects',
  },
  agreeableness: {
    'very low': 'you push back hard and you do not soften it',
    low: 'you disagree out loud and you hold your ground',
    moderate: 'you will disagree, but you try to stay friendly while you do it',
    high: 'you look for a way to agree and you steer away from conflict',
    'very high': 'you give in quickly to keep the peace, even when you are hurt',
  },
  neuroticism: {
    'very low': 'you stay calm even when something goes wrong',
    low: 'you shake off upsets quickly',
    moderate: 'you get upset, and then you settle again',
    high: 'you are easily rattled and you stay upset for a while',
    'very high': 'small things feel very big to you and you get overwhelmed fast',
  },
});

export interface TraitTranslation {
  trait: OceanTrait;
  value: number;
  band: TraitBand;
  behaviour: string;
  note: string;
}

/** The trait-to-behaviour translation, exposed so tests and the inspector can read it. */
export function translateTraits(persona: Persona): TraitTranslation[] {
  return OCEAN_TRAITS.map((trait) => {
    const authored = persona.traits[trait];
    const band = bandForTrait(authored.value);
    return {
      trait,
      value: authored.value,
      band,
      behaviour: TRAIT_BEHAVIOUR[trait][band],
      note: authored.note,
    };
  });
}

function describeEmotions(emotion: EmotionState): string[] {
  const salient = emotion.salient();
  if (salient.length === 0) return ['You feel steady and ordinary right now.'];
  return salient.slice(0, 3).map((entry) => {
    const spec = EMOTION_SPECS[entry.dimension];
    return `You ${entry.high ? spec.high : spec.low}.`;
  });
}

function describeAudience(band: AudienceBand): string[] {
  return [
    `You are talking to a child in the ${band.ageRange} age range. ${band.vocabulary}`,
    `Keep sentences to about ${band.maxSentenceWords} words or fewer.`,
    `Say at most ${band.maxSentencesPerReply} sentence(s) per turn.`,
    ...band.avoid.map((item) => `Do not use ${item}.`),
    ...band.guidance,
  ];
}

/**
 * Rules that apply to every character in every beat. These encode product
 * constraints that are not negotiable, so they live in code next to the builder
 * rather than in an authored file any single persona could drop.
 */
export const UNIVERSAL_RULES: readonly string[] = Object.freeze([
  'The child can walk away mid-sentence. That is completely fine. Never ask them to come back, never guilt them, and never comment on them leaving.',
  'Never tell the child they have to fix this, make the friends make up, apologise, or say the right thing. There is no right answer here.',
  'Never offer or mention points, scores, stars, levels, prizes, timers, or anything the child could win or unlock.',
  'You are allowed to say no, to hesitate, or to say "not now". You do not have to be helpful.',
  'Speak only your own words out loud. No narration, no actions in asterisks, no stage directions, no quotation marks around the whole reply.',
]);

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n');
}

export interface SystemPromptInput {
  persona: Persona;
  node: StoryletNode;
  emotion: EmotionState;
  band: AudienceBand;
  /** One line of world state, e.g. "The child is holding the ball." */
  sceneNote?: string;
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  const { persona, node, emotion, band } = input;
  const { identity } = persona;

  const traitLines = translateTraits(persona).map(
    (translation) => `- ${translation.note} In practice, ${translation.behaviour}.`,
  );

  const speechLines = [
    `Vocabulary: ${identity.speech.vocabularyLevel}`,
    `Sentence length: ${identity.speech.sentenceLength}`,
    ...(identity.speech.verbalTics.length > 0
      ? [`Things you say sometimes: ${identity.speech.verbalTics.map((tic) => `"${tic}"`).join(', ')}`]
      : []),
    `You never say: ${identity.speech.neverSays.join('; ')}`,
  ];

  return [
    `${MARKERS.character} ${persona.id}`,
    `${MARKERS.beat} ${node.id}`,
    '',
    `You are ${identity.name}, age ${identity.age}. ${identity.background}`,
    `Your part in this scene: ${identity.roleInScene}`,
    '',
    '## How you talk',
    bullets(speechLines),
    '',
    '## How you behave',
    traitLines.join('\n'),
    '',
    '## How you feel right now',
    bullets(describeEmotions(emotion)),
    '',
    '## This moment',
    `What you are trying to do: ${node.beatGoal}`,
    bullets(node.constraints),
    ...(input.sceneNote ? ['', `What you can see: ${input.sceneNote}`] : []),
    '',
    '## Talking to this child',
    bullets(describeAudience(band)),
    '',
    '## Always',
    bullets([...UNIVERSAL_RULES, ...persona.boundaries]),
  ].join('\n');
}

/**
 * Bounded recent history. The model gets the last few exchanges, never the whole
 * session: a small model with a short window has to stay cheap and on-topic.
 */
export function buildMessages(
  history: readonly ChatMessage[],
  childUtterance: string,
  maxHistoryMessages = 8,
): ChatMessage[] {
  const recent = history.slice(-maxHistoryMessages);
  return [...recent, { role: 'user', content: childUtterance }];
}

export interface ClassifierPromptInput {
  personaId: string;
  nodeId: string;
  characterName: string;
  /** What the character just said. Context for the label, never the thing labelled. */
  characterReply: string;
  candidates: readonly { id: string; description: string }[];
}

/**
 * The classifier prompt. Structured, tiny, and constrained to the edges the graph
 * permits. `none` is always an allowed answer - holding position is a real
 * outcome, not a failure.
 *
 * The character's own line goes in the SYSTEM prompt, not the user turn. The
 * only user message is the child's words, so nothing downstream - the model or
 * the offline keyword matcher - can accidentally classify the character's words
 * as the child's.
 */
export function buildClassifierSystemPrompt(input: ClassifierPromptInput): string {
  return [
    // The same markers the dialogue prompt carries, so the keyless mock brain can
    // route a classification to the right persona and beat.
    `${MARKERS.character} ${input.personaId}`,
    `${MARKERS.beat} ${input.nodeId}`,
    '',
    'You label what a child just said in a conversation. You do not reply to the child.',
    '',
    `The child is talking to ${input.characterName}, who had just said: "${input.characterReply}"`,
    'The next message you receive is the child\'s reply, and it is the only thing you label.',
    'Pick the ONE label below that best matches what the child said. If none of them clearly matches, answer "none".',
    '',
    ...input.candidates.map((candidate) => `- "${candidate.id}": ${candidate.description}`),
    '- "none": nothing above clearly matches.',
    '',
    'Answer with a single JSON object and nothing else:',
    '{"edge": "<one of the ids above, or none>"}',
  ].join('\n');
}

/** Pulls the chosen edge id out of a classifier response, tolerating stray prose. */
export function parseClassifierAnswer(raw: string): string | undefined {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[0]) as { edge?: unknown };
    return typeof parsed.edge === 'string' ? parsed.edge.trim() : undefined;
  } catch {
    return undefined;
  }
}
