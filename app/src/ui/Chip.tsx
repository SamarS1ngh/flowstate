import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {colors, radii, spacing} from './theme';

// Holographic chip: transparent with a faint glowing edge when inactive; when
// active it lights up with a neon (or red, for a reject) glowing outline + soft
// fill + coloured label -- reading as a lit holo toggle rather than a solid
// pill. Used by Library's filter tabs, Playlist's vibe toggles, and the
// Player's mood/mode/reject chips.
export default function Chip({
  label,
  active = false,
  onPress,
  tone = 'default',
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  // 'danger' lights the active chip red (reject action) instead of neon.
  tone?: 'default' | 'accent' | 'danger';
}) {
  const isDanger = tone === 'danger';
  const activeBorder = isDanger ? colors.danger : colors.neon;
  const activeText = isDanger ? colors.danger : colors.neon;
  const activeBg = isDanger ? colors.dangerBg : colors.accentSoft;
  const activeGlow = isDanger ? colors.dangerGlow : colors.neonGlow;

  return (
    <Pressable
      onPress={onPress}
      style={({pressed}) => [
        styles.chip,
        active && {
          backgroundColor: activeBg,
          borderColor: activeBorder,
          shadowColor: activeGlow,
          shadowOpacity: 1,
          shadowRadius: 9,
          shadowOffset: {width: 0, height: 0},
          elevation: 6,
        },
        pressed && styles.pressed,
      ]}>
      <Text style={[styles.label, active && {color: activeText, fontWeight: '700'}]}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    backgroundColor: 'transparent',
    borderWidth: 1,
    borderColor: colors.glassBorderSoft,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  pressed: {opacity: 0.7},
  label: {color: colors.textSecondary, fontSize: 13, fontWeight: '600'},
});
