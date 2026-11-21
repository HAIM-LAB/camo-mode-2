import type { Emotion, EmotionExtent, ShownEmotion } from './emotions';
import { GuessPhase, GuessingGame, Round, planRounds } from './emotion-rounds';
import { EmotionStage, STAGE_CAST, StageAvatarId } from './emotion-stage';
import { GameModeId, gameMode } from './game-mode';
import { CarriedInputGuard, requiredElement } from './menus';
import type { PlayerLook } from './player-look';

/**
 * What the screen is doing: getting its cast ready, unable to, letting the
 * child watch an avatar that is about to show its emotion, or a phase of the
 * game itself.
 */
export type EmotionGamePhase = 'loading' | 'unavailable' | 'watching' | GuessPhase;

/** A read-only look at the game, for scripted checks. It holds nothing the child has guessed. */
export interface EmotionGameSnapshot {
  phase: EmotionGamePhase;
  /** The style and look chosen in the menus. */
  look: PlayerLook;
  /** Rounds behind the child, and rounds in the game. */
  played: number;
  total: number;
  /** The round being played, right answer included, or null when there is none. */
  round: Round<StageAvatarId> | null;
  /** What the avatar on the stage is showing now, or null while it is in its idle. */
  showing: (ShownEmotion & { avatar: StageAvatarId }) | null;
}

declare global {
  interface Window {
    __CAMO_EMOTION_GAME__?: {
      getState: () => EmotionGameSnapshot;
    };
  }
}

export interface EmotionGameOptions {
  /** Called once the game has closed itself, to show whatever comes next. */
  onLeave: () => void;
  onError: (error: unknown) => void;
}

// The question is the same every round, so a child who has read it once need not read it again.
const QUESTION = 'What feeling is this?';
const LOOK_AT: Readonly<Record<EmotionExtent, string>> = {
  face: 'Look at the face',
  body: 'Look at the face and the body',
};
// What a right answer and a wrong one open with, taken in turn so that rounds do not all sound alike.
const CHEERS = ['Yes!', 'You got it!', 'Well spotted!', 'Nice one!'];
const COMFORTS = ['Good try!', 'Nice try!'];
const STARS = 12;

interface Action {
  readonly label: string;
  /** A small picture after the label. */
  readonly glyph?: string;
  readonly run: () => void;
}

/** What the child is told once a round, or the game, is over. */
interface Feedback {
  /** How it is dressed: `glad` celebrates, `kind` is for a guess that missed and for a game that cannot start. */
  readonly tone: 'glad' | 'kind';
  readonly badge: string;
  readonly title: string;
  /** The line under the title, in pieces: plain words, and names to make stand out. */
  readonly note: readonly (string | Node)[];
  readonly primary: Action;
  readonly secondary?: Action;
}

/** An emotion's name as a sentence stresses it: the word the round was about. */
function named(emotion: Emotion): HTMLElement {
  const name = document.createElement('b');
  name.textContent = emotion;
  return name;
}

function nameOf(avatar: StageAvatarId): string {
  return STAGE_CAST.find((member) => member.id === avatar)?.name ?? avatar;
}

/** Words as they open a sentence or stand alone on a button. */
function capitalized(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * The Understanding Emotions screen: an avatar on a stage shows an emotion,
 * and the child picks which one it is. A right answer is celebrated. A wrong
 * one is met kindly: the child is told the emotion and can look again or move
 * on. Nothing is scored, kept, or sent anywhere.
 */
export class EmotionGame {
  private readonly root = requiredElement<HTMLElement>('emotion-game');
  private readonly back = requiredElement<HTMLButtonElement>('emotion-game-back');
  private readonly progress = requiredElement<HTMLElement>('emotion-game-progress');
  private readonly stageRoot = requiredElement<HTMLElement>('emotion-game-stage');
  private readonly cheer = requiredElement<HTMLElement>('emotion-game-cheer');
  private readonly kicker = requiredElement<HTMLElement>('emotion-game-kicker');
  private readonly question = requiredElement<HTMLElement>('emotion-game-question');
  private readonly answer = requiredElement<HTMLElement>('emotion-game-answer');
  private readonly choices = requiredElement<HTMLElement>('emotion-game-choices');
  private readonly feedback = requiredElement<HTMLElement>('emotion-game-feedback');
  private readonly badge = requiredElement<HTMLElement>('emotion-game-badge');
  private readonly verdict = requiredElement<HTMLElement>('emotion-game-verdict');
  private readonly note = requiredElement<HTMLElement>('emotion-game-note');
  private readonly actions = requiredElement<HTMLElement>('emotion-game-actions');
  private readonly stage: EmotionStage;
  private readonly carriedInput = new CarriedInputGuard();
  /** Ends every listener this game added to the page. */
  private readonly listeners = new AbortController();
  private game?: GuessingGame<StageAvatarId>;
  /** The cast loaded, and none of it can show an emotion. */
  private unavailable = false;
  /** The avatar has not yet shown this round's emotion, so there is nothing to guess. */
  private watching = false;
  /** The round whose choices are on the screen. */
  private offered?: Round<StageAvatarId>;
  private disposed = false;

  constructor(
    private readonly look: PlayerLook,
    mode: GameModeId,
    private readonly options: EmotionGameOptions,
  ) {
    this.stage = new EmotionStage(this.stageRoot, look, () => this.expressed());
    requiredElement<HTMLElement>('emotion-game-title').textContent = gameMode(mode).label;

    const { signal } = this.listeners;
    this.back.addEventListener('click', () => this.leave(), { signal });
    // On the window: the keyboard's focus is on nothing while one set of buttons gives way to the next.
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.leave();
    }, { signal });
    this.choices.addEventListener('keydown', (event) => this.stepBetweenChoices(event), { signal });
    this.carriedInput.watch(this.root, signal);
    this.carriedInput.settle();

    window.__CAMO_EMOTION_GAME__ = { getState: () => this.snapshot() };
    this.render();
    this.back.focus();
  }

  /** Loads the cast, then starts the first game. */
  start(): void {
    this.stage.load().then(() => {
      if (!this.disposed) this.begin();
    }).catch(this.options.onError);
  }

  /** Stops the game and gives the screen back as it was found. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.listeners.abort();
    this.stage.dispose();
    this.game = undefined;
    this.offered = undefined;
    this.choices.replaceChildren();
    this.actions.replaceChildren();
    this.progress.replaceChildren();
    this.cheer.replaceChildren();
    delete window.__CAMO_EMOTION_GAME__;
  }

  private get phase(): EmotionGamePhase {
    if (!this.game) return this.unavailable ? 'unavailable' : 'loading';
    return this.game.phase === 'asking' && this.watching ? 'watching' : this.game.phase;
  }

  private leave(): void {
    this.dispose();
    this.options.onLeave();
  }

  /** Plans a new game for whoever on the stage can play, and starts its first round. */
  private begin(): void {
    const rounds = planRounds(this.stage.cast());
    if (rounds.length === 0) {
      this.unavailable = true;
      this.show();
      return;
    }
    this.game = new GuessingGame(rounds);
    this.progress.replaceChildren(...rounds.map((round, index) => {
      const step = document.createElement('span');
      step.className = 'emotion-game__step';
      // A small gap sets the body's rounds apart from the face's.
      if (index > 0 && round.extent !== rounds[index - 1].extent) step.classList.add('emotion-game__step--break');
      return step;
    }));
    this.present();
  }

  /** Puts the round being played on the stage. Its choices can be picked once the avatar shows its emotion. */
  private present(): void {
    const round = this.game?.round;
    if (!round) return;
    this.watching = true;
    this.cheer.replaceChildren();
    this.stage.present(round.avatar, round.emotion, round.extent);
    this.watch();
  }

  /** Draws the screen for a child who is watching, with the keyboard on the question until there are answers to pick. */
  private watch(): void {
    this.render();
    this.question.focus({ preventScroll: true });
  }

  /** The avatar has started to show its emotion: now the child can answer. */
  private expressed(): void {
    if (this.phase !== 'watching') return;
    this.watching = false;
    this.show();
  }

  private guess(emotion: Emotion): void {
    if (this.phase !== 'asking') return;
    this.game?.guess(emotion);
    if (this.game?.phase === 'right') this.celebrate();
    this.show();
  }

  private retry(): void {
    this.game?.retry();
    this.watching = true;
    this.stage.replay();
    this.watch();
  }

  private next(): void {
    this.game?.next();
    if (this.game?.round) {
      this.present();
    } else {
      this.stage.rest();
      this.show();
    }
  }

  /** Draws the screen, then hands the keyboard whatever has just appeared on it. */
  private show(): void {
    this.render();
    this.carriedInput.settle();
    const container = this.phase === 'asking' ? this.choices : this.actions;
    const target = container.querySelector<HTMLButtonElement>('.menu-button--primary') ?? container.querySelector('button');
    target?.focus({ preventScroll: true });
  }

  private render(): void {
    const phase = this.phase;
    const round = this.game?.round;
    this.root.dataset.phase = phase;
    this.renderProgress();

    const [kicker, question] = this.headingFor(phase, round);
    this.kicker.textContent = kicker;
    this.question.textContent = question;
    // Says who is on the stage, and never which emotion: that is the child's to find.
    this.stageRoot.setAttribute('aria-label', round ? `${capitalized(nameOf(round.avatar))} is showing a feeling.` : 'The stage');

    if (round !== this.offered) {
      this.offered = round;
      this.choices.replaceChildren(...(round?.choices ?? []).map((emotion) => {
        const choice = document.createElement('button');
        choice.type = 'button';
        choice.className = 'emotion-choice';
        choice.dataset.emotion = emotion;
        // An emotion's name is its label, so one added to the list needs no other.
        choice.textContent = capitalized(emotion);
        choice.addEventListener('click', () => this.guess(emotion));
        return choice;
      }));
    }

    // The choices are there to read while the child watches, and wake when there is something to guess.
    for (const choice of this.choices.querySelectorAll('button')) choice.disabled = phase !== 'asking';

    const feedback = this.feedbackFor(phase, round);
    if (feedback) {
      this.feedback.dataset.tone = feedback.tone;
      this.badge.textContent = feedback.badge;
      this.verdict.textContent = feedback.title;
      this.note.replaceChildren(...feedback.note);
      this.actions.replaceChildren(
        ...(feedback.secondary ? [this.actionButton(feedback.secondary, 'quiet')] : []),
        this.actionButton(feedback.primary, 'primary'),
      );
    }
    this.answer.dataset.show = feedback ? 'feedback' : round ? 'choices' : 'none';
  }

  private renderProgress(): void {
    const played = this.game?.played ?? 0;
    const total = this.game?.total ?? 0;
    [...this.progress.children].forEach((step, index) => {
      step.classList.toggle('emotion-game__step--done', index < played);
      step.classList.toggle('emotion-game__step--now', index === played);
    });
    const place = total === 0 ? 'No rounds yet' : played < total ? `Round ${played + 1} of ${total}` : `All ${total} rounds played`;
    this.progress.setAttribute('aria-label', place);
  }

  /** The small line and the big line at the top of the panel. */
  private headingFor(phase: EmotionGamePhase, round: Round<StageAvatarId> | undefined): readonly [string, string] {
    if (round) return [LOOK_AT[round.extent], QUESTION];
    if (phase === 'finished') return ['All done', 'That was every feeling!'];
    if (phase === 'unavailable') return ['', 'The game could not get ready.'];
    return ['', 'Getting ready…'];
  }

  private feedbackFor(phase: EmotionGamePhase, round: Round<StageAvatarId> | undefined): Feedback | undefined {
    const turn = this.game?.played ?? 0;
    const next: Action = { label: 'Next', glyph: '▶', run: () => this.next() };
    if (phase === 'right' && round) {
      return {
        tone: 'glad',
        badge: '★',
        title: CHEERS[turn % CHEERS.length],
        note: ['That’s ', named(round.emotion), '!'],
        primary: next,
      };
    }
    if (phase === 'wrong' && round) {
      return {
        tone: 'kind',
        badge: '♥',
        title: COMFORTS[turn % COMFORTS.length],
        note: ['This one is ', named(round.emotion), '.'],
        primary: { label: 'Try again', glyph: '↻', run: () => this.retry() },
        secondary: next,
      };
    }
    if (phase === 'finished') {
      return {
        tone: 'glad',
        badge: '★',
        title: 'You did it!',
        note: ['Want to play again?'],
        primary: { label: 'Play again', glyph: '↻', run: () => this.begin() },
        secondary: { label: 'Menu', run: () => this.leave() },
      };
    }
    if (phase === 'unavailable') {
      return {
        tone: 'kind',
        badge: '♥',
        title: 'Sorry!',
        note: ['The characters did not load. Try again in a moment.'],
        primary: { label: 'Menu', run: () => this.leave() },
      };
    }
    return undefined;
  }

  private actionButton(action: Action, weight: 'primary' | 'quiet'): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu-button menu-button--${weight}`;
    button.append(action.label);
    if (action.glyph) {
      const glyph = document.createElement('span');
      glyph.setAttribute('aria-hidden', 'true');
      glyph.textContent = action.glyph;
      button.append(glyph);
    }
    button.addEventListener('click', action.run);
    return button;
  }

  /**
   * A burst of stars that fly out from the middle of the stage and stay
   * around the avatar until the next round. Each flies its own way, by the
   * numbers set on it here.
   */
  private celebrate(): void {
    const reach = Math.min(this.stageRoot.clientWidth, this.stageRoot.clientHeight) * 0.42;
    this.cheer.replaceChildren(...Array.from({ length: STARS }, (_, index) => {
      const star = document.createElement('i');
      const angle = ((index + 0.5) / STARS) * Math.PI * 2 - Math.PI / 2;
      // Every other star stops a little short, so they ring the avatar loosely rather than in a circle.
      const distance = reach * (index % 2 === 0 ? 1 : 0.88);
      star.textContent = '★';
      star.style.setProperty('--fly-x', `${Math.round(Math.cos(angle) * distance)}px`);
      star.style.setProperty('--fly-y', `${Math.round(Math.sin(angle) * distance)}px`);
      star.style.setProperty('--fly-turn', `${((index * 47) % 50) - 25}deg`);
      star.style.setProperty('--fly-delay', `${(index % 4) * 50}ms`);
      return star;
    }));
  }

  /** The arrow keys move between the choices as they lie on the screen, in rows and columns. */
  private stepBetweenChoices(event: KeyboardEvent): void {
    const steps: Record<string, readonly [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const step = steps[event.key];
    const from = event.target;
    if (!step || !(from instanceof HTMLButtonElement)) return;
    event.preventDefault();

    const center = (element: Element): readonly [number, number] => {
      const box = element.getBoundingClientRect();
      return [box.left + box.width / 2, box.top + box.height / 2];
    };
    const [x, y] = center(from);
    let nearest: HTMLButtonElement | undefined;
    let nearestCost = Infinity;
    for (const choice of this.choices.querySelectorAll('button')) {
      const [left, top] = center(choice);
      const along = (left - x) * step[0] + (top - y) * step[1];
      const across = Math.abs((left - x) * step[1]) + Math.abs((top - y) * step[0]);
      // Only a choice that lies the way the arrow points; one straight ahead before one off to the side.
      if (along < 1) continue;
      const cost = along + across * 4;
      if (cost < nearestCost) {
        nearest = choice;
        nearestCost = cost;
      }
    }
    nearest?.focus();
  }

  private snapshot(): EmotionGameSnapshot {
    return {
      phase: this.phase,
      look: this.look,
      played: this.game?.played ?? 0,
      total: this.game?.total ?? 0,
      round: this.game?.round ?? null,
      showing: this.stage.showing ?? null,
    };
  }
}
