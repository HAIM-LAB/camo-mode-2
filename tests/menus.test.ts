import { describe, expect, it } from 'vitest';
import { isStrayClick, shouldSkipMenu } from '../src/menus';

describe('menu skip', () => {
  it('skips the menus only for skipMenu=1', () => {
    expect(shouldSkipMenu('?skipMenu=1')).toBe(true);
    expect(shouldSkipMenu('?debug=1&skipMenu=1')).toBe(true);
    expect(shouldSkipMenu('')).toBe(false);
    expect(shouldSkipMenu('?skipMenu=0')).toBe(false);
  });
});

describe('menu clicks', () => {
  it('ignores a click or tap that lands just after a screen appears, as the rest of a double one does', () => {
    expect(isStrayClick(1, 0)).toBe(true);
    expect(isStrayClick(2, 150)).toBe(true);
    expect(isStrayClick(1, 399)).toBe(true);
  });

  it('takes a click once the screen has been up for a moment', () => {
    expect(isStrayClick(1, 400)).toBe(false);
    expect(isStrayClick(1, 5000)).toBe(false);
  });

  it('never ignores a key press, which reports no click count', () => {
    expect(isStrayClick(0, 0)).toBe(false);
    expect(isStrayClick(0, 150)).toBe(false);
  });
});
