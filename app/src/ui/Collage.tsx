import React from 'react';
import {StyleSheet, View} from 'react-native';
import Thumbnail from './Thumbnail';
import {colors, radii} from './theme';

// Playlist header art: a 2x2 collage built from the first up to 4 songs'
// thumbnails (no dedicated playlist-art column exists in the db). Falls
// back to a single big thumbnail when there's only one song, or the plain
// placeholder box when there are none.
export default function Collage({videoIds, size = 240}: {videoIds: string[]; size?: number}) {
  const ids = videoIds.slice(0, 4);

  if (ids.length <= 1) {
    return (
      <Thumbnail videoId={ids[0]} size={size} radius={radii.lg} style={styles.shadow} />
    );
  }

  const cell = size / 2;
  // Repeat the last id to fill a 3-song playlist's fourth cell rather than
  // leaving a blank placeholder square in an otherwise-full collage.
  const cells = [ids[0], ids[1], ids[2] ?? ids[0], ids[3] ?? ids[1] ?? ids[0]];

  return (
    <View style={[styles.grid, {width: size, height: size}, styles.shadow]}>
      {cells.map((id, i) => (
        <Thumbnail key={i} videoId={id} size={cell} radius={0} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    borderRadius: radii.lg,
    overflow: 'hidden',
    backgroundColor: colors.surfaceRaised,
  },
  shadow: {elevation: 4},
});
