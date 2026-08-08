import React from 'react';
import Svg, {Path} from 'react-native-svg';
import {colors} from './theme';

// Crisp monochrome shuffle icon (classic two-crossing-arrows). Vector, so it's
// pure white on the playlist's white random-play circle and fully tintable in
// the player transport (neon when active, dimmed when inert) -- unlike the
// fixed-colour 🔀 emoji glyph. react-native-svg is already a dependency.
export default function ShuffleGlyph({
  size = 24,
  color = colors.black,
}: {
  size?: number;
  color?: string;
}) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        fill={color}
        d="M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z"
      />
    </Svg>
  );
}
