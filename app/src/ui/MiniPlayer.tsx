import React from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import {State, usePlaybackState} from 'react-native-track-player';
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

  if (!song) return null; // nothing loaded yet this session -- nothing to show

  const isPlaying = playbackState.state === State.Playing;

  return (
    <Pressable onPress={onPress} style={({pressed}) => [styles.bar, pressed && styles.pressed]}>
      <Thumbnail videoId={song.videoId} size={thumbSize.mini} radius={radii.sm} />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {song.title}
        </Text>
        <Text style={styles.artist} numberOfLines={1}>
          {song.artist}
        </Text>
      </View>
      <IconButton
        name={isPlaying ? 'pause' : 'play'}
        onPress={() => togglePlayPause()}
        size={18}
        hitSlop={8}
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    height: miniPlayerHeight,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surfaceRaised,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingHorizontal: spacing.md,
  },
  pressed: {backgroundColor: colors.surfacePressed},
  text: {flex: 1, marginLeft: spacing.md, marginRight: spacing.sm},
  title: {color: colors.textPrimary, fontSize: 13, fontWeight: '600'},
  artist: {color: colors.textSecondary, fontSize: 11, marginTop: 2},
});
