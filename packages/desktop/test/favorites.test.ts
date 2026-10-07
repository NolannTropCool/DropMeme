import { describe, expect, test } from 'vitest';
import type { Favorite, MediaEvent } from '@dropmeme/shared';
import { favoriteExtensionOf, favoriteRefusal, filterFavorites, maxFavoriteBytes, maxFavorites, moveFavorite, parseFavorites, rememberReceived } from '../src/favorites.js';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const gif = (i: number, name = `GIF ${i}`): Favorite => ({ id: uuid(i), kind: 'gif', name, gif: `cat-${i}`, previewUrl: 'https://static.klipy.com/a.webp', width: 320, height: 240 });
const file = (i: number, size: number, name = `Fichier ${i}`): Favorite => ({ id: uuid(i), kind: 'file', name, ext: 'png', size });

describe('favorites list read from the store', () => {
  test('keeps valid entries in order and drops invalid or duplicate ones, never the whole list', () => {
    const raw = [gif(1), { ...gif(2), previewUrl: 'http://evil.example/a.webp' }, { ...file(3, 10), ext: 'mov' }, { ...file(4, 10), ext: '../x' }, null, 'gif',
      { ...gif(5), id: 'not-a-uuid' }, { ...gif(6), name: '   ' }, { ...gif(7), name: 'x'.repeat(65) }, { ...file(8, 0) }, gif(1, 'doublon'), file(9, 2048), { ...gif(10), kind: 'audio' }];
    expect(parseFavorites(raw)).toEqual([gif(1), file(9, 2048)]);
    for (const value of [undefined, null, {}, 'favoris', 42]) expect(parseFavorites(value)).toEqual([]);
    expect(parseFavorites(Array.from({ length: 250 }, (_, i) => gif(i)))).toHaveLength(maxFavorites);
  });
});

describe('favorite caps', () => {
  test('refuses a 201st favorite and anything past 500 MB in total, in French', () => {
    expect([maxFavorites, maxFavoriteBytes]).toEqual([200, 500 * 1024 * 1024]);
    expect(favoriteRefusal(Array.from({ length: 199 }, (_, i) => gif(i)))).toBeUndefined();
    expect(favoriteRefusal(Array.from({ length: 200 }, (_, i) => gif(i)))).toBe('200 favoris maximum. Supprimez-en dans l’onglet Favoris.');
    const list = [file(1, 300 * 1024 * 1024), gif(2), file(3, 150 * 1024 * 1024)];
    expect(favoriteRefusal(list, 50 * 1024 * 1024)).toBeUndefined();
    expect(favoriteRefusal(list, 50 * 1024 * 1024 + 1)).toBe('Espace des favoris plein (500 Mo maximum). Supprimez-en dans l’onglet Favoris.');
  });
});

describe('favorites in the quick-send window', () => {
  test('filters by name, ignoring case and accents, everything when the field is empty', () => {
    const list = [gif(1, 'Chat qui danse'), file(2, 10, 'Élan'), gif(3, 'Chien')];
    expect(filterFavorites(list, '')).toEqual(list);
    expect(filterFavorites(list, '   ')).toEqual(list);
    expect(filterFavorites(list, ' CHAT ').map(item => item.name)).toEqual(['Chat qui danse']);
    expect(filterFavorites(list, 'elan').map(item => item.name)).toEqual(['Élan']);
    expect(filterFavorites(list, 'ch').map(item => item.name)).toEqual(['Chat qui danse', 'Chien']);
    expect(filterFavorites(list, 'loup')).toEqual([]);
  });
  test('moves one favorite up or down, unchanged at either end', () => {
    const list = [gif(1), gif(2), gif(3)];
    const ids = (value: Favorite[]) => value.map(item => item.id);
    expect(ids(moveFavorite(list, uuid(3), -1))).toEqual([uuid(1), uuid(3), uuid(2)]);
    expect(ids(moveFavorite(list, uuid(1), 1))).toEqual([uuid(2), uuid(1), uuid(3)]);
    expect(ids(moveFavorite(list, uuid(1), -1))).toEqual(ids(list));
    expect(ids(moveFavorite(list, uuid(3), 1))).toEqual(ids(list));
    expect(ids(moveFavorite(list, uuid(9), 1))).toEqual(ids(list));
    expect(ids(list)).toEqual([uuid(1), uuid(2), uuid(3)]);
  });
  test('keeps the extension from the MIME type first, then from the name; MOV, SVG and the rest are refused', () => {
    expect(favoriteExtensionOf('image/jpeg', 'photo.jpeg')).toBe('jpg');
    expect(favoriteExtensionOf('image/png', 'capture')).toBe('png');
    expect(favoriteExtensionOf('', 'clip.WEBM')).toBe('webm');
    expect(favoriteExtensionOf('application/octet-stream', 'a.gif')).toBe('gif');
    for (const [type, name] of [['video/quicktime', 'a.mov'], ['image/svg+xml', 'a.svg'], ['text/html', 'a.png.html'], ['', 'a']]) expect(favoriteExtensionOf(type!, name!)).toBeUndefined();
  });
});

describe('latest received media', () => {
  const media = (id: string, kind: MediaEvent['kind']): MediaEvent => ({ type: 'media', id, channelId: '123456789012345678', kind, ...(kind === 'text' ? { text: 'gg' } : {}), url: `https://dropmeme.example.com/v1/media/${id}?ticket=t`, name: `${id}.gif`, author: 'Alice', createdAt: 0 });
  test('keeps the 5 latest images and videos, newest first, without text, audio or duplicates', () => {
    let list = rememberReceived([], media('text', 'text'));
    list = rememberReceived(list, media('audio', 'audio'));
    expect(list).toEqual([]);
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) list = rememberReceived(list, media(id, id === 'c' ? 'video' : 'image'));
    expect(list.map(item => item.id)).toEqual(['f', 'e', 'd', 'c', 'b']);
    list = rememberReceived(list, media('d', 'image'));
    expect(list.map(item => item.id)).toEqual(['d', 'f', 'e', 'c', 'b']);
    expect(list[0]).toEqual({ id: 'd', kind: 'image', url: 'https://dropmeme.example.com/v1/media/d?ticket=t', name: 'd.gif', author: 'Alice' });
  });
});
