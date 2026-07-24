// flowstate design system -- a YouTube Music-flavoured dark theme (pure-black
// background, white/grey text, rounded thumbnails, pill chips/buttons) kept
// deliberately generic (no copied icons, wordmarks, or exact colour values
// from any real app) so it reads as "the same family" without being a clone.
//
// This file is pure presentation constants -- no behavior, no native deps.
// Every screen restyle in src/screens + src/auth should pull colors/spacing/
// type from here rather than hand-rolling hex codes, so the look stays
// consistent and easy to retune from one place.

export const colors = {
  // Backgrounds
  bg: '#000000',
  surface: '#141414', // rows, cards, headers
  surfaceRaised: '#1f1f1f', // chips (inactive), mini player, inputs
  surfacePressed: '#242424',
  border: '#2a2a2a',

  // Text
  textPrimary: '#ffffff',
  textSecondary: '#aaaaaa',
  textTertiary: '#767676',

  // Chips / pills
  chipBg: '#272727',
  chipActiveBg: '#ffffff',
  chipActiveText: '#0a0a0a',

  // flowstate's own accent -- used sparingly, only for vibe-engine features
  // (lock/drift, mood chips, progress emphasis) so the app still has an
  // identity distinct from the reference app's pure black/white/red look.
  accent: '#5b8def',
  accentText: '#06101f',

  // Status
  danger: '#ef5b5b',
  dangerBg: '#2a1616',
  success: '#5bc98a',

  white: '#ffffff',
  black: '#000000',
  overlay: 'rgba(0,0,0,0.6)',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
};

export const radii = {
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  pill: 999,
};

export const type = {
  display: {fontSize: 28, fontWeight: '700' as const, color: colors.textPrimary},
  title: {fontSize: 22, fontWeight: '700' as const, color: colors.textPrimary},
  headline: {fontSize: 17, fontWeight: '700' as const, color: colors.textPrimary},
  body: {fontSize: 15, fontWeight: '400' as const, color: colors.textPrimary},
  bodyBold: {fontSize: 15, fontWeight: '600' as const, color: colors.textPrimary},
  caption: {fontSize: 13, fontWeight: '400' as const, color: colors.textSecondary},
  tiny: {fontSize: 11, fontWeight: '400' as const, color: colors.textTertiary},
};

// Standard sizes reused across ListRow/Thumbnail/PlayerScreen so thumbnails
// line up consistently between Library, Playlist, and the mini player.
export const thumbSize = {
  row: 48,
  collageCell: 60, // 2x2 collage cell on PlaylistScreen's header (~120 total)
  mini: 40,
  player: 320,
};

export const miniPlayerHeight = 56;
export const bottomNavHeight = 56;
