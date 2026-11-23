import { DEFAULT_GAME_MODE, GAME_MODES, GameModeId, saveGameMode } from './game-mode';
import { LOOK_ICONS } from './look-icons';
import { LookPreview } from './look-preview';
import {
  LOOK_AXES,
  LookAxis,
  LookAxisId,
  PLAYER_STYLES,
  PlayerLook,
  PlayerStyle,
  PlayerStyleId,
  lookPaint,
  savePlayerLook,
  surfaceColor,
} from './player-look';

/** Axes with few choices, which share one row on wide screens. */
const PAIRED_AXES: ReadonlySet<string> = new Set(['bottoms', 'headwear']);

export type Screen = 'start' | 'mode' | 'style' | 'customize' | 'game' | 'emotions' | 'error';

/** `?skipMenu=1` goes straight into the game with the saved (or default) mode and look. */
export function shouldSkipMenu(search: string): boolean {
  return new URLSearchParams(search).get('skipMenu') === '1';
}

/**
 * How long a screen ignores the pointer after it appears. The second click or
 * tap of a double one lands on whatever the next screen has put under it, and
 * it must not choose there.
 */
const SETTLE_MS = 400;

/** Whether a click came from a pointer before its screen could be looked at. A key's click has a detail of 0. */
export function isStrayClick(detail: number, sinceShownMs: number): boolean {
  return detail > 0 && sinceShownMs < SETTLE_MS;
}

/**
 * Keeps input that began before a screen changed from choosing on it: the
 * rest of a double click or tap, and the repeats of an Enter key held down.
 */
export class CarriedInputGuard {
  /** When what is showing last changed, on the performance.now() clock. */
  private changedAt = 0;

  /** Call whenever the screen, or what it puts under the pointer, changes. */
  settle(): void {
    this.changedAt = performance.now();
  }

  /** Guards everything inside an element, until the signal, if one is given, aborts. */
  watch(element: HTMLElement, signal?: AbortSignal): void {
    element.addEventListener(
      'click',
      (event) => {
        if (!isStrayClick(event.detail, performance.now() - this.changedAt)) return;
        event.preventDefault();
        event.stopPropagation();
      },
      { capture: true, signal },
    );
    element.addEventListener(
      'keydown',
      (event) => {
        if (event.repeat && event.key === 'Enter') event.preventDefault();
      },
      { capture: true, signal },
    );
  }
}

/** The stylesheet shows exactly one screen, keyed off `body[data-screen]`. */
export function showScreen(screen: Screen): void {
  document.body.dataset.screen = screen;
}

/** An element one of the screens is built on. */
export function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required screen element #${id} is missing`);
  return element as T;
}

/** Rings the choice made last time and announces it as the current one. */
function markCurrent(button: HTMLButtonElement, className: string, current: boolean): void {
  button.classList.toggle(className, current);
  if (current) button.setAttribute('aria-current', 'true');
  else button.removeAttribute('aria-current');
}

export interface MenuFlowOptions {
  /** The mode picked on an earlier visit, if any. */
  savedMode: GameModeId | undefined;
  look: PlayerLook;
  onPlay: (look: PlayerLook, mode: GameModeId) => void;
  onError: (error: unknown) => void;
}

/**
 * Start menu, then the mode choice, then the style choice, then character
 * customization in that style, then hands the chosen mode and look to the game.
 */
export class MenuFlow {
  private readonly modeMenu = requiredElement<HTMLElement>('mode-menu');
  private readonly styleMenu = requiredElement<HTMLElement>('style-menu');
  private readonly customize = requiredElement<HTMLElement>('customize');
  private readonly startPlay = requiredElement<HTMLButtonElement>('start-play');
  private readonly modeBack = requiredElement<HTMLButtonElement>('mode-back');
  private readonly modeCards = requiredElement<HTMLElement>('mode-cards');
  private readonly styleBack = requiredElement<HTMLButtonElement>('style-back');
  private readonly styleCards = requiredElement<HTMLElement>('style-cards');
  private readonly back = requiredElement<HTMLButtonElement>('customize-back');
  private readonly play = requiredElement<HTMLButtonElement>('customize-play');
  private readonly stage = requiredElement<HTMLElement>('look-stage');
  private readonly axesRoot = requiredElement<HTMLElement>('look-axes');
  /** The mode picked on the mode screen, on this visit or an earlier one. */
  private mode: GameModeId | undefined;
  private look: PlayerLook;
  /** The live previews of whichever screen is showing; none outlives its screen. */
  private previews: LookPreview[] = [];
  private readonly carriedInput = new CarriedInputGuard();

  constructor(private readonly options: MenuFlowOptions) {
    this.mode = options.savedMode;
    this.look = options.look;
    this.renderModeCards();
    this.renderStyleCards();
    this.renderAxes();
    this.startPlay.addEventListener('click', () => this.showMode());
    this.modeBack.addEventListener('click', () => this.showStart());
    this.styleBack.addEventListener('click', () => this.showMode());
    this.back.addEventListener('click', () => this.showStyle());
    this.play.addEventListener('click', () => this.finish());
    this.modeMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.showStart();
    });
    this.styleMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.showMode();
    });
    this.customize.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.showStyle();
    });
    for (const menu of [this.modeMenu, this.styleMenu, this.customize]) this.carriedInput.watch(menu);
  }

  showStart(): void {
    this.open('start');
    this.startPlay.focus();
  }

  /** One button per mode. Only a mode the child has picked before is marked. */
  showMode(): void {
    this.open('mode');
    const cards = [...this.modeCards.querySelectorAll<HTMLButtonElement>('.mode-card')];
    for (const card of cards) markCurrent(card, 'mode-card--current', card.dataset.mode === this.mode);
    (cards.find((card) => card.dataset.mode === this.mode) ?? cards[0])?.focus();
  }

  /** Two cards, each showing its character in the child's current look. */
  showStyle(): void {
    this.open('style');
    try {
      for (const card of this.cardButtons()) {
        markCurrent(card, 'style-card--current', card.dataset.style === this.look.style);
        const stage = card.querySelector<HTMLElement>('.style-card__stage');
        if (!stage) throw new Error('A style card is missing its stage');
        this.previews.push(new LookPreview(
          stage,
          { ...this.look, style: card.dataset.style as PlayerStyleId },
          { interactive: false },
        ));
      }
    } catch (error) {
      this.options.onError(error);
      return;
    }
    this.styleCards.querySelector<HTMLButtonElement>('.style-card--current')?.focus();
  }

  showCustomize(): void {
    this.open('customize');
    this.paintIcons();
    try {
      this.previews.push(new LookPreview(this.stage, this.look, { interactive: true }));
    } catch (error) {
      this.options.onError(error);
      return;
    }
    this.axesRoot.querySelector<HTMLInputElement>('input:checked')?.focus();
  }

  private finish(): void {
    this.closePreviews();
    // No mode is picked yet only if the flow was entered past the mode screen.
    this.options.onPlay(this.look, this.mode ?? DEFAULT_GAME_MODE);
  }

  private open(screen: Screen): void {
    this.closePreviews();
    showScreen(screen);
    this.carriedInput.settle();
  }

  private closePreviews(): void {
    for (const preview of this.previews) preview.dispose();
    this.previews = [];
  }

  private cardButtons(): HTMLButtonElement[] {
    return [...this.styleCards.querySelectorAll<HTMLButtonElement>('.style-card')];
  }

  private chooseMode(mode: GameModeId): void {
    this.mode = mode;
    saveGameMode(mode);
    this.showStyle();
  }

  private chooseStyle(style: PlayerStyleId): void {
    this.look = { ...this.look, style };
    savePlayerLook(this.look);
    this.showCustomize();
  }

  private choose(axis: LookAxisId, option: string): void {
    this.look = { ...this.look, [axis]: option };
    savePlayerLook(this.look);
    for (const preview of this.previews) preview.setLook(this.look);
    this.paintIcons();
  }

  /** Keeps the picture cards in the child's current skin and outfit colors. */
  private paintIcons(): void {
    for (const [role, surface] of Object.entries(lookPaint(this.look))) {
      if (surface) this.axesRoot.style.setProperty(`--paint-${role}`, surfaceColor(surface));
    }
  }

  private renderModeCards(): void {
    for (const mode of GAME_MODES) {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'mode-card';
      card.dataset.mode = mode.id;
      card.textContent = mode.label;
      card.addEventListener('click', () => this.chooseMode(mode.id));
      this.modeCards.append(card);
    }
  }

  private renderStyleCards(): void {
    for (const style of PLAYER_STYLES) this.styleCards.append(this.styleCard(style));
  }

  private styleCard(style: PlayerStyle): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'style-card';
    card.dataset.style = style.id;
    card.addEventListener('click', () => this.chooseStyle(style.id));

    const stage = document.createElement('span');
    stage.className = 'style-card__stage';
    const name = document.createElement('span');
    name.className = 'style-card__name';
    name.textContent = style.label;
    const blurb = document.createElement('span');
    blurb.className = 'style-card__blurb';
    blurb.textContent = style.blurb;
    card.append(stage, name, blurb);
    return card;
  }

  private renderAxes(): void {
    const axes = LOOK_AXES as readonly LookAxis[];
    // The shared row has a column per choice, so its cards are all one width
    // however the choices divide between its axes.
    const paired = axes.filter((axis) => PAIRED_AXES.has(axis.id));
    const pairColumns = paired.reduce((sum, axis) => sum + axis.options.length, 0);
    this.axesRoot.style.setProperty('--pair-columns', String(pairColumns));

    for (const axis of axes) {
      const fieldset = document.createElement('fieldset');
      fieldset.className = `look-axis look-axis--${axis.display}`;
      if (PAIRED_AXES.has(axis.id)) {
        fieldset.classList.add('look-axis--pair');
        fieldset.style.setProperty('--span', String(axis.options.length));
      }
      const legend = document.createElement('legend');
      legend.textContent = axis.label;
      const options = document.createElement('div');
      options.className = 'look-axis__options';
      const columns = axis.display === 'swatch' ? axis.options.length : Math.min(axis.options.length, 3);
      options.style.setProperty('--columns', String(columns));

      for (const option of axis.options) {
        const label = document.createElement('label');
        label.className = 'look-option';
        const input = document.createElement('input');
        input.type = 'radio';
        input.name = `look-${axis.id}`;
        input.value = option.id;
        input.className = 'look-option__input';
        input.checked = this.look[axis.id as LookAxisId] === option.id;
        input.addEventListener('change', () => this.choose(axis.id as LookAxisId, option.id));

        const swatch = document.createElement('span');
        swatch.className = 'look-option__swatch';
        swatch.setAttribute('aria-hidden', 'true');
        if (option.icon) {
          swatch.innerHTML = LOOK_ICONS[option.icon] ?? '';
        }
        for (const role of axis.swatchRoles ?? []) {
          const band = document.createElement('i');
          const surface = option.paint?.[role];
          band.style.background = surface ? surfaceColor(surface) : 'transparent';
          swatch.append(band);
        }

        const name = document.createElement('span');
        name.className = axis.display === 'swatch' ? 'visually-hidden' : 'look-option__name';
        name.textContent = option.label;
        label.append(input, swatch, name);
        options.append(label);
      }

      fieldset.append(legend, options);
      this.axesRoot.append(fieldset);
    }
  }
}
