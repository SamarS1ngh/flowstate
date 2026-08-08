import React from 'react';
import {Pressable, StyleSheet, ViewStyle} from 'react-native';
import Icon, {IconName} from './Icon';
import {colors} from './theme';

// Small circular tap target for header/toolbar actions (settings, sync,
// search, menu, collapse-chevron). Background is transparent by default
// (matches the reference app's plain top-bar icons) or a dark chip circle
// when `filled` (used for the player's transport/menu buttons over art).
export default function IconButton({
  name,
  children,
  onPress,
  size = 22,
  color = colors.textPrimary,
  filled = false,
  disabled = false,
  hitSlop = 10,
  style,
}: {
  name?: IconName;
  // Custom icon node (e.g. an SVG glyph) rendered instead of the built-in
  // `name`. One of `name`/`children` should be provided.
  children?: React.ReactNode;
  onPress?: () => void;
  size?: number;
  color?: string;
  filled?: boolean;
  disabled?: boolean;
  hitSlop?: number;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      style={({pressed}) => [
        styles.base,
        filled && styles.filled,
        pressed && styles.pressed,
        disabled && styles.disabled,
        style,
      ]}>
      {children ?? (name ? <Icon name={name} size={size} color={color} /> : null)}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 20,
  },
  filled: {backgroundColor: colors.surfaceRaised},
  pressed: {opacity: 0.6},
  disabled: {opacity: 0.35},
});
