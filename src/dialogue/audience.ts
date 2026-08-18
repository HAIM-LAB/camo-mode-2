/**
 * Target age band.
 *
 * Reading level is an authored parameter, never hardcoded. Every language rule
 * the model is given - sentence length, reply length, vocabulary, what to avoid -
 * comes from the active band in `data/audience.jsonc`, so retuning the whole cast
 * for a different age is one file and one field.
 *
 * The launch band is still an open captain decision; the shipped default is 5-7.
 */

import { parseJsonc } from './jsonc';
import { Validator } from './validate';

export interface AudienceBand {
  id: string;
  label: string;
  /** Human-readable range, e.g. "5-7". Presentation only. */
  ageRange: string;
  maxSentenceWords: number;
  maxSentencesPerReply: number;
  vocabulary: string;
  /** Constructions to keep out of replies at this band. */
  avoid: string[];
  /** Extra authored guidance appended verbatim to the prompt. */
  guidance: string[];
}

export interface AudienceConfig {
  activeBandId: string;
  bands: AudienceBand[];
}

export function parseAudience(raw: unknown, sourceName: string): AudienceConfig {
  const validator = new Validator(sourceName);
  const root = validator.object(raw, 'audience');

  const bands = validator.array(root.bands, 'bands', { minLength: 1 }).map((item, index) => {
    const path = `bands[${index}]`;
    const entry = validator.object(item, path);
    return {
      id: validator.identifier(entry.id, `${path}.id`),
      label: validator.string(entry.label, `${path}.label`, { minLength: 3 }),
      ageRange: validator.string(entry.ageRange, `${path}.ageRange`, { minLength: 1 }),
      maxSentenceWords: validator.integer(entry.maxSentenceWords, `${path}.maxSentenceWords`, {
        min: 3,
        max: 40,
      }),
      maxSentencesPerReply: validator.integer(
        entry.maxSentencesPerReply,
        `${path}.maxSentencesPerReply`,
        { min: 1, max: 10 },
      ),
      vocabulary: validator.string(entry.vocabulary, `${path}.vocabulary`, { minLength: 10 }),
      avoid: validator.stringArray(entry.avoid, `${path}.avoid`, { minLength: 1 }),
      guidance: validator.stringArray(entry.guidance, `${path}.guidance`),
    } satisfies AudienceBand;
  });

  const activeBandId = validator.identifier(root.activeBandId, 'activeBandId');
  if (bands.length > 0 && !bands.some((band) => band.id === activeBandId)) {
    validator.fail(
      'activeBandId',
      `"${activeBandId}" is not one of the declared bands: ${bands.map((band) => band.id).join(', ')}`,
    );
  }

  validator.throwIfInvalid();
  return { activeBandId, bands };
}

export function parseAudienceSource(source: string, sourceName: string): AudienceConfig {
  return parseAudience(parseJsonc<unknown>(source, sourceName), sourceName);
}

export function activeBand(config: AudienceConfig): AudienceBand {
  const band = config.bands.find((item) => item.id === config.activeBandId);
  if (!band) throw new Error(`Audience band "${config.activeBandId}" is not declared`);
  return band;
}
