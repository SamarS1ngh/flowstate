import TrackPlayer, {Event} from 'react-native-track-player';
import {skipToNext, skipToPrevious, togglePlayPause} from './controller';

// LIMITATION (post-process-death): this headless JS service only runs while
// the app process is alive (foreground or backgrounded-but-resident). If
// Android has fully killed the process -- e.g. the OS reclaimed memory, or
// the user swiped the app away from recents while
// AppKilledPlaybackBehavior.ContinuePlayback kept native playback going for
// a while -- there is no JS runtime left to receive these events at all.
// Native playback controls (notification, headset buttons, etc.) may
// continue to work via the OS media session for a short while in that
// state, but any interaction requiring this JS handler (skipToNext's
// offline retry/cap logic, vibe-mode fallbacks, feedback recording) becomes
// a no-op until the app is reopened and this service is re-registered by
// App.tsx's bootstrap. This is an inherent RNTP/Android limitation, not a
// bug in the handlers below -- documented here since it's easy to assume
// "the service" means "always running."
export async function playbackService(): Promise<void> {
  TrackPlayer.addEventListener(Event.RemotePlay, () => TrackPlayer.play());
  TrackPlayer.addEventListener(Event.RemotePause, () => TrackPlayer.pause());
  TrackPlayer.addEventListener(Event.RemoteNext, () => skipToNext());
  TrackPlayer.addEventListener(Event.RemotePrevious, () => skipToPrevious());
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  // Auto-advance when a song ends: the single-track queue runs out, so this
  // fires -> load the next song (from the prefetched file if ready = instant).
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => skipToNext());
}
