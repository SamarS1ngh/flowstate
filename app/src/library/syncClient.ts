// Authenticated library sync (Plan C Task 3): fetches the logged-in user's
// YouTube playlists (including the account's "Liked Music" auto-playlist)
// and their tracks, and pure-parses the raw responses into a flat shape
// syncToDb.ts can write straight into SQLite.
//
// *** WHY THIS DOES NOT USE yt.music.* ***
// The OAuth token this app obtains comes from youtubei.js's device-code
// ("smart TV") flow (src/auth/oauth.ts). That flow issues a token scoped to
// the TV client -- empirically verified against the real logged-in account
// (see the task report for the full transcript):
//   yt.getLibrary()             [WEB]       -> 400 INVALID_ARGUMENT
//   yt.music.getLibrary()       [WEB_REMIX] -> 400 INVALID_ARGUMENT
//   yt.music.getHomeFeed()      [YTMUSIC]   -> 400 INVALID_ARGUMENT
//   yt.music.getPlaylist('LM')  [YTMUSIC]   -> 400 INVALID_ARGUMENT
//   yt.getPlaylist('LM')        [WEB]       -> 400 INVALID_ARGUMENT
//   browse FEmusic_library_landing [TV]     -> 400 FAILED_PRECONDITION
// Every WEB/WEB_REMIX/YTMUSIC-context call 400s with this token, including
// plain browse attempts under the `client: 'TV'` override for YT-Music-only
// surfaces. So a TV-issued token genuinely cannot read the YouTube Music
// library surface (yt.music.*) -- this is the real, load-bearing limitation
// the task asked to diagnose honestly rather than paper over.
//
// What DOES work with this token, all under `client: 'TV'`:
//   browse FEplaylist_aggregation [TV] -> OK: the account's regular
//     playlists (verified: "Watch later", "Dang OSTs", "Liked videos").
//   browse VL<playlistId> [TV]         -> OK: a playlist's track list,
//     including the well-known fixed ID "LM" (Liked Music) -- confirmed by
//     fetching VLLM and getting back a page headed "Liked Music" with real
//     tracks, even though it never appears in FEplaylist_aggregation itself
//     (a regular-YouTube surface; YT Music's own auto-playlist isn't a
//     "regular playlist" the aggregation view lists). It's always added as
//     an explicit extra fetch below rather than relying on it showing up.
// These are the *TV client's* UI-shaped browse responses -- a completely
// different JSON shape from web/music's typed Grid/MusicShelf/
// MusicResponsiveListItem classes: every row (whether a playlist tile in a
// grid, or a track tile in a playlist) comes back as a `tileRenderer`
// wrapping a `tileMetadataRenderer` (title/lines) and either an
// `onSelectCommand.browseEndpoint` (playlist ref) or
// `onSelectCommand.watchEndpoint` (track). One tile shape, two contexts --
// see TvTile below. Captured and inspected directly against the real
// account via a throwaway Node script hitting these same endpoints (see
// task report for the raw JSON structure this is modeled on).
import type {Innertube} from 'youtubei.js';
import {getAuthedInnertube} from '../auth/oauth';

export interface SyncedTrack {
  videoId: string;
  title: string;
  artist: string;
  durationS: number | null;
}

export interface SyncedPlaylist {
  playlistId: string;
  name: string;
  tracks: SyncedTrack[];
}

export interface SyncedLibrary {
  playlists: SyncedPlaylist[];
}

// --- pure parsing --------------------------------------------------------

// The TV client's generic "Text" shape: either a plain string (`simpleText`)
// or a list of runs to concatenate. Every title/label in these responses is
// one of these, never a bare string.
export interface TvText {
  simpleText?: string;
  runs?: Array<{text?: string}> | null;
}

/** Converts a TvText (or anything else) to a plain string. Never throws. */
export function tvText(t?: TvText | null): string {
  if (!t) return '';
  if (typeof t.simpleText === 'string') return t.simpleText;
  if (Array.isArray(t.runs)) return t.runs.map(r => r?.text ?? '').join('');
  return '';
}

// One row in either a playlist grid (FEplaylist_aggregation) or a playlist's
// track list (playlistVideoListRenderer/-Continuation) -- the TV client
// wraps both in the same tileRenderer envelope, just with a different
// onSelectCommand endpoint (browseEndpoint for a playlist ref, watchEndpoint
// for a track). videoId/browseId are read from onSelectCommand rather than
// from the (also-present, but inconsistently-shaped -- sometimes
// `title.simpleText` with no runs at all) navigationEndpoint nested under
// title, which is the more reliable single source for both.
export interface TvTile {
  tileRenderer?: {
    metadata?: {
      tileMetadataRenderer?: {
        title?: TvText;
        lines?: Array<{
          lineRenderer?: {
            items?: Array<{lineItemRenderer?: {text?: TvText}}>;
          };
        } | null> | null;
      };
    };
    onSelectCommand?: {
      browseEndpoint?: {browseId?: string};
      watchEndpoint?: {videoId?: string};
    };
    header?: {
      tileHeaderRenderer?: {
        thumbnailOverlays?: Array<{
          thumbnailOverlayTimeStatusRenderer?: {text?: TvText};
        } | null> | null;
      };
    };
  };
}

/**
 * Parses a duration label ("2:39", "1:02:39", ...) into whole seconds.
 * Returns null for anything that isn't a plain, colon-separated number
 * string (missing overlay, unexpected format, etc.) -- durationS is
 * optional throughout this app, so silently dropping an unparseable label
 * is preferable to guessing.
 */
export function parseDurationLabel(label: string): number | null {
  const trimmed = label.trim();
  if (!trimmed) return null;
  const parts = trimmed.split(':');
  if (!parts.length) return null;
  let seconds = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    seconds = seconds * 60 + parseInt(part, 10);
  }
  return seconds;
}

function lineText(tile: TvTile, index: number): string {
  const line = tile.tileRenderer?.metadata?.tileMetadataRenderer?.lines?.[index];
  return tvText(line?.lineRenderer?.items?.[0]?.lineItemRenderer?.text);
}

function tileDurationS(tile: TvTile): number | null {
  const overlays = tile.tileRenderer?.header?.tileHeaderRenderer?.thumbnailOverlays ?? [];
  for (const overlay of overlays) {
    const label = overlay?.thumbnailOverlayTimeStatusRenderer?.text;
    if (!label) continue;
    const parsed = parseDurationLabel(tvText(label));
    if (parsed != null) return parsed;
  }
  return null;
}

/**
 * From a page of a playlist's track tiles (playlistVideoListRenderer's
 * `contents`, or a -Continuation page's), extracts playable tracks. Tiles
 * with no resolvable videoId are dropped (there is nothing playable to
 * record). Artist defaults to 'Unknown', duration to null, title to a
 * placeholder -- all tolerated, never thrown on.
 */
export function parseTvTracks(tiles: Array<TvTile | null | undefined>): SyncedTrack[] {
  const out: SyncedTrack[] = [];
  for (const tile of tiles ?? []) {
    const videoId = tile?.tileRenderer?.onSelectCommand?.watchEndpoint?.videoId;
    if (!videoId) continue;
    const title =
      tvText(tile!.tileRenderer!.metadata?.tileMetadataRenderer?.title) || 'Unknown title';
    const artist = lineText(tile!, 0) || 'Unknown';
    out.push({videoId, title, artist, durationS: tileDurationS(tile!)});
  }
  return out;
}

/**
 * From a page of playlist-grid tiles (FEplaylist_aggregation's `items`, or a
 * -Continuation page's), extracts playlist references, de-duplicated by id.
 * Only tiles whose browseEndpoint is a playlist ("VL"-prefixed browseId) are
 * kept; the canonical playlistId stored/returned has that prefix stripped
 * (matching the plain YouTube playlist-ID format used elsewhere in this app
 * and by the analyzer -- see analyzer/flowstate_analyzer/library.py), and is
 * re-added (`VL${playlistId}`) wherever a browseId is needed again to fetch
 * that playlist's tracks.
 */
export function parseTvPlaylistRefs(
  tiles: Array<TvTile | null | undefined>,
): Array<{playlistId: string; name: string}> {
  const out: Array<{playlistId: string; name: string}> = [];
  const seen = new Set<string>();
  for (const tile of tiles ?? []) {
    const browseId = tile?.tileRenderer?.onSelectCommand?.browseEndpoint?.browseId;
    if (!browseId || !browseId.startsWith('VL')) continue;
    const playlistId = browseId.slice(2);
    if (!playlistId || seen.has(playlistId)) continue;
    seen.add(playlistId);
    const name =
      tvText(tile!.tileRenderer!.metadata?.tileMetadataRenderer?.title) || 'Untitled playlist';
    out.push({playlistId, name});
  }
  return out;
}

// --- raw-response navigation ---------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawData = any;

interface TilesPage {
  tiles: TvTile[];
  continuationToken: string | null;
}

// A first-page browse response nests its content shelf differently
// depending on which TV surface it is: FEplaylist_aggregation's tiles sit
// under a `gridRenderer`, while a playlist's tracks sit inside a
// `twoColumnRenderer`'s right column under `playlistVideoListRenderer`.
// Both expose `items`/`contents` (respectively) plus an old-style
// `continuations[0].nextContinuationData.continuation` token in exactly the
// same shape, so one function handles either, and the caller
// (browseAllPages) never needs to know which surface it asked for.
function firstPage(data: RawData): TilesPage {
  const content =
    data?.contents?.tvBrowseRenderer?.content?.tvSurfaceContentRenderer?.content;
  const container =
    content?.gridRenderer ??
    content?.twoColumnRenderer?.rightColumn?.playlistVideoListRenderer;
  return {
    tiles: (container?.items ?? container?.contents ?? []) as TvTile[],
    continuationToken:
      container?.continuations?.[0]?.nextContinuationData?.continuation ?? null,
  };
}

// A continuation response's single shelf is named after which container it
// continues (`gridContinuation` vs `playlistVideoListContinuation`) -- both
// tried, whichever is present (never both) wins.
function continuationPage(data: RawData): TilesPage {
  const container =
    data?.continuationContents?.gridContinuation ??
    data?.continuationContents?.playlistVideoListContinuation;
  return {
    tiles: (container?.items ?? container?.contents ?? []) as TvTile[],
    continuationToken:
      container?.continuations?.[0]?.nextContinuationData?.continuation ?? null,
  };
}

// Defends against a pathological/never-ending continuation chain (a bug on
// either youtubei.js's or YouTube's side) turning a sync into an infinite
// loop. The TV client pages tracks 15-at-a-time (much smaller than web/
// music's ~100), so a large "Liked Music" playlist legitimately needs many
// more pages than a typical web-paginated fetch would -- 800 pages (12k
// tracks) is comfortably above any real account size while still being a
// hard ceiling against a genuine bug.
const MAX_CONTINUATION_PAGES = 800;

/** Fetches every tile across all pages of a TV-client browse surface. */
async function browseAllPages(yt: Innertube, browseId: string): Promise<TvTile[]> {
  const first = await yt.actions.execute('/browse', {browseId, client: 'TV'});
  let {tiles: all, continuationToken: token} = firstPage(first.data);
  let pages = 0;
  while (token && pages++ < MAX_CONTINUATION_PAGES) {
    const next = await yt.actions.execute('/browse', {continuation: token, client: 'TV'});
    const page = continuationPage(next.data);
    all = all.concat(page.tiles);
    token = page.continuationToken;
  }
  return all;
}

// YT Music's well-known id for the account's auto-generated Liked Songs
// playlist. It never appears in FEplaylist_aggregation (a regular-YouTube
// surface; this is YT Music's own auto-playlist, not something the account
// "created" the way it did "Dang OSTs"), but IS directly fetchable by this
// fixed id even from the TV client -- see the module doc comment above for
// the on-device confirmation. Always added explicitly rather than relying
// on it showing up in the aggregation list.
const LIKED_MUSIC_PLAYLIST_ID = 'LM';

/**
 * Fetches the authenticated account's full library: every regular playlist
 * (via FEplaylist_aggregation) plus the fixed Liked Music auto-playlist, and
 * every track in each, using the same long-lived Innertube session
 * getAuthedInnertube() hands back elsewhere (playback resolution, token
 * refresh persistence) rather than creating a second one.
 *
 * A single playlist failing to fetch (deleted mid-sync, a transient network
 * error, ...) does not abort the whole sync -- it's logged and skipped, so
 * one bad playlist can't block every other one from syncing.
 */
export async function fetchLibrary(): Promise<SyncedLibrary> {
  const yt = await getAuthedInnertube();

  const aggregationTiles = await browseAllPages(yt, 'FEplaylist_aggregation');
  const refs = parseTvPlaylistRefs(aggregationTiles);
  if (!refs.some(r => r.playlistId === LIKED_MUSIC_PLAYLIST_ID)) {
    refs.unshift({playlistId: LIKED_MUSIC_PLAYLIST_ID, name: 'Liked Music'});
  }

  const playlists: SyncedPlaylist[] = [];
  for (const ref of refs) {
    try {
      const tiles = await browseAllPages(yt, `VL${ref.playlistId}`);
      playlists.push({playlistId: ref.playlistId, name: ref.name, tracks: parseTvTracks(tiles)});
    } catch (e) {
      console.warn(
        `fetchLibrary: skipping playlist "${ref.name}" (${ref.playlistId}) -- fetch failed`,
        e,
      );
    }
  }

  return {playlists};
}
