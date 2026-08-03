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
  // Backgrounds -- near-black with subtle elevation (not flat #000 everywhere)
  // so surfaces read as layered, which is most of what makes a dark UI feel
  // premium rather than "developer default".
  bg: '#08080b',
  surface: '#141418', // rows, cards, headers
  surfaceRaised: '#1e1e24', // chips (inactive), mini player, inputs
  surfacePressed: '#2a2a32',
  border: '#2a2a32',

  // Text
  textPrimary: '#ffffff',
  textSecondary: '#b3b3bd',
  textTertiary: '#7a7a86',

  // Chips / pills
  chipBg: 'rgba(255,255,255,0.07)',
  chipActiveBg: '#ffffff',
  chipActiveText: '#0a0a0a',

  // Stark/JARVIS-flavoured neon-glass palette: white + NEON PURPLE (the "cyan"
  // slot) + red, over frosted translucent glass. The neon carries every active
  // state; red is reserved for destructive/alert.
  accent: '#c04dff', // neon purple
  accentDeep: '#7a1fd0', // gradient bottom / pressed
  accentSoft: 'rgba(192,77,255,0.16)', // tinted fills behind accent content
  accentText: '#0b0714',
  neon: '#c04dff',
  neonGlow: 'rgba(192,77,255,0.55)', // shadowColor for glow effects

  // Glass surfaces -- translucent fills + luminous hairline borders that read as
  // frosted panels floating over the art-tinted backdrop.
  glassFill: 'rgba(255,255,255,0.06)',
  glassFillStrong: 'rgba(255,255,255,0.10)',
  glassBorder: 'rgba(192,77,255,0.35)', // neon-tinted edge
  glassBorderSoft: 'rgba(255,255,255,0.14)',

  // Kept as a sparkle highlight ONLY for the "magic" vibe-shuffle affordance.
  magic: '#f5c451',

  // Status -- Iron-Man red.
  danger: '#ff3557',
  dangerGlow: 'rgba(255,53,87,0.5)',
  dangerBg: 'rgba(255,53,87,0.12)',
  success: '#4dd0a0',

  white: '#ffffff',
  black: '#000000',
  overlay: 'rgba(0,0,0,0.6)',
};

// Reusable gradient stops (react-native-linear-gradient `colors` arrays). Used
// for the Player backdrop, playlist headers, and scrims. Kept here so the whole
// app pulls the same violet-into-black feel from one place.
export const gradients: {playerBackdrop: string[]; scrimDown: string[]} = {
  // Player / header backdrop: violet glow up top fading into the app bg.
  playerBackdrop: ['#241a3d', '#120f1d', colors.bg],
  // A soft top-down scrim to keep text legible over artwork.
  scrimDown: ['rgba(8,8,11,0)', 'rgba(8,8,11,0.85)'],
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
