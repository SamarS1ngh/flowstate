// Pure-function tests for src/library/syncClient.ts's parsers, fed
// synthetic fixtures modeled directly on the REAL TV-client browse
// responses captured against the logged-in account (a throwaway Node
// script using the same saved OAuth credentials, hitting
// FEplaylist_aggregation and VLLM/VL<playlistId> with `client: 'TV'` --
// see that file's header comment and the task report for the full
// transcript and raw JSON). Only the duck-typed fields these parsers
// actually read are included in fixtures; everything else real responses
// carry (thumbnails, tracking params, watch endpoint playback config, ...)
// is irrelevant here and omitted.
//
// fetchLibrary/browseAllPages themselves are integration glue around a
// live Innertube session and are device-verified instead (see the task
// report for real account evidence: playlist names + counts, screenshot).
import {
  parseDurationLabel,
  parseTvPlaylistRefs,
  parseTvTracks,
  tvText,
  type TvText,
  type TvTile,
} from '../src/library/syncClient';

describe('tvText', () => {
  test('passes simpleText through unchanged', () => {
    expect(tvText({simpleText: 'Dang OSTs'})).toBe('Dang OSTs');
  });

  test('concatenates runs', () => {
    expect(tvText({runs: [{text: 'FREAKED'}, {text: ' OUT'}]})).toBe('FREAKED OUT');
  });

  test('prefers simpleText when (unusually) both are present', () => {
    expect(tvText({simpleText: 'A', runs: [{text: 'B'}]})).toBe('A');
  });

  test('returns empty string for null/undefined', () => {
    expect(tvText(null)).toBe('');
    expect(tvText(undefined)).toBe('');
  });

  test('returns empty string for an empty object', () => {
    expect(tvText({})).toBe('');
  });

  test('tolerates a run with no text field', () => {
    expect(tvText({runs: [{}]})).toBe('');
  });
});

describe('parseDurationLabel', () => {
  test('parses mm:ss', () => {
    expect(parseDurationLabel('2:39')).toBe(159);
  });

  test('parses h:mm:ss', () => {
    expect(parseDurationLabel('1:02:39')).toBe(3759);
  });

  test('parses single-digit seconds', () => {
    expect(parseDurationLabel('0:05')).toBe(5);
  });

  test('returns null for an empty string', () => {
    expect(parseDurationLabel('')).toBeNull();
  });

  test('returns null for a non-numeric label', () => {
    expect(parseDurationLabel('LIVE')).toBeNull();
  });
});

// A minimal playlist-track tile, modeled on the real VLLM (Liked Music)
// capture: title as `runs` + videoId under onSelectCommand.watchEndpoint,
// artist as lines[0], duration as a thumbnailOverlayTimeStatusRenderer.
function trackTile(overrides: {
  videoId?: string;
  title?: TvText;
  artist?: string | null;
  durationLabel?: string | null;
} = {}): TvTile {
  return {
    tileRenderer: {
      metadata: {
        tileMetadataRenderer: {
          title: overrides.title ?? {runs: [{text: 'FREAKED OUT'}]},
          lines:
            overrides.artist === undefined
              ? [
                  {
                    lineRenderer: {
                      items: [{lineItemRenderer: {text: {simpleText: 'Fat Papi & prodshushy'}}}],
                    },
                  },
                ]
              : overrides.artist === null
                ? []
                : [
                    {
                      lineRenderer: {
                        items: [{lineItemRenderer: {text: {simpleText: overrides.artist}}}],
                      },
                    },
                  ],
        },
      },
      onSelectCommand: {watchEndpoint: {videoId: overrides.videoId ?? 'kFeYV_QO2oo'}},
      header:
        overrides.durationLabel === null
          ? undefined
          : {
              tileHeaderRenderer: {
                thumbnailOverlays: [
                  {thumbnailOverlayTimeStatusRenderer: {text: {simpleText: overrides.durationLabel ?? '2:39'}}},
                ],
              },
            },
    },
  };
}

describe('parseTvTracks', () => {
  test('extracts a full track row (real VLLM shape: runs title, simpleText artist+duration)', () => {
    expect(parseTvTracks([trackTile()])).toEqual([
      {videoId: 'kFeYV_QO2oo', title: 'FREAKED OUT', artist: 'Fat Papi & prodshushy', durationS: 159},
    ]);
  });

  test('extracts a track whose title is simpleText, not runs (real Dang OSTs shape)', () => {
    const tile = trackTile({
      title: {simpleText: 'Keep Reaching (Deku Theme)'},
      artist: 'Jasper Stories',
      videoId: '9UVqV84c2xQ',
      durationLabel: '2:56',
    });
    expect(parseTvTracks([tile])).toEqual([
      {videoId: '9UVqV84c2xQ', title: 'Keep Reaching (Deku Theme)', artist: 'Jasper Stories', durationS: 176},
    ]);
  });

  test('drops a tile with no resolvable videoId', () => {
    const tile = trackTile();
    delete tile.tileRenderer!.onSelectCommand;
    expect(parseTvTracks([tile])).toEqual([]);
  });

  test('drops null/undefined tiles', () => {
    expect(parseTvTracks([null, undefined])).toEqual([]);
  });

  test('defaults artist to Unknown when the artist line is missing', () => {
    const tile = trackTile({artist: null});
    expect(parseTvTracks([tile])[0].artist).toBe('Unknown');
  });

  test('defaults durationS to null when no time-status overlay is present', () => {
    const tile = trackTile({durationLabel: null as unknown as string});
    expect(parseTvTracks([tile])[0].durationS).toBeNull();
  });

  test('defaults title to a placeholder when missing', () => {
    const tile = trackTile({title: {}});
    expect(parseTvTracks([tile])[0].title).toBe('Unknown title');
  });
});

// A minimal playlist-grid tile, modeled on the real FEplaylist_aggregation
// capture: title as simpleText, browseId "VL"-prefixed.
function playlistTile(browseId: string, title: string): TvTile {
  return {
    tileRenderer: {
      metadata: {tileMetadataRenderer: {title: {simpleText: title}}},
      onSelectCommand: {browseEndpoint: {browseId}},
    },
  };
}

describe('parseTvPlaylistRefs', () => {
  test('extracts playlist refs, stripping the VL prefix (real aggregation shape)', () => {
    const refs = parseTvPlaylistRefs([
      playlistTile('VLWL', 'Watch later'),
      playlistTile('VLPLoSzw6migEXu_itcLwafQGVMZxbK2TPVp', 'Dang OSTs'),
      playlistTile('VLLL', 'Liked videos'),
    ]);
    expect(refs).toEqual([
      {playlistId: 'WL', name: 'Watch later'},
      {playlistId: 'PLoSzw6migEXu_itcLwafQGVMZxbK2TPVp', name: 'Dang OSTs'},
      {playlistId: 'LL', name: 'Liked videos'},
    ]);
  });

  test('drops a tile whose browseEndpoint is not a playlist (no VL prefix)', () => {
    const refs = parseTvPlaylistRefs([playlistTile('UCsomeChannelId', 'Some Channel')]);
    expect(refs).toEqual([]);
  });

  test('drops a tile with no browseEndpoint at all', () => {
    const refs = parseTvPlaylistRefs([{tileRenderer: {metadata: {tileMetadataRenderer: {title: {simpleText: 'X'}}}}}]);
    expect(refs).toEqual([]);
  });

  test('de-duplicates by playlistId, keeping the first occurrence', () => {
    const refs = parseTvPlaylistRefs([
      playlistTile('VLPL1', 'First name'),
      playlistTile('VLPL1', 'Second name'),
    ]);
    expect(refs).toEqual([{playlistId: 'PL1', name: 'First name'}]);
  });

  test('falls back to a placeholder name for a titleless playlist tile', () => {
    const refs = parseTvPlaylistRefs([
      {tileRenderer: {onSelectCommand: {browseEndpoint: {browseId: 'VLPL9'}}}},
    ]);
    expect(refs).toEqual([{playlistId: 'PL9', name: 'Untitled playlist'}]);
  });

  test('drops null/undefined tiles', () => {
    expect(parseTvPlaylistRefs([null, undefined])).toEqual([]);
  });
});
