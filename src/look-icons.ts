/**
 * Pictures for the menu's icon choices. They paint with the `--paint-<role>`
 * custom properties the menu keeps in step with the current look, so each card
 * shows the child's own skin and outfit colors. Static, trusted markup.
 */

const HAIR = '#4d352c';
const INK = '#172033';

const face = (y: number) => `
  <circle cx="26" cy="${y}" r="2.6" fill="${INK}"/>
  <circle cx="38" cy="${y}" r="2.6" fill="${INK}"/>
  <path d="M27.5 ${y + 7} Q32 ${y + 10.5} 36.5 ${y + 7}" stroke="${INK}" stroke-width="2.2" fill="none" stroke-linecap="round"/>`;

// Each picture's viewBox is cropped to its drawing so it fills the card.
const icon = (viewBox: string, body: string) =>
  `<svg viewBox="${viewBox}" aria-hidden="true" focusable="false">${body}</svg>`;

export const LOOK_ICONS: Readonly<Record<string, string>> = Object.freeze({
  boy: icon('11 9 42 41', `
    <circle cx="32" cy="31" r="17" fill="var(--paint-skin)"/>
    <path d="M14.5 29 C13 11 51 9 49.5 27 C45 22 37 19.5 28 21.5 C22 23 17.5 25.5 14.5 29 Z" fill="${HAIR}"/>
    ${face(33)}`),
  girl: icon('10 10 44 44', `
    <path d="M13 30 C13 10 51 10 51 30 V49 C51 52 46 53 44 50 V33 H20 V50 C18 53 13 52 13 49 Z" fill="${HAIR}"/>
    <circle cx="32" cy="31" r="16" fill="var(--paint-skin)"/>
    <path d="M16 29 C15 13 49 13 48 29 C42 23 22 23 16 29 Z" fill="${HAIR}"/>
    ${face(33)}`),
  trousers: icon('10 3 44 50', `
    <path d="M19 5 H45 L47.5 51 H35.5 L32 21 L28.5 51 H16.5 Z" fill="var(--paint-trousers)"/>
    <rect x="19" y="5" width="26" height="6" rx="2" fill="var(--paint-hoodieDark)"/>`),
  skirt: icon('9 3 46 50', `
    <rect x="22.5" y="36" width="7.5" height="15" rx="3.5" fill="var(--paint-trousers)"/>
    <rect x="34" y="36" width="7.5" height="15" rx="3.5" fill="var(--paint-trousers)"/>
    <path d="M21 5 H43 L51 37 C51.5 39.5 50 41 47.5 41 H16.5 C14 41 12.5 39.5 13 37 Z" fill="var(--paint-skirt)"/>`),
  beanie: icon('10 7 44 44', `
    <circle cx="32" cy="33" r="16" fill="var(--paint-skin)"/>
    <path d="M14.5 27 C14.5 7 49.5 7 49.5 27 Z" fill="var(--paint-pack)"/>
    <rect x="12.5" y="22.5" width="39" height="8" rx="4" fill="var(--paint-packDark)"/>
    ${face(37)}`),
  scarf: icon('7 2 50 54', `
    <path d="M32 4 C17 4 11 16 11 30 C11 41 15 47 20 50 H44 C49 47 53 41 53 30 C53 16 47 4 32 4 Z" fill="var(--paint-scarf)"/>
    <path d="M12 44 C18 53 46 53 52 44 L55 55 H9 Z" fill="var(--paint-scarfDark)"/>
    <ellipse cx="32" cy="31" rx="11.5" ry="13.5" fill="var(--paint-skin)"/>
    ${face(30)}`),
});
