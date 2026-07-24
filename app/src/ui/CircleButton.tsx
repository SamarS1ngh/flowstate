import React from 'react';
import {Pressable, StyleSheet, ViewStyle} from 'react-native';
import Icon, {IconName} from './Icon';
import {colors} from './theme';

// Big circular white play/pause button -- the single most recognisable
// piece of the reference app's now-playing screen and playlist header.
export default function CircleButton({
  icon,
  onPress,
  size = 64,
  iconSize,
  iconColor = colors.black,
  backgroundColor = colors.white,
  style,
}: {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  iconSize?: number;
  iconColor?: string;
  backgroundColor?: string;
  style?: ViewStyle;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={12}
      style={({pressed}) => [
        styles.base,
        {width: size, height: size, borderRadius: size / 2, backgroundColor},
        pressed && styles.pressed,
        style,
      ]}>
      <Icon name={icon} size={iconSize ?? size * 0.4} color={iconColor} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  base: {alignItems: 'center', justifyContent: 'center'},
  pressed: {opacity: 0.85},
});
