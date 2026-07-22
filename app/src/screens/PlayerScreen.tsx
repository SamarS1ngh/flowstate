import React, {useCallback, useEffect, useState} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {Event, State, useProgress, useTrackPlayerEvents, usePlaybackState} from 'react-native-track-player';
import {
  nowPlaying,
  skipToNext,
  skipToPrevious,
  togglePlayPause,
} from '../player/controller';
import type {Song} from '../types';

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export default function PlayerScreen() {
  const [song, setSong] = useState<Song | null>(() => nowPlaying());
  const progress = useProgress(500);
  const playbackState = usePlaybackState();

  const refreshSong = useCallback(() => {
    setSong(nowPlaying());
  }, []);

  useTrackPlayerEvents([Event.PlaybackActiveTrackChanged], refreshSong);

  // Also catch the case where this screen is reached right after playFrom()
  // resolved, before any track-changed event has fired.
  useEffect(() => {
    refreshSong();
  }, [refreshSong]);

  const isPlaying = playbackState.state === State.Playing;

  if (!song) {
    return (
      <View style={styles.center}>
        <Text style={styles.emptyText}>Nothing playing.</Text>
      </View>
    );
  }

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
  info: {alignItems: 'center', marginBottom: 40},
  title: {
    color: '#f2f2f5',
    fontSize: 22,
    fontWeight: '600',
    textAlign: 'center',
  },
  artist: {color: '#9a9aa8', fontSize: 16, marginTop: 8, textAlign: 'center'},
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
