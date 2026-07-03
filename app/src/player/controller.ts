import TrackPlayer, {State} from 'react-native-track-player';
import {Song} from '../types';
import {resolveStreamUrl, StreamResolveError} from '../stream/resolver';
import {QueueSource} from './queue';

let source: QueueSource | null = null;
let current: Song | null = null;

async function load(song: Song): Promise<void> {
  // retry-once semantics per design: fresh extraction on first failure, then skip
  let url: string;
  try {
    url = await resolveStreamUrl(song.videoId);
  } catch (e) {
    if (!(e instanceof StreamResolveError)) throw e;
    url = await resolveStreamUrl(song.videoId); // second attempt
  }
  await TrackPlayer.reset();
  await TrackPlayer.add({
    id: song.videoId,
    url,
    title: song.title,
    artist: song.artist,
    duration: song.durationS ?? undefined,
  });
  await TrackPlayer.play();
  current = song;
}

export async function playFrom(src: QueueSource, first: Song): Promise<void> {
  source = src;
  src.reset(first);
  await load(first);
}

export async function skipToNext(): Promise<void> {
  if (!source) return;
  let candidate = source.next(current);
  while (candidate) {
    try {
      await load(candidate);
      return;
    } catch {
      candidate = source.next(candidate); // unplayable song: skip forward
    }
  }
  await TrackPlayer.stop();
}

export async function skipToPrevious(): Promise<void> {
  await TrackPlayer.seekTo(0); // v1: previous restarts current track
}

export function nowPlaying(): Song | null {
  return current;
}

export async function togglePlayPause(): Promise<void> {
  const state = (await TrackPlayer.getPlaybackState()).state;
  if (state === State.Playing) await TrackPlayer.pause();
  else await TrackPlayer.play();
}
