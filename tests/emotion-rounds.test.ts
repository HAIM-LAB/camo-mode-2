import { describe, expect, it } from 'vitest';
import { IdleMotion } from '../src/cast-motion';
import { EMOTIONS, Emotion, EmotionExtent } from '../src/emotions';
import {
  CHOICES_PER_ROUND,
  GuessingGame,
  ROUND_EXTENTS,
  Round,
  RoundAvatar,
  planRounds,
} from '../src/emotion-rounds';
import { STAGE_CAST } from '../src/emotion-stage';
import { PlayerAvatar } from '../src/player-avatar';
import { DEFAULT_PLAYER_LOOK, PLAYER_STYLES } from '../src/player-look';
import { loadCastModel } from './helpers/player-model';

/** A repeatable stand-in for Math.random: the same seed always plans the same game. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

const SEEDS = Array.from({ length: 200 }, (_, index) => index + 1);

/** An avatar that can show the given emotions on its face, and with its body unless told otherwise. */
function avatar<Id extends string>(
  id: Id,
  face: readonly Emotion[] = EMOTIONS,
  body: readonly Emotion[] = face,
): RoundAvatar<Id> {
  return { id, available: (extent) => (extent === 'face' ? face : body) };
}

const TRIO = [avatar('player'), avatar('friend-a'), avatar('friend-b')];

function of<Id extends string>(rounds: readonly Round<Id>[], extent: EmotionExtent): Round<Id>[] {
  return rounds.filter((round) => round.extent === extent);
}

describe('a planned game', () => {
  it('asks about every emotion in the list once on the face and once with the body', () => {
    for (const seed of SEEDS) {
      const rounds = planRounds(TRIO, seeded(seed));
      expect(rounds).toHaveLength(EMOTIONS.length * ROUND_EXTENTS.length);
      for (const extent of ROUND_EXTENTS) {
        expect(of(rounds, extent).map((round) => round.emotion).sort()).toEqual([...EMOTIONS].sort());
      }
    }
  });

  it('plays every face round before the first body round', () => {
    expect(ROUND_EXTENTS).toEqual(['face', 'body']);
    for (const seed of SEEDS) {
      const extents = planRounds(TRIO, seeded(seed)).map((round) => round.extent);
      expect(extents.lastIndexOf('face')).toBeLessThan(extents.indexOf('body'));
      expect(extents[0]).toBe('face');
    }
  });

  it('offers the right answer among distinct choices, in the order of the list', () => {
    const size = Math.min(CHOICES_PER_ROUND, EMOTIONS.length);
    for (const seed of SEEDS) {
      for (const round of planRounds(TRIO, seeded(seed))) {
        expect(round.choices).toContain(round.emotion);
        expect(round.choices).toHaveLength(size);
        expect(new Set(round.choices).size).toBe(size);
        expect(round.choices).toEqual(EMOTIONS.filter((emotion) => round.choices.includes(emotion)));
      }
    }
  });

  it('offers something to tell the right answer from', () => {
    expect(Math.min(CHOICES_PER_ROUND, EMOTIONS.length)).toBeGreaterThan(1);
  });

  it('never shows the same emotion or the same avatar two rounds running', () => {
    for (const cast of [TRIO, TRIO.slice(0, 2)]) {
      for (const seed of SEEDS) {
        const rounds = planRounds(cast, seeded(seed));
        rounds.slice(1).forEach((round, index) => {
          expect(round.emotion).not.toBe(rounds[index].emotion);
          expect(round.avatar).not.toBe(rounds[index].avatar);
        });
      }
    }
  });

  it('gives every avatar the same number of turns', () => {
    for (const seed of SEEDS) {
      const rounds = planRounds(TRIO, seeded(seed));
      for (const { id } of TRIO) {
        expect(rounds.filter((round) => round.avatar === id)).toHaveLength(rounds.length / TRIO.length);
      }
    }
  });

  it('is not the same game every time', () => {
    const games = new Set(SEEDS.map((seed) => (
      planRounds(TRIO, seeded(seed)).map((round) => `${round.avatar}:${round.emotion}:${round.choices.join()}`).join(' ')
    )));
    expect(games.size).toBeGreaterThan(SEEDS.length / 2);
  });

  it('never asks about an avatar that has no emotions, as Camo has none', () => {
    const cast = [...TRIO, avatar('camo', [])];
    for (const seed of SEEDS) {
      expect(planRounds(cast, seeded(seed)).map((round) => round.avatar)).not.toContain('camo');
    }
  });

  it('asks an avatar only for what it can show', () => {
    const cast = [avatar('player', ['anger', 'fear'], ['anger']), avatar('friend-a'), avatar('friend-b')];
    for (const seed of SEEDS) {
      for (const round of planRounds(cast, seeded(seed))) {
        const can = cast.find((member) => member.id === round.avatar)?.available(round.extent);
        expect(can).toContain(round.emotion);
      }
    }
  });

  it('leaves out what nobody can show', () => {
    const faceOnly = planRounds([avatar('player', EMOTIONS, []), avatar('friend-a', EMOTIONS, [])], seeded(3));
    expect(faceOnly.map((round) => round.extent)).toEqual(EMOTIONS.map(() => 'face'));

    const some = planRounds([avatar('player', ['fear', 'sadness'])], seeded(3));
    expect(some.map((round) => round.emotion).sort()).toEqual(['fear', 'fear', 'sadness', 'sadness']);
  });

  it('still never repeats an emotion when one avatar plays alone', () => {
    for (const seed of SEEDS) {
      const rounds = planRounds([avatar('player')], seeded(seed));
      expect(rounds).toHaveLength(EMOTIONS.length * ROUND_EXTENTS.length);
      rounds.slice(1).forEach((round, index) => expect(round.emotion).not.toBe(rounds[index].emotion));
    }
  });

  it('plans nothing for a cast that can show nothing', () => {
    expect(planRounds([], seeded(1))).toEqual([]);
    expect(planRounds([avatar('player', [])], seeded(1))).toEqual([]);
  });
});

describe('the stage cast', () => {
  it('is the player and both friends, and never Camo', () => {
    expect(STAGE_CAST.map((member) => member.asset)).toEqual(['player', 'friendA', 'friendB']);
    expect(STAGE_CAST.map((member) => member.id)).not.toContain('camo');
  });

  it.each(PLAYER_STYLES.map((style) => style.id))('can play a whole game with the %s models', async (style) => {
    const cast = await Promise.all(STAGE_CAST.map(async ({ id, asset }): Promise<RoundAvatar> => {
      const model = await loadCastModel(asset, style);
      const performer = asset === 'player' ? new PlayerAvatar({ ...DEFAULT_PLAYER_LOOK, style }) : new IdleMotion();
      performer.prepare(model);
      return { id, available: (extent) => performer.emotions.available(extent) };
    }));

    const rounds = planRounds(cast, seeded(7));
    expect(rounds).toHaveLength(EMOTIONS.length * ROUND_EXTENTS.length);
    expect(new Set(rounds.map((round) => round.avatar))).toEqual(new Set(STAGE_CAST.map((member) => member.id)));
  });
});

describe('a game being played', () => {
  const rounds = planRounds(TRIO, seeded(11));
  const wrongFor = (round: Round): Emotion => round.choices.find((emotion) => emotion !== round.emotion) as Emotion;

  it('starts by asking its first round', () => {
    const game = new GuessingGame(rounds);
    expect(game.phase).toBe('asking');
    expect(game.round).toBe(rounds[0]);
    expect(game.played).toBe(0);
    expect(game.total).toBe(rounds.length);
  });

  it('takes a right answer and moves on to the next round', () => {
    const game = new GuessingGame(rounds);
    game.guess(rounds[0].emotion);
    expect(game.phase).toBe('right');
    expect(game.round).toBe(rounds[0]);
    game.next();
    expect(game.phase).toBe('asking');
    expect(game.round).toBe(rounds[1]);
    expect(game.played).toBe(1);
  });

  it('lets a wrong answer be tried again, as often as the child likes', () => {
    const game = new GuessingGame(rounds);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      game.guess(wrongFor(rounds[0]));
      expect(game.phase).toBe('wrong');
      expect(game.round).toBe(rounds[0]);
      game.retry();
      expect(game.phase).toBe('asking');
      expect(game.round).toBe(rounds[0]);
      expect(game.played).toBe(0);
    }
    game.guess(rounds[0].emotion);
    expect(game.phase).toBe('right');
  });

  it('lets a wrong answer be left behind', () => {
    const game = new GuessingGame(rounds);
    game.guess(wrongFor(rounds[0]));
    game.next();
    expect(game.phase).toBe('asking');
    expect(game.round).toBe(rounds[1]);
  });

  it('ends the same way whether every answer was right or wrong', () => {
    const play = (answer: (round: Round) => Emotion): GuessingGame => {
      const game = new GuessingGame(rounds);
      for (const round of rounds) {
        game.guess(answer(round));
        game.next();
      }
      return game;
    };
    const allRight = play((round) => round.emotion);
    const allWrong = play(wrongFor);
    expect(allRight.phase).toBe('finished');
    expect(allWrong).toEqual(allRight);
    expect(allWrong.played).toBe(rounds.length);
    expect(allWrong.round).toBeUndefined();
  });

  it('keeps nothing but its rounds and its place in them', () => {
    const game = new GuessingGame(rounds);
    game.guess(wrongFor(rounds[0]));
    expect(Object.keys(game).sort()).toEqual(['index', 'rounds', 'state']);
  });

  it('ignores what does not fit the moment', () => {
    const game = new GuessingGame(rounds);
    game.retry();
    game.next();
    expect(game.phase).toBe('asking');
    expect(game.played).toBe(0);

    game.guess(rounds[0].emotion);
    game.guess(wrongFor(rounds[0]));
    game.retry();
    expect(game.phase).toBe('right');
  });

  it('has finished before it starts when there are no rounds', () => {
    const game = new GuessingGame([]);
    expect(game.phase).toBe('finished');
    expect(game.round).toBeUndefined();
    game.guess('fear');
    game.next();
    expect(game.phase).toBe('finished');
  });
});
