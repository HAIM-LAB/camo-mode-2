/**
 * Persona schema and validation.
 *
 * Authored persona text lives in `data/personas/*.jsonc`, never in TypeScript.
 * This module owns the shape of that data and turns an authoring mistake into an
 * error that names the file, the field, and what was expected.
 */

import {
  EMOTION_DIMENSIONS,
  createEmotionVector,
  type EmotionNudge,
  type EmotionVector,
} from './emotion';
import { parseJsonc } from './jsonc';
import { Validator } from './validate';

/**
 * The closed set of scene facts a persona may react to. Kept small and explicit
 * so an authoring typo is an error rather than a rule that silently never fires.
 */
export const SCENE_FACTS = [
  'carrying-ball',
  'carrying-block',
  'carrying-nothing',
  'topic-known',
  'first-meeting',
  'returning',
] as const;

export type SceneFact = (typeof SCENE_FACTS)[number];

/**
 * How a character's mood shifts before the first word, based on what is true in
 * the room. This is the seam between the existing pickup/drop gameplay and the
 * dialogue layer: walking up to someone holding the thing you fell out over is
 * not the same as walking up empty-handed.
 */
export interface SceneReaction {
  when: SceneFact;
  emotion: EmotionNudge;
  /** Author's reason. Shown in the debug inspector when the reaction fires. */
  note: string;
}

export const OCEAN_TRAITS = [
  'openness',
  'conscientiousness',
  'extraversion',
  'agreeableness',
  'neuroticism',
] as const;

export type OceanTrait = (typeof OCEAN_TRAITS)[number];

export interface TraitValue {
  /** 0..1. Never shown to the model as a number - see `prompt.ts`. */
  value: number;
  /** How this trait shows up for this specific character, in the author's words. */
  note: string;
}

export interface PersonaSpeech {
  vocabularyLevel: string;
  sentenceLength: string;
  verbalTics: string[];
  neverSays: string[];
}

export interface PersonaIdentity {
  name: string;
  age: number;
  background: string;
  roleInScene: string;
  speech: PersonaSpeech;
}

export interface PersonaVoice {
  /** ElevenLabs voice id. Per persona so each character sounds distinct. */
  voiceId: string;
  /** ElevenLabs model id; falls back to the server default when omitted. */
  modelId?: string;
  stability?: number;
  similarityBoost?: number;
  speed?: number;
}

export interface Persona {
  id: string;
  /** Scene entity this persona speaks for, e.g. `camo`, `friend-a`. */
  entityId: string;
  /** Storylet graph that governs this character's beats. */
  storyletId: string;
  identity: PersonaIdentity;
  traits: Record<OceanTrait, TraitValue>;
  emotionBaseline: EmotionVector;
  voice?: PersonaVoice;
  /** Hard content rules for this character, added verbatim to the system prompt. */
  boundaries: string[];
  /**
   * What this character says when the safety gate blocks a turn. The child never
   * sees an error or a moderation notice - the character simply moves the moment
   * along in their own voice.
   */
  deflections: string[];
  /** Mood shifts applied at greeting time from what is true in the room. */
  sceneReactions: SceneReaction[];
  /**
   * Lines the keyless mock brain speaks, keyed by storylet node id. Authoring aid
   * for the offline demo only - a live provider never sees these.
   */
  offlineLines: Record<string, string[]>;
  /**
   * Offline edge choices, keyed by node id then edge id, listing child words that
   * should fire that edge. Only used by the mock brain.
   */
  offlineIntents: Record<string, Record<string, string[]>>;
}

function parseTrait(validator: Validator, raw: unknown, path: string): TraitValue {
  const object = validator.object(raw, path);
  return {
    value: validator.number(object.value, `${path}.value`, { min: 0, max: 1 }),
    note: validator.string(object.note, `${path}.note`, { minLength: 8 }),
  };
}

function parseStringRecordOfArrays(
  validator: Validator,
  raw: unknown,
  path: string,
): Record<string, string[]> {
  if (raw === undefined) return {};
  const object = validator.object(raw, path);
  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(object)) {
    result[key] = validator.stringArray(value, `${path}.${key}`, { minLength: 1 });
  }
  return result;
}

/** Validates one persona document. Collects every issue before throwing. */
export function parsePersona(raw: unknown, sourceName: string): Persona {
  const validator = new Validator(sourceName);
  const root = validator.object(raw, 'persona');

  const identityRaw = validator.object(root.identity, 'identity');
  const speechRaw = validator.object(identityRaw.speech, 'identity.speech');
  const traitsRaw = validator.object(root.traits, 'traits');
  const baselineRaw = validator.object(root.emotionBaseline, 'emotionBaseline');

  const traits = {} as Record<OceanTrait, TraitValue>;
  for (const trait of OCEAN_TRAITS) {
    traits[trait] = parseTrait(validator, traitsRaw[trait], `traits.${trait}`);
  }

  const baseline: Partial<EmotionVector> = {};
  for (const dimension of EMOTION_DIMENSIONS) {
    baseline[dimension] = validator.number(
      baselineRaw[dimension],
      `emotionBaseline.${dimension}`,
      { min: 0, max: 1 },
    );
  }

  let voice: PersonaVoice | undefined;
  if (root.voice !== undefined && root.voice !== null) {
    const voiceRaw = validator.object(root.voice, 'voice');
    voice = {
      voiceId: validator.string(voiceRaw.voiceId, 'voice.voiceId'),
      modelId: validator.optionalString(voiceRaw.modelId, 'voice.modelId'),
      ...(voiceRaw.stability === undefined
        ? {}
        : { stability: validator.number(voiceRaw.stability, 'voice.stability', { min: 0, max: 1 }) }),
      ...(voiceRaw.similarityBoost === undefined
        ? {}
        : {
            similarityBoost: validator.number(voiceRaw.similarityBoost, 'voice.similarityBoost', {
              min: 0,
              max: 1,
            }),
          }),
      ...(voiceRaw.speed === undefined
        ? {}
        : { speed: validator.number(voiceRaw.speed, 'voice.speed', { min: 0.5, max: 1.5 }) }),
    };
  }

  const persona: Persona = {
    id: validator.identifier(root.id, 'id'),
    entityId: validator.identifier(root.entityId, 'entityId'),
    storyletId: validator.identifier(root.storyletId, 'storyletId'),
    identity: {
      name: validator.string(identityRaw.name, 'identity.name'),
      age: validator.integer(identityRaw.age, 'identity.age', { min: 1, max: 200 }),
      background: validator.string(identityRaw.background, 'identity.background', { minLength: 20 }),
      roleInScene: validator.string(identityRaw.roleInScene, 'identity.roleInScene', {
        minLength: 10,
      }),
      speech: {
        vocabularyLevel: validator.string(
          speechRaw.vocabularyLevel,
          'identity.speech.vocabularyLevel',
          { minLength: 8 },
        ),
        sentenceLength: validator.string(speechRaw.sentenceLength, 'identity.speech.sentenceLength', {
          minLength: 3,
        }),
        verbalTics: validator.stringArray(speechRaw.verbalTics, 'identity.speech.verbalTics'),
        neverSays: validator.stringArray(speechRaw.neverSays, 'identity.speech.neverSays', {
          minLength: 1,
        }),
      },
    },
    traits,
    emotionBaseline: createEmotionVector(baseline),
    voice,
    boundaries: validator.stringArray(root.boundaries, 'boundaries', { minLength: 1 }),
    deflections: validator.stringArray(root.deflections, 'deflections', { minLength: 2 }),
    sceneReactions: parseSceneReactions(validator, root.sceneReactions),
    offlineLines: parseStringRecordOfArrays(validator, root.offlineLines, 'offlineLines'),
    offlineIntents: parseOfflineIntents(validator, root.offlineIntents),
  };

  validator.throwIfInvalid();
  return persona;
}

function parseSceneReactions(validator: Validator, raw: unknown): SceneReaction[] {
  if (raw === undefined) return [];
  return validator.array(raw, 'sceneReactions').map((item, index) => {
    const path = `sceneReactions[${index}]`;
    const entry = validator.object(item, path);
    const emotionRaw = validator.object(entry.emotion, `${path}.emotion`);
    const emotion: EmotionNudge = {};
    for (const [key, value] of Object.entries(emotionRaw)) {
      const dimension = validator.oneOf(key, `${path}.emotion (key)`, EMOTION_DIMENSIONS);
      emotion[dimension] = validator.number(value, `${path}.emotion.${key}`, { min: -1, max: 1 });
    }
    return {
      when: validator.oneOf(entry.when, `${path}.when`, SCENE_FACTS),
      emotion,
      note: validator.string(entry.note, `${path}.note`, { minLength: 8 }),
    } satisfies SceneReaction;
  });
}

function parseOfflineIntents(
  validator: Validator,
  raw: unknown,
): Record<string, Record<string, string[]>> {
  if (raw === undefined) return {};
  const object = validator.object(raw, 'offlineIntents');
  const result: Record<string, Record<string, string[]>> = {};
  for (const [nodeId, edges] of Object.entries(object)) {
    result[nodeId] = parseStringRecordOfArrays(validator, edges, `offlineIntents.${nodeId}`);
  }
  return result;
}

export function parsePersonaSource(source: string, sourceName: string): Persona {
  return parsePersona(parseJsonc<unknown>(source, sourceName), sourceName);
}
