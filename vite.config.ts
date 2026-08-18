import { defineConfig } from 'vitest/config';
import { dialogueProxyPlugin } from './server/dialogue-proxy';

export default defineConfig({
  // The dialogue proxy is the only thing that reads API keys. It declares server
  // hooks only, so it never becomes part of the browser bundle.
  plugins: [dialogueProxyPlugin()],
  server: {
    host: true,
    port: 4173,
  },
  preview: {
    host: true,
    port: 4173,
  },
  test: {
    environment: 'node',
    coverage: {
      reporter: ['text', 'html'],
    },
  },
});
