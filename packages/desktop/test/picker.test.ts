import { describe, expect, test } from 'vitest';
import { gridMove } from '../src/picker.js';

describe('GIF grid keyboard navigation', () => {
  // 12 tiles in 5 columns: rows 0-4, 5-9 and a partial last row 10-11.
  const move = (index: number, key: string, shiftKey = false) => gridMove(index, { key, shiftKey }, 12, 5);
  test('enters the grid from the search field with ↓ or Tab, leaves the caret keys alone', () => {
    expect(move(-1, 'ArrowDown')).toBe(0);
    expect(move(-1, 'Tab')).toBe(0);
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'Home', 'a']) expect(move(-1, key)).toBeUndefined();
    expect(move(-1, 'Tab', true)).toBeUndefined();
    expect(gridMove(-1, { key: 'ArrowDown' }, 0, 5)).toBeUndefined();
  });
  test('moves by tile horizontally and by row vertically, clamped to the grid', () => {
    expect(move(0, 'ArrowRight')).toBe(1);
    expect(move(11, 'ArrowRight')).toBe(11);
    expect(move(5, 'ArrowLeft')).toBe(4);
    expect(move(0, 'ArrowLeft')).toBe(0);
    expect(move(2, 'ArrowDown')).toBe(7);
    expect(move(7, 'ArrowUp')).toBe(2);
    expect(move(3, 'ArrowUp')).toBe(-1);
    expect(move(4, 'Tab')).toBe(5);
    expect(move(11, 'Tab')).toBe(11);
    expect(move(0, 'Tab', true)).toBe(-1);
    expect(move(3, 'Enter')).toBeUndefined();
  });
  test('↓ above a partial last row lands on its last tile, and stays on the last row', () => {
    expect(move(8, 'ArrowDown')).toBe(11);
    expect(move(6, 'ArrowDown')).toBe(11);
    expect(move(10, 'ArrowDown')).toBe(10);
  });
});
