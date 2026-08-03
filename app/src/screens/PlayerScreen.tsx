import React, {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {Alert, Dimensions, FlatList, StyleSheet, Text, View} from 'react-native';
import LinearGradient from 'react-native-linear-gradient';
import {SafeAreaView} from 'react-native-safe-area-context';
import {useArtGradient} from '../ui/useArtGradient';
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
  currentSource,
  consumeFallbackStatus,
  nowPlaying,
  peekUpcoming,
  playFrom,
  reportFallback,
  skipToNext,
  skipToPrevious,
  subscribeNowPlaying,
  togglePlayPause,
  FallbackKind,
} from '../player/controller';
import {openVibesDb, VibesDb} from '../db/vibesDb';
import {FeedbackStore} from '../engine/feedbackStore';
import {VibeQueue} from '../engine/vibeQueue';
import type {Song} from '../types';
import Chip from '../ui/Chip';
import CircleButton from '../ui/CircleButton';
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
const {width: SCREEN_WIDTH} = Dimensions.get('window');
const ART_SIZE = Math.min(thumbSize.player, SCREEN_WIDTH - spacing.xxl * 2);

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
  const [isSeeking, setIsSeeking] = useState(false);
  const [seekPreview, setSeekPreview] = useState(0);
  // Which way the art should slide in/out on the next song change -- set
  // right before calling skipToNext/skipToPrevious (by gesture or by the
  // transport buttons), consumed by the art's entering/exiting animation
  // below. null only on first mount, where a plain fade reads better than a
  // directional slide from nowhere.
  const [swipeDir, setSwipeDir] = useState<'left' | 'right' | null>(null);
  // Backdrop gradient derived from the current song's artwork (see hook).
  const artGradient = useArtGradient(song?.videoId);

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
  // "Loading" = we have a target song (optimistic open / skip) but the audio
  // isn't actually playing yet -- it's still resolving or buffering. Show a
  // spinner on the transport button until it truly plays, so the first song
  // doesn't look "playing" (or paused) before any sound comes out. Paused /
  // stopped / errored are NOT loading -- those show the normal play button.
  const pbState = playbackState.state;
  const isLoading =
    !!song &&
    (pbState === State.None ||
      pbState === State.Loading ||
      pbState === State.Buffering ||
      pbState === State.Ready) &&
    fallbackStatus !== 'error';
  const isLock = src instanceof VibeQueue && src.label === 'vibe:lock';

  // Up Next preview (Task: fill the emptiness). SimpleQueue's order is fully
  // known ahead of time so it can be peeked without side effects; VibeQueue
  // picks weighted-random on each next() call, so there is no honest
  // deterministic list to show -- the section below falls back to a plain
  // "vibe will choose" note for it instead of faking one (see
  // QueueSource.peekUpcoming).
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

  // Shared by both the transport buttons and the horizontal swipe gesture so
  // the art's slide direction is consistent regardless of which one the user
  // used.
  const handleNext = useCallback(() => {
    setSwipeDir('left');
    skipToNext();
  }, []);
  const handlePrev = useCallback(() => {
    setSwipeDir('right');
    skipToPrevious();
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

  const duration = progress.duration > 0 ? progress.duration : 0;
  const sliderMax = duration > 0 ? duration : 1;
  const displayPosition = isSeeking ? seekPreview : progress.position;
  const bufferedValue = Math.min(progress.buffered, sliderMax);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      {/* Violet-into-black backdrop -- gives the now-playing screen depth
          instead of flat black. Fades to the app bg by the lower third so the
          transport/up-next sit on plain dark. */}
      <LinearGradient
        colors={artGradient}
        locations={[0, 0.4, 0.78]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Animated.View style={[styles.flexFill, screenAnimatedStyle]}>
        <GestureDetector gesture={panGesture}>
          <View style={styles.hero}>
            <View style={styles.topBar}>
              <IconButton name="chevronDown" size={26} onPress={() => navigation.goBack()} />
              <Text style={styles.contextLabel} numberOfLines={1}>
                {isVibe ? (isLock ? 'Vibe · Lock' : 'Vibe · Drift') : `Playing from ${src?.label ?? 'queue'}`}
              </Text>
              {/* Balances the chevron-down button's width so the label above
                  stays visually centered -- no 3-dot menu here on purpose:
                  there's nothing real to put in one (no "go to playlist"
                  context is tracked by the controller, and this redesign
                  doesn't invent playback/navigation features to fill a
                  dead icon). */}
              <View style={styles.topBarSpacer} />
            </View>

            <View style={styles.artWrap}>
              <Animated.View
                key={song.videoId}
                entering={
                  swipeDir === 'left'
                    ? SlideInRight.duration(220)
                    : swipeDir === 'right'
                    ? SlideInLeft.duration(220)
                    : FadeIn.duration(200)
                }
                exiting={swipeDir === 'right' ? SlideOutRight.duration(200) : SlideOutLeft.duration(200)}>
                <Thumbnail videoId={song.videoId} size={ART_SIZE} radius={16} />
              </Animated.View>
            </View>

            <View style={styles.info}>
              {/* Fixed-height title box (always 2 lines tall) so a 1-line vs
                  2-line song title doesn't shift everything below it. */}
              <View style={styles.titleWrap}>
                <Text style={styles.title} numberOfLines={2}>
                  {song.title}
                </Text>
              </View>
              <Text style={styles.artist} numberOfLines={1}>
                {song.artist}
              </Text>
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
              minimumTrackTintColor={colors.textTertiary}
              maximumTrackTintColor={colors.chipBg}
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
              minimumTrackTintColor={colors.white}
              maximumTrackTintColor="transparent"
              thumbTintColor={colors.white}
            />
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.time}>{formatTime(displayPosition)}</Text>
            <Text style={styles.time}>{formatTime(duration)}</Text>
          </View>

          <View style={styles.controls}>
            {/* "shuffle-vibe": mirrors the lock/drift chip above in transport-row
                position (matches the reference app's shuffle-prev-play-next-repeat
                layout) -- dimmed/inert when there's no vibe queue to toggle. */}
            <IconButton
              name="shuffle"
              size={22}
              color={isVibe ? (isLock ? colors.textTertiary : colors.accent) : colors.textTertiary}
              disabled={!isVibe}
              onPress={onToggleLockDrift}
            />
            <IconButton name="previous" size={30} onPress={handlePrev} />
            <CircleButton
              icon={isPlaying ? 'pause' : 'play'}
              size={72}
              loading={isLoading}
              onPress={() => togglePlayPause()}
            />
            <IconButton name="next" size={30} onPress={handleNext} />
            {/* Repeat: decorative only -- no repeat-track/queue concept exists in
                controller.ts/queue.ts, and this redesign doesn't invent new
                playback logic. Rendered dimmed so it doesn't imply a working
                toggle. */}
            <IconButton name="repeat" size={22} color={colors.textTertiary} disabled />
          </View>

          <Text style={styles.sectionLabel}>UP NEXT</Text>
          {isVibe ? (
            <View style={styles.upNextEmpty}>
              <Text style={styles.upNextHint}>
                {isLock
                  ? 'Locked -- vibe will keep replaying songs like this one'
                  : 'Vibe will choose the next song based on your mood'}
              </Text>
            </View>
          ) : upcoming.length === 0 ? (
            <View style={styles.upNextEmpty}>
              <Text style={styles.upNextHint}>End of queue</Text>
            </View>
          ) : (
            <FlatList
              style={styles.upNextList}
              contentContainerStyle={styles.upNextContent}
              data={upcoming}
              keyExtractor={item => item.videoId}
              renderItem={({item}) => (
                <ListRow
                  videoId={item.videoId}
                  title={item.title}
                  subtitle={item.artist}
                  thumbRadius={radii.sm}
                />
              )}
            />
          )}
        </View>
      </Animated.View>
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
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginHorizontal: spacing.sm,
  },
  topBarSpacer: {width: 40},
  artWrap: {marginTop: spacing.lg},
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
  time: {color: colors.textTertiary, fontSize: 12},
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: spacing.lg,
    paddingHorizontal: spacing.sm,
  },
  sectionLabel: {
    color: colors.textTertiary,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 0.5,
    marginTop: spacing.xl,
    marginBottom: spacing.xs,
  },
  upNextEmpty: {paddingVertical: spacing.lg},
  upNextHint: {color: colors.textTertiary, fontSize: 13, textAlign: 'center'},
  upNextList: {flex: 1},
  upNextContent: {paddingBottom: spacing.xxl},
});
