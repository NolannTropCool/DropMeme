import { describe, expect, test, vi } from 'vitest';
import { defaultSettings, playbackDuration, type MediaEvent } from '@dropmeme/shared';
import { MediaQueue } from '../src/queue.js';

function event(id: string, kind: MediaEvent['kind'] = 'image'): MediaEvent {
  return { type: 'media', id, channelId: '123456789012345678', kind, url: `https://example.com/v1/media/${id}`, name: id, author: 'Alice', createdAt: Date.now() };
}
describe('bounded media queue', () => {
  test('a video shares GIF/text slots and waiting videos do not block later text', () => {
    const queue = new MediaQueue({ ...defaultSettings, multiDisplay: true, maxSimultaneous: 3 }, vi.fn());
    queue.enqueue({ ...event('gif'), animation: true });
    queue.enqueue({ ...event('text', 'text'), text: 'Bonjour' });
    queue.enqueue({ ...event('text2', 'text'), text: 'Encore' });
    queue.enqueue(event('v1', 'video')); queue.enqueue(event('v2', 'video'));
    queue.enqueue({ ...event('text3', 'text'), text: 'Après' });
    expect(queue.currentIds()).toEqual(['gif', 'text', 'text2']);
    queue.complete('text'); expect(queue.currentIds()).toEqual(['gif', 'text2', 'v1']);
    queue.complete('gif'); expect(queue.currentIds()).toEqual(['text2', 'v1', 'text3']);
    queue.complete('v1'); expect(queue.currentIds()).toEqual(['text2', 'text3', 'v2']);
    queue.complete('text2'); queue.complete('text3'); expect(queue.currentIds()).toEqual(['v2']);
  });
  test('multiple pending videos retain their order and release only the video slot', () => {
    const queue = new MediaQueue({ ...defaultSettings, multiDisplay: true, maxSimultaneous: 4 }, vi.fn());
    queue.enqueue(event('v1', 'video')); queue.enqueue(event('v2', 'video')); queue.enqueue(event('v3', 'video'));
    queue.enqueue({ ...event('gif'), animation: true }); queue.enqueue({ ...event('text', 'text'), text: 'Bonjour' });
    expect(queue.currentIds()).toEqual(['v1', 'gif', 'text']);
    queue.complete('v1'); expect(queue.currentIds()).toEqual(['gif', 'text', 'v2']);
    queue.complete('v2'); expect(queue.currentIds()).toEqual(['gif', 'text', 'v3']);
    queue.complete('v2'); expect(queue.currentIds()).toEqual(['gif', 'text', 'v3']);
  });
  test('GIF picker MP4 animations can play alongside one ordinary video', () => {
    const queue = new MediaQueue({ ...defaultSettings, multiDisplay: true, maxSimultaneous: 4 }, vi.fn());
    queue.enqueue(event('v1', 'video')); queue.enqueue(event('v2', 'video'));
    queue.enqueue({ ...event('gif1', 'video'), loop: true }); queue.enqueue({ ...event('gif2', 'video'), loop: true });
    expect(queue.currentIds()).toEqual(['v1', 'gif1', 'gif2']);
    queue.complete('v1'); expect(queue.currentIds()).toEqual(['gif1', 'gif2', 'v2']);
  });
  test('mixed media respect the global capacity and custom zone count', () => {
    for (const settings of [
      { ...defaultSettings, multiDisplay: true, maxSimultaneous: 2 },
      { ...defaultSettings, multiDisplay: true, multiPlacement: 'zones' as const, zones: [0, 1].map(i => ({ id: `zone-${i}`, monitor: 'primary', position: 'custom' as const, x: i * 0.5, y: 0, width: 320, height: 240 })) },
    ]) {
      const queue = new MediaQueue(settings, vi.fn());
      queue.enqueue(event('v1', 'video')); queue.enqueue(event('v2', 'video'));
      queue.enqueue({ ...event('gif'), animation: true }); queue.enqueue({ ...event('text', 'text'), text: 'Bonjour' });
      expect(queue.currentIds()).toEqual(['v1', 'gif']);
      queue.complete('gif'); expect(queue.currentIds()).toEqual(['v1', 'text']);
      queue.complete('v1'); expect(queue.currentIds()).toEqual(['text', 'v2']);
    }
  });
  test('disabled concurrency keeps mixed media FIFO and static images remain a barrier', () => {
    const sequential = new MediaQueue(defaultSettings, vi.fn());
    sequential.enqueue(event('v', 'video')); sequential.enqueue({ ...event('gif'), animation: true }); sequential.enqueue(event('text', 'text'));
    expect(sequential.currentIds()).toEqual(['v']); sequential.complete('v'); expect(sequential.currentIds()).toEqual(['gif']);
    const parallel = new MediaQueue({ ...defaultSettings, multiDisplay: true }, vi.fn());
    parallel.enqueue(event('v1', 'video')); parallel.enqueue(event('v2', 'video')); parallel.enqueue(event('static'));
    parallel.enqueue({ ...event('gif'), animation: true });
    expect(parallel.currentIds()).toEqual(['v1']); parallel.complete('v1'); expect(parallel.currentIds()).toEqual(['v2']);
    parallel.complete('v2'); expect(parallel.currentIds()).toEqual(['static']); parallel.complete('static'); expect(parallel.currentIds()).toEqual(['gif']);
  });
  test('text concurrency respects the opt-in and the number of custom zones', () => {
    for (const settings of [defaultSettings, { ...defaultSettings, multiDisplay: true, multiPlacement: 'zones' as const, zones: [{ id: 'one', monitor: 'primary', position: 'custom' as const, x: 0, y: 0, width: 320, height: 240 }] }]) {
      const queue = new MediaQueue(settings, vi.fn());
      queue.enqueue({ ...event('a', 'text'), text: 'A' }); queue.enqueue({ ...event('b', 'text'), text: 'B' });
      expect(queue.currentIds()).toEqual(['a']);
      queue.complete('a'); expect(queue.currentIds()).toEqual(['b']);
    }
  });
  test('parallel GIFs release only their own slot and retain FIFO ordering for ordinary videos', () => {
    const display = vi.fn(); const queue = new MediaQueue({ ...defaultSettings, multiDisplay: true, maxSimultaneous: 2 }, display);
    const gif = (id: string) => ({ ...event(id), animation: true });
    queue.enqueue(gif('a')); queue.enqueue(gif('b')); queue.enqueue(gif('c')); queue.enqueue(event('v', 'video')); queue.enqueue(gif('d'));
    expect(queue.currentIds()).toEqual(['a', 'b']);
    queue.complete('b'); expect(queue.currentIds()).toEqual(['a', 'c']);
    queue.complete('a'); expect(queue.currentIds()).toEqual(['c', 'v']);
    queue.complete('c'); expect(queue.currentIds()).toEqual(['v', 'd']);
    queue.complete('v'); expect(queue.currentIds()).toEqual(['d']);
    expect(display.mock.calls.map(call => call[0].id)).toEqual(['a', 'b', 'c', 'v', 'd']);
  });
  test('custom zones bound concurrency and durations distinguish GIFs, video and text', () => {
    const settings = { ...defaultSettings, multiDisplay: true, multiPlacement: 'zones' as const, zones: [{ id: 'one', monitor: 'primary', position: 'custom' as const, x: 0, y: 0, width: 320, height: 240 }], gifDurationSeconds: 3, videoDurationSeconds: 40, durationSeconds: 7 };
    const queue = new MediaQueue(settings, vi.fn());
    queue.enqueue({ ...event('a'), animation: true }); queue.enqueue({ ...event('b'), animation: true });
    expect(queue.currentIds()).toEqual(['a']);
    expect(playbackDuration({ ...event('gif', 'video'), loop: true }, settings)).toBe(3);
    expect(playbackDuration({ ...event('webp'), name: 'cat.webp' }, settings)).toBe(3);
    expect(playbackDuration({ ...event('static-webp'), name: 'photo.webp', animation: false }, settings)).toBe(7);
    expect(playbackDuration(event('mov', 'video'), settings)).toBe(40);
    expect(playbackDuration(event('text', 'text'), settings)).toBe(7);
  });
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
