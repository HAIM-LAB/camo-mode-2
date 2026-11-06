import './styles.css';
import { CamoDemoApp } from './app';
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

function startGame(look: PlayerLook): void {
  showScreen('game');
  try {
    const app = new CamoDemoApp(look);
    app.start();
  } catch (error) {
    showFatalError(error);
  }
}

const look = loadPlayerLook();
if (shouldSkipMenu(window.location.search)) {
  startGame(look);
} else {
  try {
    new MenuFlow({ look, onPlay: startGame, onError: showFatalError }).showStart();
  } catch (error) {
    showFatalError(error);
  }
}
