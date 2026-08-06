import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {State, usePlaybackState, useProgress} from 'react-native-track-player';
import Thumbnail from './Thumbnail';
import IconButton from './IconButton';
import {colors, miniPlayerHeight, radii, spacing, thumbSize} from './theme';
import {togglePlayPause} from '../player/controller';
import {useNowPlayingSong} from './useNowPlaying';

// Persistent mini-player bar (Task 3): mounted once at App level (see
// src/App.tsx) so it survives Library <-> Playlist navigation instead of
// being re-created per screen, matching the reference app's behavior of
// keeping the mini player attached to the bottom nav everywhere except the
// full now-playing screen itself.
export default function MiniPlayer({onPress}: {onPress: () => void}) {
  const song = useNowPlayingSong();
  const playbackState = usePlaybackState();
  const progress = useProgress(500);

  if (!song) return null; // nothing loaded yet this session -- nothing to show

  const isPlaying = playbackState.state === State.Playing;
  // Thin progress line along the bottom edge. Fall back to the song's known
  // duration until the player reports a real one, so the bar isn't stuck empty
  // during the first moments of a track.
  const dur = progress.duration > 0 ? progress.duration : song.durationS ?? 0;
  const pct = dur > 0 ? Math.max(0, Math.min(1, progress.position / dur)) : 0;

  return (
    <Pressable onPress={onPress} style={({pressed}) => [styles.bar, pressed && styles.pressed]}>
      {/* Neon top rail + a live status pip -- the mini dock reads as part of
          the same HUD as the full player. */}
      <View style={styles.rail} />
      <View style={styles.artWrap}>
        <Thumbnail videoId={song.videoId} size={thumbSize.mini} radius={radii.sm} />
      </View>
      <View style={styles.text}>
        <View style={styles.titleRow}>
          <View style={[styles.pip, {backgroundColor: isPlaying ? colors.neon : colors.textTertiary}]} />
          <Text style={styles.title} numberOfLines={1}>
            {song.title}
          </Text>
        </View>
        <Text style={styles.artist} numberOfLines={1}>
          {song.artist}
        </Text>
      </View>
      <IconButton
        name={isPlaying ? 'pause' : 'play'}
        onPress={() => togglePlayPause(isPlaying)}
        size={18}
        color={colors.neon}
        hitSlop={8}
      />
      {/* Playback progress along the bottom edge (timer bar). */}
      <View style={styles.progressTrack}>
        <View style={[styles.progressFill, {width: `${pct * 100}%`}]} />
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: miniPlayerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
  },
  rail: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: colors.glassBorder,
  },
  pressed: {backgroundColor: colors.surfacePressed},
  artWrap: {
    borderWidth: 1,
    borderColor: colors.glassBorderSoft,
    borderRadius: radii.sm + 1,
    padding: 1,
  },
  text: {flex: 1, marginLeft: spacing.md, marginRight: spacing.sm},
  titleRow: {flexDirection: 'row', alignItems: 'center'},
  pip: {width: 6, height: 6, borderRadius: 3, marginRight: spacing.sm},
  title: {flex: 1, color: colors.textPrimary, fontSize: 13, fontWeight: '700', fontFamily: 'monospace'},
  artist: {color: colors.textSecondary, fontSize: 11, marginTop: 2, fontFamily: 'monospace'},
  progressTrack: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: 'rgba(255,255,255,0.12)',
  },
  progressFill: {height: 2, backgroundColor: colors.neon},
});
