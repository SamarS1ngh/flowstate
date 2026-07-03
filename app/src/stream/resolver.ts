import {Innertube} from 'youtubei.js';

export class StreamResolveError extends Error {}

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

// Client fallback order, verified live against real YouTube traffic (see
// task-3-report.md for the probe): as of youtubei.js 17.2.0, ANDROID and WEB
// (the brief's original pick) both come back with adaptive_formats that have
// neither a direct `url` nor a `signature_cipher` — YouTube now withholds
// stream URLs from those clients without a Proof-of-Origin token. Meanwhile
// this package's default JS evaluator (needed to decipher a
// `signature_cipher`) is an unimplemented stub that always throws, so any
// client that *does* return a cipher (MWEB, TV, YTMUSIC) can't be deciphered
// either without wiring in a custom evaluator. IOS and ANDROID_VR are the
// two clients that still return a direct, unciphered `url`, so they're used
// here instead. `decipher()` is still called unconditionally below since
// it's a safe no-op passthrough of `url` when there's no cipher to decode.
const CLIENTS = ['IOS', 'ANDROID_VR'] as const;

export async function resolveStreamUrl(videoId: string): Promise<string> {
  const tube = await innertube();
  let lastErr: unknown;
  for (const client of CLIENTS) {
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
      if (typeof url === 'string' && url.length > 0) return url;
      throw new StreamResolveError('format had no URL after decipher');
    } catch (e) {
      lastErr = e;
    }
  }
  throw new StreamResolveError(
    `could not resolve stream for ${videoId}: ${String(lastErr)}`,
  );
}
