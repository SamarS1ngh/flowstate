import React from 'react';
import {StyleSheet, View} from 'react-native';
import {colors} from './theme';

/**
 * Full-screen HUD viewport chrome: a faint neon border inset from the edges
 * plus large L-shaped corner brackets at the four screen corners, so the whole
 * screen reads as a projected terminal viewport (JARVIS/FRIDAY style) rather
 * than a normal app surface. Purely decorative overlay -- ignores touches.
 */
export default function HudChrome() {
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      <View style={styles.border} />
      <View style={[styles.corner, styles.tl]} />
      <View style={[styles.corner, styles.tr]} />
      <View style={[styles.corner, styles.bl]} />
      <View style={[styles.corner, styles.br]} />
    </View>
  );
}

const INSET = 8;
const SIZE = 34;
const R = 20;

const styles = StyleSheet.create({
  border: {
    position: 'absolute',
    top: INSET,
    left: INSET,
    right: INSET,
    bottom: INSET,
    borderWidth: 1,
    borderColor: colors.glassBorderSoft,
    borderRadius: R,
  },
  corner: {position: 'absolute', width: SIZE, height: SIZE, borderColor: colors.neon},
  tl: {top: INSET - 1, left: INSET - 1, borderTopWidth: 2, borderLeftWidth: 2, borderTopLeftRadius: R},
  tr: {top: INSET - 1, right: INSET - 1, borderTopWidth: 2, borderRightWidth: 2, borderTopRightRadius: R},
  bl: {bottom: INSET - 1, left: INSET - 1, borderBottomWidth: 2, borderLeftWidth: 2, borderBottomLeftRadius: R},
  br: {bottom: INSET - 1, right: INSET - 1, borderBottomWidth: 2, borderRightWidth: 2, borderBottomRightRadius: R},
});
