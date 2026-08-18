/**
 * Loads and validates every authored data file at startup.
 *
 * All authored text lives in `data/` as `.jsonc`. Nothing here is lazy: if a
 * persona or storylet is malformed, the app says so immediately with the file
 * name and the field, rather than failing halfway through a conversation in
 * front of a child.
 *
 * `data/templates/` is deliberately outside every glob. The templates are blank
 * by design and must never be loaded as content.
 */

import { activeBand, parseAudienceSource, type AudienceBand, type AudienceConfig } from './audience';
import type { MockContext, MockScript } from './providers/mock';
import { parsePersonaSource, type Persona } from './persona';
import { parseStoryletSource, type StoryletGraph } from './storylet';

const personaSources = import.meta.glob('../../data/personas/*.jsonc', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const storyletSources = import.meta.glob('../../data/storylets/*.jsonc', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const audienceSource = (
  import.meta.glob('../../data/audience.jsonc', {
    query: '?raw',
    import: 'default',
    eager: true,
  }) as Record<string, string>
)['../../data/audience.jsonc'];

export interface DialogueLibrary {
  personas: Persona[];
  storylets: StoryletGraph[];
  audience: AudienceConfig;
  band: AudienceBand;
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Builds the library from raw sources. Exported with explicit inputs so tests can
 * feed deliberately broken documents without touching the filesystem.
 */
export function buildLibrary(inputs: {
  personaSources: Record<string, string>;
  storyletSources: Record<string, string>;
  audienceSource: string;
}): DialogueLibrary {
  const audience = parseAudienceSource(inputs.audienceSource, 'data/audience.jsonc');

  const storylets = Object.entries(inputs.storyletSources).map(([path, source]) =>
    parseStoryletSource(source, `data/storylets/${fileName(path)}`),
  );

  const personas = Object.entries(inputs.personaSources).map(([path, source]) =>
    parsePersonaSource(source, `data/personas/${fileName(path)}`),
  );

  // Cross-file integrity. A persona pointing at a storylet that does not exist is
  // the single easiest mistake to make here, so it gets its own clear message.
  const storyletIds = new Set(storylets.map((graph) => graph.id));
  for (const persona of personas) {
    if (!storyletIds.has(persona.storyletId)) {
      throw new Error(
        `data/personas/${persona.id}.jsonc: storyletId "${persona.storyletId}" does not match any file in data/storylets/. ` +
          `Available: ${[...storyletIds].join(', ') || '(none)'}`,
      );
    }
  }

  return { personas, storylets, audience, band: activeBand(audience) };
}

let cached: DialogueLibrary | undefined;

/** The live library, built once per session from `data/`. */
export function loadLibrary(): DialogueLibrary {
  cached ??= buildLibrary({ personaSources, storyletSources, audienceSource });
  return cached;
}

export function personaForEntity(library: DialogueLibrary, entityId: string): Persona | undefined {
  return library.personas.find((persona) => persona.entityId === entityId);
}

export function storyletFor(library: DialogueLibrary, persona: Persona): StoryletGraph {
  const graph = library.storylets.find((item) => item.id === persona.storyletId);
  if (!graph) throw new Error(`Persona "${persona.id}" references unknown storylet "${persona.storyletId}"`);
  return graph;
}

/**
 * Matches a keyword on word boundaries rather than as a bare substring, so "no"
 * does not fire on "I don't know". Apostrophes count as word characters so
 * "i'll" is one token.
 */
export function matchesKeyword(utterance: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w'])${escaped}(?![\\w'])`, 'i').test(utterance);
}

/**
 * The offline script: turns authored persona data into the keyless mock brain's
 * behaviour. Every line it speaks and every intent it recognises comes from
 * `data/personas/*.jsonc`, so the no-key demo is authored content rather than
 * hardcoded strings.
 */
export function createMockScript(library: DialogueLibrary): MockScript {
  const byId = new Map(library.personas.map((persona) => [persona.id, persona]));

  const lookup = (context: MockContext): Persona | undefined => byId.get(context.characterId);

  return {
    reply(context) {
      const persona = lookup(context);
      const lines = persona?.offlineLines[context.nodeId] ?? [];
      if (lines.length === 0) {
        return persona
          ? `${persona.identity.speech.verbalTics[0] ?? 'Hm.'} I am not sure what to say here.`
          : 'Hm. I am not sure what to say here.';
      }
      const index = (context.turnIndex + context.variation) % lines.length;
      // Never say the same thing twice running: two identical lines in a row is
      // the one thing that makes the offline demo look broken rather than quiet.
      return lines.length > 1 && lines[index] === context.previousReply
        ? lines[(index + 1) % lines.length]
        : lines[index];
    },

    classify(context, allowed) {
      const persona = lookup(context);
      const intents = persona?.offlineIntents[context.nodeId];
      if (!intents) return 'none';

      // Authored order wins, so the captain controls precedence between
      // overlapping keyword sets. Ids the graph does not permit are skipped
      // rather than returned - the interpreter would reject them anyway, but
      // silently proposing an illegal edge would be confusing in the inspector.
      for (const [edgeId, keywords] of Object.entries(intents)) {
        if (!allowed.includes(edgeId)) continue;
        if (keywords.some((keyword) => matchesKeyword(context.childUtterance, keyword))) {
          return edgeId;
        }
      }
      return 'none';
    },
  };
}
