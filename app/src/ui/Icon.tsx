import React from 'react';
import {Text, TextStyle} from 'react-native';
import {colors} from './theme';

// No icon library is installed in this app (no react-native-svg, no
// vector-icons) and the brief asks to keep new deps minimal and to avoid
// copying the reference app's actual icon glyphs/trademarks. Plain Unicode
// glyphs rendered as Text give a "same family, legally distinct" icon set
// for free -- no native linking, nothing that can fail to autolink on New
// Architecture, and each one reads clearly at the sizes used here (verified
// on-device, see task-ui-report.md).
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
  | 'library';

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
