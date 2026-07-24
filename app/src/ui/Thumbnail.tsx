import React, {useState} from 'react';
import {Image, StyleSheet, View, ViewStyle} from 'react-native';
import Icon from './Icon';
import {colors, radii} from './theme';
import {nextThumbQuality, thumbUrl, ThumbQuality} from './thumb';

// Rounded remote-image thumbnail for a single song, with a graceful
// placeholder while loading and a two-step quality fallback (mqdefault ->
// hqdefault -> placeholder) if YouTube 404s the smaller size. `videoId` is
// optional so pinned pseudo-rows ("All songs") without one real song can
// still render a placeholder instead of every call site special-casing it.
export default function Thumbnail({
  videoId,
  size = 48,
  radius = radii.md,
  style,
}: {
  videoId?: string | null;
  size?: number;
  radius?: number;
  style?: ViewStyle;
}) {
  const [quality, setQuality] = useState<ThumbQuality>('mqdefault');
  const [failed, setFailed] = useState(false);

  const box = {width: size, height: size, borderRadius: radius};

  if (!videoId || failed) {
    return (
      <View style={[styles.placeholder, box, style]}>
        <Icon name="note" size={size * 0.4} color={colors.textTertiary} />
      </View>
    );
  }

  return (
    <View style={[box, style, styles.clip]}>
      <Image
        source={{uri: thumbUrl(videoId, quality)}}
        style={[box, styles.image]}
        onError={() => {
          const next = nextThumbQuality(quality);
          if (next) setQuality(next);
          else setFailed(true);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {overflow: 'hidden', backgroundColor: colors.surfaceRaised},
  image: {backgroundColor: colors.surfaceRaised},
  placeholder: {
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
