import React, {useCallback, useEffect, useMemo, useReducer, useRef, useState} from 'react';
import {
  Dimensions,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import LinearGradient from 'react-native-linear-gradient';
import {Gesture, GestureDetector} from 'react-native-gesture-handler';
import {runOnJS} from 'react-native-reanimated';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import Slider from '@react-native-community/slider';
import TrackPlayer, {State, useProgress, usePlaybackState} from 'react-native-track-player';
import type {RootStackParamList} from '../App';
import {
  activeVideoId,
  nowPlaying,
  peekUpcoming,
  skipToNext,
  skipToPrevious,
  subscribeNowPlaying,
  togglePlayPause,
} from '../player/controller';
import {
  openVibesDb,
  VibesDb,
  LIKED_PLAYLIST_ID,
  LIKED_PLAYLIST_NAME,
} from '../db/vibesDb';
import {likeSong} from '../engine/accountLikes';
import type {Song} from '../types';
import CircleButton from '../ui/CircleButton';
import HoloFrame from '../ui/HoloFrame';
import HudChrome from '../ui/HudChrome';
import IconButton from '../ui/IconButton';
import ListRow from '../ui/ListRow';
import Thumbnail from '../ui/Thumbnail';
import {colors, gradients, radii, spacing, thumbSize} from '../ui/theme';

type Props = NativeStackScreenProps<RootStackParamList, 'Radio'>;

const {width: SCREEN_WIDTH, height: SCREEN_HEIGHT} = Dimensions.get('window');
const ART_SIZE = Math.min(thumbSize.player, SCREEN_WIDTH - spacing.xxl * 2, SCREEN_HEIGHT * 0.28);
const UP_NEXT_COUNT = 8;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// Dedicated Radio screen: the YouTube song-radio source rendered on its own,
// with no vibe/lock/drift chrome -- radio is a separate concept from the
// on-device vibe engine (see [[yt-tv-token-capabilities]]). Reads the same
// shared playback controller as PlayerScreen; it's just a radio-only view.
export default function RadioScreen({navigation}: Props) {
  const [song, setSong] = useState<Song | null>(() => nowPlaying());
  const [vibesDb, setVibesDb] = useState<VibesDb | null>(null);
  const [liked, setLiked] = useState(false);
  const [wantPlaying, setWantPlaying] = useState<boolean | null>(null);

  const progress = useProgress(500);
  const playbackState = usePlaybackState();
  const isPlaying = playbackState.state === State.Playing;

  useEffect(() => {
    const unsub = subscribeNowPlaying(() => setSong(nowPlaying()));
    return unsub;
  }, []);

  // The radio buffer fills asynchronously with no event; tick a re-render so
  // UP.NEXT reflects it without waiting for the next track change.
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void openVibesDb().then(db => {
      if (!cancelled) setVibesDb(db);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (wantPlaying !== null && isPlaying === wantPlaying) setWantPlaying(null);
  }, [isPlaying, wantPlaying]);
  const shownPlaying = wantPlaying ?? isPlaying;

  const onTogglePlay = useCallback(() => {
    setWantPlaying(!shownPlaying);
    void togglePlayPause(shownPlaying);
  }, [shownPlaying]);

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

  const onLike = useCallback(async () => {
    if (!song || liked) return;
    const target = song;
    setLiked(true);
    try {
      const db = vibesDb ?? (await openVibesDb());
      if (db) db.mirrorSong(target, LIKED_PLAYLIST_ID, LIKED_PLAYLIST_NAME);
      void likeSong(target.videoId);
    } catch {
      setLiked(false);
    }
  }, [song, liked, vibesDb]);

  // Double-tap the art to like (stable ref so the gesture isn't rebuilt).
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

  const pbState = playbackState.state;
  const settled = song != null && song.videoId === activeVideoId();
  // Show the spinner (not a Play button) whenever the shown song isn't the
  // active track yet -- a skip pauses the player while the next song resolves,
  // which would otherwise read as "paused, tap to play". See PlayerScreen.
  const isLoading =
    !!song &&
    (!settled ||
      pbState === State.None ||
      pbState === State.Loading ||
      pbState === State.Buffering ||
      pbState === State.Ready);
  const rawDuration = progress.duration > 0 ? progress.duration : 0;
  const duration = settled ? rawDuration : song?.durationS ?? 0;
  const sliderMax = duration > 0 ? duration : 1;
  const position = settled ? progress.position : 0;

  const upcoming = peekUpcoming(UP_NEXT_COUNT);

  if (!song) {
    return (
      <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
        <HudChrome />
        <View style={styles.emptyWrap}>
          <Text style={styles.emptyText}>No radio playing.</Text>
          <Text style={styles.emptyHint}>Tap the radio icon on a song to start.</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.root} edges={['top', 'bottom']}>
      <LinearGradient
        colors={gradients.playerBackdrop}
        locations={[0, 0.4, 0.78]}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <HudChrome />
      <View style={styles.flexFill}>
        <View style={styles.statusStrip}>
          <IconButton name="chevronDown" size={22} onPress={() => navigation.goBack()} />
          <Text style={styles.sysId}>FLOWSTATE.RADIO</Text>
          <View style={styles.statusRight}>
            <View style={styles.liveDot} />
            <Text style={styles.liveText}>LIVE</Text>
          </View>
        </View>
        <View style={styles.hudDivider} />

        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}>
          <View style={styles.artWrap}>
            <GestureDetector gesture={doubleTapLike}>
              <HoloFrame radius={20} cornerSize={24} style={styles.artHolo}>
                <Thumbnail videoId={song.videoId} size={ART_SIZE} radius={12} />
                <View style={styles.artTag}>
                  <Text style={styles.artTagText}>RADIO</Text>
                </View>
                {/* Like: bottom-right of the art. Tap here OR double-tap. */}
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
          </View>

          <View style={styles.readout}>
            <View style={styles.readRow}>
              <Text style={styles.readLabel}>TRACK</Text>
              <Text style={styles.readTitle} numberOfLines={2}>
                {song.title}
              </Text>
            </View>
            <View style={styles.readRow}>
              <Text style={styles.readLabel}>ARTIST</Text>
              <Text style={styles.readArtist} numberOfLines={1}>
                {song.artist || '—'}
              </Text>
            </View>
          </View>

          <View style={styles.sliderWrap}>
            <Slider
              style={styles.slider}
              minimumValue={0}
              maximumValue={sliderMax}
              value={position}
              minimumTrackTintColor={colors.neon}
              maximumTrackTintColor={'rgba(255,255,255,0.5)'}
              thumbTintColor={colors.neon}
              onSlidingComplete={v => void TrackPlayer.seekTo(v)}
            />
          </View>
          <View style={styles.timeRow}>
            <Text style={styles.time}>{formatTime(position)}</Text>
            <Text style={styles.time}>{formatTime(duration)}</Text>
          </View>

          <HoloFrame style={styles.transportPanel} radius={22} cornerSize={18}>
            <View style={styles.controls}>
              <IconButton name="previous" size={24} onPress={() => skipToPrevious()} />
              <View style={styles.playGlow}>
                <CircleButton
                  icon={shownPlaying ? 'pause' : 'play'}
                  size={56}
                  iconSize={shownPlaying ? 18 : 26}
                  loading={isLoading}
                  onPress={onTogglePlay}
                />
              </View>
              <IconButton name="next" size={24} onPress={() => skipToNext()} />
            </View>
          </HoloFrame>

          <Text style={styles.upNextLabel}>UP.NEXT</Text>
          {upcoming.length === 0 ? (
            <Text style={styles.upNextEmpty}>Loading related songs…</Text>
          ) : (
            upcoming.map((s, i) => (
              <ListRow
                key={`${s.videoId}-${i}`}
                title={s.title}
                subtitle={s.artist || 'Radio'}
                videoId={s.videoId}
              />
            ))
          )}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {flex: 1, backgroundColor: colors.bg},
  flexFill: {flex: 1},
  emptyWrap: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.xl},
  emptyText: {color: colors.textPrimary, fontSize: 16, marginBottom: spacing.xs},
  emptyHint: {color: colors.textSecondary, fontSize: 13},
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.sm,
  },
  sysId: {
    color: colors.neon,
    fontFamily: 'monospace',
    fontSize: 13,
    letterSpacing: 2,
    fontWeight: '700',
  },
  statusRight: {flexDirection: 'row', alignItems: 'center'},
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
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xl,
    marginTop: spacing.sm,
  },
  scroll: {paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl},
  artWrap: {alignItems: 'center', marginTop: spacing.lg},
  artHolo: {padding: spacing.sm},
  artTag: {
    position: 'absolute',
    left: spacing.md,
    bottom: spacing.md,
    backgroundColor: 'rgba(0,0,0,0.6)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radii.sm,
  },
  artLike: {
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
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
    fontSize: 10,
    letterSpacing: 1.5,
    fontWeight: '700',
  },
  readout: {marginTop: spacing.lg},
  readRow: {flexDirection: 'row', alignItems: 'flex-start', marginBottom: spacing.xs},
  readLabel: {
    color: colors.textTertiary,
    fontFamily: 'monospace',
    fontSize: 10,
    letterSpacing: 1.5,
    width: 54,
    marginTop: 3,
  },
  readTitle: {flex: 1, color: colors.textPrimary, fontSize: 18, fontWeight: '700'},
  readArtist: {flex: 1, color: colors.textSecondary, fontSize: 14},
  sliderWrap: {height: 36, justifyContent: 'center', marginTop: spacing.lg},
  slider: {width: '100%', height: 36},
  timeRow: {flexDirection: 'row', justifyContent: 'space-between', marginTop: -spacing.xs},
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
  playGlow: {alignItems: 'center', justifyContent: 'center'},
  upNextLabel: {
    color: colors.textTertiary,
    fontFamily: 'monospace',
    fontSize: 11,
    letterSpacing: 2,
    fontWeight: '700',
    marginTop: spacing.xl,
    marginBottom: spacing.sm,
  },
  upNextEmpty: {color: colors.textSecondary, fontSize: 13, fontStyle: 'italic'},
});
