/**
 * Server-side configuration.
 *
 * This module is imported by `vite.config.ts` and runs in the node process that
 * serves the app. It is never bundled into anything the browser downloads.
 *
 * Keys are read with Vite's `loadEnv` at an EMPTY prefix, which reads `.env`
 * without the `VITE_` filter. That filter is exactly what would otherwise push a
 * key into client code, so the rule for this project is simple and absolute:
 *
 *   **Never name a secret `VITE_*`. Never reference `import.meta.env` for a key.**
 *
 * `.env` is gitignored. `.env.example` documents the variable names.
 */

import { loadEnv } from 'vite';

export type ServerEnv = Readonly<Record<string, string | undefined>>;

export function loadServerEnv(mode: string, root: string): ServerEnv {
  // process.env first so a real shell export wins over a stale .env line.
  return { ...loadEnv(mode, root, ''), ...process.env };
}

/** Names of every secret this project reads. Used for the redaction check below. */
export const SECRET_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'ELEVENLABS_API_KEY',
] as const;

/**
 * Everything the browser is allowed to know: which capabilities are live, and
 * nothing about how. Built by allow-list, not by deleting fields from the env,
 * so a new secret cannot leak by being forgotten here.
 */
export interface PublicConfig {
  brain: { id: string; label: string; model: string };
  voice: { available: boolean };
  speechToText: { available: boolean; provider: string | null };
  moderation: { id: string };
}
