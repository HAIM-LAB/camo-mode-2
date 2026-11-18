import { LOOK_ICONS } from './look-icons';
import { LookPreview } from './look-preview';
import {
  LOOK_AXES,
  LookAxis,
  LookAxisId,
  PlayerLook,
  lookPaint,
  savePlayerLook,
  surfaceColor,
} from './player-look';

/** Two-choice axes that share one row on wide screens. */
const PAIRED_AXES: ReadonlySet<string> = new Set(['bottoms', 'headwear']);

export type Screen = 'start' | 'customize' | 'game' | 'error';

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

/** Start menu, then character customization, then hands the chosen look to the game. */
export class MenuFlow {
  private readonly customize = requiredElement<HTMLElement>('customize');
  private readonly startPlay = requiredElement<HTMLButtonElement>('start-play');
  private readonly back = requiredElement<HTMLButtonElement>('customize-back');
  private readonly play = requiredElement<HTMLButtonElement>('customize-play');
  private readonly stage = requiredElement<HTMLElement>('look-stage');
  private readonly axesRoot = requiredElement<HTMLElement>('look-axes');
  private look: PlayerLook;
  private preview?: LookPreview;

  constructor(private readonly options: MenuFlowOptions) {
    this.look = options.look;
    this.renderAxes();
    this.paintIcons();
    this.startPlay.addEventListener('click', () => this.showCustomize());
    this.back.addEventListener('click', () => this.showStart());
    this.play.addEventListener('click', () => this.finish());
    this.customize.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') this.showStart();
    });
  }

  showStart(): void {
    this.closePreview();
    showScreen('start');
    this.startPlay.focus();
  }

  showCustomize(): void {
    showScreen('customize');
    try {
      this.preview ??= new LookPreview(this.stage, this.look);
    } catch (error) {
      this.options.onError(error);
      return;
    }
    this.axesRoot.querySelector<HTMLInputElement>('input:checked')?.focus();
  }

  private finish(): void {
    this.closePreview();
    this.options.onPlay(this.look);
  }

  private closePreview(): void {
    this.preview?.dispose();
    this.preview = undefined;
  }

  private choose(axis: LookAxisId, option: string): void {
    this.look = { ...this.look, [axis]: option };
    savePlayerLook(this.look);
    this.preview?.setLook(this.look);
    this.paintIcons();
  }

  /** Keeps the picture cards in the child's current skin and outfit colors. */
  private paintIcons(): void {
    for (const [role, surface] of Object.entries(lookPaint(this.look))) {
      if (surface) this.axesRoot.style.setProperty(`--paint-${role}`, surfaceColor(surface));
    }
  }

  private renderAxes(): void {
    for (const axis of LOOK_AXES as readonly LookAxis[]) {
      const fieldset = document.createElement('fieldset');
      fieldset.className = `look-axis look-axis--${axis.display}`;
      fieldset.classList.toggle('look-axis--pair', PAIRED_AXES.has(axis.id));
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
