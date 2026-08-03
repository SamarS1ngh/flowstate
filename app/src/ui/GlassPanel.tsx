import React from 'react';
import {StyleSheet, View, ViewStyle} from 'react-native';
import {BlurView} from '@react-native-community/blur';
import {colors, radii} from './theme';

/**
 * A frosted-glass panel for the Stark/JARVIS neon look: a real blur behind a
 * translucent fill and a luminous hairline border, so it reads as glass
 * floating over the art-tinted backdrop. The translucent fill means it still
 * looks glassy even if the native blur under-renders on a given device.
 * `neon` uses the neon-purple edge (default) vs a soft white edge; `glow` adds
 * a neon drop shadow.
 */
export default function GlassPanel({
  children,
  style,
  radius = radii.lg,
  neon = true,
  glow = false,
  strong = false,
}: {
  children?: React.ReactNode;
  style?: ViewStyle;
  radius?: number;
  neon?: boolean;
  glow?: boolean;
  strong?: boolean;
}) {
  return (
    <View
      style={[
        styles.wrap,
        {
          borderRadius: radius,
          borderColor: neon ? colors.glassBorder : colors.glassBorderSoft,
        },
        glow && styles.glow,
        style,
      ]}>
      <BlurView
        style={[StyleSheet.absoluteFill, {borderRadius: radius}]}
        blurType="dark"
        blurAmount={16}
        reducedTransparencyFallbackColor={colors.surface}
      />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            borderRadius: radius,
            backgroundColor: strong ? colors.glassFillStrong : colors.glassFill,
          },
        ]}
      />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {overflow: 'hidden', borderWidth: 1},
  content: {position: 'relative'},
  glow: {
    shadowColor: colors.neonGlow,
    shadowOpacity: 1,
    shadowRadius: 16,
    shadowOffset: {width: 0, height: 0},
    elevation: 12,
  },
});
