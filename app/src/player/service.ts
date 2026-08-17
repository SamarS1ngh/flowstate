import TrackPlayer, {Event} from 'react-native-track-player';
import {
  handlePlaybackError,
  handleQueueEnded,
  onActiveTrackChanged,
  skipToNext,
  skipToPrevious,
  togglePlayPause,
} from './controller';

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
  // Dragging the notification / lock-screen scrubber. Capability.SeekTo (see
  // App.tsx) makes the scrubber appear, but without this handler the drag did
  // nothing -- the RemoteSeek event was unhandled. `position` is in seconds.
  TrackPlayer.addEventListener(Event.RemoteSeek, e => TrackPlayer.seekTo(e.position));
  // immediate=true: commit the skip now, not via the debounce timer -- remote
  // skips must work while the app is backgrounded, where JS timers are frozen
  // (see controller.scheduleSeek).
  TrackPlayer.addEventListener(Event.RemoteNext, () => skipToNext(true));
  TrackPlayer.addEventListener(Event.RemotePrevious, () => skipToPrevious(true));
  TrackPlayer.addEventListener(Event.RemoteStop, () => TrackPlayer.stop());
  // Native auto-advance: when a track ends, ExoPlayer moves to the pre-loaded
  // next track in its queue and fires this -- the ONLY signal for a
  // background/locked-screen advance (no JS skip is involved there). The
  // controller updates its mirror + refills the window from here. Because the
  // player never stops at the boundary, the media foreground service + wake lock
  // stay held, so playback continues with the screen locked.
  TrackPlayer.addEventListener(Event.PlaybackActiveTrackChanged, () =>
    onActiveTrackChanged(),
  );
  // Genuine end of the queue (source exhausted). Repeat-one is handled natively
  // via RepeatMode.Track, so this is only the real end.
  TrackPlayer.addEventListener(Event.PlaybackQueueEnded, () => handleQueueEnded());
  // ExoPlayer failed to play the active track (dead URL, connection dropped) --
  // flag the error + stop instead of stalling/churning. See controller.
  // Pass the error through so the controller can tell a rate-limit (HTTP 403/429
  // -> back off, don't re-resolve) from a transient/dead URL (re-resolve+retry).
  TrackPlayer.addEventListener(Event.PlaybackError, e => handlePlaybackError(e));
}
