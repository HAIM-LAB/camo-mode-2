import './styles.css';
import { CamoDemoApp } from './app';
import { DEFAULT_GAME_MODE, GameModeId, GameScene, gameMode, loadGameMode } from './game-mode';
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
  console.error('[Camo] Unable to start the playroom:', error);
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

/** How each scene starts. GAME_MODES says which scene a mode plays in. */
const SCENE_STARTS: Readonly<Record<GameScene, (look: PlayerLook, mode: GameModeId) => void>> = {
  playroom: startPlayroom,
};

function startGame(look: PlayerLook, mode: GameModeId): void {
  SCENE_STARTS[gameMode(mode).scene](look, mode);
}

const look = loadPlayerLook();
const savedMode = loadGameMode();
if (shouldSkipMenu(window.location.search)) {
  startGame(look, savedMode ?? DEFAULT_GAME_MODE);
} else {
  try {
    new MenuFlow({ savedMode, look, onPlay: startGame, onError: showFatalError }).showStart();
  } catch (error) {
    showFatalError(error);
  }
}
