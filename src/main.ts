import './styles.css';
import { CamoDemoApp } from './app';
import { EmotionGame } from './emotion-game';
import {
  DEFAULT_GAME_MODE,
  GameModeId,
  GameScene,
  gameMode,
  gameModeFromSearch,
  loadGameMode,
} from './game-mode';
import { MenuFlow, shouldSkipMenu, showScreen } from './menus';
import { PlayerLook, loadPlayerLook } from './player-look';

function showFatalError(error: unknown): void {
  const panel = document.getElementById('fatal-error');
  const message = document.getElementById('fatal-error-message');
  const startup = document.getElementById('startup');
  const detail = error instanceof Error ? error.message : String(error);

  document.body.dataset.appError = 'true';
  showScreen('error');
  startup?.classList.add('startup--hidden');
  if (message) {
    message.textContent = `Try refreshing in a browser with WebGL enabled. (${detail})`;
  }
  if (panel) panel.hidden = false;
  console.error('[Camo] Unable to start the game:', error);
}

function startPlayroom(look: PlayerLook, mode: GameModeId): void {
  showScreen('game');
  try {
    const app = new CamoDemoApp(look, mode);
    app.start();
  } catch (error) {
    showFatalError(error);
  }
}

/** The guessing game closes itself when the child leaves it, and the mode choice takes over. */
function startEmotionGame(look: PlayerLook, mode: GameModeId): void {
  showScreen('emotions');
  try {
    new EmotionGame(look, mode, {
      onLeave: () => openMenus((menus) => menus.showMode()),
      onError: showFatalError,
    }).start();
  } catch (error) {
    showFatalError(error);
  }
}

/** How each scene starts. GAME_MODES says which scene a mode plays in. */
const SCENE_STARTS: Readonly<Record<GameScene, (look: PlayerLook, mode: GameModeId) => void>> = {
  playroom: startPlayroom,
  'emotion-game': startEmotionGame,
};

function startGame(look: PlayerLook, mode: GameModeId): void {
  SCENE_STARTS[gameMode(mode).scene](look, mode);
}

const look = loadPlayerLook();
const savedMode = loadGameMode();

let menuFlow: MenuFlow | undefined;
/** Shows one of the menus. They are built when first shown: a visit that skips them may never show them. */
function openMenus(show: (menus: MenuFlow) => void): void {
  try {
    menuFlow ??= new MenuFlow({ savedMode, look, onPlay: startGame, onError: showFatalError });
    show(menuFlow);
  } catch (error) {
    showFatalError(error);
  }
}

if (shouldSkipMenu(window.location.search)) {
  // On the dev server `&mode=emotions` names the mode to skip into; a built game plays the saved one.
  const askedMode = import.meta.env.DEV ? gameModeFromSearch(window.location.search) : undefined;
  startGame(look, askedMode ?? savedMode ?? DEFAULT_GAME_MODE);
} else {
  openMenus((menus) => menus.showStart());
}
