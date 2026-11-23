import { EMOTIONS, Emotion, EmotionExtent } from './emotions';

/**
 * The rules of the Understanding Emotions guessing game, apart from anything
 * drawn: which rounds a game has, and what a guess does.
 *
 * A game asks about every emotion in EMOTIONS once on the face alone, then
 * once more with the body. Nothing here names an emotion, so one added to that
 * list is asked about too.
 */

/** The order a game shows the emotions in: on the face alone, then with the body. */
export const ROUND_EXTENTS = ['face', 'body'] as const satisfies readonly EmotionExtent[];

/** How many emotions a round offers to pick from, the right one among them. */
export const CHOICES_PER_ROUND = 4;

/** An avatar that can take a round. */
export interface RoundAvatar<Id extends string = string> {
  readonly id: Id;
  /** The emotions this avatar can show at an extent; none for a model that has not loaded. */
  available(extent: EmotionExtent): readonly Emotion[];
}

/** One question: an avatar shows an emotion, and the child picks it from the choices. */
export interface Round<Id extends string = string> {
  /** Who shows the emotion. */
  readonly avatar: Id;
  /** The emotion shown, which is the right answer. */
  readonly emotion: Emotion;
  readonly extent: EmotionExtent;
  /** The emotions offered, the right one among them, in the order EMOTIONS lists them. */
  readonly choices: readonly Emotion[];
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(Math.floor(random() * items.length), items.length - 1)];
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const result = [...items];
  for (let last = result.length - 1; last > 0; last -= 1) {
    const other = Math.min(Math.floor(random() * (last + 1)), last);
    [result[last], result[other]] = [result[other], result[last]];
  }
  return result;
}

/**
 * The right answer among other emotions. They keep the order of EMOTIONS, so
 * a name the child has found once is never somewhere unexpected the next time.
 */
function choicesFor(answer: Emotion, random: () => number): Emotion[] {
  const others = shuffled(EMOTIONS.filter((emotion) => emotion !== answer), random);
  const offered = new Set<Emotion>([answer, ...others.slice(0, CHOICES_PER_ROUND - 1)]);
  return EMOTIONS.filter((emotion) => offered.has(emotion));
}

/**
 * Plans a game for the avatars that can play: every emotion on the face alone,
 * then every emotion with the body, each time in a new order.
 *
 * No round shows the emotion of the round before it. No round has the avatar
 * of the round before it either, as long as another avatar can show the
 * emotion, and the avatars take turns evenly. An emotion that no avatar can
 * show at an extent is left out, so a cast that can show nothing plans no
 * rounds.
 */
export function planRounds<Id extends string>(
  cast: readonly RoundAvatar<Id>[],
  random: () => number = Math.random,
): Round<Id>[] {
  const rounds: Round<Id>[] = [];
  const turns = new Map<Id, number>(cast.map((avatar) => [avatar.id, 0]));

  for (const extent of ROUND_EXTENTS) {
    const able = new Map(cast.map((avatar) => [avatar.id, new Set(avatar.available(extent))]));
    const showing = (emotion: Emotion): Id[] => (
      cast.filter((avatar) => able.get(avatar.id)?.has(emotion)).map((avatar) => avatar.id)
    );

    const emotions = shuffled(EMOTIONS.filter((emotion) => showing(emotion).length > 0), random);
    // The body's rounds must not open on the emotion the face's rounds closed on.
    if (emotions.length > 1 && emotions[0] === rounds.at(-1)?.emotion) {
      const other = 1 + Math.min(Math.floor(random() * (emotions.length - 1)), emotions.length - 2);
      [emotions[0], emotions[other]] = [emotions[other], emotions[0]];
    }

    for (const emotion of emotions) {
      const before = rounds.at(-1)?.avatar;
      const candidates = showing(emotion);
      const fresh = candidates.filter((id) => id !== before);
      const pool = fresh.length > 0 ? fresh : candidates;
      // Whoever has had the fewest rounds goes next, so everyone gets a turn.
      const fewest = Math.min(...pool.map((id) => turns.get(id) ?? 0));
      const avatar = pick(pool.filter((id) => (turns.get(id) ?? 0) === fewest), random);
      turns.set(avatar, fewest + 1);
      rounds.push({ avatar, emotion, extent, choices: choicesFor(emotion, random) });
    }
  }
  return rounds;
}

/**
 * Where a game stands: the child is being asked, has guessed right, has
 * guessed wrong, or has been through every round.
 */
export type GuessPhase = 'asking' | 'right' | 'wrong' | 'finished';

/**
 * One game: the child's place in its rounds, and what each guess does.
 *
 * It keeps no score and no record of guesses. A wrong guess changes nothing
 * but the phase: the child can try the same round again as often as they like,
 * or move on, and the game goes on to the same end either way.
 */
export class GuessingGame<Id extends string = string> {
  private index = 0;
  private state: GuessPhase;

  constructor(private readonly rounds: readonly Round<Id>[]) {
    this.state = rounds.length > 0 ? 'asking' : 'finished';
  }

  get phase(): GuessPhase {
    return this.state;
  }

  /** The round being played, or undefined once the game has finished. */
  get round(): Round<Id> | undefined {
    return this.state === 'finished' ? undefined : this.rounds[this.index];
  }

  /** How many rounds are behind the child, from 0 to `total`. */
  get played(): number {
    return this.state === 'finished' ? this.rounds.length : this.index;
  }

  get total(): number {
    return this.rounds.length;
  }

  /** Takes the child's answer to the round being asked. Ignored at any other time. */
  guess(emotion: Emotion): void {
    if (this.state !== 'asking') return;
    this.state = emotion === this.rounds[this.index].emotion ? 'right' : 'wrong';
  }

  /** Asks the same round again after a wrong guess. */
  retry(): void {
    if (this.state === 'wrong') this.state = 'asking';
  }

  /** Moves on from an answered round, right or wrong, to the next one or to the end. */
  next(): void {
    if (this.state !== 'right' && this.state !== 'wrong') return;
    this.index += 1;
    this.state = this.index < this.rounds.length ? 'asking' : 'finished';
  }
}
