/**
 * Stable, machine-readable markers the prompt builder always emits.
 *
 * A real model reads these as ordinary headings. The keyless mock brain parses
 * them to work out who is speaking and which beat is active, which is how
 * `npm run dev` with no API keys still drives a coherent conversation.
 *
 * Changing these strings is a breaking change for the mock brain, so they live in
 * their own file with no imports rather than being buried in the builder.
 */

export const MARKERS = Object.freeze({
  character: '# CHARACTER:',
  beat: '# BEAT:',
});

/** Reads back a marker value, e.g. `# BEAT: tension-surfaces` -> `tension-surfaces`. */
export function readMarker(prompt: string, marker: string): string | undefined {
  for (const line of prompt.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith(marker)) return trimmed.slice(marker.length).trim();
  }
  return undefined;
}
