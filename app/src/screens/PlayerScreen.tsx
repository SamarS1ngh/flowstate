import React, {useCallback, useEffect, useReducer, useRef, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Event, State, useProgress, useTrackPlayerEvents, usePlaybackState} from 'react-native-track-player';
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
};

// TODO(device verification): no device/emulator was available while building
// this screen. tsc + jest are clean, but the lock/drift toggle, mood chips,
// "doesn't fit" flow, and the fallback status line have not been exercised
// against a real vibes.db / TrackPlayer instance. Verify on-device before
// relying on this for the release build (see Task 4).
export default function PlayerScreen() {
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
      <View style={styles.center}>
        <Text style={styles.emptyText}>Nothing playing.</Text>
      </View>
    );
  }

  const isLock = src instanceof VibeQueue && src.label === 'vibe:lock';

  return (
    <View style={styles.container}>
      <View style={styles.info}>
        <Text style={styles.title} numberOfLines={2}>
          {song.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {song.artist}
        </Text>
      </View>

      {isVibe ? (
        <View style={styles.vibeSection}>
          <View style={styles.modeRow}>
            <Pressable
              style={[styles.modeButton, isLock && styles.modeButtonActive]}
              onPress={onToggleLockDrift}>
              <Text
                style={[
                  styles.modeButtonText,
                  isLock && styles.modeButtonTextActive,
                ]}>
                {isLock ? 'Lock' : 'Drift'}
              </Text>
            </Pressable>
            <Pressable style={styles.rejectButton} onPress={onDoesntFit}>
              <Text style={styles.rejectButtonText}>Doesn't fit</Text>
            </Pressable>
          </View>

          <View style={styles.chipRow}>
            {MOOD_CHIPS.map(chip => {
              const active = selectedMood === chip.key;
              return (
                <Pressable
                  key={chip.key}
                  style={[styles.chip, active && styles.chipActive]}
                  onPress={() => onToggleMood(chip.key)}>
                  <Text
                    style={[styles.chipText, active && styles.chipTextActive]}>
                    {chip.label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {fallbackStatus ? (
            <Text style={styles.fallbackText}>
              {FALLBACK_LABEL[fallbackStatus]}
            </Text>
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
                    ? Math.min(
                        100,
                        (progress.position / progress.duration) * 100,
                      )
                    : 0
                }%`,
              },
            ]}
          />
        </View>
        <Text style={styles.time}>{formatTime(progress.duration)}</Text>
      </View>

      <View style={styles.controls}>
        <Pressable
          style={styles.controlButton}
          onPress={() => skipToPrevious()}
          hitSlop={16}>
          <Text style={styles.controlIcon}>⏮</Text>
        </Pressable>
        <Pressable
          style={[styles.controlButton, styles.playButton]}
          onPress={() => togglePlayPause()}
          hitSlop={16}>
          <Text style={styles.playIcon}>{isPlaying ? '⏸' : '▶'}</Text>
        </Pressable>
        <Pressable
          style={styles.controlButton}
          onPress={() => skipToNext()}
          hitSlop={16}>
          <Text style={styles.controlIcon}>⏭</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    padding: 24,
    justifyContent: 'center',
  },
  center: {
    flex: 1,
    backgroundColor: '#0b0b0f',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyText: {color: '#9a9aa8', fontSize: 16},
  info: {alignItems: 'center', marginBottom: 24},
  title: {
    color: '#f2f2f5',
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  artist: {color: '#9a9aa8', fontSize: 16, marginTop: 8, textAlign: 'center'},
  vibeSection: {marginBottom: 24},
  modeRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 14,
  },
  modeButton: {
    borderWidth: 1,
    borderColor: '#26262f',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 8,
    marginRight: 10,
  },
  modeButtonActive: {backgroundColor: '#5b8def', borderColor: '#5b8def'},
  modeButtonText: {color: '#9a9aa8', fontSize: 14, fontWeight: '600'},
  modeButtonTextActive: {color: '#0b0b0f'},
  rejectButton: {
    borderWidth: 1,
    borderColor: '#3d2020',
    borderRadius: 20,
    paddingHorizontal: 18,
    paddingVertical: 8,
  },
  rejectButtonText: {color: '#e08a8a', fontSize: 14, fontWeight: '600'},
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  chip: {
    borderWidth: 1,
    borderColor: '#26262f',
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 6,
    marginRight: 8,
    marginBottom: 8,
  },
  chipActive: {backgroundColor: '#26262f', borderColor: '#5b8def'},
  chipText: {color: '#9a9aa8', fontSize: 13},
  chipTextActive: {color: '#5b8def', fontWeight: '600'},
  fallbackText: {
    color: '#6f6f7d',
    fontSize: 12,
    textAlign: 'center',
    marginTop: 4,
  },
  progressRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 48,
  },
  time: {color: '#6f6f7d', fontSize: 12, width: 40, textAlign: 'center'},
  progressBarTrack: {
    flex: 1,
    height: 4,
    backgroundColor: '#26262f',
    borderRadius: 2,
    marginHorizontal: 8,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: 4,
    backgroundColor: '#5b8def',
    borderRadius: 2,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
  },
  controlIcon: {color: '#f2f2f5', fontSize: 32},
  playButton: {
    backgroundColor: '#5b8def',
    borderRadius: 40,
    width: 80,
    height: 80,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playIcon: {color: '#0b0b0f', fontSize: 32},
});
