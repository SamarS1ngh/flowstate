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
  // retrieve_player:false is a ~6x bootstrap speedup (measured 5272ms -> 884ms
  // on-device). Innertube.create({retrieve_player:true}) downloads and parses
  // YouTube's ~2MB player JS (signature deciphering) on session bootstrap --
  // and that cost otherwise lands on the FIRST play, making the first song (or
  // vibe shuffle) take ~6s. But the mobile clients we resolve with (ANDROID_VR,
  // IOS -- see CLIENTS) return pre-deciphered progressive URLs that need no
  // player at all, so we skip it. A format that DID need deciphering would just
  // fail this client and fall through to the next client / the search fallback
  // (which probes the same mobile clients), so reliability is preserved while
  // the common path gets dramatically faster.
  if (!yt) yt = await Innertube.create({retrieve_player: false, fetch: anonymousFetch});
  return yt;
}

// Even with retrieve_player:false the session bootstrap still does a round-trip
// (~900ms measured) that otherwise lands on the first stream resolve. Kick it
// off once at app startup (fire-and-forget) so the session is already warm by
// the time anything plays. Idempotent: the innertube() singleton means later
// resolves reuse it, and a failed prewarm just leaves yt null to retry.
let prewarmStarted = false;
export function prewarmResolver(): void {
  if (prewarmStarted) return;
  prewarmStarted = true;
  void innertube().catch(() => {
    prewarmStarted = false; // let a later call retry the bootstrap
  });
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

const VALIDATE_TIMEOUT_MS = 5000;

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

// Session cache: an original (often unplayable "- Topic") videoId -> a videoId
// that actually streamed for it, discovered once via the slow search fallback.
// A later play of the same song then resolves the known-good id directly and
// skips the search entirely -- the biggest win for a library full of "- Topic"
// entries, which the user replays constantly. Session-scoped (fine: the mapping
// is stable and cheap to rediscover after a restart).
const altIdCache = new Map<string, string>();

export async function resolveStreamUrl(
  videoId: string,
  opts: {quality?: 'highest' | 'lowest'; title?: string; artist?: string} = {},
): Promise<ResolvedStream> {
  const quality = opts.quality ?? 'highest';
  let tube: Innertube;
  try {
    tube = await innertube();
  } catch (e) {
    throw new StreamResolveError('session bootstrap failed: ' + String(e), {cause: e});
  }

  // 0) Known-good alternate from a previous search fallback this session.
  const cachedAlt = altIdCache.get(videoId);
  if (cachedAlt) {
    const viaCache = await tryAllClients(tube, cachedAlt, quality);
    if (viaCache) return viaCache;
    altIdCache.delete(videoId); // stale alternate; fall through to a fresh resolve
  }

  // 1) Try the exact videoId across all clients.
  const direct = await tryAllClients(tube, videoId, quality);
  if (direct) return direct;

  // 2) SEARCH FALLBACK. A big class of failures is YouTube Music "- Topic"
  // art tracks (and other licensed catalog entries) that return UNPLAYABLE
  // "This video is not available" for EVERY anonymous client (confirmed:
  // yt-dlp can't stream them either). But the same song almost always exists
  // under a DIFFERENT, playable videoId (official "Audio"/lyric upload, the
  // original, etc.). So when the stored id won't stream, search "title artist"
  // and use the first result that DOES stream. Recovers real songs that were
  // otherwise permanently "failed"/unplayable. Requires title (artist helps).
  if (opts.title) {
    const viaSearch = await resolveViaSearch(tube, videoId, opts.title, opts.artist, quality);
    if (viaSearch) {
      altIdCache.set(videoId, viaSearch.id); // remember for next time
      return viaSearch.stream;
    }
  }

  // Reset the cached singleton so the next call re-bootstraps fresh.
  yt = null;
  throw new StreamResolveError(`could not resolve stream for ${videoId} (unplayable; no playable alternate found)`);
}

/** Try every client for one videoId; return the first playable stream or null
 * (never throws -- a totally-unplayable video just yields null). */
async function tryAllClients(
  tube: Innertube,
  videoId: string,
  quality: 'highest' | 'lowest',
): Promise<ResolvedStream | null> {
  for (const client of CLIENTS) {
    try {
      const got = await extractStream(tube, videoId, client, CLIENT_HEADERS[client], quality);
      if (got) return got;
    } catch {
      // try next client
    }
  }
  return null;
}

/** Search for the song and return a stream for the first result (other than
 * the original, unplayable id) that actually streams. Query appends "lyrics"
 * to bias toward LYRIC videos -- those carry the accurate studio recording,
 * so the fallback doesn't grab a cover / live version / sped-up edit with the
 * same title (the exact risk of matching by plain title+artist). */
async function resolveViaSearch(
  tube: Innertube,
  originalId: string,
  title: string,
  artist: string | undefined,
  quality: 'highest' | 'lowest',
): Promise<{stream: ResolvedStream; id: string} | null> {
  // Drop the auto-generated "- Topic" suffix from the artist so the query is
  // natural ("Ali Sethi" not "Ali Sethi - Topic").
  const cleanArtist = (artist ?? '').replace(/\s*-\s*Topic\s*$/i, '').trim();
  const query = cleanArtist ? `${title} ${cleanArtist} lyrics` : `${title} lyrics`;
  let results: Array<{id?: string; video_id?: string}> = [];
  try {
    const res: any = await tube.search(query, {type: 'video'});
    results = res.videos ?? res.results ?? [];
  } catch {
    return null;
  }
  let tried = 0;
  for (const v of results) {
    const id = (v.id ?? v.video_id) as string | undefined;
    if (!id || id === originalId) continue;
    if (tried >= SEARCH_FALLBACK_MAX) break;
    tried += 1;
    const got = await tryAllClients(tube, id, quality);
    if (got) return {stream: got, id};
  }
  return null;
}

// How many search results to probe before giving up -- keeps the fallback
// bounded (each probe is a player request). The canonical upload almost
// always ranks in the first couple, so a few is plenty.
const SEARCH_FALLBACK_MAX = 3;

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
  // ANDROID_VR has no GVS Proof-of-Origin cap (unlike IOS, which is capped to
  // ~1 MiB without a PoT), so its direct URL is reliable as-is -- skip the
  // extra validation GET (a whole round trip, expensive on slow/roaming/DoT
  // networks). Only IOS needs the 1-MiB-cap check. A rare bad ANDROID_VR URL
  // is still caught downstream by the controller's resolve/skip retry.
  if (client === 'ANDROID_VR') return {url, headers};
  return (await validateUrl(url, headers)) ? {url, headers} : null;
}
