import { describe, expect, it, vi } from 'vitest';
import {
  createModeration,
  NullModeration,
  PermissiveModeration,
  ShieldModelModeration,
  takeCompleteSentences,
  type ModerationContext,
  type ModerationProvider,
} from '../src/dialogue/safety';

const context: ModerationContext = {
  stage: 'child-turn',
  personaId: 'camo',
  nodeId: 'greeting',
  audienceBandId: '5-7',
};

describe('sentence gating', () => {
  it('yields only complete sentences and keeps the remainder buffered', () => {
    const result = takeCompleteSentences('Oh - hello. You came over. And then');
    expect(result.sentences).toEqual(['Oh - hello.', 'You came over.']);
    expect(result.rest).toBe('And then');
  });

  it('handles question marks, exclamations, and ellipses', () => {
    const result = takeCompleteSentences('Really? Yes! ...I think so. ');
    expect(result.sentences).toEqual(['Really?', 'Yes!', '...I think so.']);
    expect(result.rest).toBe('');
  });

  it('buffers a partial sentence rather than releasing it early', () => {
    expect(takeCompleteSentences('Hm, I was going to say').sentences).toEqual([]);
  });

  it('never loses or reorders text across incremental calls', () => {
    const full = 'One thing. Then another! And a third? Finally a tail';
    let buffer = '';
    const emitted: string[] = [];

    for (const character of full) {
      buffer += character;
      const { sentences, rest } = takeCompleteSentences(buffer);
      emitted.push(...sentences);
      buffer = rest;
    }
    expect([...emitted, buffer].join(' ')).toBe(full);
  });
});

describe('permissive default', () => {
  const moderation = new PermissiveModeration();

  it('allows ordinary child conversation, including hard feelings', async () => {
    for (const text of [
      'why is she sad',
      'that is not fair, I am cross about it',
      'I hate this game',
      'I do not want to talk',
    ]) {
      expect((await moderation.check(text, context)).allowed, text).toBe(true);
    }
  });

  it('blocks a child volunteering identifying details', async () => {
    const verdict = await moderation.check('I live at 42 Oak Street', context);
    expect(verdict.allowed).toBe(false);
    expect(verdict.category).toBe('personal-information');
  });

  it('blocks self-harm content in either direction', async () => {
    expect((await moderation.check('I want to hurt myself', context)).allowed).toBe(false);
    expect(
      (await moderation.check('you should kill you', { ...context, stage: 'character-reply' })).allowed,
    ).toBe(false);
  });
});

describe('shield model stub', () => {
  it('reports unavailable and fails closed with no endpoint', async () => {
    const shield = new ShieldModelModeration();
    expect(shield.available).toBe(false);

    const verdict = await shield.check('anything', context);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/MODERATION_ENDPOINT/);
  });

  it('posts the same tiny contract a Llama Guard endpoint would answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ allowed: false, category: "S1" }), { status: 200 }),
    );
    const shield = new ShieldModelModeration({
      endpoint: 'http://localhost:9999/guard',
      model: 'llama-guard-3-8b',
      fetchImpl,
    });

    expect(shield.available).toBe(true);
    const verdict = await shield.check('something', { ...context, stage: 'character-reply' });
    expect(verdict).toEqual({ allowed: false, category: 'S1' });

    const body = JSON.parse((fetchImpl.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({
      model: 'llama-guard-3-8b',
      stage: 'character-reply',
      text: 'something',
      context: { personaId: 'camo', nodeId: 'greeting', audienceBandId: '5-7' },
    });
  });

  it('fails closed when the shield errors, because the audience is children', async () => {
    const shield = new ShieldModelModeration({
      endpoint: 'http://localhost:9999/guard',
      fetchImpl: (async () => {
        throw new Error('timeout');
      }) as unknown as typeof fetch,
    });
    expect((await shield.check('anything', context)).allowed).toBe(false);
  });
});

describe('moderation selection', () => {
  it.each([
    ['permissive', 'permissive'],
    ['shield', 'shield'],
    ['none', 'none'],
    [undefined, 'permissive'],
    ['nonsense', 'permissive'],
  ])('CAMO_MODERATION=%s -> %s', (configured, expected) => {
    expect(createModeration(configured).id).toBe(expected);
  });

  it('exposes the same two-hook interface for every implementation', async () => {
    const providers: ModerationProvider[] = [
      new PermissiveModeration(),
      new NullModeration(),
      new ShieldModelModeration(),
    ];
    for (const provider of providers) {
      expect(typeof provider.check).toBe('function');
      await provider.check('hello', context);
      await provider.check('hello', { ...context, stage: 'character-reply' });
    }
  });
});
