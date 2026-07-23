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

export function pickAudioFormat<T extends AudioFormatLike>(formats: T[]): T {
  const audio = formats
    .filter(x => x.hasAudio && !x.hasVideo)
    .sort((a, b) => b.bitrate - a.bitrate);
  if (!audio.length) {
    throw new StreamResolveError('no audio-only format available');
  }
  return audio[0];
}

let yt: Innertube | null = null;
async function innertube(): Promise<Innertube> {
  if (!yt) yt = await Innertube.create({retrieve_player: true});
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
    const res = await fetch(url, {
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

export async function resolveStreamUrl(videoId: string): Promise<ResolvedStream> {
  let tube: Innertube;
  try {
    tube = await innertube();
  } catch (e) {
    throw new StreamResolveError('session bootstrap failed: ' + String(e), {cause: e});
  }
  let lastErr: unknown;
  for (const client of CLIENTS) {
    const headers = CLIENT_HEADERS[client];
    try {
      const info = await tube.getBasicInfo(videoId, {client});
      const rawFormats = info.streaming_data?.adaptive_formats ?? [];
      // youtubei.js's Format class exposes snake_case fields (mime_type,
      // has_audio, has_video) rather than the camelCase AudioFormatLike
      // contract used here, so adapt each raw format into that shape while
      // keeping a reference back to the original for deciphering.
      const candidates = rawFormats.map(raw => ({
        mimeType: raw.mime_type,
        bitrate: raw.bitrate,
        hasAudio: raw.has_audio,
        hasVideo: raw.has_video,
        raw,
      }));
      const picked = pickAudioFormat(candidates);
      // In this version, Format#decipher is async and accepts the session's
      // Player (rather than being a sync method guarded by an `if` check as
      // in older API sketches); it returns the plain `url` untouched when no
      // signature cipher is present, so it's always safe to call.
      const url = await picked.raw.decipher(tube.session.player);
      if (typeof url !== 'string' || url.length === 0) {
        throw new StreamResolveError('format had no URL after decipher');
      }
      if (!(await validateUrl(url, headers))) {
        lastErr = new Error(`${client} stream URL failed resolve-time validation (non-2xx)`);
        continue;
      }
      return {url, headers};
    } catch (e) {
      lastErr = e;
    }
  }
  // Reset the cached singleton so the next call re-bootstraps fresh.
  yt = null;
  throw new StreamResolveError(
    `could not resolve stream for ${videoId}: ${String(lastErr)}`,
    {cause: lastErr},
  );
}
