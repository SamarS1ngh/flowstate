import {parseRadioSongs, RadioQueue} from '../src/engine/radioQueue';
import type {Song} from '../src/types';

// Minimal playlistPanelVideoRenderer-shaped fixture (the music watch-next mix).
function panelItem(videoId: string, title: string, artist: string, len: string) {
  return {
    playlistPanelVideoRenderer: {
      videoId,
      title: {runs: [{text: title}]},
      longBylineText: {runs: [{text: artist}]},
      lengthText: {simpleText: len},
    },
  };
}

function mixResponse(items: Array<[string, string, string, string]>) {
  return {
    contents: {
      playlistPanelRenderer: {
        contents: items.map(([id, t, a, l]) => panelItem(id, t, a, l)),
      },
    },
  };
}

const seed: Song = {
  videoId: 'SEED',
  title: 'Seed Song',
  artist: 'Seed Artist',
  durationS: 200,
  hasVibe: false,
};

const flush = () => new Promise(r => setTimeout(r, 0));

describe('parseRadioSongs', () => {
  it('extracts videoId/title/artist/duration in order', () => {
    const songs = parseRadioSongs(
      mixResponse([
        ['a', 'Alpha', 'A Band', '3:45'],
        ['b', 'Beta', 'B Band', '1:02:03'],
      ]),
    );
    expect(songs.map(s => s.videoId)).toEqual(['a', 'b']);
    expect(songs[0]).toMatchObject({title: 'Alpha', artist: 'A Band', durationS: 225});
    expect(songs[1].durationS).toBe(3723); // 1:02:03
  });

  it('dedupes repeated videoIds', () => {
    const songs = parseRadioSongs(
      mixResponse([
        ['a', 'Alpha', 'A', '0:30'],
        ['a', 'Alpha again', 'A', '0:30'],
        ['c', 'Gamma', 'C', '0:30'],
      ]),
    );
    expect(songs.map(s => s.videoId)).toEqual(['a', 'c']);
  });

  it('skips nodes that carry a videoId but no video metadata', () => {
    const data = {watchEndpoint: {videoId: 'ENDPOINT_ONLY'}}; // no title/length
    expect(parseRadioSongs(data)).toEqual([]);
  });

  it('returns [] for junk input', () => {
    expect(parseRadioSongs(null)).toEqual([]);
    expect(parseRadioSongs({})).toEqual([]);
  });

  it('parses the TV shelf-tile shape (videoId + title not co-located)', () => {
    const tile = (videoId: string, title: string, artist: string) => ({
      tileRenderer: {
        onSelectCommand: {watchEndpoint: {videoId}},
        metadata: {
          tileMetadataRenderer: {
            lines: [
              {lineRenderer: {items: [{lineItemRenderer: {text: {runs: [{text: title}]}}}]}},
              {lineRenderer: {items: [{lineItemRenderer: {text: {runs: [{text: artist}]}}}]}},
            ],
          },
        },
      },
    });
    const data = {
      contents: {shelfRenderer: {content: [tile('t1', 'Tile One', 'Artist 1'), tile('t2', 'Tile Two', 'Artist 2')]}},
    };
    const songs = parseRadioSongs(data);
    expect(songs.map(s => s.videoId)).toEqual(['t1', 't2']);
    expect(songs[0]).toMatchObject({title: 'Tile One', artist: 'Artist 1'});
  });
});

describe('RadioQueue', () => {
  it('serves fetched songs in order, excluding the seed', async () => {
    const fetchFn = jest.fn(async () =>
      parseRadioSongs(
        mixResponse([
          ['SEED', 'Seed Song', 'Seed Artist', '3:20'], // echoed seed -> deduped out
          ['x', 'X', 'XA', '3:00'],
          ['y', 'Y', 'YA', '3:00'],
        ]),
      ),
    );
    const q = new RadioQueue(fetchFn);
    q.reset(seed);
    await flush(); // let the reset-kicked refill resolve

    expect(q.next(seed)?.videoId).toBe('x');
    expect(q.next(null)?.videoId).toBe('y');
  });

  it('is endless: refills by re-seeding off the last-served song', async () => {
    let page = 0;
    const fetchFn = jest.fn(async (fromId: string) => {
      page += 1;
      // Each fetch returns brand-new ids so the buffer keeps growing.
      return parseRadioSongs(
        mixResponse([
          [`${fromId}-a-${page}`, 'A', 'A', '3:00'],
          [`${fromId}-b-${page}`, 'B', 'B', '3:00'],
        ]),
      );
    });
    const q = new RadioQueue(fetchFn);
    q.reset(seed);
    await flush();

    const got: string[] = [];
    for (let i = 0; i < 10; i++) {
      const s = q.next(got.length ? {videoId: got[got.length - 1]} as Song : seed);
      await flush();
      if (s) got.push(s.videoId);
    }
    expect(got.length).toBe(10); // never ran dry
    expect(new Set(got).size).toBe(10); // all distinct
  });

  it('never serves the same song twice across refills', async () => {
    // A fetch that always returns the SAME two ids -> dedup must starve the
    // buffer rather than loop forever on duplicates.
    const fetchFn = jest.fn(async () =>
      parseRadioSongs(
        mixResponse([
          ['dup1', 'D1', 'D', '3:00'],
          ['dup2', 'D2', 'D', '3:00'],
        ]),
      ),
    );
    const q = new RadioQueue(fetchFn);
    q.reset(seed);
    await flush();

    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const s = q.next(null);
      await flush();
      if (s) ids.add(s.videoId);
    }
    expect(ids).toEqual(new Set(['dup1', 'dup2']));
  });
});
