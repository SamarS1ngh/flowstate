import {pickAudioFormat} from '../src/stream/resolver';

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
