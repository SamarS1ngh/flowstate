import React from 'react';
import {StyleSheet, View, ViewStyle} from 'react-native';
import {colors} from './theme';

/**
 * A Stark/JARVIS "system window" frame: a transparent dark fill, a thin glowing
 * neon border, and bright L-shaped CORNER BRACKETS at each corner -- the
 * signature holographic-panel look (cf. the FRIDAY OS / Solo-Leveling status
 * windows). `tone` switches the accent to red for alerts; `glow` adds bloom.
 * Corners overhang the edge, so this frame does not clip its children.
 */
export default function HoloFrame({
  children,
  style,
  radius = 4,
  cornerSize = 18,
  glow = true,
  tone = 'neon',
}: {
  children?: React.ReactNode;
  style?: ViewStyle;
  radius?: number;
  cornerSize?: number;
  glow?: boolean;
  tone?: 'neon' | 'danger';
}) {
  const edge = tone === 'danger' ? colors.danger : colors.neon;
  const glowColor = tone === 'danger' ? colors.dangerGlow : colors.neonGlow;
  const corner = {borderColor: edge, width: cornerSize, height: cornerSize};
  return (
    <View
      style={[
        styles.frame,
        {borderRadius: radius},
        glow && {
          shadowColor: glowColor,
          shadowOpacity: 1,
          shadowRadius: 12,
          shadowOffset: {width: 0, height: 0},
          elevation: 8,
        },
        style,
      ]}>
      <View style={[styles.corner, styles.tl, corner]} pointerEvents="none" />
      <View style={[styles.corner, styles.tr, corner]} pointerEvents="none" />
      <View style={[styles.corner, styles.bl, corner]} pointerEvents="none" />
      <View style={[styles.corner, styles.br, corner]} pointerEvents="none" />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    borderWidth: 1,
    borderColor: colors.glassBorder,
    backgroundColor: colors.glassFill,
  },
  corner: {position: 'absolute'},
  tl: {top: -1, left: -1, borderTopWidth: 2, borderLeftWidth: 2},
  tr: {top: -1, right: -1, borderTopWidth: 2, borderRightWidth: 2},
  bl: {bottom: -1, left: -1, borderBottomWidth: 2, borderLeftWidth: 2},
  br: {bottom: -1, right: -1, borderBottomWidth: 2, borderRightWidth: 2},
});
