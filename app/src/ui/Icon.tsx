import React from 'react';
import {Text, TextStyle} from 'react-native';
import {colors} from './theme';

// This icon set is plain Unicode glyphs rendered as Text -- a "same family,
// legally distinct" set that avoids copying the reference app's actual icon
// glyphs/trademarks, reads clearly at the sizes used here, and needs no native
// linking. Where a glyph doesn't exist or can't be tinted (e.g. shuffle, which
// only has a fixed-colour 🔀 emoji), a small react-native-svg component is used
// instead -- see ShuffleGlyph.tsx.
export type IconName =
  | 'chevronDown'
  | 'chevronBack'
  | 'menu'
  | 'search'
  | 'settings'
  | 'sync'
  | 'play'
  | 'pause'
  | 'next'
  | 'previous'
  | 'shuffle'
  | 'repeat'
  | 'lock'
  | 'drift'
  | 'thumbsDown'
  | 'pin'
  | 'note'
  | 'library'
  | 'heart'
  | 'heartOutline'
  | 'radio';

const GLYPHS: Record<IconName, string> = {
  chevronDown: '⌄',
  chevronBack: '‹',
  menu: '⋮',
  search: '⌕',
  settings: '⚙',
  sync: '⟳',
  play: '▶',
  pause: '❚❚',
  next: '⏭',
  previous: '⏮',
  shuffle: '⇄',
  repeat: '⟲',
  lock: '🔒',
  drift: '〜',
  thumbsDown: '👎',
  pin: '📌',
  note: '♪',
  library: '▤',
  heart: '♥',
  heartOutline: '♡',
  radio: '📡',
};

export default function Icon({
  name,
  size = 20,
  color = colors.textPrimary,
  style,
}: {
  name: IconName;
  size?: number;
  color?: string;
  style?: TextStyle;
}) {
  return (
    <Text
      allowFontScaling={false}
      style={[{fontSize: size, color, lineHeight: size * 1.15}, style]}>
      {GLYPHS[name]}
    </Text>
  );
}
