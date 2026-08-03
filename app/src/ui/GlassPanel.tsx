import React from 'react';
import {StyleSheet, View, ViewStyle} from 'react-native';
import {colors, radii} from './theme';

/**
 * A holographic panel for the Stark/JARVIS look -- NOT frosted glass. A
 * barely-there translucent fill lets the art-tinted backdrop show through
 * (a projection floating in space), and the panel is defined by a GLOWING thin
 * neon edge plus a faint top "sheen" line that reads as the projected upper
 * edge. Clean, luminous, minimal. `neon` uses the neon edge (default) vs a soft
 * white edge; `glow` adds the neon bloom.
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
          backgroundColor: strong ? colors.glassFillStrong : colors.glassFill,
        },
        glow && styles.glow,
        style,
      ]}>
      {/* Faint top-edge highlight -- the "projected" upper rim of a hologram. */}
      <View
        style={[
          styles.sheen,
          {borderTopLeftRadius: radius, borderTopRightRadius: radius},
        ]}
      />
      <View style={styles.content}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {overflow: 'hidden', borderWidth: 1},
  content: {position: 'relative'},
  sheen: {
    position: 'absolute',
    top: 0,
    left: '6%',
    right: '6%',
    height: 1,
    backgroundColor: colors.holoSheen,
  },
  glow: {
    shadowColor: colors.neonGlow,
    shadowOpacity: 1,
    shadowRadius: 14,
    shadowOffset: {width: 0, height: 0},
    elevation: 10,
  },
});
