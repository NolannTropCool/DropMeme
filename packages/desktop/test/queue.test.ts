import { describe, expect, test, vi } from 'vitest';
import { defaultSettings, type MediaEvent } from '@dropmeme/shared';
import { MediaQueue } from '../src/queue.js';

function event(id: string, kind: MediaEvent['kind'] = 'image'): MediaEvent {
  return { type: 'media', id, channelId: '123456789012345678', kind, url: `https://example.com/v1/media/${id}`, name: id, author: 'Alice', createdAt: Date.now() };
}
describe('bounded media queue', () => {
  test('Discord GIF animations encoded as MP4 follow the Images & GIF filter, not the video filter', () => {
    const queue = new MediaQueue({ ...defaultSettings, videos: false }, vi.fn());
    expect(queue.enqueue({ ...event('gif', 'video'), loop: true })).toBe(true);
    queue.configure({ ...defaultSettings, images: false, videos: true });
    expect(queue.enqueue({ ...event('gif-disabled', 'video'), loop: true })).toBe(false);
    expect(queue.enqueue(event('video', 'video'))).toBe(true);
  });
  test('plays FIFO, ignores duplicates and stale completion callbacks', () => {
    const display = vi.fn(); const queue = new MediaQueue(defaultSettings, display);
    expect(queue.enqueue(event('a'))).toBe(true);
    expect(queue.enqueue(event('a'))).toBe(false);
    queue.enqueue(event('b')); queue.enqueue(event('c'));
    expect(display.mock.calls.map(call => call[0].id)).toEqual(['a']);
    queue.complete('a'); queue.complete('a');
    expect(display.mock.calls.map(call => call[0].id)).toEqual(['a', 'b']);
    queue.complete('b'); expect(queue.currentId()).toBe('c');
  });
  test('bounds pending media and drops incoming media when paused', () => {
    const queue = new MediaQueue({ ...defaultSettings, maxQueue: 1 }, vi.fn());
    queue.enqueue(event('a')); queue.enqueue(event('b'));
    expect(queue.enqueue(event('c'))).toBe(false);
    queue.setPaused(true); expect(queue.currentId()).toBeUndefined();
    expect(queue.enqueue(event('d'))).toBe(false);
    queue.setPaused(false); expect(queue.enqueue(event('e'))).toBe(true);
  });
  test('filters formats, mute-only audio, expired media and reset state', () => {
    const display = vi.fn(); const queue = new MediaQueue({ ...defaultSettings, videos: false, audio: true }, display);
    expect(queue.enqueue(event('v', 'video'))).toBe(false);
    expect(queue.enqueue(event('audio', 'audio'))).toBe(false);
    expect(queue.enqueue({ ...event('old'), createdAt: Date.now() - 6 * 60_000 })).toBe(false);
    queue.configure({ ...defaultSettings, audio: true, sound: true });
    expect(queue.enqueue(event('audio', 'audio'))).toBe(true);
    queue.reset(); expect(queue.enqueue(event('audio', 'audio'))).toBe(true);
  });
  test('drops stale media while advancing a long queue', () => {
    const display = vi.fn(); const queue = new MediaQueue(defaultSettings, display);
    const now = Date.now();
    queue.enqueue(event('a')); queue.enqueue(event('b'));
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    try {
      queue.complete('a');
      expect(queue.currentId()).toBeUndefined();
      expect(display).toHaveBeenCalledTimes(1);
    } finally { clock.mockRestore(); }
  });
});
