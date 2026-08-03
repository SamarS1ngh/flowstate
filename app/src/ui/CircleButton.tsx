import React from 'react';
import {ActivityIndicator, Pressable, StyleSheet, ViewStyle} from 'react-native';
import Icon, {IconName} from './Icon';
import {colors} from './theme';

// Big circular white play/pause button -- the single most recognisable
// piece of the reference app's now-playing screen and playlist header.
// When `loading` is true it shows a spinner instead of the icon and ignores
// taps -- used while a track is resolving/buffering but not yet audible.
export default function CircleButton({
  icon,
  onPress,
  size = 64,
  iconSize,
  iconColor = colors.black,
  backgroundColor = colors.white,
  loading = false,
  style,
}: {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  iconSize?: number;
  iconColor?: string;
  backgroundColor?: string;
  loading?: boolean;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      onPress={loading ? undefined : onPress}
      hitSlop={12}
      style={({pressed}) => [
        styles.base,
        {width: size, height: size, borderRadius: size / 2, backgroundColor},
        pressed && !loading && styles.pressed,
        style,
      ]}>
      {loading ? (
        <ActivityIndicator size="small" color={iconColor} />
      ) : (
        <Icon name={icon} size={iconSize ?? size * 0.4} color={iconColor} />
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {alignItems: 'center', justifyContent: 'center'},
  pressed: {opacity: 0.85},
});
