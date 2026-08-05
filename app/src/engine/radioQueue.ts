// Song radio: an endless QueueSource backed by YouTube's watch-next "mix"
// (the RD<videoId> radio). Unlike VibeQueue (which picks from locally-analyzed
// songs by embedding similarity), radio pulls fresh related tracks from the
// network -- so it needs no embeddings and can surface songs not in the
// library at all. See [[yt-tv-token-capabilities]]: the OAuth token is a
// TV-client token, and `/next {videoId, playlistId:'RD'+videoId, client:'TV'}`
// is the one personalized-MUSIC surface it can reach (musicWatchMetadata).
//
// Refill strategy: rather than parse continuation tokens (whose TV-client
// shape is undocumented and brittle), each refill re-seeds off the LAST song
// served -- every RD<id> request returns a fresh mix centered on that id, so
// the stream drifts organically and never runs dry. Songs already served are
// deduped so it doesn't loop on the seed.
import type {Song} from '../types';
import type {QueueSource} from '../player/queue';
import {getAuthedInnertube} from '../auth/oauth';

// Refill when the buffer drops to or below this many upcoming songs.
const LOW_WATER = 4;

/** Parse "3:45" / "1:02:33" -> seconds. Null if unparseable. */
function parseLength(text: string | undefined): number | null {
  if (!text) return null;
  const parts = text.split(':').map(p => Number(p.trim()));
  if (parts.some(n => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

function runText(node: any): string | undefined {
  return node?.runs?.[0]?.text ?? node?.simpleText ?? undefined;
}

/**
 * Pure parser: walk a raw `/next` response and pull out the mix's songs, in
 * order, deduped by videoId. Kept pure (no IO) so it's unit-testable against a
 * captured fixture. Collects any node that carries a string `videoId` AND
 * looks like a playable video row (has a title or a lengthText) -- covers both
 * `playlistPanelVideoRenderer` (music watch-next) and the TV `tileRenderer`
 * shape without hard-coding either renderer name.
 */
export function parseRadioSongs(data: any): Song[] {
  const out: Song[] = [];
  const seen = new Set<string>();
  const push = (
    videoId: string | undefined,
    title: string | undefined,
    artist: string | undefined,
    lengthText: string | undefined,
  ): void => {
    if (!videoId || seen.has(videoId)) return;
    // Require some video-ish metadata so we skip bare watchEndpoint stubs that
    // merely reference a videoId (navigation/logging nodes).
    if (!title && !lengthText) return;
    seen.add(videoId);
    out.push({
      videoId,
      title: title ?? '(unknown)',
      artist: artist ?? '',
      durationS: parseLength(lengthText),
      hasVibe: false,
    });
  };
  const visit = (node: any, depth: number): void => {
    if (!node || depth > 18) return;
    if (Array.isArray(node)) {
      for (const n of node) visit(n, depth + 1);
      return;
    }
    if (typeof node !== 'object') return;
    // Shape A -- TV shelf tile: videoId in onSelectCommand.watchEndpoint, title
    // in metadata.tileMetadataRenderer.lines. (Some seeds return the home-feed
    // style shelves instead of a linear mix.)
    const tr = node.tileRenderer;
    if (tr) {
      const vid =
        tr?.onSelectCommand?.watchEndpoint?.videoId ??
        tr?.onSelectCommand?.navigationEndpoint?.watchEndpoint?.videoId;
      const lines = tr?.metadata?.tileMetadataRenderer?.lines ?? [];
      const lineText = (i: number) =>
        lines?.[i]?.lineRenderer?.items?.[0]?.lineItemRenderer?.text?.runs?.[0]?.text;
      const title = lineText(0) ?? tr?.metadata?.tileMetadataRenderer?.title?.runs?.[0]?.text;
      push(vid, title, lineText(1), undefined);
    } else if (typeof node.videoId === 'string') {
      // Shape B -- co-located row (playlistPanelVideoRenderer / pivot / next /
      // autoplay / grid / compact video renderers): videoId + title + length
      // on the same node.
      push(
        node.videoId,
        runText(node.title),
        runText(node.longBylineText) ?? runText(node.shortBylineText) ?? runText(node.subtitle),
        runText(node.lengthText),
      );
    }
    for (const k of Object.keys(node)) visit(node[k], depth + 1);
  };
  visit(data, 0);
  return out;
}

/** Fetch one mix page seeded on `seedVideoId`. Returns [] on any failure. */
export async function fetchRadio(seedVideoId: string): Promise<Song[]> {
  try {
    const yt = await getAuthedInnertube();
    const res: any = await yt.actions.execute('/next', {
      videoId: seedVideoId,
      playlistId: `RD${seedVideoId}`,
      client: 'TV',
    });
    return parseRadioSongs(res?.data ?? res);
  } catch {
    return [];
  }
}

export class RadioQueue implements QueueSource {
  label = 'Radio';
  private buffer: Song[] = [];
  private served = new Set<string>();
  private seedId = '';
  private lastId = '';
  private refilling = false;
  // Injectable for tests; defaults to the real network fetch.
  private fetch: (seedVideoId: string) => Promise<Song[]>;

  constructor(fetchFn: (seedVideoId: string) => Promise<Song[]> = fetchRadio) {
    this.fetch = fetchFn;
  }

  reset(seed: Song): void {
    this.seedId = seed.videoId;
    this.lastId = seed.videoId;
    this.served = new Set([seed.videoId]);
    this.buffer = [];
    void this.refill();
  }

  next(lastPlayed: Song | null): Song | null {
    if (lastPlayed) this.lastId = lastPlayed.videoId;
    if (this.buffer.length <= LOW_WATER) void this.refill();
    return this.buffer.shift() ?? null;
  }

  peekNext(): Song | null {
    if (this.buffer.length <= LOW_WATER) void this.refill();
    return this.buffer[0] ?? null;
  }

  peekUpcoming(count: number): Song[] {
    return this.buffer.slice(0, count);
  }

  // Single-flight refill: fetch a fresh mix off the last-served song, append
  // any songs we haven't served yet. Falls back to the original seed if a
  // drifted seed returns nothing new (keeps the stream alive).
  private async refill(): Promise<void> {
    if (this.refilling) return;
    this.refilling = true;
    try {
      let songs = await this.fetch(this.lastId);
      let fresh = songs.filter(s => !this.served.has(s.videoId));
      if (fresh.length === 0 && this.lastId !== this.seedId) {
        songs = await this.fetch(this.seedId);
        fresh = songs.filter(s => !this.served.has(s.videoId));
      }
      for (const s of fresh) {
        this.served.add(s.videoId);
        this.buffer.push(s);
      }
    } finally {
      this.refilling = false;
    }
  }
}
