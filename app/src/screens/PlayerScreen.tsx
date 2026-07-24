import React, {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {ScrollView, StyleSheet, Text, View} from 'react-native';
import {SafeAreaView} from 'react-native-safe-area-context';
import type {NativeStackScreenProps} from '@react-navigation/native-stack';
import {Event, State, useProgress, useTrackPlayerEvents, usePlaybackState} from 'react-native-track-player';
import type {RootStackParamList} from '../App';
import {
  currentSource,
  consumeFallbackStatus,
  nowPlaying,
  skipToNext,
  skipToPrevious,
  togglePlayPause,
  FallbackKind,
} from '../player/controller';
import {openVibesDb} from '../db/vibesDb';
import {FeedbackStore} from '../engine/feedbackStore';
import {VibeQueue} from '../engine/vibeQueue';
import type {Song} from '../types';
import Chip from '../ui/Chip';
import CircleButton from '../ui/CircleButton';
import IconButton from '../ui/IconButton';
import Thumbnail from '../ui/Thumbnail';
import {colors, spacing, thumbSize, type} from '../ui/theme';

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

export default function PlayerScreen({navigation}: Props) {
  const [song, setSong] = useState<Song | null>(() => nowPlaying());
  const [selectedMood, setSelectedMood] = useState<string | null>(null);
  const [fallbackStatus, setFallbackStatus] = useState<FallbackKind | null>(null);
  const [feedbackStore, setFeedbackStore] = useState<FeedbackStore | null>(null);
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
  // resolved, before any track-changed event has fired.
  useEffect(() => {
    refreshSong();
  }, [refreshSong]);

  // FeedbackStore needs a live DB handle; opened once per screen visit and
  // reused for both the "doesn't fit" write and (defensively) ensureTables,
  // in case vibes.db was imported after App.tsx's bootstrap-time call.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const opened = await openVibesDb();
      if (cancelled || !opened) return;
      const store = new FeedbackStore(opened.handle);
      store.ensureTables();
      setFeedbackStore(store);
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

  const isLock = src instanceof VibeQueue && src.label === 'vibe:lock';

  return (
    <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
      <View style={styles.topBar}>
        <IconButton name="chevronDown" size={26} onPress={() => navigation.goBack()} />
        <IconButton name="menu" size={22} onPress={() => navigation.navigate('Settings')} />
      </View>

      <ScrollView
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}>
        <View style={styles.artWrap}>
          <Thumbnail videoId={song.videoId} size={thumbSize.player} radius={12} />
        </View>

        <View style={styles.info}>
          <Text style={styles.title} numberOfLines={2}>
            {song.title}
          </Text>
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

            {fallbackStatus && fallbackStatus !== 'error' ? (
              <Text style={styles.fallbackText}>{FALLBACK_LABEL[fallbackStatus]}</Text>
            ) : null}
          </View>
        ) : null}

        <View style={styles.progressRow}>
          <Text style={styles.time}>{formatTime(progress.position)}</Text>
          <View style={styles.progressBarTrack}>
            <View
              style={[
                styles.progressBarFill,
                {
                  width: `${
                    progress.duration > 0
                      ? Math.min(100, (progress.position / progress.duration) * 100)
                      : 0
                  }%`,
                },
              ]}
            />
          </View>
          <Text style={styles.time}>{formatTime(progress.duration)}</Text>
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
          <IconButton name="previous" size={30} onPress={() => skipToPrevious()} />
          <CircleButton
            icon={isPlaying ? 'pause' : 'play'}
            size={72}
            onPress={() => togglePlayPause()}
          />
          <IconButton name="next" size={30} onPress={() => skipToNext()} />
          {/* Repeat: decorative only -- no repeat-track/queue concept exists in
              controller.ts/queue.ts, and this redesign doesn't invent new
              playback logic. Rendered dimmed so it doesn't imply a working
              toggle. */}
          <IconButton name="repeat" size={22} color={colors.textTertiary} disabled />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {flex: 1, backgroundColor: colors.bg},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center'},
  emptyTopBar: {paddingHorizontal: spacing.md, paddingTop: spacing.xs},
  emptyText: {color: colors.textSecondary, fontSize: 16},
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingTop: spacing.xs,
  },
  scrollContent: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
    alignItems: 'center',
    flexGrow: 1,
  },
  artWrap: {marginTop: spacing.lg},
  info: {alignItems: 'center', marginTop: spacing.xxl, width: '100%'},
  title: {...type.title, textAlign: 'center'},
  artist: {color: colors.textSecondary, fontSize: 15, marginTop: spacing.sm, textAlign: 'center'},
  errorText: {color: colors.danger, fontSize: 13, textAlign: 'center', marginTop: spacing.md},
  vibeSection: {marginTop: spacing.xxl, width: '100%', alignItems: 'center'},
  actionChipRow: {flexDirection: 'row', justifyContent: 'center', marginBottom: spacing.sm},
  chipRow: {flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center'},
  fallbackText: {color: colors.textTertiary, fontSize: 12, textAlign: 'center', marginTop: spacing.xs},
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    width: '100%',
    marginTop: spacing.xxl,
  },
  time: {color: colors.textTertiary, fontSize: 12, width: 40, textAlign: 'center'},
  progressBarTrack: {
    flex: 1,
    height: 4,
    backgroundColor: colors.chipBg,
    borderRadius: 2,
    marginHorizontal: spacing.sm,
    overflow: 'hidden',
  },
  progressBarFill: {height: 4, backgroundColor: colors.white, borderRadius: 2},
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    marginTop: spacing.xl,
    paddingHorizontal: spacing.sm,
  },
});
