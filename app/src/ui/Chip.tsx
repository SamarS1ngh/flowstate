import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {colors, radii, spacing} from './theme';

// Rounded-full filter/mood chip, matching the reference app's chip cloud:
// dark pill when inactive, white-bg/black-text when active. Used for
// Library's Playlists/Songs filter and PlayerScreen's mood filter row.
export default function Chip({
  label,
  active = false,
  onPress,
  tone = 'default',
}: {
  label: string;
  active?: boolean;
  onPress?: () => void;
  // 'danger' tints an active chip red instead of white/accent -- used by
  // PlayerScreen's "doesn't fit" pill so it reads as a reject action rather
  // than a filter toggle even though it shares the same chip shape.
  tone?: 'default' | 'accent' | 'danger';
}) {
  const activeBg =
    tone === 'danger' ? colors.dangerBg : tone === 'accent' ? colors.accent : colors.chipActiveBg;
  const activeText =
    tone === 'danger' ? colors.danger : tone === 'accent' ? colors.accentText : colors.chipActiveText;
  const activeBorder = tone === 'danger' ? colors.danger : 'transparent';

  return (
    <Pressable
      onPress={onPress}
      style={({pressed}) => [
        styles.chip,
        active && {backgroundColor: activeBg, borderColor: activeBorder},
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
    backgroundColor: colors.chipBg,
    borderWidth: 1,
    borderColor: colors.chipBg,
    borderRadius: radii.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    marginRight: spacing.sm,
    marginBottom: spacing.sm,
  },
  pressed: {opacity: 0.75},
  label: {color: colors.textPrimary, fontSize: 13, fontWeight: '600'},
});
