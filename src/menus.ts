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

export type Screen = 'start' | 'style' | 'customize' | 'game' | 'error';

/** `?skipMenu=1` goes straight into the playroom with the saved (or default) look. */
export function shouldSkipMenu(search: string): boolean {
  return new URLSearchParams(search).get('skipMenu') === '1';
}

/** The stylesheet shows exactly one screen, keyed off `body[data-screen]`. */
export function showScreen(screen: Screen): void {
  document.body.dataset.screen = screen;
}

function requiredElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Required menu element #${id} is missing`);
  return element as T;
}

export interface MenuFlowOptions {
  look: PlayerLook;
  onPlay: (look: PlayerLook) => void;
  onError: (error: unknown) => void;
}

/**
 * Start menu, then the style choice, then character customization in that
 * style, then hands the chosen look to the game.
 */
export class MenuFlow {
  private readonly styleMenu = requiredElement<HTMLElement>('style-menu');
  private readonly customize = requiredElement<HTMLElement>('customize');
  private readonly startPlay = requiredElement<HTMLButtonElement>('start-play');
  private readonly styleBack = requiredElement<HTMLButtonElement>('style-back');
  private readonly styleCards = requiredElement<HTMLElement>('style-cards');
  private readonly back = requiredElement<HTMLButtonElement>('customize-back');
  private readonly play = requiredElement<HTMLButtonElement>('customize-play');
  private readonly stage = requiredElement<HTMLElement>('look-stage');
  private readonly axesRoot = requiredElement<HTMLElement>('look-axes');
  private look: PlayerLook;
  /** The live previews of whichever screen is showing; none outlives its screen. */
  private previews: LookPreview[] = [];

  constructor(private readonly options: MenuFlowOptions) {
    this.look = options.look;
    this.renderStyleCards();
    this.renderAxes();
    this.startPlay.addEventListener('click', () => this.showStyle());
    this.styleBack.addEventListener('click', () => this.showStart());
    this.back.addEventListener('click', () => this.showStyle());
    this.play.addEventListener('click', () => this.finish());
    this.styleMenu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.showStart();
    });
    this.customize.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.showStyle();
    });
  }

  showStart(): void {
    this.closePreviews();
    showScreen('start');
    this.startPlay.focus();
  }

  /** Two cards, each showing its character in the child's current look. */
  showStyle(): void {
    this.closePreviews();
    showScreen('style');
    try {
      for (const card of this.cardButtons()) {
        const current = card.dataset.style === this.look.style;
        card.classList.toggle('style-card--current', current);
        if (current) card.setAttribute('aria-current', 'true');
        else card.removeAttribute('aria-current');
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
    this.closePreviews();
    showScreen('customize');
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
    this.options.onPlay(this.look);
  }

  private closePreviews(): void {
    for (const preview of this.previews) preview.dispose();
    this.previews = [];
  }

  private cardButtons(): HTMLButtonElement[] {
    return [...this.styleCards.querySelectorAll<HTMLButtonElement>('.style-card')];
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
