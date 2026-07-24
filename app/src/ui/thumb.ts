// Songs have no thumbnail column of their own (see src/types.ts: Song) --
// every video_id is a YouTube video id though, and YouTube serves a
// predictable thumbnail path for any of them without an API call. mqdefault
// (320x180) is the default: small enough to load fast in list rows, big
// enough to upscale acceptably for the player's large art and the playlist
// header collage. hqdefault (480x360) is offered as an explicit fallback
// quality for <Thumbnail> to retry with if mqdefault 404s (some very old or
// region-locked videos only have hqdefault+ available).
export type ThumbQuality = 'mqdefault' | 'hqdefault';

export function thumbUrl(videoId: string, quality: ThumbQuality = 'mqdefault'): string {
  return `https://i.ytimg.com/vi/${videoId}/${quality}.jpg`;
}

// The next quality to retry with after `quality` fails to load. Returns null
// once there's nothing left to try, so callers know to fall back to the
// placeholder box instead of looping.
export function nextThumbQuality(quality: ThumbQuality): ThumbQuality | null {
  return quality === 'mqdefault' ? 'hqdefault' : null;
}
