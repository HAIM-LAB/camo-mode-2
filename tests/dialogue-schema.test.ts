import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseAudienceSource } from '../src/dialogue/audience';
import { parseJsonc, stripJsonComments, stripTrailingCommas } from '../src/dialogue/jsonc';
import { loadLibrary, matchesKeyword, personaForEntity, storyletFor } from '../src/dialogue/library';
import { parsePersonaSource } from '../src/dialogue/persona';
import { parseStoryletSource } from '../src/dialogue/storylet';
import { SchemaValidationError } from '../src/dialogue/validate';

function issuesOf(run: () => unknown): { path: string; message: string }[] {
  try {
    run();
  } catch (error) {
    if (error instanceof SchemaValidationError) return [...error.issues];
    throw error;
  }
  throw new Error('expected validation to fail, but it passed');
}

describe('jsonc authoring format', () => {
  it('keeps comment-like text inside strings intact', () => {
    const source = '{ "a": "http://example.com // not a comment" } // trailing';
    expect(JSON.parse(stripJsonComments(source))).toEqual({
      a: 'http://example.com // not a comment',
    });
  });

  it('accepts block comments and trailing commas', () => {
    const source = `{
      /* the captain's note */
      "a": 1,
      "b": [1, 2,],
    }`;
    expect(parseJsonc(source, 'test')).toEqual({ a: 1, b: [1, 2] });
  });

  it('leaves commas that are not trailing alone', () => {
    expect(stripTrailingCommas('{"a":1,"b":2}')).toBe('{"a":1,"b":2}');
  });

  it('names the file when a document is malformed', () => {
    expect(() => parseJsonc('{ "a": }', 'data/personas/broken.jsonc')).toThrow(
      /data\/personas\/broken\.jsonc: not valid JSONC/,
    );
  });
});

describe('persona validation', () => {
  it('loads every shipped persona and resolves its storylet', () => {
    const library = loadLibrary();
    expect(library.personas.map((persona) => persona.id).sort()).toEqual([
      'camo',
      'friend-a',
      'friend-b',
    ]);
    for (const persona of library.personas) {
      expect(storyletFor(library, persona).id).toBe(persona.storyletId);
    }
  });

  it('reports every problem at once, with the field path and what was expected', () => {
    const issues = issuesOf(() =>
      parsePersonaSource(
        JSON.stringify({
          id: 'Bad Id',
          entityId: 'camo',
          storyletId: 'camo-check-in',
          identity: {
            name: 'X',
            age: 6,
            background: 'too short',
            roleInScene: 'guide',
            speech: {
              vocabularyLevel: 'plain words',
              sentenceLength: 'short',
              verbalTics: [],
              neverSays: [],
            },
          },
          traits: { openness: { value: 4, note: 'way out of range' } },
          emotionBaseline: { joy: 0.5 },
          boundaries: [],
          deflections: ['only one'],
        }),
        'data/personas/broken.jsonc',
      ),
    );

    const paths = issues.map((issue) => issue.path);
    expect(paths).toContain('id');
    expect(paths).toContain('identity.background');
    expect(paths).toContain('traits.openness.value');
    expect(paths).toContain('traits.agreeableness');
    expect(paths).toContain('emotionBaseline.hurt');
    expect(paths).toContain('boundaries');
    expect(paths).toContain('deflections');

    expect(issues.find((issue) => issue.path === 'id')?.message).toMatch(/kebab-case/);
    expect(issues.find((issue) => issue.path === 'traits.openness.value')?.message).toMatch(
      /must be between 0 and 1, found 4/,
    );
  });

  it('rejects a scene reaction that names a fact the scene cannot supply', () => {
    const base = JSON.parse(
      stripTrailingCommas(
        stripJsonComments(readFileSync('data/personas/camo.jsonc', 'utf8')),
      ),
    ) as Record<string, unknown>;
    base.sceneReactions = [{ when: 'holding-a-sandwich', emotion: {}, note: 'not a real fact' }];

    const issues = issuesOf(() => parsePersonaSource(JSON.stringify(base), 'data/personas/x.jsonc'));
    expect(issues[0].path).toBe('sceneReactions[0].when');
    expect(issues[0].message).toMatch(/carrying-ball/);
  });
});

describe('storylet validation', () => {
  it('loads both shipped graphs', () => {
    const ids = loadLibrary().storylets.map((graph) => graph.id).sort();
    expect(ids).toEqual(['camo-check-in', 'friend-disagreement']);
  });

  it('catches dangling edges, unknown entry nodes, and undeclared state', () => {
    const issues = issuesOf(() =>
      parseStoryletSource(
        JSON.stringify({
          id: 'broken',
          title: 'Broken graph',
          entryNode: 'nowhere',
          variables: [],
          flags: [],
          nodes: [
            {
              id: 'start',
              beatGoal: 'do the first thing',
              constraints: ['keep it short'],
              edges: [
                {
                  id: 'go',
                  to: 'missing-node',
                  why: 'points at nothing',
                  when: { kind: 'variable', name: 'closeness', op: '>=', value: 0.5 },
                },
              ],
            },
          ],
        }),
        'data/storylets/broken.jsonc',
      ),
    );

    const messages = issues.map((issue) => `${issue.path}: ${issue.message}`);
    expect(messages.some((message) => message.includes('entryNode'))).toBe(true);
    expect(
      messages.some((message) => message.includes('missing-node') && message.includes('not a node')),
    ).toBe(true);
    expect(messages.some((message) => message.includes('closeness'))).toBe(true);
  });

  it('requires a node with no edges to be marked terminal', () => {
    const issues = issuesOf(() =>
      parseStoryletSource(
        JSON.stringify({
          id: 'dead-end',
          title: 'Dead end',
          entryNode: 'start',
          variables: [],
          flags: [],
          nodes: [{ id: 'start', beatGoal: 'stand around a bit', constraints: ['say little'], edges: [] }],
        }),
        'data/storylets/dead-end.jsonc',
      ),
    );
    expect(issues[0].message).toMatch(/terminal/);
  });
});

describe('audience band', () => {
  it('rejects an active band that is not declared', () => {
    const issues = issuesOf(() =>
      parseAudienceSource(
        JSON.stringify({
          activeBandId: 'teenagers',
          bands: [
            {
              id: '5-7',
              label: 'Early readers',
              ageRange: '5-7',
              maxSentenceWords: 9,
              maxSentencesPerReply: 3,
              vocabulary: 'plain everyday words',
              avoid: ['sarcasm'],
              guidance: [],
            },
          ],
        }),
        'data/audience.jsonc',
      ),
    );
    expect(issues[0].path).toBe('activeBandId');
    expect(issues[0].message).toMatch(/5-7/);
  });

  it('ships 5-7 as the default band', () => {
    expect(loadLibrary().band.id).toBe('5-7');
  });
});

describe('authoring templates', () => {
  const templates = [
    'data/templates/persona.template.jsonc',
    'data/templates/storylet.template.jsonc',
  ];

  it.each(templates)('%s is valid JSONC, blank, and heavily commented', (path) => {
    const source = readFileSync(path, 'utf8');
    // Parses: a captain filling it in starts from something well-formed.
    expect(() => parseJsonc(source, path)).not.toThrow();
    // Commented: more than a third of the lines carry guidance.
    const lines = source.split('\n');
    const commentLines = lines.filter((line) => line.trim().startsWith('//'));
    expect(commentLines.length / lines.length).toBeGreaterThan(0.33);
    // Blank: the placeholders are still placeholders.
    expect(source).toContain('""');
  });

  it.each(templates)('%s does not validate as content, so it is never loaded by mistake', (path) => {
    const source = readFileSync(path, 'utf8');
    const parse = path.includes('persona') ? parsePersonaSource : parseStoryletSource;
    expect(() => parse(source, path)).toThrow(SchemaValidationError);
  });

  it('keeps templates out of the loader globs', () => {
    const library = loadLibrary();
    expect(library.personas.some((persona) => persona.id === '')).toBe(false);
    expect(library.storylets.some((graph) => graph.id === '')).toBe(false);
  });
});

describe('offline keyword matching', () => {
  it('matches on word boundaries so "no" does not fire inside "know"', () => {
    expect(matchesKeyword("i don't know", 'no')).toBe(false);
    expect(matchesKeyword('no thanks', 'no')).toBe(true);
    expect(matchesKeyword("i'll do it", "i'll")).toBe(true);
  });
});

describe('cross-file integrity', () => {
  it('gives every scene character a persona', () => {
    const library = loadLibrary();
    for (const entityId of ['camo', 'friend-a', 'friend-b']) {
      expect(personaForEntity(library, entityId)?.entityId).toBe(entityId);
    }
  });

  it('gives every persona an offline line for every node in its graph', () => {
    const library = loadLibrary();
    for (const persona of library.personas) {
      const graph = storyletFor(library, persona);
      for (const node of graph.nodes) {
        expect(
          persona.offlineLines[node.id]?.length,
          `${persona.id} has no offline lines for node "${node.id}"`,
        ).toBeGreaterThan(0);
      }
    }
  });
});
