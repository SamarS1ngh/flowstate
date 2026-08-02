import {anonymousFetch, pickAudioFormat, StreamResolveError} from '../src/stream/resolver';

const f = (bitrate: number, hasVideo = false) => ({
  mimeType: 'audio/mp4', bitrate, hasAudio: true, hasVideo,
});

test('picks highest-bitrate audio-only format (ignoring muxed) by default', () => {
  const best = pickAudioFormat([f(128000), f(256000), f(999999, true)]);
  expect(best.bitrate).toBe(256000);
});

test("'lowest' picks the smallest audio-only format", () => {
  const lo = pickAudioFormat([f(128000), f(256000), f(64000)], 'lowest');
  expect(lo.bitrate).toBe(64000);
});

test('falls back to a muxed (video+audio) format when no audio-only exists', () => {
  // Only muxed formats present -> must NOT throw; pick from the muxed pool.
  const hi = pickAudioFormat([f(500000, true), f(900000, true)]);
  expect(hi.bitrate).toBe(900000);
  const lo = pickAudioFormat([f(500000, true), f(900000, true)], 'lowest');
  expect(lo.bitrate).toBe(500000);
});

test('throws only when NO format has an audio track', () => {
  const videoOnly = {mimeType: 'video/mp4', bitrate: 100, hasAudio: false, hasVideo: true};
  expect(() => pickAudioFormat([videoOnly])).toThrow();
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

// Regression guard for the post-login playback bug: on Android, RN's fetch
// defaults `withCredentials` to true, which routes requests through a
// device-wide CookieManager shared by every Innertube instance in the app
// (see src/stream/resolver.ts's root-cause comment). This resolver must
// always force `credentials: 'omit'` so its requests stay genuinely
// anonymous regardless of what the rest of the app is logged into.
test('anonymousFetch always forces credentials: omit, preserving other init', async () => {
  const calls: [unknown, unknown][] = [];
  const fakeResponse = {ok: true} as Response;
  (globalThis as any).fetch = (input: unknown, init: unknown) => {
    calls.push([input, init]);
    return Promise.resolve(fakeResponse);
  };

  await anonymousFetch('https://example.com/x', {
    method: 'GET',
    headers: {Range: 'bytes=0-'},
    credentials: 'include', // caller/library default must not survive
  });

  expect(calls).toHaveLength(1);
  const [url, init] = calls[0] as [string, RequestInit];
  expect(url).toBe('https://example.com/x');
  expect(init.credentials).toBe('omit');
  expect(init.method).toBe('GET');
  expect(init.headers).toEqual({Range: 'bytes=0-'});
});
