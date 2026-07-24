import React, {ReactNode} from 'react';
import {Pressable, StyleSheet, Text, View} from 'react-native';
import Thumbnail from './Thumbnail';
import {colors, spacing, thumbSize} from './theme';

// Shared row shape for Library's playlist list and Playlist's song list:
// thumbnail + title (+ optional badge) + subtitle, with a trailing slot for
// a spinner, play icon, or nothing. Kept generic (no db/player imports) so
// it's reusable wherever a "row with art" is needed.
export default function ListRow({
  videoId,
  title,
  titleBadge,
  subtitle,
  onPress,
  disabled,
  trailing,
  thumbRadius,
}: {
  videoId?: string | null;
  title: string;
  titleBadge?: string;
  subtitle?: string;
  onPress?: () => void;
  disabled?: boolean;
  trailing?: ReactNode;
  thumbRadius?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}>
      <Thumbnail videoId={videoId} size={thumbSize.row} radius={thumbRadius} />
      <View style={styles.text}>
        <Text style={styles.title} numberOfLines={1}>
          {title}
          {titleBadge ? <Text style={styles.badge}> {titleBadge}</Text> : null}
        </Text>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {trailing ? <View style={styles.trailing}>{trailing}</View> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm + 2,
  },
  pressed: {backgroundColor: colors.surface},
  text: {flex: 1, marginLeft: spacing.md, marginRight: spacing.sm},
  title: {color: colors.textPrimary, fontSize: 16, fontWeight: '500'},
  badge: {color: colors.textTertiary, fontSize: 13, fontWeight: '400'},
  subtitle: {color: colors.textSecondary, fontSize: 13, marginTop: 2},
  trailing: {marginLeft: spacing.sm},
});
