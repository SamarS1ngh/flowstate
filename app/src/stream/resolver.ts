import {Innertube} from 'youtubei.js';

export class StreamResolveError extends Error {
  cause?: unknown;

  constructor(message?: string, options?: {cause?: unknown}) {
    super(message);
    this.name = 'StreamResolveError';
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export interface AudioFormatLike {
  mimeType: string;
  bitrate: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

export function pickAudioFormat<T extends AudioFormatLike>(
  formats: T[],
  quality: 'highest' | 'lowest' = 'highest',
): T {
  // Prefer audio-only (smallest download / cleanest). But some tracks come
  // back from the TV streaming client with NO audio-only adaptive format --
  // only muxed (video+audio) or video-only. Those are still perfectly
  // playable/analyzable: TrackPlayer plays a muxed URL, and the analyzer's
  // MediaExtractor selects the audio track out of the muxed container. So
  // fall back to any format that HAS audio (i.e. muxed) rather than failing
  // the whole song -- this recovers a large chunk of "no audio-only format
  // available" failures that were real, available music.
  const audioOnly = formats.filter(x => x.hasAudio && !x.hasVideo);
  const pool = (audioOnly.length ? audioOnly : formats.filter(x => x.hasAudio)).sort(
    (a, b) => b.bitrate - a.bitrate,
  );
  if (!pool.length) {
    throw new StreamResolveError('no format with an audio track available');
  }
  // Playback wants the best-sounding stream (highest). Analysis downsamples
  // to 16kHz mono regardless, so bitrate is irrelevant to the fingerprint --
  // it wants the SMALLEST file to download fastest (googlevideo throttles a
  // full-file GET to ~playback speed, so a high-bitrate stream can blow past
  // the download timeout on a slow link). 'lowest' picks the smallest.
  return quality === 'lowest' ? pool[pool.length - 1] : pool[0];
}

// Root-cause note (post-login playback regression): this resolver has
// ALWAYS used its own Innertube instance, separate from
// src/auth/oauth.ts's getAuthedInnertube() (confirmed: two independent
// `Innertube.create()` calls, no shared object). That separation is not
// enough on Android. youtubei.js's react-native platform shim points
// every Innertube instance's default fetch at the SAME `globalThis.fetch`
// (node_modules/youtubei.js/dist/src/platform/react-native.js), and React
// Native's fetch (via the `whatwg-fetch` polyfill over
// Libraries/Network/XMLHttpRequest.js) defaults `withCredentials` to
// `true` unless a request explicitly sets `credentials: 'include'|'omit'`.
// On Android, `withCredentials: true` routes the request through OkHttp's
// shared `CookieJarContainer`, which is backed by the single, process-wide
// `android.webkit.CookieManager` (see RN's NetworkingModule.kt --
// `if (!withCredentials) clientBuilder.cookieJar(NO_COOKIES)` -- and
// ForwardingCookieHandler.kt, which reads/writes that same CookieManager
// singleton for every request app-wide, regardless of which JS object or
// module issued it).
//
// So once the user completes OAuth device-flow login and library sync
// (both via getAuthedInnertube(), both hitting google.com/youtube.com and
// getting real Set-Cookie session cookies back), those cookies land in
// that shared CookieManager. This resolver's "separate" Innertube instance
// still silently attached them to its own getBasicInfo() calls to
// www.youtube.com (same host), making YouTube's edge see a signed-in
// request and apply PoT gating to the ANDROID_VR/IOS clients that are
// otherwise ungated for a genuinely anonymous device -- which is exactly
// the resolve-time validation failure this regression presented as.
// Confirmed by code trace (this file + oauth.ts + the RN/whatwg-fetch/
// youtubei.js sources above) since a real authed-vs-anon fetch can't be
// driven from a plain Node script (no CookieManager there).
//
// Forcing `credentials: 'omit'` here is the actual fix -- it's what makes
// this resolver's requests genuinely anonymous on-device, independent of
// whatever the rest of the app is logged into.
// Exported (only) so a unit test can pin down the `credentials: 'omit'`
// behavior above without needing a real network stack or RN's
// CookieManager -- see __tests__/resolver.test.ts.
export function anonymousFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return fetch(input, {...init, credentials: 'omit'});
}

let yt: Innertube | null = null;
async function innertube(): Promise<Innertube> {
  if (!yt) yt = await Innertube.create({retrieve_player: true, fetch: anonymousFetch});
  return yt;
}

// Client fallback order. as of youtubei.js 17.2.0, ANDROID and WEB (the
// brief's original pick) both come back with adaptive_formats that have
// neither a direct `url` nor a `signature_cipher` — YouTube now withholds
// stream URLs from those clients without a Proof-of-Origin token. Meanwhile
// this package's default JS evaluator (needed to decipher a
// `signature_cipher`) is an unimplemented stub that always throws, so any
// client that *does* return a cipher (MWEB, TV, YTMUSIC) can't be deciphered
// either without wiring in a custom evaluator. IOS and ANDROID_VR are the
// two clients that still return a direct, unciphered `url`.
//
// Round-5 finding (confirmed by direct curl probing of resolved googlevideo
// URLs, not just log inference — see checklist report): a direct,
// unciphered URL is necessary but NOT sufficient. YouTube's edge enforces a
// per-client Proof-of-Origin (PoT) policy on the *media* GET itself,
// independent of headers/User-Agent (a matching UA was tried and ruled out
// earlier): IOS requires a PoT for full GVS access and, without one, serves
// only the first ~1 MiB of any format (any request — bounded, unbounded, at
// any offset — is honored only up to that fixed byte cap, then 403s for the
// remainder), which is exactly what ExoPlayer's default open-ended
// `Range: bytes=0-` progressive request hits immediately. ANDROID_VR has no
// such GVS PoT requirement (confirmed against yt-dlp's own
// INNERTUBE_CLIENTS PoT policy table, `ios` vs `android_vr` in
// yt_dlp/extractor/youtube/_base.py) and was confirmed here to stream a
// complete file (3,193,119 bytes, valid WebM, correct duration) with no cap.
// ANDROID_VR is therefore tried FIRST; IOS is kept as a second-choice
// fallback only (e.g. in case ANDROID_VR formats are ever unavailable for a
// given video/region).
//
// `decipher()` is still called unconditionally below since it's a safe
// no-op passthrough of `url` when there's no cipher to decode.
const CLIENTS = ['ANDROID_VR', 'IOS'] as const;

const CLIENT_HEADERS: Record<(typeof CLIENTS)[number], Record<string, string>> = {
  ANDROID_VR: {
    'User-Agent':
      'com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; en_US) gzip',
  },
  IOS: {
    'User-Agent':
      'com.google.ios.youtube/20.11.6 (iPhone14,3; U; CPU iOS 17_4 like Mac OS X;)',
  },
};

export interface ResolvedStream {
  url: string;
  headers: Record<string, string>;
}

const VALIDATE_TIMEOUT_MS = 8000;

// Confirms the URL is actually fully fetchable before handing it to the
// player, using the SAME request shape ExoPlayer's progressive HTTP data
// source uses for a fresh, position-0 track: an open-ended
// `Range: bytes=0-`. This is deliberate, not incidental — a small bounded
// probe (e.g. bytes=0-0) is exactly what a PoT-gated client's ~1 MiB free
// allowance would still pass, giving a false positive (this is what
// happened on the first Round-5 attempt: IOS validated fine on a 1-byte
// probe, then 403'd on-device the moment ExoPlayer made its real,
// open-ended request). Only the response status is needed, so the body is
// aborted the instant headers arrive — no need to actually pull the file
// down twice.
async function validateUrl(url: string, headers: Record<string, string>): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
  try {
    const res = await anonymousFetch(url, {
      method: 'GET',
      headers: {...headers, Range: 'bytes=0-'},
      signal: controller.signal,
    });
    const ok = res.ok || res.status === 206;
    controller.abort(); // status is known; stop pulling the body down
    return ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function resolveStreamUrl(
  videoId: string,
  opts: {quality?: 'highest' | 'lowest'} = {},
): Promise<ResolvedStream> {
  const quality = opts.quality ?? 'highest';
  let tube: Innertube;
  try {
    tube = await innertube();
  } catch (e) {
    throw new StreamResolveError('session bootstrap failed: ' + String(e), {cause: e});
  }
  let lastErr: unknown;
  for (const client of CLIENTS) {
    try {
      const got = await extractStream(tube, videoId, client, CLIENT_HEADERS[client], quality);
      if (got) return got;
      lastErr = new Error(`${client} stream URL failed resolve-time validation (non-2xx)`);
    } catch (e) {
      lastErr = e;
    }
  }

  // (Tried an authed-session fallback here -- retrying via getAuthedInnertube()
  // when anonymous clients yield no audio. It does NOT help: the device-code
  // "TV" OAuth token 400s on the /youtubei/v1/player endpoint for these tracks
  // -- the same INVALID_ARGUMENT limitation that blocks yt.music.* with this
  // token -- and it only added latency/timeouts to each already-failing song.
  // The remaining failures (a track with no anonymous audio format) are
  // YouTube PoToken/SABR gating; recovering them needs a PoToken, not an authed
  // retry, so it's deliberately NOT attempted here.)

  // Reset the cached singleton so the next call re-bootstraps fresh.
  yt = null;
  throw new StreamResolveError(
    `could not resolve stream for ${videoId}: ${String(lastErr)}`,
    {cause: lastErr},
  );
}

/**
 * Pull a validated, playable stream out of one Innertube session/client, or
 * return null if the URL exists but fails validation. Throws if no usable
 * format/URL could be produced at all (so the caller can try the next client).
 */
async function extractStream(
  tube: Innertube,
  videoId: string,
  client: (typeof CLIENTS)[number] | undefined,
  headers: Record<string, string>,
  quality: 'highest' | 'lowest',
): Promise<ResolvedStream | null> {
  const info = client
    ? await tube.getBasicInfo(videoId, {client})
    : await tube.getBasicInfo(videoId);
  // BOTH format lists: adaptive_formats = separate audio-only/video-only;
  // formats = legacy MUXED (video+audio). Include both so pickAudioFormat's
  // muxed fallback has muxed to choose from.
  const rawFormats = [
    ...(info.streaming_data?.adaptive_formats ?? []),
    ...(info.streaming_data?.formats ?? []),
  ];
  const candidates = rawFormats.map(raw => ({
    mimeType: raw.mime_type,
    bitrate: raw.bitrate,
    hasAudio: raw.has_audio,
    hasVideo: raw.has_video,
    raw,
  }));
  const picked = pickAudioFormat(candidates, quality);
  const url = await picked.raw.decipher(tube.session.player);
  if (typeof url !== 'string' || url.length === 0) {
    throw new StreamResolveError('format had no URL after decipher');
  }
  return (await validateUrl(url, headers)) ? {url, headers} : null;
}
