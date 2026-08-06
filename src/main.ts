import './styles.css';
import { CamoDemoApp } from './app';

function showFatalError(error: unknown): void {
  const panel = document.getElementById('fatal-error');
  const message = document.getElementById('fatal-error-message');
  const startup = document.getElementById('startup');
  const detail = error instanceof Error ? error.message : String(error);

  document.body.dataset.appError = 'true';
  startup?.classList.add('startup--hidden');
  if (message) {
    message.textContent = `Try refreshing in a browser with WebGL enabled. (${detail})`;
  }
  if (panel) panel.hidden = false;
  console.error('[Camo] Unable to start the playroom:', error);
}

try {
  const app = new CamoDemoApp();
  app.start();
} catch (error) {
  showFatalError(error);
}
