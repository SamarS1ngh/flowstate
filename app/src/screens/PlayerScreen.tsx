import React, {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {
  Alert,
  Dimensions,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import Animated, {
  Extrapolation,
  FadeIn,
  SlideInLeft,
  SlideInRight,
  SlideOutLeft,
  SlideOutRight,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import Slider from '@react-native-community/slider';
import TrackPlayer, {
  Event,
  State,
  useProgress,
  useTrackPlayerEvents,
  usePlaybackState,
} from 'react-native-track-player';
import type {RootStackParamList} from '../App';
import {
  activeVideoId,
  currentSource,
  consumeFallbackStatus,
  isRepeatOne,
  nowPlaying,
  peekNextSong,
  peekUpcoming,
  playFrom,
  reportFallback,
  setRepeatOne as setRepeatOneCtl,
  skipToNext,
  skipToPrevious,
  subscribeNowPlaying,
  togglePlayPause,
  FallbackKind,
} from '../player/controller';
import {
  openVibesDb,
  VibesDb,
  LIKED_PLAYLIST_ID,
  LIKED_PLAYLIST_NAME,
} from '../db/vibesDb';
import {FeedbackStore} from '../engine/feedbackStore';
import {VibeQueue} from '../engine/vibeQueue';
import {RadioQueue} from '../engine/radioQueue';
import {likeSong} from '../engine/accountLikes';
import type {Song} from '../types';
import Chip from '../ui/Chip';
import CircleButton from '../ui/CircleButton';
import HoloFrame from '../ui/HoloFrame';
import HudChrome from '../ui/HudChrome';
import IconButton from '../ui/IconButton';
import ListRow from '../ui/ListRow';
import Thumbnail from '../ui/Thumbnail';
import {colors, gradients, radii, spacing, thumbSize, type} from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Player'>;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const MOOD_CHIPS: Array<{label: string; key: string}> = [
  {label: 'Happy', key: 'happy'},
  {label: 'Chill', key: 'relaxed'},
  {label: 'Aggressive', key: 'aggressive'},
  {label: 'Dance', key: 'danceable'},
  {label: 'Acoustic', key: 'acoustic'},
  {label: 'Party', key: 'party'},
];

const FALLBACK_LABEL: Record<FallbackKind, string> = {
  relaxed: 'vibe loosened',
  random: 'vibe map too small — random',
  error: 'playback failed — check connection',
};

// Album art: as large as the reference app's now-playing screen, but capped
// to the screen width (minus side padding) so it never overflows on a
// narrower device -- there's a lot more content below it now (slider,
// transport, Up Next) than the old layout had.
const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get('window');
// Height-aware so the whole player (art + info + chips + transport + up-next)
// fits without overflowing/cutting off the controls on shorter screens.
const ART_SIZE = Math.min(
  thumbSize.player,
  SCREEN_WIDTH - spacing.xxl * 2,
  SCREEN_HEIGHT * 0.25,
);

const UP_NEXT_COUNT = 6;

// Gesture thresholds (Task: swipe/pull-down redesign). Distance is in dp,
// velocity in dp/s (react-native-gesture-handler's Pan event units) -- either
// crossing its threshold commits the gesture, matching the brief's
// "threshold + velocity based" requirement so a fast flick commits even if
// the finger didn't travel far.
const DISMISS_DISTANCE = 120;
const DISMISS_VELOCITY = 1200;
const SWIPE_DISTANCE = 70;
const SWIPE_VELOCITY = 800;

export default function PlayerScreen({navigation}: Props) {
  const [song, setSong] = useState<Song | null>(() => nowPlaying());
  const [selectedMood, setSelectedMood] = useState<string | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<FallbackKind | null>(null);
  const [feedbackStore, setFeedbackStore] = useState<FeedbackStore | null>(null);
  const [vibesDb, setVibesDb] = useState<VibesDb | null>(null);
  const [startingVibe, setStartingVibe] = useState(false);
  const [startingRadio, setStartingRadio] = useState(false);
  // Local "liked" state for the current track (mirrors the local:liked
  // playlist, which is also pushed to the real YouTube account on toggle).
  const [liked, setLiked] = useState(false);
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreview, setSeekPreview] = useState(0);
  // Latest playback position, kept in a ref so handlePrev can decide
  // restart-vs-go-back without depending on (and re-creating on) every tick.
  const positionRef = useRef(0);
  // Which way the art should slide in/out on the next song change -- set
  // right before calling skipToNext/skipToPrevious (by gesture or by the
  // transport buttons), consumed by the art's entering/exiting animation
  // below. null only on first mount, where a plain fade reads better than a
  // directional slide from nowhere.
  const [swipeDir, setSwipeDir] = useState<'left' | 'right' | null>(null);
  // Backdrop gradient derived from the current song's artwork (see hook).
  const [queueOpen, setQueueOpen] = useState(false);
  const [repeatOne, setRepeatOne] = useState(isRepeatOne());
  const onToggleRepeat = useCallback(() => {
    setRepeatOne(prev => {
      const next = !prev;
      setRepeatOneCtl(next);
      return next;
    });
  }, []);

  // Gentle looping pulse for the play button's neon halo -- the "live hologram"
  // heartbeat. Runs whenever this screen is mounted.
  const pulse = useSharedValue(0);
  useEffect(() => {
    pulse.value = withRepeat(withTiming(1, {duration: 1600}), -1, true);
  }, [pulse]);
  const haloStyle = useAnimatedStyle(() => ({
    opacity: 0.28 + pulse.value * 0.6,
    transform: [{scale: 1 + pulse.value * 0.1}],
  }));

  const progress = useProgress(500);
  const playbackState = usePlaybackState();

  // Design note (previous-song tracking for reject pairs): the controller
  // only exposes nowPlaying() as a point-in-time getter, not a history. We
  // derive the previous song ourselves by diffing consecutive `song` state
  // values right here in refreshSong -- whenever the track actually changes,
  // the outgoing videoId is stashed in this ref before `song` is overwritten.
  // That makes previousIdRef.current always "the song that was playing right
  // before the current one", which is exactly the fromId half of the
  // (fromId, rejectedId) feedback pair. A ref (not state) is enough since
  // nothing needs to re-render off of it directly.
  const previousIdRef = useRef<string | null>(null);

  // Forces a re-render after mutating the active VibeQueue in place
  // (setMode/setMoodFilter don't themselves trigger React updates, since the
  // queue instance lives outside React state -- see currentSource()).
  const [, bump] = useReducer(c => c + 1, 0);

  const refreshSong = useCallback(() => {
    setSong(prev => {
      const next = nowPlaying();
      if (prev && next && prev.videoId !== next.videoId) {
        previousIdRef.current = prev.videoId;
      }
      return next;
    });
    setFallbackStatus(consumeFallbackStatus());
  }, []);

  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], refreshSong);

  // Also catch the case where this screen is reached right after playFrom()
  // resolved, before any track-changed event has fired -- and, crucially, the
  // OPTIMISTIC path: playFrom() sets the now-playing song before the network
  // resolve, so the screen (navigated to on tap, before load finishes) shows
  // that song immediately instead of the previous/blank one. subscribeNowPlaying
  // fires on that optimistic set; the mount call covers an already-set current.
  useEffect(() => {
    refreshSong();
    return subscribeNowPlaying(refreshSong);
  }, [refreshSong]);

  // FeedbackStore + the raw VibesDb handle both need a live db handle;
  // opened once per screen visit. VibesDb itself is kept (not just the
  // FeedbackStore built from it) so "Start vibe from here" can look up
  // library-wide vibe songs on demand without a second openVibesDb() call.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const opened = await openVibesDb();
      if (cancelled || !opened) return;
      const store = new FeedbackStore(opened.handle);
      store.ensureTables();
      setFeedbackStore(store);
      setVibesDb(opened);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const src = currentSource();
  const isVibe = src instanceof VibeQueue;
  const isRadio = src instanceof RadioQueue;

  // Reset the mood-chip selection (and the underlying queue's filter) when
  // the active source changes identity -- e.g. the user started a new vibe
  // session from PlaylistScreen while this screen stayed mounted (React
  // Navigation reuses the 'Player' route instance when navigating to it
  // again from elsewhere in the stack). `src` is recomputed fresh from
  // currentSource() every render, so depending on it here is equivalent to
  // comparing against the previous source by reference.
  useEffect(() => {
    setSelectedMood(null);
    previousIdRef.current = null;
    if (src instanceof VibeQueue) src.setMoodFilter(null);
  }, [src]);

  const isPlaying = playbackState.state === State.Playing;
  // Optimistic play/pause: flip the icon the instant you tap, then let the real
  // playback state reconcile -- so the button doesn't wait for the state event.
  const [wantPlaying, setWantPlaying] = useState<boolean | null>(null);
  useEffect(() => {
    if (wantPlaying !== null && isPlaying === wantPlaying) setWantPlaying(null);
  }, [isPlaying, wantPlaying]);
  const shownPlaying = wantPlaying ?? isPlaying;
  const onTogglePlay = useCallback(() => {
    setWantPlaying(!shownPlaying);
    void togglePlayPause(shownPlaying); // pauses if currently playing, else plays
  }, [shownPlaying]);
  // "Loading" = we have a target song (optimistic open / skip) but the audio
  // isn't actually playing yet -- it's still resolving or buffering. Show a
  // spinner on the transport button until it truly plays, so the first song
  // doesn't look "playing" (or paused) before any sound comes out.
  //
  // CRITICAL: also treat "the shown song isn't the active track yet" as
  // loading. On a skip, scheduleSeek() PAUSES the player during the debounce +
  // resolve, so pbState is Paused while the new song is still being loaded --
  // without this, the transport would show a Play button (reads as "paused,
  // tap to play") for that whole window even though it's actually loading.
  const pbState = playbackState.state;
  const notActiveYet = !!song && song.videoId !== activeVideoId();
  const isLoading =
    !!song &&
    fallbackStatus !== 'error' &&
    (notActiveYet ||
      pbState === State.None ||
      pbState === State.Loading ||
      pbState === State.Buffering ||
      pbState === State.Ready);
  const isLock = src instanceof VibeQueue && src.label === 'vibe:lock';

  // Up Next: SimpleQueue's order is fully known, so peek several ahead. VibeQueue
  // is generative, but it COMMITS one next pick (peekNextSong) -- so we can show
  // that single real "coming up" song. Computed EVERY render (not cached in
  // state) so it always equals the currently-committed next == what will actually
  // play. A state+effect version showed a stale pick when the committed next
  // changed after the effect last ran (preview said one song, another played).
  const vibeNext = isVibe ? peekNextSong() : null;
  const upcoming = isVibe ? [] : peekUpcoming(UP_NEXT_COUNT);

  const onToggleLockDrift = () => {
    if (!(src instanceof VibeQueue)) return;
    src.setMode(src.label === 'vibe:lock' ? 'drift' : 'lock');
    bump();
  };

  const onToggleMood = (key: string) => {
    if (!(src instanceof VibeQueue)) return;
    const next = selectedMood === key ? null : key;
    setSelectedMood(next);
    src.setMoodFilter(next ? {key: next, min: 0.5} : null);
  };

  const onDoesntFit = async () => {
    if (!song || !(src instanceof VibeQueue)) return;
    const rejectedId = song.videoId;
    feedbackStore?.recordReject(previousIdRef.current, rejectedId, Date.now());
    src.rejectCurrent(rejectedId);
    await skipToNext();
  };

  // "Start vibe from here" (Task: never-empty action row for a plain
  // SimpleQueue). Mirrors PlaylistScreen's own vibe-session construction
  // exactly (VibeQueue + FeedbackStore snapshot + playFrom) -- no new engine
  // behavior, just triggering the existing one from a song that's already
  // analyzed but wasn't opened in vibe mode, scoped to the whole library
  // ('ALL') since the Player screen has no playlist context of its own.
  const onStartVibeFromHere = async () => {
    if (!song || isVibe || startingVibe) return;
    setStartingVibe(true);
    try {
      const db = vibesDb ?? (await openVibesDb());
      if (!db) {
        Alert.alert('Vibe unavailable', 'No vibes database found on this device.');
        return;
      }
      const vibeSongs = db.getVibeSongs('ALL');
      const seed = vibeSongs.find(v => v.videoId === song.videoId);
      if (!seed) {
        Alert.alert('Not analyzed', 'This song has no vibe analysis yet.');
        return;
      }
      const store = feedbackStore ?? new FeedbackStore(db.handle);
      store.ensureTables();
      const feedback = store.snapshot(Date.now());
      const queue = new VibeQueue(seed, 'drift', {
        songs: vibeSongs,
        feedback,
        onFallback: reportFallback,
      });
      await playFrom(queue, seed.song);
    } catch (e) {
      Alert.alert('Could not start vibe', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setStartingVibe(false);
    }
  };

  // Reflect whether the current track is in the account's Liked Music playlist
  // ('LM') whenever the song or db changes -- songs already liked show filled.
  useEffect(() => {
    if (!song || !vibesDb) {
      setLiked(false);
      return;
    }
    try {
      setLiked(vibesDb.isLikedSong(song));
    } catch {
      setLiked(false);
    }
  }, [song, vibesDb]);

  // ❤️ Like the current track. One-way by design: liking pushes to the real
  // account (/like/like) AND adds the song to the local Liked Music playlist
  // so it shows immediately (a later sync re-fetches it from the account into
  // the same 'LM' playlist). There is NO unlike -- removing a track from a
  // YouTube playlist isn't possible with this TV token (see
  // [[yt-tv-token-capabilities]]), so once liked the heart stays filled and
  // the button is disabled.
  const onLike = useCallback(async () => {
    if (!song || liked) return;
    const target = song;
    setLiked(true); // optimistic
    try {
      const db = vibesDb ?? (await openVibesDb());
      if (db) db.mirrorSong(target, LIKED_PLAYLIST_ID, LIKED_PLAYLIST_NAME);
      void likeSong(target.videoId); // best-effort real-account write
    } catch {
      setLiked(false); // revert on local-db failure
    }
  }, [song, liked, vibesDb]);

  // 📡 Start an endless song-radio seeded from the current track: related
  // music streamed from YouTube (the one personalized-music surface the TV
  // token can reach), fed straight into the existing player/timeline.
  const onStartRadio = useCallback(async () => {
    if (!song || startingRadio) return;
    setStartingRadio(true);
    try {
      await playFrom(new RadioQueue(), song);
      navigation.navigate('Radio'); // radio lives on its own screen
    } catch (e) {
      Alert.alert('Could not start radio', e instanceof Error ? e.message : 'Unknown error');
    } finally {
      setStartingRadio(false);
    }
  }, [song, startingRadio, navigation]);

  // Shared by both the transport buttons and the horizontal swipe gesture so
  // the art's slide direction is consistent regardless of which one the user
  // used.
  const handleNext = useCallback(() => {
    setSwipeDir('left');
    skipToNext();
  }, []);
  const handlePrev = useCallback(() => {
    setSwipeDir('right');
    // First press restarts the current song (bring it back to 0); only go to the
    // previous song when you're already near the start. Lets you reset a song
    // with "previous" without leaving it.
    if (positionRef.current > 3) {
      void TrackPlayer.seekTo(0);
    } else {
      skipToPrevious();
    }
  }, []);

  const dismiss = useCallback(() => navigation.goBack(), [navigation]);

  // --- Gestures (Task: pull-down-to-dismiss + swipe-to-skip) ---------------
  // translateY drives the *entire* screen's transform (see screenAnimatedStyle
  // below) so the whole player visually slides down together, but the
  // GestureDetector below is only attached to the hero area (top bar + art +
  // title/artist + action row) -- deliberately excluding the slider and the
  // Up Next list, which have their own touch handling (native SeekBar drag,
  // FlatList scroll) that a screen-wide pan recognizer would otherwise fight.
  const translateY = useSharedValue(0);

  // Single Pan gesture that decides its own dominant axis at runtime, rather
  // than racing two separately-configured Pan gestures against each other via
  // activeOffsetX/Y + failOffsetX/Y. That two-gesture Race setup looked
  // correct on paper but device-testing showed the horizontal swipe never
  // won the race in practice (only the vertical dismiss ever fired) --
  // deciding "is this drag more X or more Y so far" ourselves, every frame,
  // is unambiguous and doesn't depend on getting two independent
  // offset/fail thresholds to interact exactly right.
  const panGesture = useMemo(
    () =>
      Gesture.Pan()
        .onUpdate(e => {
          // Only let a vertical-reading drag push the screen down -- once a
          // swipe is reading as horizontal (|dx| > |dy|), leave translateY
          // alone so a track-change swipe doesn't also nudge the screen.
          if (e.translationY > 0 && e.translationY >= Math.abs(e.translationX)) {
            translateY.value = e.translationY;
          }
        })
        .onEnd(e => {
          const absX = Math.abs(e.translationX);
          const absY = Math.abs(e.translationY);
          if (absX > absY) {
            // Horizontal-dominant: treat as a track-change swipe. translateY
            // never moved for a drag this horizontal (see onUpdate above),
            // so no spring-back is needed here.
            if (e.translationX < -SWIPE_DISTANCE || e.velocityX < -SWIPE_VELOCITY) {
              runOnJS(handleNext)();
            } else if (e.translationX > SWIPE_DISTANCE || e.velocityX > SWIPE_VELOCITY) {
              runOnJS(handlePrev)();
            }
            return;
          }
          // Vertical-dominant: dismiss past the threshold, else spring back.
          if (e.translationY > DISMISS_DISTANCE || e.velocityY > DISMISS_VELOCITY) {
            translateY.value = withTiming(700, {duration: 180}, finished => {
              if (finished) runOnJS(dismiss)();
            });
          } else {
            translateY.value = withSpring(0, {damping: 18, stiffness: 180});
          }
        }),
    [dismiss, handleNext, handlePrev],
  );

  // Double-tap the album art to like. Kept stable via a ref so the gesture
  // isn't rebuilt every render (onLike changes with song/liked state).
  const onLikeRef = useRef(onLike);
  onLikeRef.current = onLike;
  const triggerLike = useCallback(() => {
    void onLikeRef.current();
  }, []);
  const doubleTapLike = useMemo(
    () =>
      Gesture.Tap()
        .numberOfTaps(2)
        .maxDuration(300)
        .onEnd((_e, success) => {
          if (success) runOnJS(triggerLike)();
        }),
    [triggerLike],
  );

  const screenAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{translateY: translateY.value}],
    // Subtle fade as the player is dragged down, so the gesture reads as
    // "letting go of the screen" rather than a dead pixel-for-pixel drag.
    opacity: interpolate(
      translateY.value,
      [0, DISMISS_DISTANCE * 1.5],
      [1, 0.5],
      Extrapolation.CLAMP,
    ),
  }));

  const onSlidingStart = () => setIsSeeking(true);
  const onSlidingComplete = async (value: number) => {
    setIsSeeking(false);
    await TrackPlayer.seekTo(value);
  };

  if (!song) {
    return (
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.emptyTopBar}>
          <IconButton name="chevronDown" size={26} onPress={() => navigation.goBack()} />
        </View>
        <View style={styles.center}>
          <Text style={styles.emptyText}>Nothing playing.</Text>
        </View>
      </SafeAreaView>
    );
  }

  // "Settled" = the song shown is the one actually loaded/playing. While a skip's
  // song is still loading (optimistic flip ahead of the load), snap the progress
  // bar to 0 and use the song's own duration, so the loader visibly resets before
  // the track switches -- instead of briefly showing the previous song's time.
  const settled = song != null && song.videoId === activeVideoId();
  const rawDuration = progress.duration > 0 ? progress.duration : 0;
  const duration = settled ? rawDuration : song?.durationS ?? 0;
  const sliderMax = duration > 0 ? duration : 1;
  const displayPosition = isSeeking ? seekPreview : settled ? progress.position : 0;
  const bufferedValue = settled ? Math.min(progress.buffered, sliderMax) : 0;
  // Latest live position, read by handlePrev without re-creating the callback.
  positionRef.current = settled ? progress.position : 0;

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Violet-into-black backdrop -- gives the now-playing screen depth
          instead of flat black. Fades to the app bg by the lower third so the
          transport/up-next sit on plain dark. */}
      <LinearGradient
        colors={gradients.playerBackdrop}
        locations={[0, 0.4, 0.78]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <HudChrome />
      <Animated.View style={[styles.flexFill, screenAnimatedStyle]}>
        <GestureDetector gesture={panGesture}>
          <View style={styles.hero}>
            {/* HUD status strip -- reads as a terminal header, not an app bar. */}
            <View style={styles.statusStrip}>
              <IconButton name="chevronDown" size={22} onPress={() => navigation.goBack()} />
              <Text style={styles.sysId}>FLOWSTATE.AUDIO_SYS</Text>
              <View style={styles.statusRight}>
                <IconButton
                  name="radio"
                  size={18}
                  color={isRadio ? colors.neon : colors.textSecondary}
                  disabled={startingRadio}
                  onPress={onStartRadio}
                  hitSlop={10}
                  style={styles.radioBtn}
                />
                <View style={styles.liveDot} />
                <Text style={styles.liveText}>LIVE</Text>
              </View>
            </View>
            <View style={styles.hudDivider} />

            <View style={styles.artWrap}>
              <Animated.View
                key={song.videoId}
                style={styles.artGlow}
                entering={
                  swipeDir === 'left'
                    ? SlideInRight.duration(220)
                    : swipeDir === 'right'
                    ? SlideInLeft.duration(220)
                    : FadeIn.duration(200)
                }
                exiting={swipeDir === 'right' ? SlideOutRight.duration(200) : SlideOutLeft.duration(200)}>
                <GestureDetector gesture={doubleTapLike}>
                  <HoloFrame radius={20} cornerSize={24} style={styles.artHolo}>
                    <Thumbnail videoId={song.videoId} size={ART_SIZE} radius={12} />
                    <View style={styles.artTag}>
                      <Text style={styles.artTagText}>
                        {isRadio
                          ? 'RADIO'
                          : isVibe
                          ? isLock
                            ? 'VIBE·LOCK'
                            : 'VIBE·DRIFT'
                          : 'QUEUE'}
                      </Text>
                    </View>
                    {/* Like: bottom-right of the art. Tap here OR double-tap the
                        art. One-way -- filled + disabled once liked. */}
                    <IconButton
                      name={liked ? 'heart' : 'heartOutline'}
                      size={22}
                      color={liked ? colors.neon : colors.textPrimary}
                      disabled={liked}
                      onPress={onLike}
                      hitSlop={8}
                      style={styles.artLike}
                    />
                  </HoloFrame>
                </GestureDetector>
              </Animated.View>
            </View>

            {/* Terminal-style metadata readout (labelled, mono, left-aligned)
                -- fixed 2-line title height so it never shifts the layout. */}
            <View style={styles.readout}>
              <View style={styles.readRow}>
                <Text style={styles.readLabel}>TRACK</Text>
                <View style={styles.readTitleWrap}>
                  <Text style={styles.readTitle} numberOfLines={2}>
                    {song.title}
                  </Text>
                </View>
              </View>
              <View style={styles.readRowLast}>
                <Text style={styles.readLabel}>ARTIST</Text>
                <Text style={styles.readValue} numberOfLines={1}>
                  {song.artist}
                </Text>
              </View>
            </View>

            {fallbackStatus === 'error' ? (
              // Surfaced regardless of vibe mode: skipToNext's consecutive-failure
              // cap can fire for a plain SimpleQueue too (not just VibeQueue), so
              // this banner isn't gated behind isVibe like the relaxed/random ones
              // below.
              <Text style={styles.errorText}>{FALLBACK_LABEL.error}</Text>
            ) : null}

            {isVibe ? (
              <View style={styles.vibeSection}>
                <View style={styles.actionChipRow}>
                  <Chip
                    label={isLock ? '🔒 Lock' : '〜 Drift'}
                    active={isLock}
                    onPress={onToggleLockDrift}
                    tone="accent"
                  />
                  <Chip label="👎 Doesn't fit" active onPress={onDoesntFit} tone="danger" />
                </View>

                <View style={styles.chipRow}>
                  {MOOD_CHIPS.map(chip => (
                    <Chip
                      key={chip.key}
                      label={chip.label}
                      active={selectedMood === chip.key}
                      onPress={() => onToggleMood(chip.key)}
                    />
                  ))}
                </View>

                {/* Always rendered at a fixed height so the status text
                    appearing/disappearing between songs doesn't shift the
                    transport below. */}
                <Text style={styles.fallbackText} numberOfLines={1}>
                  {fallbackStatus && fallbackStatus !== 'error'
                    ? FALLBACK_LABEL[fallbackStatus]
                    : ' '}
                </Text>
              </View>
            ) : (
              // Action row is never left empty: a real, working "start a
              // vibe session from this song" action when it's analyzed, or
              // an honest "not analyzed" note (no fake buttons) when it
              // isn't.
              <View style={styles.actionChipRow}>
                {song.hasVibe ? (
                  <Chip
                    label={startingVibe ? 'Starting vibe…' : '✨ Start vibe from here'}
                    active
                    tone="accent"
                    onPress={startingVibe ? undefined : onStartVibeFromHere}
                  />
                ) : (
                  <Chip label="Not analyzed yet" />
                )}
              </View>
            )}
          </View>
        </GestureDetector>

        <View style={styles.lower}>
          <View style={styles.sliderWrap}>
            {/* Two stacked native sliders sharing identical track geometry:
                the back one (disabled -- never receives touches) renders the
                buffered range so it can't fight the front one's drag; the
                front one is the real interactive seek control. Its
                maximumTrackTintColor is transparent so the back slider's
                buffered/unbuffered colors show through past the playhead. */}
            <Slider
              style={StyleSheet.absoluteFill}
              disabled
              minimumValue={0}
              maximumValue={sliderMax}
              value={bufferedValue}
              // buffered = bright gray; unplayed (past playhead) = clearly
              // visible gray, not the near-invisible faint line it was.
              minimumTrackTintColor="rgba(255,255,255,0.85)"
              maximumTrackTintColor="rgba(255,255,255,0.50)"
              thumbTintColor="transparent"
            />
            <Slider
              style={StyleSheet.absoluteFill}
              minimumValue={0}
              maximumValue={sliderMax}
              value={displayPosition}
              onSlidingStart={onSlidingStart}
              onValueChange={setSeekPreview}
              onSlidingComplete={onSlidingComplete}
              minimumTrackTintColor={colors.neon}
              maximumTrackTintColor="transparent"
              thumbTintColor={colors.white}
            />
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.time}>{formatTime(displayPosition)}</Text>
            <Text style={styles.time}>{formatTime(duration)}</Text>
          </View>

          <HoloFrame style={styles.transportPanel} radius={22} cornerSize={18}>
            <View style={styles.controls}>
            {/* "shuffle-vibe": mirrors the lock/drift chip above in transport-row
                position (matches the reference app's shuffle-prev-play-next-repeat
                layout) -- dimmed/inert when there's no vibe queue to toggle. */}
            <IconButton
              name="shuffle"
              size={isVibe && !isLock ? 25 : 22}
              color={isVibe ? (isLock ? colors.textSecondary : colors.neon) : colors.textTertiary}
              disabled={!isVibe}
              onPress={onToggleLockDrift}
            />
            <IconButton name="previous" size={24} onPress={handlePrev} />
            <View style={styles.playGlow}>
              <Animated.View style={[styles.playHalo, haloStyle]} pointerEvents="none" />
              <CircleButton
                icon={shownPlaying ? 'pause' : 'play'}
                size={56}
                // Play triangle renders optically smaller than the pause bars at
                // the same point size -- bump it so the two read equal.
                iconSize={shownPlaying ? 18 : 26}
                loading={isLoading}
                onPress={onTogglePlay}
              />
            </View>
            <IconButton name="next" size={24} onPress={handleNext} />
            {/* Repeat-one: real toggle -- when on, a track that ends replays
                instead of advancing (see controller.handleQueueEnded). Lit neon
                + larger when armed. */}
            <IconButton
              name="repeat"
              size={repeatOne ? 25 : 22}
              color={repeatOne ? colors.neon : colors.textSecondary}
              onPress={onToggleRepeat}
            />
            </View>
          </HoloFrame>

          {/* Collapsed UP.NEXT register -- a tappable rounded panel that unfolds
              into a half-screen scrollable queue sheet. */}
          {(() => {
            const preview = isVibe ? vibeNext : upcoming[0] ?? null;
            const count = isVibe ? (vibeNext ? 1 : 0) : upcoming.length;
            return (
              <Pressable
                style={({pressed}) => [styles.upNextBar, pressed && styles.upNextBarPressed]}
                onPress={() => setQueueOpen(true)}>
                <View style={styles.upNextBarBrL} />
                <View style={styles.upNextBarBrR} />
                <Text style={styles.upNextBarLabel}>◤ UP.NEXT</Text>
                <View style={styles.upNextBarMid}>
                  {preview ? (
                    <Text style={styles.upNextBarTitle} numberOfLines={1}>
                      ▸ {preview.title}
                    </Text>
                  ) : (
                    <Text style={styles.upNextBarEmpty} numberOfLines={1}>
                      {isVibe ? (isLock ? 'LOCKED · LIKE THIS' : 'DRIFT · BY MOOD') : 'END OF QUEUE'}
                    </Text>
                  )}
                </View>
                <Text style={styles.upNextBarCount}>
                  {count > 0 ? `[${count > 99 ? '99+' : count}]` : ''} ▲
                </Text>
              </Pressable>
            );
          })()}
        </View>
      </Animated.View>

      <Modal
        visible={queueOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setQueueOpen(false)}>
        <Pressable style={styles.sheetBackdrop} onPress={() => setQueueOpen(false)} />
        <View style={styles.sheet}>
          <View style={styles.sheetCornerTL} />
          <View style={styles.sheetCornerTR} />
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>◤ UP.NEXT.QUEUE</Text>
            <IconButton name="chevronDown" size={24} onPress={() => setQueueOpen(false)} />
          </View>
          <View style={styles.hudDivider} />
          {isVibe ? (
            <View style={styles.sheetBody}>
              {vibeNext ? (
                <ListRow
                  videoId={vibeNext.videoId}
                  title={vibeNext.title}
                  subtitle={vibeNext.artist}
                  thumbRadius={radii.md}
                />
              ) : null}
              <Text style={styles.sheetHint}>
                {isLock
                  ? 'LOCK MODE — vibe keeps to songs like the current one. The full queue is decided one song ahead.'
                  : 'DRIFT MODE — vibe picks each next song live from your mood, so only the next track is committed.'}
              </Text>
            </View>
          ) : upcoming.length === 0 ? (
            <View style={styles.sheetBody}>
              <Text style={styles.sheetHint}>END OF QUEUE</Text>
            </View>
          ) : (
            <FlatList
              style={styles.sheetList}
              contentContainerStyle={styles.sheetListContent}
              data={upcoming}
              keyExtractor={item => item.videoId}
              renderItem={({item}) => (
                <ListRow
                  videoId={item.videoId}
                  title={item.title}
                  subtitle={item.artist}
                  thumbRadius={radii.md}
                />
              )}
            />
          )}
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  flexFill: {flex: 1},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyTopBar: {paddingHorizontal: spacing.md, paddingTop: spacing.xs},
  emptyText: {color: colors.textSecondary, fontSize: 16},
  hero: {alignItems: 'center', paddingHorizontal: spacing.xl},
  // HUD status strip + terminal readout
  statusStrip: {flexDirection: 'row', alignItems: 'center', width: '100%', paddingTop: spacing.xs},
  sysId: {
    flex: 1,
    color: colors.neon,
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginLeft: spacing.sm,
  },
  statusRight: {flexDirection: 'row', alignItems: 'center'},
  radioBtn: {marginRight: spacing.sm},
  liveDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.neon,
    marginRight: spacing.xs,
    shadowColor: colors.neonGlow,
    shadowOpacity: 1,
    shadowRadius: 6,
    elevation: 4,
  },
  liveText: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  hudDivider: {
    height: 1,
    alignSelf: 'stretch',
    backgroundColor: colors.glassBorder,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    opacity: 0.6,
  },
  artTag: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    backgroundColor: 'rgba(8,8,11,0.72)',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 3,
  },
  artLike: {
    position: 'absolute',
    bottom: 6,
    right: 6,
    backgroundColor: '#08080b',
    borderWidth: 1,
    borderColor: colors.glassBorder,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  artTagText: {
    color: colors.neon,
    fontFamily: 'monospace',
    fontSize: 9,
    letterSpacing: 1,
    fontWeight: '700',
  },
  readout: {alignSelf: 'stretch', marginTop: spacing.md},
  readRow: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.sm},
  readRowLast: {flexDirection: 'row', alignItems: 'flex-start'},
  readLabel: {
    width: 54,
    color: colors.textTertiary,
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1,
    fontWeight: '700',
    marginTop: 2,
  },
  readTitleWrap: {flex: 1, height: 18 * 2, justifyContent: 'flex-start'},
  readTitle: {color: colors.white, fontFamily: 'monospace', fontSize: 13, fontWeight: '700', lineHeight: 18},
  readValue: {flex: 1, color: colors.textPrimary, fontFamily: 'monospace', fontSize: 12, lineHeight: 16},
  readValueNeon: {
    flex: 1,
    color: colors.neon,
    fontFamily: 'monospace',
    fontSize: 14,
    letterSpacing: 1,
    lineHeight: 20,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingTop: spacing.xs,
  },
  contextLabel: {
    flex: 1,
    textAlign: 'center',
    color: colors.neon,
    fontSize: 11,
    fontWeight: '700',
    fontFamily: 'monospace',
    textTransform: 'uppercase',
    letterSpacing: 2,
    marginHorizontal: spacing.sm,
  },
  topBarSpacer: {width: 40},
  artWrap: {marginTop: spacing.lg},
  // Neon glow cast around the album art (colored spot shadow on Android P+).
  artGlow: {
    borderRadius: 22,
    // iOS-only bloom; no `elevation` (Android would draw a sharp shadow box).
    shadowColor: colors.neonGlow,
    shadowOpacity: 1,
    shadowRadius: 26,
    shadowOffset: {width: 0, height: 0},
  },
  // Padding so the system-window frame + corner brackets sit around the art.
  artHolo: {padding: 10},
  info: {alignItems: 'center', marginTop: spacing.xl, width: '100%'},
  // Two lines of the title's line-height, so titles of any length occupy the
  // same vertical space and nothing below jumps between songs.
  titleWrap: {height: 30 * 2, justifyContent: 'center', width: '100%'},
  title: {...type.title, textAlign: 'center', lineHeight: 30},
  artist: {color: colors.textSecondary, fontSize: 15, marginTop: spacing.sm, textAlign: 'center'},
  errorText: {color: colors.danger, fontSize: 13, textAlign: 'center', marginTop: spacing.md},
  vibeSection: {marginTop: spacing.lg, width: '100%', alignItems: 'center'},
  actionChipRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    marginTop: spacing.lg,
    marginBottom: spacing.sm,
  },
  chipRow: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center'},
  fallbackText: {
    color: colors.textTertiary,
    fontSize: 12,
    textAlign: 'center',
    marginTop: spacing.xs,
    height: 16, // reserved slot -> no shift when it toggles on/off
  },
  lower: {flex: 1, paddingHorizontal: spacing.xl, minHeight: 0},
  sliderWrap: {height: 36, justifyContent: 'center', marginTop: spacing.md},
  timeRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: -spacing.xs,
  },
  time: {color: colors.textSecondary, fontSize: 11, fontFamily: 'monospace', letterSpacing: 1},
  transportPanel: {marginTop: spacing.md, alignSelf: 'stretch'},
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  // Neon glow behind the play/pause button + its pulsing halo ring.
  playGlow: {
    width: 74,
    height: 74,
    borderRadius: 37,
    alignItems: 'center',
    justifyContent: 'center',
    // iOS-only bloom; no `elevation` (Android would draw a sharp shadow box).
    shadowColor: colors.neonGlow,
    shadowOpacity: 1,
    shadowRadius: 20,
    shadowOffset: {width: 0, height: 0},
  },
  playHalo: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderRadius: 37,
    borderWidth: 1.5,
    borderColor: colors.neon,
  },
  sectionLabel: {
    color: colors.neon,
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginTop: spacing.sm,
    marginBottom: spacing.sm,
  },
  upNextEmpty: {paddingVertical: spacing.lg},
  upNextHint: {color: colors.textTertiary, fontSize: 13},
  upNextMono: {flexDirection: 'row', alignItems: 'center'},
  upNextArrow: {color: colors.neon, fontSize: 16, marginRight: spacing.sm},
  upNextMonoText: {flex: 1},
  upNextMonoTitle: {color: colors.white, fontFamily: 'monospace', fontSize: 14, fontWeight: '700'},
  upNextMonoArtist: {color: colors.textSecondary, fontFamily: 'monospace', fontSize: 12, marginTop: 1},
  upNextList: {flex: 1},
  upNextContent: {paddingBottom: spacing.xxl},
  // Collapsed UP.NEXT bar (tap to unfold the queue sheet)
  upNextBar: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'stretch',
    marginTop: spacing.sm,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    borderRadius: radii.lg,
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glassFill,
    overflow: 'hidden',
  },
  upNextBarPressed: {opacity: 0.75},
  upNextBarBrL: {
    position: 'absolute',
    top: 4,
    left: 4,
    width: 12,
    height: 12,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderColor: colors.neon,
    borderTopLeftRadius: radii.lg,
  },
  upNextBarBrR: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    width: 12,
    height: 12,
    borderBottomWidth: 2,
    borderRightWidth: 2,
    borderColor: colors.neon,
    borderBottomRightRadius: radii.lg,
  },
  upNextBarLabel: {
    color: colors.neon,
    fontFamily: 'monospace',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  upNextBarMid: {flex: 1, marginHorizontal: spacing.md},
  upNextBarTitle: {color: colors.white, fontFamily: 'monospace', fontSize: 12, fontWeight: '700'},
  upNextBarEmpty: {color: colors.textTertiary, fontFamily: 'monospace', fontSize: 11, letterSpacing: 1},
  upNextBarCount: {color: colors.neon, fontFamily: 'monospace', fontSize: 12, fontWeight: '700', letterSpacing: 1},
  // Half-screen unfoldable queue sheet
  sheetBackdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(4,4,7,0.72)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: SCREEN_HEIGHT * 0.55,
    backgroundColor: '#0c0a14',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderColor: colors.glassBorder,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.lg,
  },
  sheetCornerTL: {
    position: 'absolute',
    top: -1,
    left: -1,
    width: 28,
    height: 28,
    borderTopWidth: 2,
    borderLeftWidth: 2,
    borderColor: colors.neon,
    borderTopLeftRadius: 24,
  },
  sheetCornerTR: {
    position: 'absolute',
    top: -1,
    right: -1,
    width: 28,
    height: 28,
    borderTopWidth: 2,
    borderRightWidth: 2,
    borderColor: colors.neon,
    borderTopRightRadius: 24,
  },
  sheetHeader: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  sheetTitle: {
    color: colors.neon,
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: '700',
    letterSpacing: 1.5,
  },
  sheetBody: {paddingTop: spacing.md},
  sheetHint: {
    color: colors.textSecondary,
    fontFamily: 'monospace',
    fontSize: 12,
    lineHeight: 18,
    letterSpacing: 0.5,
    marginTop: spacing.md,
  },
  sheetList: {flex: 1},
  sheetListContent: {paddingBottom: spacing.xxxl, paddingTop: spacing.xs},
});
