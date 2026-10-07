import { describe, expect, test } from 'vitest';
import { defaultMaxMediaBytes, fileError, formatSize, gridMove } from '../src/picker.js';

describe('quick-send file validation', () => {
  const file = (name: string, type: string, size = 1000) => ({ name, type, size });
  test('accepts the formats of /v2/send/file, by type or by extension when Windows reports none', () => {
    for (const [name, type] of [['a.png', 'image/png'], ['a.JPG', 'image/jpeg'], ['a.gif', 'image/gif'], ['a.webp', 'image/webp'], ['a.avif', 'image/avif'],
      ['a.mp4', 'video/mp4'], ['a.webm', 'video/webm'], ['a.mov', 'video/quicktime'], ['clip.mov', ''], ['clip.mp4', 'application/octet-stream'], ['capture', 'image/png']] as const) {
      expect(fileError(file(name, type), defaultMaxMediaBytes)).toBeUndefined();
    }
  });
  test('refuses HTML, SVG, audio and unknown files with the server message', () => {
    for (const [name, type] of [['a.html', 'text/html'], ['a.svg', 'image/svg+xml'], ['a.mp3', 'audio/mpeg'], ['a.txt', 'text/plain'], ['a', ''], ['a.exe', 'application/x-msdownload']]) {
      expect(fileError(file(name, type), defaultMaxMediaBytes)).toBe('Format refusé. Utilisez une image, un GIF, WebP, MP4, WebM ou MOV.');
    }
  });
  test('enforces the announced size limit, 25 MB before a server announces one', () => {
    expect(defaultMaxMediaBytes).toBe(25 * 1024 * 1024);
    expect(fileError(file('a.png', 'image/png', defaultMaxMediaBytes), defaultMaxMediaBytes)).toBeUndefined();
    expect(fileError(file('a.png', 'image/png', defaultMaxMediaBytes + 1), defaultMaxMediaBytes)).toBe('Fichier trop volumineux : 25 Mo maximum.');
    expect(fileError(file('a.png', 'image/png', 2000), 1500)).toBe('Fichier trop volumineux : 1 Ko maximum.');
    expect(fileError(file('a.png', 'image/png', 0), defaultMaxMediaBytes)).toBe('Ce fichier est vide.');
    expect(formatSize(1536 * 1024)).toBe('1,5 Mo');
    expect(formatSize(10)).toBe('1 Ko');
  });
});

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
  test('runs across the favorites grid then the Klipy grid, each starting its own row', () => {
    // 7 favorites (0-4, 5-6) above 6 GIFs (7-11, 12).
    const both = (index: number, key: string, shiftKey = false) => gridMove(index, { key, shiftKey }, [7, 6], 5);
    expect(both(-1, 'ArrowDown')).toBe(0);
    expect(both(3, 'ArrowDown')).toBe(6);
    expect(both(6, 'ArrowDown')).toBe(8);
    expect(both(5, 'ArrowDown')).toBe(7);
    expect(both(10, 'ArrowUp')).toBe(6);
    expect(both(8, 'ArrowUp')).toBe(6);
    expect(both(7, 'ArrowUp')).toBe(5);
    expect(both(6, 'ArrowRight')).toBe(7);
    expect(both(7, 'ArrowLeft')).toBe(6);
    expect(both(6, 'Tab')).toBe(7);
    expect(both(12, 'Tab')).toBe(12);
    expect(both(9, 'ArrowDown')).toBe(12);
    expect(both(2, 'ArrowUp')).toBe(-1);
    // An empty section takes no row.
    expect(gridMove(2, { key: 'ArrowUp' }, [0, 6], 5)).toBe(-1);
    expect(gridMove(-1, { key: 'ArrowDown' }, [0, 0], 5)).toBeUndefined();
  });
});
