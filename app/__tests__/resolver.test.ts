import {pickAudioFormat, StreamResolveError} from '../src/stream/resolver';

const f = (bitrate: number, hasVideo = false) => ({
  mimeType: 'audio/mp4', bitrate, hasAudio: true, hasVideo,
});

test('picks highest-bitrate audio-only format', () => {
  const best = pickAudioFormat([f(128000), f(256000), f(999999, true)]);
  expect(best.bitrate).toBe(256000);
});

test('throws when no audio-only format exists', () => {
  expect(() => pickAudioFormat([f(128000, true)])).toThrow();
});

test('StreamResolveError supports cause option', () => {
  const cause = new Error('root cause');
  const err = new StreamResolveError('something failed', {cause});
  expect(err.cause).toBe(cause);
});

test('StreamResolveError without cause has undefined cause', () => {
  const err = new StreamResolveError('something failed');
  expect(err.cause).toBeUndefined();
});
