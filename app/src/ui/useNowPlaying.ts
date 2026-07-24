import {useCallback, useEffect, useState} from 'react';
import {Event, useTrackPlayerEvents} from 'react-native-track-player';
import {nowPlaying} from '../player/controller';
import type {Song} from '../types';

// Minimal "what's currently loaded" subscription for the persistent mini
// player (App-level, mounted across every screen). Deliberately thinner
// than PlayerScreen's own refreshSong (no fallback-status/previous-id
// tracking -- the mini player only needs to know what to show and whether
// to re-render on track change), so this doesn't duplicate or risk
// interfering with PlayerScreen's more detailed bookkeeping.
export function useNowPlayingSong(): Song | null {
  const [song, setSong] = useState<Song | null>(() => nowPlaying());
  const refresh = useCallback(() => setSong(nowPlaying()), []);
  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], refresh);
  useEffect(() => {
    refresh();
  }, [refresh]);
  return song;
}
